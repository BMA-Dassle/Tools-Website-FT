/**
 * Shared SendGrid send helper — wraps `POST https://api.sendgrid.com/v3/mail/send`.
 *
 * Supports per-message `from` / `replyTo` overrides so features like the
 * sales-lead flow can send email that appears to come from the assigned
 * planner (rather than the default `SENDGRID_FROM_EMAIL` noreply sender).
 *
 * Keeps the existing default behavior when `from` is omitted, so legacy call
 * sites migrate to this helper without a behavior change.
 */

import { recordCustomerComm } from "@/lib/customer-comms";

const SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";

/** Record a send to the durable evidence log (soft-fail) when meta is given. */
function logComm(opts: SendEmailOpts, status: string): void {
  if (!opts.meta) return;
  void recordCustomerComm({
    channel: "email",
    toAddress: opts.to,
    subject: opts.subject,
    body: opts.html,
    policyVersion: opts.meta.policyVersion ?? null,
    reservationRef: opts.meta.reservationRef ?? null,
    kind: opts.meta.kind ?? null,
    center: opts.meta.center ?? null,
    provider: "sendgrid",
    status,
  });
}

export interface SendEmailOpts {
  to: string;
  toName?: string;
  from?: { email: string; name: string }; // overrides env default
  replyTo?: string;
  replyToName?: string;
  /** BCC address (or list). Hidden from the `to` recipient. Used to copy event planners on their own outbound lead emails. */
  bcc?: string | string[];
  /** CC address (or list). Visible on the `to` recipient. */
  cc?: string | string[];
  subject: string;
  html: string;
  /** Optional plain-text part. When omitted only HTML is sent (SendGrid allows this, but providing both is best practice). */
  text?: string;
  /** Optional metadata for the durable customer-communications evidence log.
   *  When provided, the send is recorded to Neon (chargeback evidence). */
  meta?: {
    kind?: string;
    reservationRef?: string;
    policyVersion?: string;
    center?: string;
  };
}

export interface SendEmailResult {
  ok: boolean;
  status: number | null;
  error?: string;
}

export async function sendEmail(opts: SendEmailOpts): Promise<SendEmailResult> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    return { ok: false, status: null, error: "SENDGRID_API_KEY missing" };
  }

  const defaultFromEmail = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";
  const defaultFromName = process.env.SENDGRID_FROM_NAME || "FastTrax Entertainment";
  const from = opts.from || { email: defaultFromEmail, name: defaultFromName };

  const content: Array<{ type: string; value: string }> = [];
  if (opts.text) content.push({ type: "text/plain", value: opts.text });
  content.push({ type: "text/html", value: opts.html });

  const personalization: Record<string, unknown> = {
    to: [opts.toName ? { email: opts.to, name: opts.toName } : { email: opts.to }],
    subject: opts.subject,
  };
  const usedEmails = new Set([opts.to.toLowerCase()]);
  if (opts.cc) {
    const ccList = Array.isArray(opts.cc) ? opts.cc : [opts.cc];
    personalization.cc = ccList
      .filter((e) => {
        const lower = e.toLowerCase();
        if (usedEmails.has(lower)) return false;
        usedEmails.add(lower);
        return true;
      })
      .map((email) => ({ email }));
    if ((personalization.cc as unknown[]).length === 0) delete personalization.cc;
  }
  if (opts.bcc) {
    const bccList = Array.isArray(opts.bcc) ? opts.bcc : [opts.bcc];
    const filtered = bccList.filter((e) => !usedEmails.has(e.toLowerCase()));
    if (filtered.length > 0) personalization.bcc = filtered.map((email) => ({ email }));
  }

  const payload: Record<string, unknown> = {
    personalizations: [personalization],
    from,
    content,
  };
  if (opts.replyTo) {
    payload.reply_to = opts.replyToName
      ? { email: opts.replyTo, name: opts.replyToName }
      : { email: opts.replyTo };
  }

  try {
    const res = await fetch(SENDGRID_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = (await res.text().catch(() => "")).slice(0, 500);
      console.error(
        `[sendgrid] FAILED ${res.status} to=${opts.to} subject="${opts.subject}" error=${errText}`,
      );
      logComm(opts, `failed:${res.status}`);
      return { ok: false, status: res.status, error: errText };
    }
    console.log(`[sendgrid] sent to=${opts.to} subject="${opts.subject}" status=${res.status}`);
    logComm(opts, "sent");
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : "network error",
    };
  }
}
