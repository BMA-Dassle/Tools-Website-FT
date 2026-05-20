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
 * Returned for telemetry / log lines so ops can grep "we sent template X".
 */
export const TEMPLATE_KEYS = {
  bowlingSurveyInvite: "bowling_survey_invite",
} as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[keyof typeof TEMPLATE_KEYS];
