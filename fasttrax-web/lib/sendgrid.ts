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

const SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";

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
  if (opts.bcc) {
    const bccList = Array.isArray(opts.bcc) ? opts.bcc : [opts.bcc];
    personalization.bcc = bccList.map((email) => ({ email }));
  }
  if (opts.cc) {
    const ccList = Array.isArray(opts.cc) ? opts.cc : [opts.cc];
    personalization.cc = ccList.map((email) => ({ email }));
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
      return { ok: false, status: res.status, error: errText };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : "network error",
    };
  }
}
