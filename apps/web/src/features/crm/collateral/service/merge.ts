/**
 * Merge fields for `crm_templates` (brief C6, R11).
 *
 * PURE and CLIENT-SAFE: no Neon, no `@/lib`, no React. The editor imports it
 * for its live preview and the server imports it to render what a guest
 * actually receives, so both sides agree on what a field means by construction.
 *
 * THE RULE THAT MOTIVATES THE SHAPE — "a preview that HIGHLIGHTS a missing
 * field rather than rendering a blank". A blank is the dangerous outcome: a
 * rep reads "Hi , it's Kelsea" as a typo and sends it anyway, and the guest
 * gets a letter addressed to nobody. So `renderSegments` never substitutes an
 * empty string. A field with no value keeps its literal `{{token}}` in the
 * text AND comes back as a segment flagged `missing`, which the editor paints
 * and the send path refuses on.
 *
 * Two different failures are distinguished, because the fixes differ:
 *   missing  a KNOWN field the lead has no value for (no account, no last-year
 *            event) — the rep fills it in or picks another template;
 *   unknown  a token that is not one of the twelve — a typo in the template,
 *            which only a director editing the template can fix.
 */

import type { Gsm7Verdict } from "../contracts";

export interface MergeFieldDef {
  /** The token between the braces: `guest.first`. */
  key: string;
  /** What the editor's insert button and the field list call it. */
  label: string;
  /** The value the preview shows when no real lead is in hand. */
  sample: string;
}

/**
 * The twelve fields, in the order the brief's §3.8 seed comment lists them.
 * Samples are the prototype's own preview lead (Lee Health, L-1042 — Sat 17
 * Oct 2026, 60 guests, HP Fort Myers, Kelsea).
 */
export const MERGE_FIELDS: readonly MergeFieldDef[] = [
  { key: "guest.first", label: "Guest first name", sample: "Dana" },
  { key: "rep.first", label: "Your first name", sample: "Kelsea" },
  { key: "centre.short", label: "Centre short name", sample: "HP Fort Myers" },
  { key: "centre.name", label: "Centre full name", sample: "HeadPinz Fort Myers" },
  { key: "event.date", label: "Event date", sample: "Sat Oct 17" },
  { key: "event.type", label: "Event type", sample: "corporate" },
  { key: "event.guests", label: "Guest count", sample: "60" },
  { key: "hold.until", label: "Hold expires", sample: "Friday" },
  { key: "contract.link", label: "Contract link", sample: "headpinz.com/c/7Hx2" },
  { key: "lastYear.date", label: "Last year's date", sample: "Oct 18, 2025" },
  { key: "account.name", label: "Account name", sample: "Lee Health" },
  { key: "quote.sentAgo", label: "Quote sent", sample: "3 days ago" },
];

export const MERGE_FIELD_KEYS: readonly string[] = MERGE_FIELDS.map((f) => f.key);

const KNOWN = new Set(MERGE_FIELD_KEYS);

/**
 * `{{ field.name }}` — whitespace inside the braces tolerated, because a
 * director hand-typing a token will put it there. Built fresh per call: a
 * module-level `/g` regex carries `lastIndex` between calls and would skip
 * every other match.
 */
function tokenRe(): RegExp {
  return /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
}

export function isMergeField(key: string): boolean {
  return KNOWN.has(key);
}

/** Every token in the text, deduplicated, in order of first appearance. */
export function mergeFieldsIn(...texts: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(tokenRe())) {
      const key = m[1];
      if (key && !out.includes(key)) out.push(key);
    }
  }
  return out;
}

export type MergeValues = Record<string, string | number | null | undefined>;

export type MergeSegment =
  | { kind: "text"; text: string }
  | {
      kind: "field";
      key: string;
      /** What is rendered: the value, or the literal `{{key}}` when missing. */
      text: string;
      /** A known field with no value for this lead. */
      missing: boolean;
      /** Not one of the twelve — a typo in the template body. */
      unknown: boolean;
    };

function valueFor(values: MergeValues, key: string): string | null {
  const raw = values[key];
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === "number" ? String(raw) : raw;
  return text.trim() === "" ? null : text;
}

/**
 * Split a body into literal runs and field hits. The editor renders each
 * `field` segment as a `<mark>`; nothing is ever dropped, so concatenating
 * `segment.text` reproduces `renderTemplate(...).text` exactly.
 */
export function renderSegments(body: string, values: MergeValues = {}): MergeSegment[] {
  const out: MergeSegment[] = [];
  let last = 0;
  for (const m of body.matchAll(tokenRe())) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: body.slice(last, at) });
    const key = m[1] ?? "";
    const unknown = !isMergeField(key);
    const value = unknown ? null : valueFor(values, key);
    out.push({
      kind: "field",
      key,
      text: value ?? `{{${key}}}`,
      missing: !unknown && value === null,
      unknown,
    });
    last = at + m[0].length;
  }
  if (last < body.length) out.push({ kind: "text", text: body.slice(last) });
  return out;
}

export interface MergeResult {
  /** The body with every resolvable field filled; unresolved ones keep `{{…}}`. */
  text: string;
  /** Known fields this lead had no value for. */
  missing: string[];
  /** Tokens that are not merge fields at all. */
  unknown: string[];
}

export function renderTemplate(body: string, values: MergeValues = {}): MergeResult {
  const segments = renderSegments(body, values);
  const missing: string[] = [];
  const unknown: string[] = [];
  let text = "";
  for (const s of segments) {
    text += s.text;
    if (s.kind !== "field") continue;
    if (s.unknown && !unknown.includes(s.key)) unknown.push(s.key);
    else if (s.missing && !missing.includes(s.key)) missing.push(s.key);
  }
  return { text, missing, unknown };
}

/** Every field filled — what a template looks like on its luckiest lead. */
export function sampleValues(): Record<string, string> {
  return Object.fromEntries(MERGE_FIELDS.map((f) => [f.key, f.sample]));
}

/**
 * The fields a REAL lead most often has nothing behind. The prototype's own
 * preview lead (Lee Health, L-1042) has no lane hold, no event with us last
 * year and no quote sent yet — so these three are exactly where a template
 * silently goes blank in practice.
 */
export const PREVIEW_GAP_FIELDS: readonly string[] = [
  "hold.until",
  "lastYear.date",
  "quote.sentAgo",
];

export type PreviewLead = "typical" | "complete";

/**
 * What the editor previews against.
 *
 * `"typical"` is the DEFAULT and it is the point: previewing against a value
 * set where all twelve fields are present means `segment.missing` is false for
 * every known token, the `<mark>` never paints, and the caption's promise —
 * "a missing field is highlighted rather than rendered blank" — is one nobody
 * can ever see kept. A director writing "your lanes are held until
 * {{hold.until}}" has to see what that looks like on the leads that have no
 * hold, because that is the message that goes out wrong.
 *
 * `"complete"` stays available behind the editor's toggle for reading the copy
 * as a lucky guest receives it.
 */
export function previewValues(lead: PreviewLead = "typical"): MergeValues {
  const values: MergeValues = sampleValues();
  if (lead === "complete") return values;
  for (const key of PREVIEW_GAP_FIELDS) values[key] = null;
  return values;
}

// ---------------------------------------------------------------------------
// GSM-7
// ---------------------------------------------------------------------------

/**
 * The same test `src/features/marketing/templates.ts:13` applies to every
 * marketing body: anything outside 7-bit ASCII pushes the whole message into
 * UCS-2, which halves the segment length (70 chars, not 160) and doubles the
 * bill. Re-stated here rather than imported because `assertGsm7Safe` THROWS,
 * and a template list has to be able to SHOW a bad row rather than die on it.
 * `gsm7Verdict` is the only form: the refusal that matters is the server's,
 * and `/collateral/templates` raises it as a 422 `not_gsm7` from this verdict
 * (there is no throwing wrapper in this module — an earlier version of this
 * comment named one that never existed).
 *
 * This is not hypothetical: the seeded template "Quote nudge (48 h)"
 * (`core/seed.ts` T-2, copied verbatim from the prototype) contains an em dash.
 * The editor flags it, and refuses to save it until the character is replaced.
 */
const NON_GSM7_RE = /[^\x00-\x7F]/;

export function gsm7Verdict(body: string): Gsm7Verdict {
  const hit = NON_GSM7_RE.exec(body);
  return hit ? { ok: false, offending: hit[0] } : { ok: true, offending: null };
}

export const GSM7_ERROR = "not_gsm7";

/** How many 160/153-char segments this body costs (GSM-7 bodies only). */
export function smsSegments(body: string): number {
  const n = body.length;
  if (n === 0) return 0;
  return n <= 160 ? 1 : Math.ceil(n / 153);
}
