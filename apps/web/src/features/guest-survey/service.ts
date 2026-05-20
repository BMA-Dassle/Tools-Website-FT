import { randomUUID } from "crypto";
import { isDbConfigured } from "@ft/db";
import { voxSend } from "@/lib/sms-retry";
import { logSms } from "@/lib/sms-log";
import { shortenUrl } from "@/lib/short-url";
import { CENTER_META } from "@/lib/bowling-lane-ready-notify";
import {
  deleteGuestSurveyByToken,
  getGuestSurveyByOriginRef,
  insertGuestSurvey,
  seedGuestSurveyQuestionsIfEmpty,
} from "@/lib/guest-survey-db";
import {
  canSend,
  getConsent,
  recordTouch,
  renderBowlingSurveyInvite,
  resolveAudienceMember,
  splitGuestName,
} from "~/features/marketing";
import { pickQuestions, pickTags } from "./questions";
import type { EnqueueBowlingSurveyInput, EnqueueOutcome, SkipReason } from "./types";

/**
 * Guest survey orchestration — bowling.
 *
 * Called from the QAMF webhook on `Completed` lane transitions (PR-GS2.5).
 * Idempotent on (origin='bowling', origin_ref=reservationId).
 *
 * Flow:
 *   1. Phone present?                   → no  → skip 'no_phone'
 *   2. DB configured?                   → no  → skip 'no_db'
 *   3. Survey already exists for ref?   → yes → skip 'already_sent_for_origin_ref'
 *   4. Resolve audience (Square cust)   → err → skip 'audience_resolve_failed'
 *   5. Marketing consent?               → no  → skip 'no_marketing_consent'  + record touch
 *   6. Frequency cap (30 days)?         → yes → skip 'within_frequency_window' + record touch
 *   7. Pick tags + questions
 *   8. Insert guest_surveys row, generate short link
 *   9. Send SMS via voxSend (Twilio failover) with center smsFrom
 *  10. On SMS failure: delete the row + record 'skipped' touch with detail
 *  11. On SMS success: logSms + record 'sent' touch + return sent outcome
 *
 * Same-day Square order context (cross-sell question selection) is NOT
 * performed for bowling visits — the tag set is fixed at
 * [baseline, bowling, fnb_service]. Racing surveys (PR-GS4) will collect
 * Square orders to derive cross-sell tags.
 */
export async function enqueueBowlingSurvey(
  input: EnqueueBowlingSurveyInput,
): Promise<EnqueueOutcome> {
  if (!input.phone) {
    return { status: "skipped", reason: "no_phone" };
  }
  if (!isDbConfigured()) {
    return { status: "skipped", reason: "no_db" };
  }

  // ── Self-heal: seed the question pool on first use ────────────────
  // The seed is idempotent (no-op when rows exist) but its absence at
  // first-fire ships an empty survey to the customer — which is what
  // happened to Eric on 2026-05-20. Run it here so the very first
  // enqueue on a fresh DB still picks real questions.
  await seedGuestSurveyQuestionsIfEmpty().catch((err) =>
    console.warn("[guest-survey] auto-seed failed (non-fatal):", err),
  );

  // ── Step 3: idempotency on (origin, origin_ref) ───────────────────
  const existing = await getGuestSurveyByOriginRef({
    origin: "bowling",
    originRef: input.reservationId,
  });
  if (existing) {
    return {
      status: "skipped",
      reason: "already_sent_for_origin_ref",
      detail: `existing survey ${existing.id}`,
    };
  }

  // ── Step 4: resolve Square customer ───────────────────────────────
  const { firstName, lastName } = splitGuestName(input.guestName ?? "");
  let audience;
  try {
    audience = await resolveAudienceMember({
      phone: input.phone,
      firstName,
      lastName,
      email: input.guestEmail,
    });
  } catch (err) {
    return {
      status: "skipped",
      reason: "audience_resolve_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const { squareCustomerId, phoneE164 } = audience;

  // ── Step 5: marketing consent (implicit-via-transactional for bowling)
  // The customer is on a bowling reservation we already confirmed via
  // SMS (the booking flow opt-in covers transactional contact), so a
  // single post-visit survey is treated as covered by that consent.
  // Only an EXPLICIT STOP (consent row with opted_in=false) blocks.
  // Cold campaigns that aren't gated by a prior transactional touch
  // must keep using hasMarketingOptIn for full default-deny.
  const consent = await getConsent(phoneE164);
  if (consent && consent.optedIn === false) {
    await recordSkipTouch({
      customerId: squareCustomerId,
      phoneE164,
      reservationId: input.reservationId,
      reason: "no_marketing_consent",
    });
    return { status: "skipped", reason: "no_marketing_consent" };
  }

  // ── Step 6: 30-day frequency cap ─────────────────────────────────
  const cap = await canSend({
    customerId: squareCustomerId,
    campaign: "guest_survey",
    windowDays: 30,
  });
  if (!cap.allowed) {
    await recordSkipTouch({
      customerId: squareCustomerId,
      phoneE164,
      reservationId: input.reservationId,
      reason: "within_frequency_window",
      meta: { lastSentAt: cap.lastSentAt?.toISOString() },
    });
    return { status: "skipped", reason: "within_frequency_window" };
  }

  // ── Step 7: pick tags + questions ─────────────────────────────────
  const tags = pickTags({ origin: "bowling" });
  const questions = await pickQuestions(tags);

  // ── Step 8: insert row + shorten URL ──────────────────────────────
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const context = {
    origin: "bowling" as const,
    centerCode: input.centerCode,
    visitDate: input.visitDate,
    tags,
  };

  const survey = await insertGuestSurvey({
    token,
    squareCustomerId,
    phoneE164,
    origin: "bowling",
    originRef: input.reservationId,
    centerCode: input.centerCode,
    visitDate: input.visitDate,
    context,
    questions,
    expiresAt,
  });

  // ── Step 9-10: short-link + SMS, with row rollback on failure ────
  let shortCode: string;
  try {
    shortCode = await shortenUrl(`/survey/${token}`);
  } catch (err) {
    await deleteGuestSurveyByToken(token).catch(() => {});
    return {
      status: "skipped",
      reason: "audience_resolve_failed", // closest existing reason; ops note in detail
      detail: `short link failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const body = renderBowlingSurveyInvite({ code: shortCode });
  const centerSmsFrom = CENTER_META[input.centerCode]?.smsFrom;

  let smsOk = false;
  let smsStatus: number | null = null;
  let smsError: string | undefined;
  let smsProvider: "vox" | "twilio" = "vox";
  let smsFailedOver = false;
  let providerMessageId: string | undefined;

  try {
    const result = await voxSend(phoneE164, body, {
      fromOverride: centerSmsFrom,
    });
    smsOk = result.ok;
    smsStatus = result.status ?? null;
    smsError = result.error;
    smsProvider = result.provider ?? "vox";
    smsFailedOver = result.failedOver ?? false;
    providerMessageId = result.voxId ?? result.twilioSid;
  } catch (err) {
    smsError = err instanceof Error ? err.message : String(err);
  }

  if (!smsOk) {
    await deleteGuestSurveyByToken(token).catch((delErr) =>
      console.warn(`[guest-survey] rollback delete failed for ${token} (non-fatal):`, delErr),
    );
    await recordSkipTouch({
      customerId: squareCustomerId,
      phoneE164,
      reservationId: input.reservationId,
      reason: "audience_resolve_failed", // again closest reason; detail captures the truth
      meta: { smsError, smsStatus },
    });
    return {
      status: "skipped",
      reason: "audience_resolve_failed",
      detail: `sms send failed: ${smsError ?? "unknown"}`,
    };
  }

  // ── Step 11: log SMS + record sent touch ─────────────────────────
  await logSms({
    ts: new Date().toISOString(),
    phone: phoneE164,
    source: "guest-survey",
    status: smsStatus,
    ok: true,
    provider: smsProvider,
    failedOver: smsFailedOver,
    shortCode,
    body,
    providerMessageId,
  });

  await recordTouch({
    customerId: squareCustomerId,
    phoneE164,
    campaign: "guest_survey",
    event: "sent",
    refId: token,
    meta: {
      origin: "bowling",
      centerCode: input.centerCode,
      visitDate: input.visitDate,
      tags,
      shortCode,
      provider: smsProvider,
      failedOver: smsFailedOver,
    },
  });

  return { status: "sent", surveyId: survey.id, token, tags };
}

// ─────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────

async function recordSkipTouch(args: {
  customerId: string;
  phoneE164: string;
  reservationId: string;
  reason: SkipReason;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await recordTouch({
      customerId: args.customerId,
      phoneE164: args.phoneE164,
      campaign: "guest_survey",
      event: "skipped",
      refId: args.reservationId,
      meta: { reason: args.reason, ...args.meta },
    });
  } catch (err) {
    // Skipped touches are ops telemetry — failure should never break the
    // caller. Log and move on.
    console.warn("[guest-survey] recordSkipTouch failed (non-fatal):", err);
  }
}
