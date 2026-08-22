import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import QRCode from "qrcode";
import redis from "@/lib/redis";
import {
  confirmationShortUrl,
  signedConfirmationUrl,
  verifyBillSignature as verifyBillSignatureShared,
} from "@/lib/booking-confirmation-link";
import { getComboSpecial, isVipComboBooking } from "~/features/combos/combo-specials";
import {
  buildVipEmailFields,
  buildVipSmsBody,
  buildVipVoucherSectionHtml,
  vipEmailSubject,
} from "~/features/combos/vip-welcome";
import { getVoucherByBillId } from "~/features/game-cards/data/vouchers-db";
import { groupVoucherItems, voucherGroupLabel } from "~/features/game-cards/vouchers/display";
import { qrAttachment, voucherRedeemUrl } from "~/features/game-cards/service/voucher-mail";
import { walletBadgesEmailHtml } from "~/features/game-cards/wallet/badges";
import { formatVoucherCode } from "~/features/game-cards/vouchers/codes";
import { a2pSender } from "~/features/sms/sender";

// Re-export so any existing importer of this route's signature verifier keeps
// working after the helpers moved to lib/booking-confirmation-link.
export const verifyBillSignature = verifyBillSignatureShared;

// ── Config ──────────────────────────────────────────────────────────────────

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";
const FROM_NAME = process.env.SENDGRID_FROM_NAME || "FastTrax Entertainment";

/** Standing audit copy on EVERY confirmation — a shared mailbox, not a person. */
const AUDIT_BCC = "vendorcases@dassle.us";

/**
 * VIP-combo watcher (owner 2026-08-03: "so he sees VIP confirmations as they
 * go out"). SCOPED TO VIP BOOKINGS ONLY — it used to sit unconditionally in
 * sendEmail's personalization, which put a copy of every confirmation this
 * route sends (every race, every bowling lane, every kiosk walk-up) in his
 * inbox instead of the handful of VIP ones he asked for. A person on a BCC
 * belongs at the call site that knows WHY, never in the transport helper.
 */
const VIP_WATCH_BCC = "tyler@headpinz.com";

const VOX_API_KEY = process.env.VOX_API_KEY || "";
// One A2P sender for every brand. Each template already opens with
// the brand name, which is also what TCR wants in HELP/opt-out
// replies, so a shared DID stays unambiguous to the guest.
const VOX_FROM_FASTTRAX = a2pSender();
const VOX_FROM_HEADPINZ = a2pSender();
const VOX_FROM_NAPLES = a2pSender();

// ── Email templates (loaded once, cached per name) ──────────────────────────

type EmailTemplateName = "booking-confirmation-waiver" | "vip-welcome";

const emailTemplates = new Map<EmailTemplateName, string>();

function getEmailTemplate(name: EmailTemplateName = "booking-confirmation-waiver"): string {
  let template = emailTemplates.get(name);
  if (!template) {
    const templatePath = join(process.cwd(), "emails", `${name}.html`);
    template = readFileSync(templatePath, "utf-8");
    emailTemplates.set(name, template);
  }
  return template;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1/, "");
}

async function sendEmail(
  to: string,
  subject: string,
  html: string,
  fromName?: string,
  /** Inline (cid:) attachments — the voucher QR. Gmail/Outlook strip data-URI
   *  images, so a cid attachment is the only <img> form that renders there. */
  attachments?: Array<{ content: string; filename: string; type: string; contentId: string }>,
  /** Per-booking watchers, on top of the standing audit copy. Callers decide —
   *  this helper has no idea what kind of booking it is sending for. */
  extraBcc: string[] = [],
): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    console.error("[booking-confirmation] No SENDGRID_API_KEY");
    return false;
  }
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [
        {
          to: [{ email: to }],
          bcc: [...new Set([AUDIT_BCC, ...extraBcc])].map((email) => ({ email })),
        },
      ],
      from: { email: FROM_EMAIL, name: fromName || FROM_NAME },
      subject,
      content: [{ type: "text/html", value: html }],
      ...(attachments && attachments.length > 0
        ? {
            attachments: attachments.map((a) => ({
              content: a.content,
              filename: a.filename,
              type: a.type,
              disposition: "inline",
              content_id: a.contentId,
            })),
          }
        : {}),
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("[booking-confirmation] SendGrid error:", res.status, err);
    return false;
  }
  return true;
}

/**
 * Send via the centralized voxSend helper — picks up quota detection
 * automatically. If we're in cooldown OR Vox returns a quota error,
 * we enqueue onto the quota queue so the every-minute sweep delivers
 * it as soon as the daily limit resets.
 *
 * Returns true for "delivered or queued for guaranteed delivery" and
 * false only for hard failures (bad phone, missing config).
 */
async function sendSms(to: string, body: string, fromNumber?: string): Promise<boolean> {
  if (!VOX_API_KEY) {
    console.error("[booking-confirmation] Missing VOX_API_KEY");
    return false;
  }
  const toFormatted = to.length === 10 ? `+1${to}` : `+${to}`;
  const from = fromNumber || VOX_FROM_FASTTRAX;
  const ts = new Date().toISOString();

  // Lazy-load to avoid pulling Redis into the route's import chain
  // until we actually need to send.
  const { voxSend } = await import("@/lib/sms-retry");
  const { logSms } = await import("@/lib/sms-log");
  const result = await voxSend(toFormatted, body, { fromOverride: from });

  if (result.ok) {
    // Log the successful booking-confirm send so the sales admin can
    // count daily SMS volume by source. Other paths (pre-race-cron,
    // checkin-cron, video-match, admin-resend) already log; this was
    // the gap — booking-confirmation was firing untracked.
    await logSms({
      ts,
      phone: toFormatted,
      source: "booking-confirm",
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
    await quotaEnqueue({
      phone: toFormatted,
      body,
      from,
      source: "booking-confirm",
      queuedAt: new Date().toISOString(),
    });
    // Log the queued attempt — quota-queue worker will log the eventual
    // delivery, but tracking the QUEUED state at attempt time means
    // dashboards reflect "we tried to send a confirmation today" even
    // when the actual delivery slips into the next quota window.
    await logSms({
      ts,
      phone: toFormatted,
      source: "booking-confirm",
      status: result.status,
      ok: false,
      error: result.error,
      body,
      provider: result.provider,
    }).catch(() => void 0);
    console.warn(
      "[booking-confirmation] queued SMS for next quota reset:",
      toFormatted,
      result.error,
    );
    // Treat as "we'll get it sent eventually" — not a customer-facing
    // failure, since email already delivered.
    return true;
  }

  // Hard failure — bad phone, missing config, etc. Still log it so the
  // dashboard surfaces the failure rate per source.
  await logSms({
    ts,
    phone: toFormatted,
    source: "booking-confirm",
    status: result.status,
    ok: false,
    error: result.error,
    body,
    provider: result.provider,
  }).catch(() => void 0);
  console.error("[booking-confirmation] Voxtelesys error:", result.status, result.error);
  return false;
}

// ── POST handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      email,
      phone,
      firstName,
      smsOptIn,
      reservationNumber,
      reservationName,
      reservationDate,
      reservationTime,
      reservationSchedule,
      waiverUrl,
      reservationCode,
      billId,
      isNewRacer,
      povCodes,
      productNames,
      scheduledItems,
      brand,
      location,
      expressLane,
      rookiePack,
      packageId,
      confirmationV2,
      comboSpecialId,
      comboReorder,
      kioskMode,
    } = body;

    // Who, besides the audit mailbox, is copied on THIS booking's confirmation.
    // Same predicate that decides the "Confirmation - VIP" BMI state below, so
    // a booking treated as VIP there is exactly the one that copies the VIP
    // watcher here. A plain race or lane booking copies nobody.
    const extraBcc = isVipComboBooking(comboSpecialId) ? [VIP_WATCH_BCC] : [];
    const codes: string[] = Array.isArray(povCodes) ? povCodes : [];
    // Legacy Rookie Pack boolean from older callers. Kept only to resolve a
    // package id (below) and to tag the sales log — it no longer implies any
    // included freebie of its own.
    const isRookiePack = rookiePack === true;
    // Generic package ID — "rookie-pack", "ultimate-qualifier-mega", etc.
    // Falls back to "rookie-pack" when the legacy rookiePack boolean is set
    // (for callers that haven't been updated to send packageId yet).
    const resolvedPackageId: string | undefined =
      typeof packageId === "string" && packageId
        ? packageId
        : isRookiePack
          ? "rookie-pack"
          : undefined;
    const products: string[] = Array.isArray(productNames) ? productNames : [];
    // scheduledItems is forwarded from the confirmation page. Older
    // callers send `{name, start}` only; newer ones include `persons`
    // and `quantity` so the participantCount math below can use them.
    // Both fields default to undefined-ish so legacy callers still work.
    const scheduled: { name: string; start: string; persons?: number; quantity?: number }[] =
      Array.isArray(scheduledItems) ? scheduledItems : [];
    const isExpressLane = !!expressLane;

    if (!email || !reservationNumber) {
      return NextResponse.json({ error: "email and reservationNumber required" }, { status: 400 });
    }

    // Dedup: check if confirmation was already sent for this bill
    const notifKey = `notif:${billId || reservationNumber}`;
    const alreadySent = await redis.get(notifKey);
    if (alreadySent) {
      console.log("[booking-confirmation] already sent for", billId || reservationNumber);
      return NextResponse.json({ success: true, duplicate: true });
    }

    // Sales-log capture — every confirmed reservation gets one entry
    // for the /organizer/{token}/sales dashboard. Fired once per bill,
    // gated by the same notif-dedup so a refresh of the confirmation
    // page doesn't double-log. Best-effort: errors here never break
    // confirmation send.
    //
    // Bookings shapes vary widely (racing, attractions, race-pack,
    // mixed) so we derive the booking type + flags by scanning the
    // product name list rather than asking the page to telegraph
    // every detail. Names from BMI are stable enough for this.
    try {
      const { logSale } = await import("@/lib/sales-log");
      const allNames = [...products, ...scheduled.map((s) => s.name)];
      const lower = (n: string) => (n || "").toLowerCase();
      const hasRacing = allNames.some(
        (n) =>
          lower(n).includes("race") ||
          lower(n).includes("kart") ||
          /(blue|red|mega).*track/i.test(n),
      );
      const hasRacePack = allNames.some((n) => /race\s*pack|pack/i.test(n));
      const hasAttraction = allNames.some((n) => {
        const x = lower(n);
        return (
          x.includes("gel") ||
          x.includes("laser") ||
          x.includes("shuffly") ||
          x.includes("bowl") ||
          x.includes("duck pin")
        );
      });
      let bookingType: "racing" | "racing-pack" | "attractions" | "mixed" | "other" = "other";
      if (hasRacing && hasAttraction) bookingType = "mixed";
      else if (hasRacePack) bookingType = "racing-pack";
      else if (hasRacing) bookingType = "racing";
      else if (hasAttraction) bookingType = "attractions";

      const raceNames = allNames.filter((n) => {
        const x = lower(n);
        return (
          x.includes("race") ||
          x.includes("kart") ||
          /(blue|red|mega).*track/i.test(n) ||
          /pack/i.test(n)
        );
      });
      const addOnNames = allNames.filter((n) => {
        const x = lower(n);
        return (
          x.includes("gel") ||
          x.includes("laser") ||
          x.includes("shuffly") ||
          x.includes("bowl") ||
          x.includes("duck pin")
        );
      });
      const hasLicense = allNames.some((n) => lower(n).includes("license"));
      const hasPov = allNames.some((n) => /pov/i.test(n)) || codes.length > 0;

      // Participant count — MAX of `persons` (or `quantity` fallback)
      // across distinct karting scheduled lines. Not the COUNT of lines.
      //
      // Why max: a single-racer Ultimate Qualifier creates 2 karting
      // lines (Starter + Intermediate), each with persons=1. Counting
      // lines reported it as 2 racers — inflated every UQ booking.
      // A 4-racer UQ creates 2 lines with persons=4 each; max=4 is the
      // correct racer count. Same shape for race packs (3 lines, same
      // persons) and individual races.
      //
      // Edge case: split-track bookings (2 racers on Red + 2 on Blue at
      // the same time) create 2 lines, persons=2 each → max=2,
      // undercounting the true 4. Rare and the BMI bill's top-level
      // `Persons` field would be the proper signal — not exposed in
      // bill/overview today. Leaving the trade-off for now.
      const kartingScheduled = scheduled.filter((s) => {
        const x = lower(s.name);
        return x.includes("race") || x.includes("kart") || /(blue|red|mega).*track/i.test(s.name);
      });
      const participantCount = (() => {
        if (kartingScheduled.length === 0) {
          return raceNames.length || undefined;
        }
        const counts = kartingScheduled
          .map((s) => Number(s.persons ?? s.quantity ?? 0))
          .filter((n) => n > 0);
        if (counts.length === 0) {
          // Legacy callers didn't forward persons/quantity — fall back to
          // the old line-count behavior so we don't suddenly report 0.
          return kartingScheduled.length || raceNames.length || undefined;
        }
        return Math.max(...counts);
      })();

      await logSale({
        ts: new Date().toISOString(),
        billId,
        reservationNumber,
        brand: brand === "headpinz" ? "headpinz" : "fasttrax",
        location: location === "naples" ? "naples" : "fortmyers",
        bookingType,
        participantCount,
        isNewRacer: !!isNewRacer,
        rookiePack: isRookiePack,
        packageId: resolvedPackageId,
        povPurchased: hasPov,
        povQty: codes.length || (hasPov ? participantCount : 0) || undefined,
        licensePurchased: hasLicense || undefined,
        expressLane: isExpressLane,
        raceProductNames: raceNames.length > 0 ? raceNames : undefined,
        addOnNames: addOnNames.length > 0 ? addOnNames : undefined,
        email,
        phone,
      });
    } catch (err) {
      console.error("[booking-confirmation] sales-log write failed:", err);
    }

    // ── Express Lane → BMI "Confirmation Kiosk" state (owner 2026-07-21) ──
    // Express-lane web bookings skip Guest Services, so staff work them from
    // the SAME BMI state the kiosk flow lands in (per-location custom ids —
    // FM 55397028 / Naples 8489113). Fires once per bill: this sits behind the
    // notif dedup above. Kiosk bookings are excluded — kiosk-post-reserve
    // already stamps the state on that rail. Best-effort: a vendor hiccup
    // never blocks the confirmation send.
    //
    // A VIP combo booked express lands in "Confirmation - VIP" instead (owner
    // 2026-08-02: VIP wins over kiosk). unified-reserve stamps the same id on
    // this booking's own rail; both writes are read-then-compare idempotent, so
    // whichever lands second reports "already" — belt-and-braces, not a race.
    // Note the knock-on: `revertExpressKioskState` only reverts FROM the kiosk
    // id, so a demoted express VIP is correctly left alone — it never made the
    // "waivers are done" claim in the state column to begin with.
    if (isExpressLane && !kioskMode && billId) {
      const centerCode = location === "naples" ? "naples" : "fort-myers";
      if (isVipComboBooking(comboSpecialId)) {
        const { stampVipStateIfCombo } = await import("~/features/combos/vip-state.server");
        await stampVipStateIfCombo({
          comboSpecialId: String(comboSpecialId),
          centerCode,
          billId: String(billId),
          tag: "booking-confirmation",
          label: "Confirmation - VIP (express lane)",
        });
      } else {
        try {
          const { setProjectState, officeProjectIdFromBillId, KIOSK_CONFIRMATION_STATE_IDS } =
            await import("@/lib/bmi-office-actions");
          await setProjectState({
            centerCode,
            projectId: officeProjectIdFromBillId(String(billId)),
            stateId: KIOSK_CONFIRMATION_STATE_IDS[centerCode],
            label: "Kiosk confirmation (express lane)",
          });
        } catch (err) {
          console.error("[booking-confirmation] express-lane kiosk state failed (non-fatal):", err);
        }
      }
    }

    const results: { email: boolean; sms: boolean | null } = { email: false, sms: null };

    // ── KIOSK lightweight confirmation (owner 2026-07-19) ──────────────
    // A kiosk guest is in-center; they don't need the QR or the desk check-in
    // steps now — those arrive later with the e-ticket. Send a short "you're
    // booked, e-ticket coming" note. Reuses the sender + dedup + sales-log above.
    // Kiosk racing is always FastTrax. Early-return so none of the web template
    // (QR, Guest-Services instructions, express-lane) runs. Web path is untouched.
    if (kioskMode) {
      const when =
        (typeof reservationTime === "string" && reservationTime) ||
        // Kiosk heat starts are NAIVE center-local wall-clock ISO strings
        // ("2026-07-19T16:00:00" = 4 PM ET). Parse as UTC and format as UTC so
        // the wall-clock renders as written — formatting in America/New_York
        // shifted every time 4h early (a 4:00 PM race emailed as "12:00 PM").
        (scheduled[0]?.start
          ? new Date(`${String(scheduled[0].start).replace(/Z?$/, "")}Z`).toLocaleString("en-US", {
              timeZone: "UTC",
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })
          : "");
      const racerCount = scheduled.reduce((n, s) => n + (s.persons ?? s.quantity ?? 1), 0) || 1;
      const who = racerCount === 1 ? "1 racer" : `${racerCount} racers`;
      const first = firstName || "Racer";
      const subject = "You're booked at FastTrax!";
      // Web parity: SMS never inlines the codes (single-segment budget) — it
      // points at the email, which carries the full codes block below. Only
      // claim "in your confirmation email" when an email address exists to
      // receive one (kiosk contacts always have one, but never misdirect).
      // ASCII ONLY. The prior form carried a middot and an em dash, and a
      // SINGLE non-ASCII character forces UCS-2: 70 chars per segment instead
      // of 160. That made a 214-char confirmation FOUR billed segments, on 60
      // of 88 sends in one measured day. Same information, GSM-7 safe, and the
      // sign-off dropped (owner 2026-08-20) since it bought nothing.
      const smsBody = `FastTrax: you're booked!${when ? ` ${when} -` : ""} ${who}. Your e-ticket with check-in details will text you shortly - nothing to print.${codes.length > 0 && email ? " POV video codes are in your confirmation email." : ""}`;
      // POV camera codes — kiosk counterpart of the web template's
      // ^SoldVouchersList()$ block (this branch's email is inline HTML, so the
      // placeholder never runs here). Renders only when codes were claimed.
      // Codes come from the organizer-imported pool ([A-Z0-9]) — strip any HTML
      // metachars anyway so a bad import can never break the email markup.
      const cleanCode = (c: string) => c.replace(/[<>&"']/g, "");
      const povHtml =
        codes.length > 0
          ? `<tr><td style="padding:0 32px 8px 32px;">
          <table role="presentation" width="100%" style="background:#1a0f2e;border:1px solid #6B21A8;border-radius:12px;">
            <tr><td style="padding:16px 20px;">
              <p style="margin:0 0 8px;color:#fff;font-size:15px;font-weight:bold;">Your ViewPoint POV Camera Codes:</p>
              ${codes.map((c, i) => `<p style="font-family:monospace;font-size:18px;font-weight:bold;color:#c084fc;margin:4px 0;">Code ${i + 1}: ${cleanCode(c)}</p>`).join("")}
              <p style="color:#f0b341;font-size:12px;line-height:1.6;margin:12px 0 0 0;">
                After your race, be sure to collect your POV camera slip — without it you can't get your video.
                Scan the QR code on the slip and enter the codes above to redeem it. Videos take 15-30 minutes to upload.
              </p>
            </td></tr>
          </table>
        </td></tr>`
          : "";
      // V2 combo voucher — kiosk sales never reach the vip-welcome template
      // (this branch early-returns), so the voucher block renders inline here.
      // Resolved SERVER-SIDE from the registry (vouchers.bill_id, stamped at
      // reserve); a client-posted code is never trusted. Best-effort.
      let kioskVoucherHtml = "";
      const kioskAttachments: Array<{
        content: string;
        filename: string;
        type: string;
        contentId: string;
      }> = [];
      if (typeof comboSpecialId === "string" && comboSpecialId && billId) {
        try {
          const v = await getVoucherByBillId(String(billId));
          if (v && !v.voidedAt) {
            const qr = await qrAttachment(v.code);
            kioskAttachments.push(qr.attachment);
            // Wallet badges, PANELLED. This card is #231a05 on #000418, and
            // Apple's badge is a black fill with a #A6A6A6 hairline — it
            // disappears without a light plate behind it. Same reason /v wraps
            // them; see wallet/badges.ts. Origin comes FROM the redeem URL so
            // the images can never load from a different host than the link.
            const redeemUrl = voucherRedeemUrl(v.code);
            const walletHtml = walletBadgesEmailHtml({
              redeemUrl,
              origin: new URL(redeemUrl).origin,
            });
            const expiry = v.expiresAt
              ? new Date(v.expiresAt).toLocaleDateString("en-US", {
                  timeZone: "America/New_York",
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })
              : null;
            kioskVoucherHtml = `<tr><td style="padding:0 32px 8px 32px;">
          <table role="presentation" width="100%" style="background:#231a05;border:1px solid #B8860B;border-radius:12px;">
            <tr><td style="padding:16px 20px;">
              <p style="margin:0 0 8px;color:#f0b341;font-size:15px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">Your VIP Voucher</p>
              <p style="font-family:monospace;font-size:22px;font-weight:bold;color:#fff;margin:0 0 10px;letter-spacing:2px;">${formatVoucherCode(v.code)}</p>
              <img src="cid:${qr.cid}" width="150" height="150" alt="Scan this voucher at any kiosk" style="display:block;border:1px solid #B8860B;border-radius:8px;margin:0 0 10px;">
              <p style="margin:0 0 4px;color:#8d7a4d;font-size:12px;">Keep it on your phone:</p>
              <div style="margin:0 0 12px;">${walletHtml}</div>
              ${groupVoucherItems(v.items.map((item, index) => ({ item, index, spent: false })))
                .map(
                  (g) =>
                    `<p style="margin:2px 0;color:#e8d9b0;font-size:13px;">&#10003;&nbsp;&nbsp;${voucherGroupLabel(g).replace(/×/g, "&times;")}</p>`,
                )
                .join("")}
              <p style="color:#8d7a4d;font-size:12px;line-height:1.6;margin:10px 0 0 0;">
                Scan the QR at any kiosk or open ${voucherRedeemUrl(v.code)} —
                ${expiry ? `valid through ${expiry} (1 year from your race date), ` : ""}not transferable. Attractions redeem when available.
              </p>
            </td></tr>
          </table>
        </td></tr>`;
          }
        } catch (err) {
          console.error("[booking-confirmation] kiosk voucher lookup failed (non-fatal):", err);
        }
      }
      const emailHtml = `<!doctype html><html><body style="margin:0;background:#000418;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000418;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#0d1a36;border-radius:16px;overflow:hidden;">
        <tr><td style="background:linear-gradient(90deg,#00E2E5,#3b82f6);height:6px;"></td></tr>
        <tr><td style="padding:32px 32px 8px 32px;color:#fff;font-size:26px;font-weight:800;font-style:italic;">You're booked!</td></tr>
        <tr><td style="padding:0 32px;color:#b7c3da;font-size:15px;line-height:1.5;">
          Thanks ${first} — your FastTrax racing is confirmed.
        </td></tr>
        <tr><td style="padding:16px 32px;">
          <table role="presentation" width="100%" style="background:#0a1430;border-radius:12px;">
            <tr><td style="padding:16px 20px;color:#fff;font-size:16px;font-weight:700;">${when || "Today"} · ${who}</td></tr>
          </table>
        </td></tr>${povHtml}${kioskVoucherHtml}
        <tr><td style="padding:8px 32px 28px 32px;color:#b7c3da;font-size:15px;line-height:1.6;">
          Your <strong style="color:#fff;">e-ticket</strong> — with your check-in time and everything you need at the track — is on its way by text and email. Nothing to print, nothing to do at the desk. See you soon!
        </td></tr>
        <tr><td style="background:#0a1430;padding:16px 32px;color:#6b7a99;font-size:12px;">FastTrax · 14501 Global Parkway, Fort Myers</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      results.email = email
        ? await sendEmail(email, subject, emailHtml, "FastTrax", kioskAttachments, extraBcc)
        : false;
      if (smsOptIn && phone) {
        results.sms = await sendSms(normalizePhone(phone), smsBody, VOX_FROM_FASTTRAX);
      }
      try {
        await redis.set(
          notifKey,
          JSON.stringify({ kiosk: true, sentAt: new Date().toISOString() }),
          "EX",
          90 * 24 * 60 * 60,
        );
      } catch {
        /* dedup mark best-effort */
      }
      console.log(
        `[booking-confirmation] KIOSK confirmation sent for ${reservationNumber}: email=${results.email} sms=${results.sms}`,
      );
      return NextResponse.json({ success: true, kiosk: true, results });
    }

    // Determine which venue each line item checks in at. Racing
    // lives at FastTrax; gel-blasters / laser tag / shuffleboard
    // (when at HP Fort Myers) live at HeadPinz. Within HeadPinz the
    // `location` param disambiguates Naples vs Fort Myers.
    function getVenue(name: string): "headpinz" | "fasttrax" {
      const n = name.toLowerCase();
      if (n.includes("gel")) return "headpinz";
      if (n.includes("laser")) return "headpinz";
      if (n.includes("shuffly") && n.includes("hpfm")) return "headpinz";
      return "fasttrax";
    }
    const firstItem = scheduled[0]?.name || products[0] || "";
    const allVenues = new Set(
      scheduled.length > 0
        ? scheduled.map((s: { name: string }) => getVenue(s.name))
        : products.map(getVenue),
    );
    const hasBoth = allVenues.has("headpinz") && allVenues.has("fasttrax");
    const firstVenue = getVenue(firstItem);

    // ── Venue address mapping ──────────────────────────────────────
    //
    // Honor `location` (passed by the booking flow) when picking the
    // HP address. Without this, HeadPinz Naples bookings used to fall
    // back to "14513 Global Parkway, Fort Myers" because the route
    // only had a product-name signal.
    const isNaples = location === "naples";
    const HP_ADDRESS = isNaples ? "8525 Radio Lane, Naples" : "14513 Global Parkway, Fort Myers";
    const HP_VENUE_NAME = isNaples ? "HeadPinz Naples" : "HeadPinz";
    const FT_ADDRESS = "14501 Global Parkway, Fort Myers";

    // Check-in location is based on first scheduled product
    const isHeadPinz = firstVenue === "headpinz";
    const showFastTrax = firstVenue === "fasttrax";
    // Brand drives the email subject + sender name. Trust the
    // explicit `brand` param from the booking page; fall back to the
    // first venue if it wasn't provided. If the booking is at Naples
    // it's always HeadPinz (no FT location there).
    const isHeadPinzBrand = brand === "headpinz" || isNaples || (!brand && isHeadPinz);
    const brandName = isHeadPinzBrand ? "HeadPinz" : "FastTrax";

    // Crude booking-type detection — drives the racing-specific
    // footer in the SMS body. Don't include the racer's-journey
    // link on a HeadPinz Naples gel-blaster confirmation.
    const isRacingBooking = (() => {
      const all = [...products, ...scheduled.map((s: { name: string }) => s.name)];
      return all.some((n) => /race|kart|(blue|red|mega).*track/i.test(String(n)));
    })();

    // Combo-special (VIP) welcome branch — resolved once so the email
    // subject, template, and SMS body can never disagree. Any lookup or
    // template failure degrades to the exact generic path; non-combo
    // bookings only ever execute this one falsy check.
    let vipCombo =
      typeof comboSpecialId === "string" && comboSpecialId ? getComboSpecial(comboSpecialId) : null;

    // V2 combo voucher — resolved SERVER-SIDE from the registry (the reserve
    // mint stamps vouchers.bill_id); a client-posted code is never trusted.
    // Best-effort: a lookup failure just drops the section.
    let vipVoucher: Awaited<ReturnType<typeof getVoucherByBillId>> = null;
    if (vipCombo && billId) {
      try {
        const v = await getVoucherByBillId(String(billId));
        if (v && !v.voidedAt) vipVoucher = v;
      } catch (err) {
        console.error("[booking-confirmation] voucher lookup failed (non-fatal):", err);
      }
    }

    // ── Send email ────────────────────────────────────────────────────────
    try {
      let html: string;
      if (vipCombo) {
        try {
          html = getEmailTemplate("vip-welcome");
        } catch (err) {
          // A missing/unreadable VIP template must never kill a confirmation.
          // Null the combo so subject + SMS revert consistently too.
          console.error("[booking-confirmation] vip-welcome template failed, using generic:", err);
          vipCombo = null;
          html = getEmailTemplate();
        }
      } else {
        html = getEmailTemplate();
      }

      // Simple ^[Placeholder]$ replacements
      html = html
        .replace(/\^\[ReservationName\]\$/g, reservationName || firstName || "Racer")
        .replace(/\^\[ReservationNumber\]\$/g, reservationNumber)
        .replace(/\^\[ReservationDate\]\$/g, reservationDate || "")
        // A bare "Time:" over a racing booking is the whole defect: that value
        // is the KARTING check-in cut-off, not the green flag. Non-racing
        // bookings keep the neutral label.
        .replace(/\^\[ReservationTimeLabel\]\$/g, isRacingBooking ? "Karting check-in:" : "Time:")
        .replace(/\^\[ReservationTime\]\$/g, reservationTime || "")
        .replace(/\^\[ReservationSchedule\]\$/g, reservationSchedule || "");

      // VIP-only placeholders (no-ops on the generic template). The itinerary
      // reuses the page's merged, time-sorted schedule lines — real booked
      // times, "VIP Bowling" leg included — falling back to registry legs.
      if (vipCombo) {
        const vipFields = buildVipEmailFields(vipCombo, {
          reordered: comboReorder === true,
          scheduleLines: String(reservationSchedule || "").split(/<br\s*\/?>/i),
        });
        const vipFirstName = firstName || String(reservationName || "").split(" ")[0] || "Racer";
        html = html
          .replace(/\^\[ComboName\]\$/g, vipFields.comboName)
          .replace(
            / &middot; \^\[ComboDuration\]\$/g,
            vipFields.durationLabel ? ` &middot; ${vipFields.durationLabel}` : "",
          )
          .replace(/\^\[ComboTagline\]\$/g, vipFields.tagline)
          .replace(/\^\[VipFirstName\]\$/g, vipFirstName)
          .replace(/\^VipItinerary\(\)\$/g, vipFields.itineraryHtml)
          .replace(/\^VipPerks\(\)\$/g, vipFields.perksHtml);
      }

      // Generate QR code from reservation code
      let qrHtml = "";
      if (reservationCode) {
        try {
          const qrDataUrl = await QRCode.toDataURL(String(reservationCode), {
            width: 160,
            margin: 1,
            color: { dark: "#000000", light: "#ffffff" },
          });
          qrHtml = `<img src="${qrDataUrl}" width="140" height="140" alt="QR Code" style="display:block;margin:0 auto;" />`;
        } catch {
          /* skip QR if generation fails */
        }
      }

      let checkInHtml = `<tr><td style="padding: 0 40px 24px 40px; font-family: Arial, sans-serif;">
        <p class="section-label" style="margin: 0 0 14px 0; text-align: center;">Where to Check In</p>`;

      // Canonical short confirmation URL for the email button. Deterministic
      // per billId, so email, SMS, the BMI memo, and the organizer board all
      // resolve to the SAME /s/{code} (one Redis key, one click bucket).
      let emailConfirmUrl = "";
      if (billId) {
        try {
          emailConfirmUrl = await confirmationShortUrl(billId, confirmationV2 === true);
        } catch {
          /* fall back */
        }
      }

      if (isExpressLane) {
        checkInHtml += `
          <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background-color: #ECFDF5; border: 2px solid #10B981; border-radius: 6px;">
          <tr><td style="font-family: Arial, sans-serif;">
            <p style="margin: 0 0 10px 0; font-size: 18px; font-weight: bold; color: #059669;">&#9889; EXPRESS CHECK-IN</p>
            <p style="margin: 0 0 8px 0; font-size: 14px; color: #CC0000; line-height: 1.5;">
              <span style="text-decoration: line-through;">&#10060; Guest Services</span> &nbsp;&nbsp; <span style="text-decoration: line-through;">&#10060; Event Check-In</span>
            </p>
            <p style="margin: 0 0 8px 0; font-size: 18px; font-weight: 900; color: #059669; letter-spacing: 0.5px;">
              &#10148; Head straight to Karting!
            </p>
            <p style="margin: 0 0 4px 0; font-size: 14px; color: #333;">1st Floor — Arrive 5 minutes before your race time.</p>
            <p style="margin: 0 0 8px 0; font-size: 13px; color: #059669; font-weight: bold;">Have your express pass open and ready on your phone.</p>
            <p style="margin: 0; font-size: 12px; color: #888;">&#128205; ${FT_ADDRESS}</p>
            ${emailConfirmUrl ? `<p style="margin: 14px 0 0 0; text-align: center;"><a href="${emailConfirmUrl}" style="display:inline-block;padding:14px 28px;background-color:#059669;color:#ffffff;text-decoration:none;border-radius:555px;font-weight:bold;font-size:15px;letter-spacing:1px;text-transform:uppercase;">View Your Express Pass</a></p>` : ""}
          </td></tr></table>
          <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background-color: #FFF0F0; border: 2px solid #D71C1C; border-radius: 6px; margin-top: 10px;">
          <tr><td style="font-family: Arial, sans-serif;">
            <p style="margin: 0 0 4px 0; font-size: 14px; font-weight: bold; color: #D71C1C;">&#9888; Additional Attractions</p>
            <p style="margin: 0; font-size: 13px; color: #333; line-height: 1.5;">
              If you have other attractions booked (gel blasters, laser tag, shuffleboard, etc.), <strong style="color:#D71C1C;">Guest Services check-in is still required</strong> for those activities. Please arrive 30 minutes early.
            </p>
          </td></tr></table>`;
      } else if (isHeadPinz && !showFastTrax) {
        checkInHtml += `
          <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background-color: #FFF5F5; border: 1px solid #FFCDD2; border-radius: 6px;">
          <tr><td style="font-family: Arial, sans-serif;">
            <p style="margin: 0 0 4px 0; font-size: 14px; font-weight: bold; color: #C62828;">&#127923; Check In at ${HP_VENUE_NAME}</p>
            <p style="margin: 0 0 4px 0; font-size: 13px; color: #333;">Please arrive 30 minutes early. Check in at Guest Services.</p>
            <p style="margin: 0; font-size: 12px; color: #888;">&#128205; ${HP_ADDRESS}</p>
          </td></tr></table>`;
      } else if (showFastTrax && !isHeadPinz) {
        checkInHtml += `
          <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background-color: #E8F8F8; border: 1px solid #B2DFDB; border-radius: 6px;">
          <tr><td style="font-family: Arial, sans-serif;">
            <p style="margin: 0 0 4px 0; font-size: 14px; font-weight: bold; color: #00838F;">&#127937; Check In at FastTrax</p>
            <p style="margin: 0 0 4px 0; font-size: 13px; color: #333;">Please arrive 30 minutes early. Check in at Guest Services, 2nd Floor.</p>
            <p style="margin: 0; font-size: 12px; color: #888;">&#128205; ${FT_ADDRESS}</p>
          </td></tr></table>`;
      } else if (hasBoth) {
        // Both venues on the same bill (FT racing + HP attractions).
        // This combination is only possible at Fort Myers — Naples
        // doesn't have a FastTrax — so HP_ADDRESS resolves correctly
        // for the FortMyers case here.
        const firstLabel = isHeadPinz ? HP_VENUE_NAME : "FastTrax";
        const firstAddr = isHeadPinz
          ? HP_ADDRESS
          : `${FT_ADDRESS} &mdash; Guest Services, 2nd Floor`;
        const secondLabel = isHeadPinz ? "FastTrax" : HP_VENUE_NAME;
        const secondAddr = isHeadPinz
          ? `${FT_ADDRESS} &mdash; Guest Services, 2nd Floor`
          : HP_ADDRESS;
        checkInHtml += `
          <p style="font-size: 14px; color: #666; line-height: 1.6; margin: 0 0 14px 0; text-align: center;">
            Your first attraction is at <strong style="color:#1A1A1A;">${firstLabel}</strong>. Please arrive 30 minutes early.
          </p>
          <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background-color: ${isHeadPinz ? "#FFF5F5; border: 2px solid #FFCDD2" : "#E8F8F8; border: 2px solid #B2DFDB"}; border-radius: 6px; margin-bottom: 10px;">
          <tr><td style="font-family: Arial, sans-serif;">
            <p style="margin: 0 0 4px 0; font-size: 14px; font-weight: bold; color: ${isHeadPinz ? "#C62828" : "#00838F"};">&#10148; Check in here first: ${firstLabel}</p>
            <p style="margin: 0; font-size: 12px; color: #888;">&#128205; ${firstAddr}</p>
          </td></tr></table>
          <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background-color: ${isHeadPinz ? "#E8F8F8; border: 1px solid #B2DFDB" : "#FFF5F5; border: 1px solid #FFCDD2"}; border-radius: 6px;">
          <tr><td style="font-family: Arial, sans-serif;">
            <p style="margin: 0 0 4px 0; font-size: 13px; font-weight: bold; color: ${isHeadPinz ? "#00838F" : "#C62828"};">${secondLabel} (later)</p>
            <p style="margin: 0; font-size: 12px; color: #888;">&#128205; ${secondAddr}</p>
          </td></tr></table>`;
      }
      // Add "View Your Confirmation" button for all emails
      if (emailConfirmUrl && !isExpressLane) {
        checkInHtml += `
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 14px;">
          <tr><td align="center">
            <a href="${emailConfirmUrl}" style="display:inline-block;padding:12px 24px;background-color:#004AAD;color:#ffffff;text-decoration:none;border-radius:555px;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;">View Your Confirmation</a>

          </td></tr></table>`;
      }
      checkInHtml += `</td></tr>`;

      html = html.replace(/\^CheckInSection\(\)\$/g, checkInHtml);

      // Legacy placeholder cleanup (no longer used)
      if (false) {
      }

      // Waiver section — whenever the page sent a waiver URL, i.e. whenever
      // someone on the booking still needs a waiver. NOT `isNewRacer`: the page
      // keys `waiverUrl` on the live Pandora check (all-valid parties send ""),
      // so a returning racer with an expired waiver and a mixed party get the
      // section too — the old gate silenced both (owner report 2026-07-31).
      //
      // The page supplies `waiverUrl` as a canonical /waiver link (buildWaiverUrl,
      // with loc+pid when the reservation is known). `waiverLinkForSuppliedUrl`
      // upgrades that to a short ORGANIZER code — this email goes to the person who
      // booked, so they get the roster with per-person waiver status — and replaces
      // the old hardcoded fallback, which pointed every guest, Naples included, at
      // the FastTrax/HeadPinz FM tenant where a Naples waiver is not valid.
      const { waiverLinkForSuppliedUrl } = await import("@/lib/waiver-link-send");
      const waiverLink = waiverUrl ? await waiverLinkForSuppliedUrl(waiverUrl, "organizer") : "";
      const waiverSectionHtml = waiverLink
        ? `
<tr>
<td style="padding: 0 40px 24px 40px; font-family: Arial, sans-serif;">
<table width="100%" cellpadding="16" cellspacing="0" border="0"
       style="background-color:#FFF0F0; border: 2px solid #D71C1C; border-radius: 6px;">
<tr><td align="center" style="font-size: 17px; font-weight: bold; color: #D71C1C;">WAIVERS REQUIRED</td></tr>
<tr><td align="center" style="font-size: 14px; color: #333; line-height: 1.6;">
  Every guest must complete a waiver <strong>before arrival</strong>.
  Missing waivers are the <strong>#1 cause of delays</strong>.
</td></tr>
<tr><td align="center"><a href="${waiverLink}" class="cta-btn red">Complete Waiver Now</a></td></tr>
<tr><td align="center" style="font-size: 11px; color: #999; word-break: break-all;">${waiverLink}</td></tr>
</table>
</td>
</tr>`
        : "";

      // VIP voucher section — cid QR (Gmail/Outlook strip data-URI imgs, so
      // the reservation QR's data-URI technique would render blank here).
      let vipVoucherSectionHtml = "";
      const emailAttachments: Array<{
        content: string;
        filename: string;
        type: string;
        contentId: string;
      }> = [];
      if (vipVoucher) {
        try {
          const qr = await qrAttachment(vipVoucher.code);
          emailAttachments.push(qr.attachment);
          vipVoucherSectionHtml = buildVipVoucherSectionHtml({
            codeDisplay: formatVoucherCode(vipVoucher.code),
            // GROUPED, and grouped by the same rule as the /v page: token legs
            // sum into one "400 Tokens" row while admissions stay countable
            // ("4 × Laser Tag"). A 7-guest grant used to render fifteen-plus
            // near-identical lines here.
            itemLabels: groupVoucherItems(
              vipVoucher.items.map((item, index) => ({ item, index, spent: false })),
            ).map(voucherGroupLabel),
            expiresAt: vipVoucher.expiresAt,
            redeemUrl: voucherRedeemUrl(vipVoucher.code),
            qrCid: qr.cid,
            // Taken FROM the redeem URL, not from a second read of the env, so
            // the wallet badge images can never load from a different host than
            // the link beside them.
            origin: new URL(voucherRedeemUrl(vipVoucher.code)).origin,
          });
        } catch (err) {
          console.error("[booking-confirmation] voucher QR failed (non-fatal):", err);
        }
      }

      // Function-style ^PlaceholderName()$ replacements
      html = html
        .replace(/\^VipVoucherSection\(\)\$/g, vipVoucherSectionHtml)
        .replace(/\^WaiverSection\(\)\$/g, waiverSectionHtml)
        .replace(/\^ReservationLink\(\)\$/g, waiverLink || "#")
        .replace(/\^BookingConfirmationQr\(\)\$/g, qrHtml)
        .replace(
          /\^QrSection\(\)\$/g,
          qrHtml
            ? `
<tr>
<td align="center" style="padding: 0 40px 24px 40px; font-family: Arial, sans-serif;">
<table width="100%" cellpadding="16" cellspacing="0" border="0" style="border: 2px solid #004AAD; border-radius: 6px;">
<tr><td align="center" style="font-size: 14px; font-weight: bold; color: #004AAD;">Booking Confirmation QR Code</td></tr>
<tr><td align="center" style="font-size: 13px; color: #666;">Present this at check-in for faster service.</td></tr>
<tr><td align="center">${qrHtml}</td></tr>
</table>
</td>
</tr>`
            : "",
        )
        .replace(
          /\^SoldVouchersList\(\)\$/g,
          codes.length > 0
            ? `<p style="font-weight:bold; color:#1A1A1A; margin:0 0 8px 0;">Your ViewPoint POV Camera Codes:</p>
             ${codes.map((c, i) => `<p style="font-family:monospace; font-size:18px; font-weight:bold; color:#6B21A8; margin:4px 0;">Code ${i + 1}: ${c}</p>`).join("")}
             <p style="color:#D71C1C; font-size:13px; line-height:1.6; margin:12px 0 0 0; font-weight:bold;">
               After your race, be sure to collect your POV camera slip. Without this slip, you will not be able to get your video.
               Scan the QR code on the slip and enter the codes above to redeem your video. Videos take 15-30 minutes to upload.
             </p>`
            : "",
        )
        .replace(/\^ActivityBoxLink\(\)\$/g, "https://smstim.in/headpinzftmyers");

      // Free appetizer call-out — appended before </body> for any
      // package that carries an appetizerCode, with the copy adapting to that
      // package's own note + menu items. DORMANT since 2026-08-12: no package
      // carries one (Rookie Pack dropped its appetizer 2026-08-04, Ultimate
      // Qualifier 2026-08-12), so this block never renders today. Left gated so
      // re-enabling the offer stays a registry data change. The actual coupon
      // code lives on the confirmation page only; this email would just tell
      // the racer to look there.
      {
        const { getPackageIgnoreFlag } = await import("@/lib/packages");
        const emailPkg = resolvedPackageId ? getPackageIgnoreFlag(resolvedPackageId) : null;
        if (emailPkg?.appetizerCode) {
          const pkgLabel = emailPkg.name;
          const note = emailPkg.appetizerNote ?? "1 per group";
          const items = emailPkg.appetizerItems ?? [
            "Bruschetta",
            "GF Mac & Cheese Bites",
            "Fried Zucchini Sticks",
          ];
          const itemsStr =
            items.length > 1
              ? items.slice(0, -1).join(", ") + ", or " + items[items.length - 1]
              : items[0];
          const noteDisplay =
            note === "1 per group" ? "One free appetizer per group" : `Free appetizer (${note})`;
          const appetizerBlock = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 20px;max-width:600px;">
  <tr><td style="padding:0 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FEF3C7;border:2px solid #F59E0B;border-radius:14px;">
      <tr><td style="padding:18px 22px;font-family:Arial,sans-serif;color:#1F2937;">
        <p style="margin:0 0 6px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#92400E;font-weight:bold;">${pkgLabel} — Included</p>
        <h3 style="margin:0 0 8px;font-size:20px;color:#111827;">🍴 Your Free Appetizer at Nemo's</h3>
        <p style="margin:0 0 8px;font-size:14px;color:#374151;line-height:1.5;">
          Join us <strong>upstairs at Nemo's</strong> before or after your race. Your coupon
          code is on your confirmation page — open the link above to grab it.
        </p>
        <p style="margin:0;font-size:12px;color:#6B7280;">
          ${noteDisplay} (${itemsStr}).
          Dine-in only · <strong style="color:#92400E;">Valid race day only</strong>.
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>`;
          html = html.replace("</body>", appetizerBlock);
        }
      }

      // Waiver section already handled by ^WaiverSection()$ placeholder

      results.email = await sendEmail(
        email,
        vipCombo
          ? vipEmailSubject(vipCombo, String(reservationNumber))
          : `${brandName} Booking Confirmed — #${reservationNumber}`,
        html,
        isHeadPinzBrand ? "HeadPinz Entertainment" : undefined,
        emailAttachments,
        extraBcc,
      );
    } catch (err) {
      console.error("[booking-confirmation] email failed:", err);
    }

    // ── Send SMS (if opted in) ──────────────────────────────────────────
    //
    // Single-segment policy: SMS is the alert; the confirmation page
    // carries the schedule, waiver requirement, arrival instructions,
    // POV codes, appetizer code, and everything else. Voxtelesys bills
    // per 153-char (GSM-7) or 67-char (UCS-2) segment; the previous
    // verbose template ran 4–9 segments per send and showed up as ~60k
    // billed segments over a couple weeks. Holding strict 1-segment
    // GSM-7 budget per booking SMS — no emoji, no em-dashes, no
    // bullets, no extra section headers — caps each booking at 1
    // billed message regardless of number of races, returning vs new,
    // express vs not.
    //
    // Trade-offs: customers don't see the schedule, waiver link, or
    // POV codes inline. They tap the confirmation URL and see all of
    // it on the page — including the action-required waiver banner.
    if (smsOptIn && phone) {
      try {
        const normalized = normalizePhone(phone);
        if (normalized.length >= 10) {
          let shortConfirm = "";
          if (billId) {
            try {
              shortConfirm = await confirmationShortUrl(billId, confirmationV2 === true);
            } catch {
              // Fall back to the full signed URL if the short-link mint fails.
              shortConfirm = signedConfirmationUrl(billId, confirmationV2 === true);
            }
          }

          // Compose date/time as a short ASCII string. `reservationDate`
          // arrives like "Saturday, May 4, 2026" — collapse to "Sat May 4"
          // to keep the SMS in single-segment range. Drop the "20XX"
          // year (rarely useful in-context, eats 6 chars).
          const compactDate = (() => {
            const raw = reservationDate || "";
            // "Saturday, May 4, 2026" → "Sat May 4"
            const m = raw.match(/^(\w+),\s*(\w+)\s+(\d{1,2})/);
            if (m) {
              return `${m[1].slice(0, 3)} ${m[2].slice(0, 3)} ${m[3]}`;
            }
            return raw;
          })();
          const dateTime = [compactDate, reservationTime].filter(Boolean).join(", ");

          // ASCII-only label for the link CTA — em-dashes / curly quotes
          // would force UCS-2 encoding, halving the per-segment budget.
          // Mention POV codes when this booking includes them so racers
          // know where to find the redemption codes (we no longer send
          // codes as separate SMS — they live on the confirmation page).
          const hasPovCodes = codes.length > 0;
          const cta = isExpressLane
            ? hasPovCodes
              ? "Pass, check-in + POV codes"
              : "View pass + check-in"
            : hasPovCodes
              ? "View, waiver + POV codes"
              : "View + waiver";

          // Express-lane racers get the brand suffixed with "Express Lane"
          // so the prefix line is unmistakable at a glance — staff and
          // racers asked for this so the SMS preview tells them they
          // bypass Guest Services without needing to open the link.
          const brandPrefix = isExpressLane ? `${brandName} Express Lane` : brandName;
          // VIP combo: name the product in the one SMS the guest gets. The
          // builder returns null if the body would ever exceed one GSM-7
          // segment (or contain non-ASCII), falling back to the standard body.
          const vipSmsBody = vipCombo
            ? buildVipSmsBody({
                brandName: brandPrefix,
                comboName: vipCombo.name,
                dateTime,
                cta,
                shortConfirm,
              })
            : null;
          // "See you soon!" trailer AFTER the link: iOS strips a message-final
          // URL into its own preview bubble, so the confirmation read as two
          // separate texts (owner 2026-07-11). Text after the link keeps it
          // one bubble — same pattern as the pre-race e-ticket SMS. Worst case
          // stays single-segment: ~46 chars of fixed copy + brand (≤22) +
          // date/time (≤20) + cta (≤24) + short link (≤35) ≈ 147 GSM-7 chars.
          const smsBody =
            vipSmsBody ??
            (shortConfirm
              ? `${brandPrefix}: Booking #${reservationNumber} for ${dateTime}. ${cta}: ${shortConfirm} See you soon!`
              : `${brandPrefix}: Booking #${reservationNumber} for ${dateTime}.`);

          const smsFrom =
            location === "naples"
              ? VOX_FROM_NAPLES
              : isHeadPinzBrand
                ? VOX_FROM_HEADPINZ
                : VOX_FROM_FASTTRAX;
          results.sms = await sendSms(normalized, smsBody, smsFrom);

          // POV codes are now displayed on the confirmation page only —
          // no separate per-code SMS. Cuts N+1 outbound messages per
          // booking (where N = video count, typically 1-4) down to 1.
          // The CTA above tells racers to tap the URL for the codes.
        }
      } catch (err) {
        console.error("[booking-confirmation] sms failed:", err);
        results.sms = false;
      }
    }

    // Log notification to Redis (90-day TTL)
    try {
      const log = {
        type: "booking-confirmation",
        billId: billId || null,
        reservationNumber,
        email,
        phone: smsOptIn ? phone : null,
        emailSent: results.email,
        smsSent: results.sms,
        povCodes: codes.length > 0 ? codes : null,
        isNewRacer: !!isNewRacer,
        comboSpecialId: vipCombo?.id ?? null,
        sentAt: new Date().toISOString(),
      };
      await redis.set(notifKey, JSON.stringify(log), "EX", 90 * 24 * 60 * 60);
      // Also append to per-bill notification history
      if (billId) {
        await redis.rpush(`notif:history:${billId}`, JSON.stringify(log));
        await redis.expire(`notif:history:${billId}`, 90 * 24 * 60 * 60);
      }
    } catch {
      /* non-fatal */
    }

    return NextResponse.json({ success: true, ...results });
  } catch (err) {
    console.error("[booking-confirmation] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Notification failed" },
      { status: 500 },
    );
  }
}
