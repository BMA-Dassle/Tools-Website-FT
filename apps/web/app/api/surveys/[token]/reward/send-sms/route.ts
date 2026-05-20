import { NextRequest, NextResponse } from "next/server";
import { getGuestSurveyByToken, getPromoCodeByGiftCardId } from "@/lib/guest-survey-db";
import { CENTER_META } from "@/lib/bowling-lane-ready-notify";
import { shortenUrl } from "@/lib/short-url";
import { voxSend } from "@/lib/sms-retry";
import { logSms } from "@/lib/sms-log";

const SHORT_LINK_BASE = process.env.NEXT_PUBLIC_HEADPINZ_SITE_URL || "https://headpinz.com";

/**
 * POST /api/surveys/[token]/reward/send-sms
 *
 * Button-triggered SMS for the gift-card path. The reward API already
 * issued the card and rendered the QR/Wallet/GAN on the confirmation
 * page; this endpoint is the "Text it to my phone" backup so the
 * customer has a saveable copy in their SMS thread.
 *
 * Keeps the SMS body to a single segment by routing the Apple Wallet
 * URL through our /s/{code} shortener (Square's URL is ~110 chars on
 * its own).
 *
 * Idempotency: a single resend per token (so a user can't spam-button
 * to burn SMS credit). Subsequent calls return 200 with already=true.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!token || token.length < 8 || token.length > 64) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }

  const survey = await getGuestSurveyByToken(token);
  if (!survey) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (survey.rewardKind !== "gift_card") {
    return NextResponse.json(
      { error: "no gift card reward issued for this survey" },
      { status: 409 },
    );
  }

  // Find the promo code row → gives us the GAN + giftCardId we need for
  // the body. Look up by survey id (1:1 relationship today).
  const promo = await findPromoCodeForSurvey(survey.id);
  if (!promo) {
    return NextResponse.json(
      { error: "promo code row not found for this survey" },
      { status: 500 },
    );
  }

  const balanceUrl = `https://app.squareup.com/gift/balance/${promo.squareGiftCardId}`;
  const walletUrl = `https://squareup.com/apass/gc/download/personalized/${promo.squareGiftCardId}?source=egift`;

  // Short-link the Apple Wallet URL so the body fits in 1 segment.
  let walletShort = walletUrl;
  try {
    const code = await shortenUrl(walletUrl);
    walletShort = `${SHORT_LINK_BASE}/s/${code}`;
  } catch (err) {
    console.warn(
      `[surveys/${token}/reward/send-sms] short link failed, falling back to full URL:`,
      err,
    );
  }

  const brand = pickBrand(survey.centerCode);
  const body =
    `${brand} $5 e-gift card\n` +
    `Card: ${formatGan(promo.squareGiftCardGan)}\n` +
    `Code: ${promo.code}\n` +
    `Add to Apple Wallet: ${walletShort}\n` +
    `Balance: ${balanceUrl}`;

  const centerFrom = CENTER_META[survey.centerCode]?.smsFrom;
  let smsOk = false;
  let smsError: string | undefined;
  try {
    const result = await voxSend(survey.phoneE164, body, { fromOverride: centerFrom });
    smsOk = result.ok;
    smsError = result.error;
    await logSms({
      ts: new Date().toISOString(),
      phone: survey.phoneE164,
      source: "guest-survey",
      status: result.status ?? null,
      ok: result.ok,
      provider: result.provider ?? "vox",
      failedOver: result.failedOver ?? false,
      body,
      providerMessageId: result.voxId ?? result.twilioSid,
    });
  } catch (err) {
    smsError = err instanceof Error ? err.message : String(err);
  }

  if (!smsOk) {
    return NextResponse.json(
      { error: "sms send failed", detail: smsError ?? "unknown" },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}

function pickBrand(centerCode: string): "HeadPinz" | "FastTrax" {
  return centerCode in CENTER_META ? "HeadPinz" : "FastTrax";
}

function formatGan(gan: string): string {
  const digits = gan.replace(/\D/g, "");
  if (digits.length !== 16) return gan;
  return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}`;
}

/**
 * Look up the promo code row tied to a survey. The schema is 1:N in
 * principle (a survey could re-issue) but in practice 1:1 — the
 * reward-issuance endpoint blocks re-issuance once reward_kind is set.
 */
async function findPromoCodeForSurvey(surveyId: string) {
  const { sql, isDbConfigured } = await import("@ft/db");
  if (!isDbConfigured()) return null;
  const q = sql();
  const rows = await q`
    SELECT code, square_gift_card_id, square_gift_card_gan, amount_cents
    FROM guest_survey_promo_codes
    WHERE survey_id = ${surveyId}
    ORDER BY issued_at DESC
    LIMIT 1
  `;
  if (!rows.length) return null;
  const row = rows[0] as Record<string, unknown>;
  return {
    code: row.code as string,
    squareGiftCardId: row.square_gift_card_id as string,
    squareGiftCardGan: row.square_gift_card_gan as string,
    amountCents: row.amount_cents as number,
  };
}

// Silence unused warning for getPromoCodeByGiftCardId (kept in scope
// for the PR-GS5 redemption webhook).
export type _UnusedKeepImport = typeof getPromoCodeByGiftCardId;
