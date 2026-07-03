/**
 * Cancellation notifications — email (SendGrid) + SMS (Vox with retry/quota),
 * sent in-process by the cascade after its commit point. Two variants:
 *
 *   refund       — "your booking is cancelled, $X is on its way back"
 *   store_credit — "your booking is cancelled, here is your $X gift card"
 *
 * The GAN is ALREADY persisted to Neon before this module runs, so a delivery
 * failure loses nothing — the admin board shows the card either way and staff
 * can resend. Failures are logged loudly and returned as {email,sms} flags for
 * the UI chips; they never fail the cancel.
 *
 * Copy rules: "bowling center" never "alley"; no emoji; GSM-7-friendly SMS;
 * gift-card URLs use the gftc:-stripped hex id (survey send-sms pattern).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { markCancelNotified, type BowlingReservation } from "@/lib/bowling-db";
import { eventStartEt, formatGan, legLabel } from "./guards";
import type { CancelOutcome } from "./types";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";

// ── Brand / center metadata (accepts slugs AND Square location ids) ─────────

interface BrandMeta {
  brand: "HeadPinz" | "FastTrax";
  fromName: string;
  centerName: string;
  phone: string;
  smsFrom: string;
}

function brandFor(r: BowlingReservation): BrandMeta {
  const isNaples = r.centerCode === "naples" || r.centerCode === "PPTR5G2N0QXF7";
  if (r.productKind === "race") {
    return {
      brand: "FastTrax",
      fromName: "FastTrax Entertainment",
      centerName: "FastTrax Fort Myers",
      phone: "(239) 275-2226",
      smsFrom: "+12394819666",
    };
  }
  if (isNaples) {
    return {
      brand: "HeadPinz",
      fromName: "HeadPinz Entertainment",
      centerName: "HeadPinz Naples",
      phone: "(239) 455-3755",
      smsFrom: "+12394553755",
    };
  }
  return {
    brand: "HeadPinz",
    fromName: "HeadPinz Entertainment",
    centerName: "HeadPinz Fort Myers",
    phone: "(239) 302-2155",
    smsFrom: "+12393022155",
  };
}

/** Where "rebook" points, by what was cancelled. */
export function rebookUrl(legs: BowlingReservation[]): string {
  const kinds = new Set(legs.map((l) => l.productKind));
  if (kinds.has("race")) return "https://fasttraxent.com/book";
  if (kinds.has("attraction")) {
    const md = legs.find((l) => l.productKind === "attraction")?.bookingMetadata as
      | { attractions?: Array<{ slug?: unknown }> }
      | undefined;
    const slug = Array.isArray(md?.attractions)
      ? md.attractions.find((a) => typeof a?.slug === "string")?.slug
      : undefined;
    if (typeof slug === "string" && slug) return `https://headpinz.com/book/${slug}`;
    return "https://headpinz.com/book";
  }
  if (kinds.has("kbf")) return "https://headpinz.com/hp/book/kids-bowl-free";
  return "https://headpinz.com/hp/book/bowling";
}

// ── Template plumbing (bowling-confirmation ^[Token]$ convention) ───────────

const templateCache: Record<string, string> = {};
function loadTemplate(file: string): string {
  if (!templateCache[file]) {
    templateCache[file] = readFileSync(join(process.cwd(), "emails", file), "utf-8");
  }
  return templateCache[file];
}

function fillTemplate(html: string, tokens: Record<string, string>): string {
  let out = html;
  for (const [k, v] of Object.entries(tokens)) {
    out = out.split(`^[${k}]$`).join(v);
  }
  return out;
}

function fmtDate(naiveEtIso: string): { full: string; compact: string } {
  // naiveEtIso is an ET wall-clock string — render it verbatim as ET.
  const d = new Date(`${naiveEtIso}`);
  if (Number.isNaN(d.getTime())) return { full: naiveEtIso, compact: naiveEtIso };
  const full = d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const compact = `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
  return { full: `${full} at ${time}`, compact };
}

const D = (c: number) => `$${(c / 100).toFixed(2)}`;

// ── Senders (bowling-confirmation route patterns) ────────────────────────────

async function sendEmail(
  to: string,
  fromName: string,
  subject: string,
  html: string,
): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    console.error("[cancel/notify] no SENDGRID_API_KEY — email skipped");
    return false;
  }
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }], bcc: [{ email: "vendorcases@dassle.us" }] }],
        from: { email: FROM_EMAIL, name: fromName },
        subject,
        content: [{ type: "text/html", value: html }],
      }),
    });
    if (!res.ok) {
      console.error("[cancel/notify] SendGrid error:", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("[cancel/notify] SendGrid threw:", err instanceof Error ? err.message : err);
    return false;
  }
}

async function sendSms(
  toRaw: string,
  body: string,
  fromNumber: string,
  source: "cancel-refund" | "cancel-credit",
): Promise<boolean> {
  try {
    const digits = toRaw.replace(/\D/g, "").replace(/^1/, "");
    if (digits.length !== 10) {
      console.warn(`[cancel/notify] unusable phone ${toRaw} — SMS skipped`);
      return false;
    }
    const to = `+1${digits}`;
    const ts = new Date().toISOString();
    const { voxSend } = await import("@/lib/sms-retry");
    const { logSms } = await import("@/lib/sms-log");
    const result = await voxSend(to, body, { fromOverride: fromNumber });
    if (result.ok) {
      await logSms({
        ts,
        phone: to,
        source,
        status: result.status,
        ok: true,
        body,
        provider: result.provider,
        failedOver: result.failedOver,
        providerMessageId: result.voxId || result.twilioSid,
      }).catch(() => void 0);
      return true;
    }
    if (result.skipped || result.quotaHit) {
      const { quotaEnqueue } = await import("@/lib/sms-quota");
      await quotaEnqueue({ phone: to, body, from: fromNumber, source, queuedAt: ts });
      await logSms({
        ts,
        phone: to,
        source,
        status: result.status,
        ok: false,
        error: result.error,
        body,
        provider: result.provider,
      }).catch(() => void 0);
      console.warn(`[cancel/notify] SMS queued for quota reset: ${to}`);
      return true; // delivered on the next quota window
    }
    await logSms({
      ts,
      phone: to,
      source,
      status: result.status,
      ok: false,
      error: result.error,
      body,
      provider: result.provider,
    }).catch(() => void 0);
    console.error("[cancel/notify] Vox error:", result.status, result.error);
    return false;
  } catch (err) {
    console.error("[cancel/notify] SMS threw:", err instanceof Error ? err.message : err);
    return false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface CancelNoticeInput {
  anchor: BowlingReservation;
  legs: BowlingReservation[];
  outcome: CancelOutcome;
  amountCents: number;
  storeCredit?: { giftCardId: string; gan: string; amountCents: number };
  forceResend?: boolean;
}

export async function sendCancellationNotifications(
  input: CancelNoticeInput,
): Promise<{ email: boolean; sms: boolean }> {
  const { anchor, legs, outcome } = input;
  const contactLeg = legs.find((l) => l.guestEmail || l.guestPhone) ?? anchor;
  const meta = brandFor(legs.find((l) => l.productKind === "race") ?? anchor);
  const firstName = (contactLeg.guestName ?? "").trim().split(/\s+/)[0] || "there";
  const active = legs.filter((l) => l.status !== "cancelled").length ? legs : [anchor];
  const earliest = active.map(eventStartEt).reduce((a, b) => (a < b ? a : b));
  const when = fmtDate(earliest);
  const labels = [...new Set(legs.map(legLabel))].join(" + ");
  const rebook = rebookUrl(legs);

  // Dedupe (Redis, notif:bowling pattern) — resend via forceResend.
  try {
    const redis = (await import("@/lib/redis")).default;
    const key = `notif:cancel:${anchor.id}:${outcome}`;
    if (!input.forceResend) {
      const already = await redis.get(key);
      if (already) {
        console.log(`[cancel/notify] deduped ${key}`);
        return { email: false, sms: false };
      }
    }
    await redis.set(key, new Date().toISOString(), "EX", 60 * 60 * 24 * 30);
  } catch {
    // Redis down → send anyway (worst case a duplicate email, never a lost one).
  }

  let email = false;
  let sms = false;

  if (outcome === "store_credit" && input.storeCredit) {
    const sc = input.storeCredit;
    const hexId = sc.giftCardId.replace(/^gftc:/, "");
    const balanceUrl = `https://squareup.com/gift/balance/${hexId}`;
    const walletUrl = `https://squareup.com/apass/gc/download/personalized/${hexId}?source=egift`;
    let walletShort = walletUrl;
    let balanceShort = balanceUrl;
    try {
      const { shortenUrl } = await import("@/lib/short-url");
      const base = process.env.NEXT_PUBLIC_HEADPINZ_SITE_URL || "https://headpinz.com";
      walletShort = `${base}/s/${await shortenUrl(walletUrl)}`;
      balanceShort = `${base}/s/${await shortenUrl(balanceUrl)}`;
    } catch {
      /* fall back to full URLs */
    }

    if (contactLeg.guestEmail) {
      const html = fillTemplate(loadTemplate("cancellation-store-credit.html"), {
        FirstName: firstName,
        BookingLabel: labels,
        BookingWhen: when.full,
        CenterName: meta.centerName,
        CenterPhone: meta.phone,
        Amount: D(sc.amountCents),
        GanFormatted: formatGan(sc.gan),
        BalanceUrl: balanceUrl,
        WalletUrl: walletUrl,
        RebookUrl: rebook,
      });
      email = await sendEmail(
        contactLeg.guestEmail,
        meta.fromName,
        `Your Gift Card & Cancellation - ${meta.centerName}`,
        html,
      );
    }
    if (contactLeg.guestPhone) {
      const body =
        `${meta.brand}: Your ${when.compact} booking is cancelled. ` +
        `Gift card ${formatGan(sc.gan)} for ${D(sc.amountCents)} was emailed to you. ` +
        `Rebook: ${rebook} Wallet: ${walletShort} Balance: ${balanceShort}`;
      sms = await sendSms(contactLeg.guestPhone, body, meta.smsFrom, "cancel-credit");
    }
  } else {
    const refunded = input.amountCents > 0;
    if (contactLeg.guestEmail) {
      const html = fillTemplate(loadTemplate("cancellation-refund.html"), {
        FirstName: firstName,
        BookingLabel: labels,
        BookingWhen: when.full,
        CenterName: meta.centerName,
        CenterPhone: meta.phone,
        RefundLine: refunded
          ? `Your ${D(input.amountCents)} refund is on its way back to your card — most banks post it within 3-5 business days.`
          : `Nothing was charged for this booking, so there is nothing to refund.`,
        RebookUrl: rebook,
      });
      email = await sendEmail(
        contactLeg.guestEmail,
        meta.fromName,
        `Cancellation Confirmed - ${meta.centerName}`,
        html,
      );
    }
    if (contactLeg.guestPhone) {
      const body = refunded
        ? `${meta.brand}: Your ${when.compact} booking is cancelled. ${D(input.amountCents)} refunds to your card in 3-5 business days. Questions? ${meta.phone}`
        : `${meta.brand}: Your ${when.compact} booking is cancelled. No charges were made. Questions? ${meta.phone}`;
      sms = await sendSms(contactLeg.guestPhone, body, meta.smsFrom, "cancel-refund");
    }
  }

  if (email || sms) {
    await markCancelNotified(anchor.id).catch(() => void 0);
  }
  return { email, sms };
}
