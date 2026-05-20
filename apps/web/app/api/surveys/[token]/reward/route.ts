import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { appendCustomerNote, type LoyaltyAccountSummary } from "@/lib/square-gift-card";
import {
  getGuestSurveyByToken,
  saveGuestSurveyReward,
  type SurveyRewardKind,
} from "@/lib/guest-survey-db";
import { CENTER_META } from "@/lib/bowling-lane-ready-notify";
import { voxSend } from "@/lib/sms-retry";
import { logSms } from "@/lib/sms-log";
import {
  issueReward,
  recordTouch,
  renderGiftCardAwardSms,
  renderPinzAwardSms,
} from "~/features/marketing";

/**
 * POST /api/surveys/[token]/reward
 *
 * Issue the chosen reward for a completed survey. Idempotent on the
 * survey row's `reward_kind` field — second call with a token that
 * already has a reward returns 409.
 *
 * Body: { kind: "pinz" | "gift_card" }
 *
 * Flow:
 *   1. Validate token + body
 *   2. Load survey; require completed_at to be set (must submit first)
 *   3. Bail if reward already issued
 *   4. Call issueReward (Square Loyalty adjust OR gift-card mint)
 *   5. Persist reward fields on the survey row
 *   6. Send confirmation SMS (best-effort; failure doesn't roll back
 *      the reward — the Square mutation already happened)
 *   7. Append a one-line note to the Square customer (fire-and-forget)
 *   8. Record a marketing_touches 'converted-reward' touch
 *
 * Returns the public reward shape (no PII, no Square ids beyond the
 * customer-visible ones — promo code, balance).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!token || token.length < 8 || token.length > 64) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }

  let body: { kind?: SurveyRewardKind };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (body.kind !== "pinz" && body.kind !== "gift_card") {
    return NextResponse.json({ error: "kind must be 'pinz' or 'gift_card'" }, { status: 400 });
  }

  const survey = await getGuestSurveyByToken(token);
  if (!survey) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!survey.completedAt) {
    return NextResponse.json(
      { error: "submit the survey before claiming a reward" },
      { status: 409 },
    );
  }
  if (survey.rewardKind) {
    return NextResponse.json(
      {
        error: "reward already issued",
        kind: survey.rewardKind,
        ref: survey.rewardRef,
      },
      { status: 409 },
    );
  }

  // Idempotency key derived from token (16-char hex prefix) — matches the
  // square-gift-card.ts conventions (≤12 char prefix + 16-hex baseKey).
  const baseKey = `gsr-${token.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16) || randomBytes(8).toString("hex")}`;

  let issued;
  try {
    issued = await issueReward({
      customerId: survey.squareCustomerId,
      phoneE164: survey.phoneE164,
      locationId: survey.centerCode,
      kind: body.kind,
      baseKey,
      surveyId: survey.id,
      reason: "Guest Survey Reward",
    });
  } catch (err) {
    console.error(`[surveys/${token}/reward] issue failed:`, err);
    return NextResponse.json(
      {
        error: "reward could not be issued",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  // Persist on the survey row so a second call sees rewardKind populated.
  await saveGuestSurveyReward({
    token,
    rewardKind: issued.kind,
    rewardRef: issued.ref,
    rewardValue: issued.value,
  });

  // Confirmation SMS — best-effort. Failures here don't roll back the
  // reward (it's already in Square / Loyalty).
  const brand = pickBrand(survey.centerCode);
  const smsBody =
    issued.kind === "pinz"
      ? renderPinzAwardSms({
          points: issued.value,
          newBalance: (issued.meta as { newBalance: number }).newBalance,
          brand,
        })
      : renderGiftCardAwardSms({
          gan: formatGan((issued.meta as { gan: string }).gan),
          promoCode: (issued.meta as { promoCode: string }).promoCode,
          brand,
        });

  const centerFrom = CENTER_META[survey.centerCode]?.smsFrom;
  voxSend(survey.phoneE164, smsBody, { fromOverride: centerFrom })
    .then((r) =>
      logSms({
        ts: new Date().toISOString(),
        phone: survey.phoneE164,
        source: "guest-survey",
        status: r.status ?? null,
        ok: r.ok,
        provider: r.provider ?? "vox",
        failedOver: r.failedOver ?? false,
        body: smsBody,
        providerMessageId: r.voxId ?? r.twilioSid,
      }),
    )
    .catch((err) => console.warn(`[surveys/${token}/reward] confirmation SMS failed:`, err));

  // Square customer note — ops visibility, fire-and-forget.
  const noteLine = `[${new Date().toISOString().slice(0, 10)}] Guest survey reward — ${issued.displayText}`;
  appendCustomerNote({
    customerId: survey.squareCustomerId,
    line: noteLine,
  }).catch((err) => console.warn(`[surveys/${token}/reward] customer note append failed:`, err));

  // marketing_touches 'converted' with reward metadata — fire-and-forget.
  recordTouch({
    customerId: survey.squareCustomerId,
    phoneE164: survey.phoneE164,
    campaign: "guest_survey",
    event: "converted",
    refId: token,
    meta: {
      stage: "reward_issued",
      rewardKind: issued.kind,
      rewardValue: issued.value,
      ...(issued.kind === "gift_card"
        ? { promoCode: (issued.meta as { promoCode: string }).promoCode }
        : {}),
    },
  }).catch((err) => console.warn(`[surveys/${token}/reward] recordTouch failed:`, err));

  return NextResponse.json({
    ok: true,
    reward: {
      kind: issued.kind,
      value: issued.value,
      displayText: issued.displayText,
      // For gift card: expose the promo code so the page can show it; the
      // full GAN is in the SMS only, not the page.
      ...(issued.kind === "gift_card"
        ? { promoCode: (issued.meta as { promoCode: string }).promoCode }
        : {}),
      ...(issued.kind === "pinz"
        ? { newBalance: (issued.meta as { newBalance: number }).newBalance }
        : {}),
    },
  });
}

function pickBrand(centerCode: string): "HeadPinz" | "FastTrax" {
  // Both current centers are HP; racing surveys (PR-GS4) will flip to FT
  // for FastTrax-only centers.
  return centerCode in CENTER_META ? "HeadPinz" : "FastTrax";
}

/** Format a 16-digit GAN as 4-4-4-4 for legibility in SMS. */
function formatGan(gan: string): string {
  const digits = gan.replace(/\D/g, "");
  if (digits.length !== 16) return gan;
  return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}`;
}

// Silence unused-type warning for the imported LoyaltyAccountSummary —
// it's referenced indirectly through issueReward's meta type, but TS may
// flag the named import if narrowing strips it.
export type _LoyaltyAccountSummary = LoyaltyAccountSummary;
