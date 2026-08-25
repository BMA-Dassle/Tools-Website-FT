/**
 * Tell the guest their payment-difference link exists — text and/or email,
 * best-effort. Until 2026-08-24 the link was neither shown to staff nor sent:
 * the success screen printed the edit id, so staff read a URL over the phone
 * or the guest never heard. This is the send half; the modal now shows the
 * URL as well.
 *
 * Never throws. A failed/absent send is reported back so the executor can
 * warn "copy the link and send it yourself"; the pending_payment row is
 * already written by the time this runs, and the link stays valid regardless.
 */
import { sendEmail } from "@/lib/sendgrid";
import { payLinkExpiresAtMs } from "./pay-link";

export interface PayLinkNoticeInput {
  guestName: string | null;
  phone: string | null;
  email: string | null;
  amountCents: number;
  url: string;
  editId: string;
  createdAtMs: number;
  eventAtMs: number | null;
}

export interface PayLinkNoticeResult {
  channels: Array<"sms" | "email">;
  error?: string;
}

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

const expiryCopy = (createdAtMs: number, eventAtMs: number | null): string => {
  const at = new Date(payLinkExpiresAtMs(createdAtMs, eventAtMs));
  return at.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

export const sendPayLinkNotice = async (
  input: PayLinkNoticeInput,
): Promise<PayLinkNoticeResult> => {
  const channels: PayLinkNoticeResult["channels"] = [];
  const errors: string[] = [];
  const first = (input.guestName ?? "").trim().split(/\s+/)[0] || "there";
  const amount = dollars(input.amountCents);
  const expires = expiryCopy(input.createdAtMs, input.eventAtMs);

  if (input.phone) {
    try {
      // voxSend owns the suppression gate, the Twilio failover and its own
      // logging — the pay link is transactional, so an opted-out guest is
      // (correctly) not texted and staff get the "send it yourself" warning.
      const { voxSend } = await import("@/lib/sms-retry");
      const body =
        `Hi ${first}, your reservation update with HeadPinz / FastTrax needs a payment of ${amount}. ` +
        `Pay securely here (link expires ${expires} ET): ${input.url}`;
      const res = await voxSend(input.phone, body, { category: "transactional" });
      if (res.ok) channels.push("sms");
      else errors.push(`sms: ${res.error ?? "send failed"}`);
    } catch (e) {
      errors.push(`sms: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (input.email) {
    try {
      const res = await sendEmail({
        to: input.email,
        toName: input.guestName ?? undefined,
        subject: `Complete your reservation update — ${amount} due`,
        text:
          `Hi ${first},\n\nYour reservation update needs a payment of ${amount}. ` +
          `Pay securely here: ${input.url}\n\nThis link expires ${expires} ET. ` +
          `Questions? Reply to this email or call the venue.\n`,
        html:
          `<p>Hi ${first},</p>` +
          `<p>Your reservation update needs a payment of <strong>${amount}</strong>.</p>` +
          `<p><a href="${input.url}" style="display:inline-block;padding:12px 20px;background:#f59e0b;color:#111;border-radius:8px;text-decoration:none;font-weight:700">Pay ${amount} securely</a></p>` +
          `<p style="color:#666;font-size:13px">This link expires ${expires} ET. If it has expired, contact the venue for a new one.</p>`,
        categories: ["reservation-edit-pay-link"],
      });
      if (res.ok) channels.push("email");
      else errors.push(`email: ${res.error ?? `HTTP ${res.status ?? "?"}`}`);
    } catch (e) {
      errors.push(`email: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!input.phone && !input.email) errors.push("no phone or email on file");
  return { channels, ...(errors.length > 0 ? { error: errors.join("; ") } : {}) };
};
