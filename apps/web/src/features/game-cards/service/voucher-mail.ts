/**
 * Voucher email — two audiences, deliberately different.
 *
 *   MINT RECEIPT (owner 2026-07-29: "I also need voucher codes emailed to me").
 *   The whole batch, in one plain list, to whoever minted it. This is the
 *   working copy of a batch — the codes exist nowhere else in readable form
 *   after the response is closed, and hunting them out of Neon by hand is a
 *   worse day. Codes are the bearer instrument, so this mail is internal-only
 *   and never sent to a guest address by the mint path.
 *
 *   GUEST VOUCHER. Exactly ONE code, with what it's worth and how to redeem it:
 *   scan the QR at a kiosk, which dispenses the card already loaded. No marketing
 *   chrome, no unsubscribe group — this is transactional.
 *
 * REDEMPTION IS KIOSK-ONLY (owner 2026-08-03). The /v page's "load it onto a card
 * you already have" form was removed, so no copy here may offer it — an email that
 * promises a button the page no longer has is worse than one that says less.
 *
 * SMS is intentionally terse: a code, a value, a link. Long marketing copy in a
 * text costs money per segment and gets read less.
 */

import QRCode from "qrcode";
import { sendEmail } from "@/lib/sendgrid";
import { twilioSend } from "@/lib/twilio-send";
import { formatVoucherCode } from "../vouchers/codes";
import { voucherItemLabel, type VoucherItem } from "../data/vouchers-db";
import { logVoucherEvent, markVoucherSent } from "../data/vouchers-db";

/**
 * Audit copy of everything a CUSTOMER receives — the same inbox the booking,
 * bowling, cancellation and video mails already BCC, so a guest saying "I never
 * got it" is answerable from one place instead of SendGrid's activity feed.
 *
 * Customer-facing sends only. The staff sends in this file (`emailMintBatch`,
 * `notifyStaffDealSale`) are already addressed to staff, so copying them here
 * would just duplicate mail nobody reads.
 *
 * Worth knowing what this inbox now holds: these mails carry LIVE BEARER CODES.
 * Anyone with the code can redeem the voucher, so vendorcases is effectively a
 * store of unspent value — treat access to it accordingly, and prefer voiding a
 * leaked code (which /v/ re-checks at tap time) over assuming the mail is private.
 */
const AUDIT_BCC = "vendorcases@dassle.us";

/** Public origin for /v/{code} links. */
function siteOrigin(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || "https://headpinz.com").replace(/\/$/, "");
}

export function voucherRedeemUrl(code: string): string {
  return `${siteOrigin()}/v/${encodeURIComponent(code)}`;
}

/** "100 bonus tokens" / "100 bonus tokens + laser tag" */
export function itemsSummary(items: VoucherItem[]): string {
  return items.map(voucherItemLabel).join(" + ");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A scannable QR per code, as an INLINE (cid:) attachment.
 *
 * It encodes the /v/{code} URL, not the bare code, so ONE image serves both
 * uses: a phone camera opens the redemption page, and the kiosk scanner
 * recognises the URL (classify.ts pulls the code back out of a /v/ path). A
 * bare-code QR would work at the kiosk and do nothing useful on a phone.
 *
 * cid, not `data:` — Gmail and Outlook both strip data URIs from <img src>, so
 * an inline attachment is the only form that actually renders.
 *
 * `errorCorrectionLevel: "H"` because these get printed, photographed off a
 * screen, and scanned under a kiosk bezel; margin 1 keeps the image tight.
 */
export async function qrAttachment(code: string): Promise<{
  cid: string;
  attachment: { content: string; filename: string; type: string; contentId: string };
}> {
  const cid = `qr-${code}`;
  const buf = await QRCode.toBuffer(voucherRedeemUrl(code), {
    type: "png",
    errorCorrectionLevel: "H",
    margin: 1,
    width: 320,
  });
  return {
    cid,
    attachment: {
      content: buf.toString("base64"),
      filename: `${code}.png`,
      type: "image/png",
      contentId: cid,
    },
  };
}

/**
 * The same QR as a data URI, for rendering in a PAGE rather than an email.
 *
 * Encodes the identical `/v/{code}` payload as `qrAttachment`, so a QR is a QR
 * wherever the guest meets it — the confirmation screen, the voucher page, the
 * email. Generated server-side and handed down as a string, which keeps the
 * `qrcode` library out of the client bundle.
 */
export async function voucherQrDataUri(code: string): Promise<string | null> {
  try {
    return await QRCode.toDataURL(voucherRedeemUrl(code), {
      errorCorrectionLevel: "H",
      margin: 1,
      width: 512,
    });
  } catch (err) {
    // A missing QR degrades to code-plus-instructions; never fail the caller.
    console.error("[voucher] QR generation failed:", err);
    return null;
  }
}

/**
 * Email a freshly-minted batch to the person who minted it.
 *
 * Best-effort by design: the vouchers are already durable in Neon, so a mail
 * failure must NOT unwind a successful mint. It returns the error instead, and
 * the admin response surfaces it so nobody assumes the codes are in their inbox.
 */
export async function emailMintBatch(args: {
  to: string;
  codes: string[];
  items: VoucherItem[];
  batchLabel?: string | null;
  batchId: string;
  expiresAt?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const value = itemsSummary(args.items);
  const label = args.batchLabel?.trim() || "Game Zone vouchers";
  const expiry = args.expiresAt
    ? new Date(args.expiresAt).toLocaleDateString("en-US", { timeZone: "America/New_York" })
    : "no expiry";

  // Each code gets a scannable QR beside it (owner 2026-07-29: "I wanted
  // scannable QRs too") so a tester can hold the phone up to the kiosk instead
  // of typing 11 characters on an on-screen keyboard. The code stays in text
  // next to it — still copy-pasteable, still readable over the phone.
  const qrs = await Promise.all(args.codes.map((c) => qrAttachment(c)));
  const rows = args.codes
    .map(
      (c, i) =>
        `<tr>` +
        `<td style="padding:6px 14px 6px 0;vertical-align:middle">` +
        `<img src="cid:${qrs[i].cid}" width="110" height="110" alt="QR for ${esc(formatVoucherCode(c))}" ` +
        `style="display:block;border:1px solid #e5e5e5;border-radius:6px"></td>` +
        `<td style="padding:6px 0;vertical-align:middle;font-family:monospace;font-size:17px">` +
        `${esc(formatVoucherCode(c))}</td>` +
        `</tr>`,
    )
    .join("");

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111">
      <h2 style="margin:0 0 4px">${esc(label)}</h2>
      <p style="margin:0 0 16px;color:#555">
        ${args.codes.length} voucher${args.codes.length === 1 ? "" : "s"} ·
        each worth <strong>${esc(value)}</strong> · ${esc(expiry)}
      </p>
      <table style="border-collapse:collapse;margin:0 0 20px">${rows}</table>
      <p style="margin:0 0 6px;color:#555;font-size:13px">
        Scan a QR at the kiosk, or type the code. Guests can also open
        <span style="font-family:monospace">${esc(siteOrigin())}/v/&lt;code&gt;</span>
        to see what is left on theirs.
      </p>
      <p style="margin:0;color:#888;font-size:12px">Batch ${esc(args.batchId)}</p>
    </div>`;

  const text = [
    `${label} — ${args.codes.length} voucher(s), each worth ${value}, ${expiry}`,
    "",
    ...args.codes.map((c) => formatVoucherCode(c)),
    "",
    `Redeem: a kiosk, or ${siteOrigin()}/v/<code>`,
    `Batch ${args.batchId}`,
  ].join("\n");

  const res = await sendEmail({
    to: args.to,
    subject: `${args.codes.length} × ${value} voucher${args.codes.length === 1 ? "" : "s"} — ${label}`,
    html,
    text,
    categories: ["voucher_mint"],
    attachments: qrs.map((q) => q.attachment),
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/**
 * Email a BOUGHT batch to the buyer — one mail, every code, each with its QR.
 *
 * Separate from both senders above because the audience is genuinely different
 * again. `emailMintBatch` is an operator's working copy of a batch, and
 * `sendVoucherToGuest` says "on us" — exactly the wrong thing to tell somebody
 * who just paid. This is a purchase receipt that happens to carry bearer codes.
 *
 * ONE mail rather than N: a buyer taking several packs gets one thing to keep,
 * and ten separate transactional sends to the same address in one second is how
 * a sending domain earns a spam reputation. Each code stays independently
 * forwardable, which is the point of a multi-pack buy — one per friend.
 *
 * Best-effort, like the others: the vouchers are already durable in Neon and the
 * money is already captured, so a mail failure must never unwind either. It
 * returns the error and the caller leaves the purchase row un-sent for the
 * reconcile cron to retry.
 */
export async function emailPurchasedVouchers(args: {
  to: string;
  name?: string | null;
  /** Product name, e.g. "Laser Tag + Game Card Pack". */
  productName: string;
  codes: string[];
  /** What ONE code carries. */
  items: VoucherItem[];
  /**
   * Guest-facing override for the value line. `itemsSummary` is built for the
   * kiosk receipt (one row per removable leg) and reads badly in a sentence —
   * "laser tag + laser tag + 100 bonus tokens + 100 bonus tokens". A seller that
   * knows its product passes something the buyer recognises.
   */
  valueSummary?: string;
  expiresAt?: string | null;
  /** Where to send them to book the timed half, when the pack has one. */
  scheduleUrl?: string | null;
  scheduleLabel?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const value = args.valueSummary?.trim() || itemsSummary(args.items);
  const many = args.codes.length > 1;
  const expiry = args.expiresAt
    ? new Date(args.expiresAt).toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;

  const qrs = await Promise.all(args.codes.map((c) => qrAttachment(c)));
  const rows = args.codes
    .map(
      (c, i) =>
        `<tr>` +
        `<td style="padding:10px 16px 10px 0;vertical-align:middle">` +
        `<img src="cid:${qrs[i].cid}" width="120" height="120" alt="QR code for ${esc(formatVoucherCode(c))}" ` +
        `style="display:block;border:1px solid #e5e5e5;border-radius:8px"></td>` +
        `<td style="padding:10px 0;vertical-align:middle">` +
        `<div style="font-family:monospace;font-size:19px;letter-spacing:1px">${esc(formatVoucherCode(c))}</div>` +
        `<div style="margin-top:4px;color:#555;font-size:13px">${esc(value)}</div>` +
        `<div style="margin-top:6px"><a href="${esc(voucherRedeemUrl(c))}" style="color:#00898b;font-size:13px">View this voucher</a></div>` +
        `</td></tr>`,
    )
    .join("");

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111">
      <p style="margin:0 0 12px">${args.name ? `Thanks, ${esc(args.name)}! ` : "Thanks! "}Your
        ${esc(args.productName)}${many ? "s are" : " is"} ready.</p>
      <p style="margin:0 0 18px;color:#555">
        ${many ? `${args.codes.length} vouchers, each carrying` : "Your voucher carries"}
        <strong>${esc(value)}</strong>.
        ${many ? "Each code works on its own, so you can pass one to a friend." : ""}
      </p>
      <table style="border-collapse:collapse;margin:0 0 22px">${rows}</table>
      ${
        args.scheduleUrl
          ? `<p style="margin:0 0 18px">
               <a href="${esc(args.scheduleUrl)}" style="background:#fd5b56;color:#fff;text-decoration:none;
                  padding:13px 22px;border-radius:999px;display:inline-block;font-weight:600">
                 ${esc(args.scheduleLabel || "Pick your time")}
               </a>
             </p>`
          : ""
      }
      <p style="margin:0 0 8px;color:#555;font-size:14px"><strong>Getting your game cards:</strong>
        scan the QR at any HeadPinz kiosk and it prints your cards with the play value already on
        them.</p>
      <p style="margin:0 0 8px;color:#555;font-size:14px">You don't have to use everything at once —
        each item is redeemed separately, so whatever you haven't used stays on the code.</p>
      ${
        expiry
          ? `<p style="margin:0;color:#888;font-size:13px">Valid through ${esc(expiry)}.</p>`
          : ""
      }
    </div>`;

  const text = [
    `${args.name ? `Thanks, ${args.name}! ` : "Thanks! "}Your ${args.productName}${many ? "s are" : " is"} ready.`,
    `${many ? `${args.codes.length} vouchers, each carrying` : "Your voucher carries"} ${value}.`,
    "",
    ...args.codes.map((c) => `${formatVoucherCode(c)} — ${voucherRedeemUrl(c)}`),
    "",
    ...(args.scheduleUrl
      ? [`${args.scheduleLabel || "Pick your time"}: ${args.scheduleUrl}`, ""]
      : []),
    "Scan the QR at any HeadPinz kiosk to print your game cards with the credit already on them.",
    ...(expiry ? [`Valid through ${expiry}.`] : []),
  ].join("\n");

  const res = await sendEmail({
    to: args.to,
    toName: args.name ?? undefined,
    subject: many
      ? `Your ${args.codes.length} ${args.productName} vouchers`
      : `Your ${args.productName} voucher`,
    html,
    text,
    bcc: AUDIT_BCC,
    categories: ["voucher_purchase"],
    attachments: qrs.map((q) => q.attachment),
  });
  if (!res.ok) return { ok: false, error: res.error };

  // Same audit trail every other send leaves, per code — so "was this ever
  // delivered?" is answerable from voucher_events without joining the purchase.
  for (const code of args.codes) {
    await markVoucherSent(code, {
      email: args.to,
      ...(args.name ? { name: args.name } : {}),
    }).catch(() => {});
    await logVoucherEvent(code, "send", {
      to: args.to,
      channel: "email",
      reason: "purchase",
      productName: args.productName,
    }).catch(() => {});
  }
  return { ok: true };
}

/**
 * Text a buyer their purchased voucher link(s).
 *
 * Separate from the email because it is opt-in and because the constraint is
 * different: each SMS segment costs money, so this carries links rather than
 * codes-plus-instructions. The link is the same `/v/{code}` page the email's QR
 * encodes and the booking confirmation's voucher card points at — one canonical
 * place a guest sees their code, whichever channel got them there.
 *
 * Multi-pack: up to 3 links inline (each code is an independent bearer
 * instrument, so a buyer splitting packs between friends wants them all),
 * beyond that it points at the email rather than sending a wall of URLs.
 */
export async function smsPurchasedVouchers(args: {
  phone: string;
  productName: string;
  codes: string[];
  /** Sending DID. Defaults to the configured number. */
  fromOverride?: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (args.codes.length === 0) return { ok: false, error: "no codes" };

  const MAX_INLINE = 3;
  const many = args.codes.length > 1;
  const head = many
    ? `Your ${args.codes.length} ${args.productName} vouchers are ready.`
    : `Your ${args.productName} voucher is ready.`;

  const body =
    args.codes.length <= MAX_INLINE
      ? [head, ...args.codes.map((c) => `${formatVoucherCode(c)} ${voucherRedeemUrl(c)}`)].join(
          "\n",
        )
      : [
          head,
          `${formatVoucherCode(args.codes[0])} ${voucherRedeemUrl(args.codes[0])}`,
          `The other ${args.codes.length - 1} codes are in your email.`,
        ].join("\n");

  const res = await twilioSend(args.phone, body, args.fromOverride);
  if (!res.ok) return { ok: false, error: res.error ?? "sms failed" };

  for (const code of args.codes.slice(0, MAX_INLINE)) {
    await logVoucherEvent(code, "send", {
      to: args.phone,
      channel: "sms",
      reason: "purchase",
    }).catch(() => {});
  }
  return { ok: true };
}

/**
 * Tell staff a deal pack just sold (owner 2026-08-03: "when these sell can you
 * email jacob and i for now").
 *
 * Deliberately a SEPARATE send, not a bcc on the buyer's receipt: the buyer's mail
 * carries their bearer codes, and staff want the money facts and the ad source,
 * which are none of the buyer's business and would look odd in their inbox. It
 * also means a staff-notify failure can never affect the guest's delivery.
 *
 * Recipients are an env list so adding someone is a Vercel change, not a deploy.
 * "for now" is the operative phrase — this is a launch-watching email, and the
 * sales board at /admin/{token}/deals is the durable answer.
 */
export async function notifyStaffDealSale(args: {
  dealName: string;
  qty: number;
  combined: boolean;
  locationLabel: string;
  totalCents: number;
  buyerName?: string | null;
  buyerEmail: string;
  codes: string[];
  purchaseId: number;
  utm?: Record<string, string> | null;
}): Promise<{ ok: boolean; error?: string }> {
  const to = (process.env.DEAL_SALE_NOTIFY_EMAILS || "eric@headpinz.com,jacob@headpinz.com")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (to.length === 0) return { ok: false, error: "no recipients configured" };

  const money = `$${(args.totalCents / 100).toFixed(2)}`;
  const source = args.utm
    ? [args.utm.utm_source, args.utm.utm_campaign].filter(Boolean).join(" / ") ||
      (args.utm.gclid ? "google ads" : "direct")
    : "direct";
  const delivery = args.combined && args.qty > 1 ? `1 code (${args.qty} packs combined)` : `${args.codes.length} code(s)`;

  const rows: [string, string][] = [
    ["Deal", `${args.dealName} × ${args.qty}`],
    ["Location", args.locationLabel],
    ["Paid", money],
    ["Buyer", `${args.buyerName ? `${esc(args.buyerName)} — ` : ""}${esc(args.buyerEmail)}`],
    ["Delivery", delivery],
    ["Codes", args.codes.map(formatVoucherCode).join(", ") || "—"],
    ["Source", esc(source)],
    ["Order", `#${args.purchaseId}`],
  ];

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111">
      <h2 style="margin:0 0 4px">Deal pack sold — ${money}</h2>
      <p style="margin:0 0 14px;color:#555">${esc(args.dealName)} × ${args.qty} · ${esc(args.locationLabel)}</p>
      <table style="border-collapse:collapse;font-size:14px">
        ${rows
          .map(
            ([k, v]) =>
              `<tr><td style="padding:3px 14px 3px 0;color:#777">${k}</td><td style="padding:3px 0"><strong>${v}</strong></td></tr>`,
          )
          .join("")}
      </table>
      <p style="margin:16px 0 0;font-size:13px;color:#555">
        Sales board: <a href="${esc(siteOrigin())}/admin/&lt;token&gt;/deals">/admin/&lt;token&gt;/deals</a>
      </p>
    </div>`;

  const res = await sendEmail({
    to: to[0],
    ...(to.length > 1 ? { cc: to.slice(1) } : {}),
    subject: `Deal pack sold — ${args.dealName} × ${args.qty} (${money})`,
    html,
    text: rows.map(([k, v]) => `${k}: ${v.replace(/<[^>]*>/g, "")}`).join("\n"),
    categories: ["deal_sale_staff"],
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Send ONE voucher to a guest by email and/or SMS. */
export async function sendVoucherToGuest(args: {
  code: string;
  items: VoucherItem[];
  email?: string;
  phone?: string;
  name?: string;
  expiresAt?: string | null;
}): Promise<{ emailOk?: boolean; smsOk?: boolean; error?: string }> {
  const pretty = formatVoucherCode(args.code);
  const value = itemsSummary(args.items);
  const url = voucherRedeemUrl(args.code);
  const out: { emailOk?: boolean; smsOk?: boolean; error?: string } = {};

  if (args.email) {
    const qr = await qrAttachment(args.code);
    const html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111">
        <p style="margin:0 0 12px">${args.name ? `${esc(args.name)}, ` : ""}here's ${esc(value)} on us.</p>
        <div style="font-family:monospace;font-size:26px;letter-spacing:2px;padding:14px 18px;
                    background:#f4f4f6;border-radius:10px;display:inline-block;margin:0 0 16px">
          ${esc(pretty)}
        </div>
        <p style="margin:0 0 12px">
          <a href="${esc(url)}" style="background:#00b3b6;color:#fff;text-decoration:none;
             padding:12px 20px;border-radius:999px;display:inline-block;font-weight:600">
            View my voucher
          </a>
        </p>
        <!-- The vendors' own badge artwork, one link each. What was here before —
             a single CSS pill reading "Add to Apple or Google Wallet" — was wrong
             twice over: it re-set both wordmarks in our own type, which both
             vendors publish files specifically to prevent, and it merged two
             brands into one control that neither of them ships. /v/ already
             renders these as separate buttons; the email now matches it, and each
             href states its platform so the redirect never has to sniff.

             PNG, NOT SVG — Gmail and Outlook do not render SVG in mail. These are
             @2x rasters of the official SVGs (a format conversion, not a redraw;
             Apple ships only SVG and EPS), served at half their pixel size via
             explicit width/height so they stay sharp on retina. Absolute URLs,
             because a mail client has no origin to resolve against. alt carries
             the full label, since most clients block images until asked. -->
        <p style="margin:0 0 12px">
          <a href="${esc(url)}/wallet?platform=apple"
             style="text-decoration:none;display:inline-block;margin:0 8px 8px 0">
            <img src="${esc(siteOrigin())}/brand/wallet/apple-wallet-en@2x.png"
                 width="158" height="50" alt="Add to Apple Wallet"
                 style="display:block;border:0;width:158px;height:50px">
          </a>
          <a href="${esc(url)}/wallet?platform=google"
             style="text-decoration:none;display:inline-block;margin:0 0 8px 0">
            <img src="${esc(siteOrigin())}/brand/wallet/google-wallet-en@2x.png"
                 width="181" height="50" alt="Add to Google Wallet"
                 style="display:block;border:0;width:181px;height:50px">
          </a>
        </p>
        <p style="margin:0 0 12px">
          <img src="cid:${qr.cid}" width="180" height="180"
               alt="Scan this at any kiosk"
               style="display:block;border:1px solid #e5e5e5;border-radius:8px">
          <span style="display:block;margin-top:6px;color:#555;font-size:13px">
            Or scan this at any kiosk
          </span>
        </p>
        <p style="margin:0 0 6px;color:#555">
          Already have a game card? Use the button. Don't have one? Scan this code at any
          kiosk and it'll print a new card for you.
        </p>
        ${
          args.expiresAt
            ? `<p style="margin:0;color:#888;font-size:13px">Valid through ${esc(
                new Date(args.expiresAt).toLocaleDateString("en-US", {
                  timeZone: "America/New_York",
                }),
              )}.</p>`
            : ""
        }
      </div>`;
    const res = await sendEmail({
      to: args.email,
      toName: args.name,
      subject: `${value} on us`,
      html,
      text: `${value} on us. Code ${pretty}. Load it on your card: ${url} — or scan it at any kiosk for a new card.`,
      bcc: AUDIT_BCC,
      categories: ["voucher_guest"],
      attachments: [qr.attachment],
    });
    out.emailOk = res.ok;
    if (!res.ok) out.error = res.error;
  }

  if (args.phone) {
    const sms = await twilioSend(
      args.phone,
      `${value} on us! Code ${pretty}. Load it on your card: ${url} — or scan it at any kiosk for a new one.`,
    );
    out.smsOk = sms.ok;
    if (!sms.ok && !out.error) out.error = sms.error;
  }

  if (out.emailOk || out.smsOk) {
    await markVoucherSent(args.code, {
      ...(args.email ? { email: args.email } : {}),
      ...(args.phone ? { phone: args.phone } : {}),
      ...(args.name ? { name: args.name } : {}),
    });
    await logVoucherEvent(args.code, "send", {
      email: args.email ?? null,
      phone: args.phone ?? null,
      emailOk: out.emailOk ?? null,
      smsOk: out.smsOk ?? null,
    });
  }
  return out;
}
