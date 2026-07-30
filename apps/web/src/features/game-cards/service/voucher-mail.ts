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
 *   GUEST VOUCHER. Exactly ONE code, with what it's worth and the two ways to
 *   redeem it: tap the link (credits a card they already have) or scan it at a
 *   kiosk (dispenses a new one). No marketing chrome, no unsubscribe group —
 *   this is transactional.
 *
 * SMS is intentionally terse: a code, a value, a link. Long marketing copy in a
 * text costs money per segment and gets read less.
 */

import { sendEmail } from "@/lib/sendgrid";
import { twilioSend } from "@/lib/twilio-send";
import { formatVoucherCode } from "../vouchers/codes";
import { voucherItemLabel, type VoucherItem } from "../data/vouchers-db";
import { logVoucherEvent, markVoucherSent } from "../data/vouchers-db";

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

  // Plain, monospaced, copy-pasteable. This is a working list, not a brochure —
  // it gets pasted into a spreadsheet or read off to a guest on the phone.
  const rows = args.codes
    .map((c) => `<tr><td style="padding:4px 12px 4px 0;font-family:monospace;font-size:15px">${esc(formatVoucherCode(c))}</td></tr>`)
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
        Guests redeem at a kiosk (scan or type the code) or at
        <span style="font-family:monospace">${esc(siteOrigin())}/v/&lt;code&gt;</span>
        to load a card they already have.
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
            Load it on my card
          </a>
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
      categories: ["voucher_guest"],
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
