/**
 * SMS body templates for marketing campaigns.
 *
 * GSM-7 discipline: no em-dash, no smart quotes, no curly apostrophes —
 * those characters push the message into the extended/UCS-2 character set
 * which costs more per segment and rounds down the segment length to 70
 * chars. Keeping bodies in plain ASCII keeps every message at $0.0075.
 *
 * Length budget: aim for ≤160 chars (1 segment). At 161–306 chars the
 * carrier bills 2 segments; we accept that only when unavoidable.
 */

const NON_GSM7_RE = /[^\x00-\x7F]/;

/**
 * Hard-fail check that a rendered SMS body uses only plain ASCII characters.
 * Throws so the build / tests catch a template regression before it ships
 * to customers.
 */
export function assertGsm7Safe(body: string, templateKey: string): void {
  if (NON_GSM7_RE.test(body)) {
    const offending = body.match(NON_GSM7_RE)?.[0];
    throw new Error(
      `SMS template "${templateKey}" contains non-GSM-7 character ${JSON.stringify(offending)} — use plain ASCII only`,
    );
  }
}

export interface BowlingSurveyInviteVars {
  /** The short-link code, e.g. "a1B2c3". Rendered as `headpinz.com/s/{code}`. */
  code: string;
  /** Brand domain — defaults to "headpinz.com". FastTrax racing surveys will use "fasttrax.com". */
  domain?: string;
}

/**
 * Bowling survey invitation SMS.
 *
 * Approved by user 2026-05-20 (Draft A).
 * 1-segment GSM-7 when {code} is ≤8 chars and domain is headpinz.com.
 *
 * Layout:
 *   line 1: greeting
 *   line 2: ask + reward teaser
 *   line 3: short link
 *   line 4: STOP footer (marketing compliance)
 */
export function renderBowlingSurveyInvite(vars: BowlingSurveyInviteVars): string {
  const domain = vars.domain ?? "headpinz.com";
  const body =
    `Thanks for visiting HeadPinz! How was your visit?\n` +
    `Take 60 sec to tell us. We'll send you a $5 gift card or 500 Pinz.\n` +
    `${domain}/s/${vars.code}\n` +
    `STOP to opt out`;
  assertGsm7Safe(body, "bowling_survey_invite");
  return body;
}

/**
 * Email version of the bowling survey invitation — used as a fallback
 * when SMS delivery fails AND we have an email on file. Designed to be
 * brand-on (HeadPinz navy/coral), mobile-readable, and short.
 *
 * The footer-level unsubscribe link is the email equivalent of the SMS
 * "STOP" footer — it points at the marketing opt-out flow. The opt-out
 * GET endpoint is added separately; the link is functional once that
 * route lands. The plain-text body mirrors the HTML for clients that
 * strip styling.
 *
 * Inputs:
 *   - code:       short-link code (e.g. "ab12cd") — the customer-facing
 *                 URL is `https://{domain}/s/{code}`.
 *   - guestName:  optional, used for the greeting line.
 *   - brand:      "HeadPinz" | "FastTrax" (defaults HeadPinz; FT racing
 *                 path will switch later).
 *   - domain:     optional override (default headpinz.com).
 */
export function renderBowlingSurveyInviteEmail(opts: {
  code: string;
  guestName?: string | null;
  brand?: "HeadPinz" | "FastTrax";
  domain?: string;
  phoneE164?: string;
}): { subject: string; html: string; text: string } {
  const brand = opts.brand ?? "HeadPinz";
  const domain = opts.domain ?? "headpinz.com";
  const surveyUrl = `https://${domain}/s/${opts.code}`;
  const greeting = opts.guestName ? `Hi ${opts.guestName.split(" ")[0]},` : "Hi there,";
  const unsubUrl =
    `https://${domain}/marketing/unsubscribe?` +
    (opts.phoneE164 ? `phone=${encodeURIComponent(opts.phoneE164)}` : "");
  const subject = `How was your visit to ${brand}?`;
  const text =
    `${greeting}\n\n` +
    `Thanks for bowling with us! We'd love your feedback — it takes about 60 seconds.\n\n` +
    `As a thank-you, you can pick either 500 Pinz or a $5 e-gift card on the way out.\n\n` +
    `Take the survey: ${surveyUrl}\n\n` +
    `Thanks,\n${brand} Team\n\n` +
    `Unsubscribe: ${unsubUrl}`;
  const html =
    `<!doctype html><html><body style="margin:0;padding:0;background:#f5f7fb;font-family:` +
    `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
    `color:#0a1628;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="background:#f5f7fb;padding:24px 0;"><tr><td align="center">` +
    `<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" ` +
    `style="max-width:480px;background:#ffffff;border-radius:14px;` +
    `box-shadow:0 4px 14px rgba(10,22,40,0.08);overflow:hidden;">` +
    `<tr><td style="background:#0a1628;padding:20px 24px;color:#ffffff;` +
    `font-size:18px;font-weight:700;letter-spacing:0.3px;">${escapeHtml(brand)}</td></tr>` +
    `<tr><td style="padding:24px;font-size:15px;line-height:1.55;color:#0a1628;">` +
    `<p style="margin:0 0 12px;">${escapeHtml(greeting)}</p>` +
    `<p style="margin:0 0 16px;">Thanks for bowling with us! We'd love a minute of your time — ` +
    `the survey takes about 60 seconds.</p>` +
    `<p style="margin:0 0 20px;">As a thank-you, you can pick <strong>500 Pinz</strong> or a ` +
    `<strong>$5 e-gift card</strong> when you're done.</p>` +
    `<p style="margin:0 0 24px;text-align:center;">` +
    `<a href="${surveyUrl}" style="display:inline-block;background:#fd5b56;color:#ffffff;` +
    `text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:999px;">` +
    `Take the survey</a></p>` +
    `<p style="margin:0;color:#5b6b85;font-size:13px;">If the button doesn't work, paste this ` +
    `into your browser:<br><span style="word-break:break-all;color:#0a1628;">${escapeHtml(surveyUrl)}</span></p>` +
    `</td></tr>` +
    `<tr><td style="background:#f5f7fb;padding:14px 24px;font-size:11px;color:#7b8aa3;` +
    `line-height:1.5;">` +
    `${escapeHtml(brand)} — Thanks for visiting. ` +
    `<a href="${unsubUrl}" style="color:#7b8aa3;text-decoration:underline;">Unsubscribe</a>` +
    `</td></tr></table></td></tr></table></body></html>`;
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Returned for telemetry / log lines so ops can grep "we sent template X".
 */
export const TEMPLATE_KEYS = {
  bowlingSurveyInvite: "bowling_survey_invite",
  bowlingSurveyInviteEmail: "bowling_survey_invite_email",
} as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[keyof typeof TEMPLATE_KEYS];
