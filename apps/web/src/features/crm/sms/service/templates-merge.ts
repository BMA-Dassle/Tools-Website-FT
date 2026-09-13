/**
 * Template merge and GSM-7 discipline for outbound texts.
 *
 * MERGE (`merge(tpl, l)`, crm-shared.js:285). The prototype's twelve tokens,
 * filled from real rows instead of a fixture. A token we cannot fill is LEFT
 * IN PLACE — `{{hold.until}}` stays visible and is listed in `missing` — so a
 * rep sees what to replace rather than sending a sentence with a hole in it
 * (the same rule C6's collateral merge follows: missing is highlighted, never
 * silently blank).
 *
 * GSM-7 (R11). `assertGsm7Safe` from `~/features/marketing/templates` is a hard
 * throw, which is right for a committed template and wrong for a rep typing on
 * an iPhone whose keyboard produces curly quotes and an ellipsis character. So
 * every body is NORMALISED first — the handful of characters a keyboard
 * substitutes are mapped to their ASCII equivalents — and only then asserted.
 * What we store in `crm_sms_messages.body` is the normalised text, because
 * that is what actually left the building. Anything still outside GSM-7 after
 * that (an emoji, an accented name) is refused with `not_gsm7` and the
 * offending character named, never silently dropped.
 *
 * The seeded T-2 is exactly why: "Hi {{guest.first}} — checking in" carries an
 * em dash, so a strict assert would make a seeded template unsendable.
 *
 * PURE: no Neon, no env, no clock beyond what the caller passes.
 */

import { assertGsm7Safe } from "~/features/marketing/templates";
import { EVENT_TYPE_LABEL } from "~/features/crm/leads/contracts";
import { CENTRES } from "../../core/centres";
import { fDate } from "../../core/dates";
import { EVENT_TYPES, type CentreCode, type EventType } from "../../core/types";
import type { CrmTemplate, LinkedContact, LinkedLead, RenderedTemplate } from "../types";

/** `D.typeLabel[l.type].toLowerCase()` (crm-shared.js:285), guarded for a stray value. */
function eventTypeWords(eventType: string): string | undefined {
  return (EVENT_TYPES as readonly string[]).includes(eventType)
    ? EVENT_TYPE_LABEL[eventType as EventType].toLowerCase()
    : undefined;
}

/** Characters a phone keyboard substitutes, and their GSM-7 equivalents. */
const GSM7_SUBSTITUTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[–—]/g, "-"], // en dash, em dash
  [/[‘’‛]/g, "'"], // curly single quotes
  [/[“”]/g, '"'], // curly double quotes
  [/…/g, "..."], // ellipsis
  [/ /g, " "], // non-breaking space
  [/•/g, "-"], // bullet
  [/·/g, "-"], // middle dot (our own captions use it)
  [/→/g, "->"], // arrow
];

/** Map the characters a keyboard substitutes back to plain ASCII. */
export function normalizeForGsm7(body: string): string {
  let out = body;
  for (const [re, to] of GSM7_SUBSTITUTIONS) out = out.replace(re, to);
  return out;
}

export interface Gsm7Result {
  ok: boolean;
  body: string;
  /** The first character that is still outside GSM-7, when `ok` is false. */
  offending: string | null;
}

/**
 * Normalise, then assert. Never throws: the caller turns `ok: false` into the
 * `not_gsm7` refusal, which is a message a rep can act on.
 */
export function toGsm7(body: string, templateKey = "crm-sms"): Gsm7Result {
  const normalized = normalizeForGsm7(body);
  try {
    assertGsm7Safe(normalized, templateKey);
    return { ok: true, body: normalized, offending: null };
  } catch {
    const offending = normalized.match(/[^\x00-\x7F]/)?.[0] ?? null;
    return { ok: false, body: normalized, offending };
  }
}

export interface MergeContext {
  contact: LinkedContact | null;
  lead: LinkedLead | null;
  rep: { firstName: string } | null;
}

/** `{{a.b}}` → its value, or `undefined` when we cannot fill it. */
export function mergeValues(ctx: MergeContext): Record<string, string | undefined> {
  const { contact, lead, rep } = ctx;
  const centre = lead && lead.centre in CENTRES ? CENTRES[lead.centre as CentreCode] : null;
  return {
    "guest.first": contact?.firstName || undefined,
    "rep.first": rep?.firstName || undefined,
    "centre.short": centre?.short,
    "centre.name": centre?.name,
    "event.date": lead ? fDate(lead.eventDate) : undefined,
    "event.type": lead ? eventTypeWords(lead.eventType) : undefined,
    "event.guests": lead ? String(lead.guests) : undefined,
    "account.name": contact?.accountName || undefined,
    // Filled by the PRs that own the facts: the builder's lane hold (C5), the
    // contract link (B5), the mirror's last-year row (B1) and the quote clock
    // (B5). Until then they stay visible in the draft and are listed in
    // `missing` — a rep types over them, and nobody sends "{{contract.link}}"
    // without noticing.
    "hold.until": undefined,
    "contract.link": undefined,
    "lastYear.date": undefined,
    "quote.sentAgo": undefined,
  };
}

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export interface MergeResult {
  text: string;
  missing: string[];
}

/** Replace what we can; leave the rest visible and report it. */
export function mergeTemplate(text: string, ctx: MergeContext): MergeResult {
  const values = mergeValues(ctx);
  const missing: string[] = [];
  const out = text.replace(TOKEN, (whole, key: string) => {
    const value = values[key];
    if (value === undefined || value === "") {
      if (!missing.includes(key)) missing.push(key);
      return whole;
    }
    return value;
  });
  return { text: out, missing };
}

/** A stored template rendered for one person, ready for the picker. */
export function renderTemplate(tpl: CrmTemplate, ctx: MergeContext): RenderedTemplate {
  const body = mergeTemplate(tpl.body, ctx);
  const subject = tpl.subject ? mergeTemplate(tpl.subject, ctx) : null;
  const missing = [...body.missing];
  for (const k of subject?.missing ?? []) if (!missing.includes(k)) missing.push(k);
  return {
    ...tpl,
    rendered: tpl.kind === "sms" ? normalizeForGsm7(body.text) : body.text,
    renderedSubject: subject ? subject.text : null,
    missing,
  };
}
