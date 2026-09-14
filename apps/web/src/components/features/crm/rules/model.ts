import type { PublicRep } from "~/features/crm/core/contracts";
import type { DecisionWire, RuleInputWire } from "~/features/crm/rules/contracts";
import { EVENT_TYPE_LABEL, LEAD_SOURCE_LABEL } from "~/features/crm/rules/labels";
import {
  EVENT_TYPES,
  type AssignmentRule,
  type CentreCode,
  type EventType,
  type LeadSource,
  type RuleKind,
  type RuleThen,
  type RuleWhen,
} from "~/features/crm/core/types";
import type { RuleTraceRow } from "../primitives/RuleTrace";

/**
 * Pure helpers behind the Rules screen — the part a test can hold. Copy is the
 * prototype's (`ruleWhen` / `ruleThen`, crm-shared.js:466-467; the rule sheet,
 * :472).
 */

/** "R3" — the code the rows, the trace and the sheet title show. */
export function ruleCode(rule: Pick<AssignmentRule, "position">): string {
  return `R${rule.position}`;
}

export interface CentreOption {
  code: CentreCode;
  short: string;
}

/** `ruleWhen(r)` — "guests ≥ 100", "type = Birthday (kids)", … or "any lead". */
export function ruleWhenLabel(when: RuleWhen, centres: readonly CentreOption[] = []): string {
  const parts: string[] = [];
  if (when.guestsMin != null) parts.push(`guests ≥ ${when.guestsMin}`);
  if (when.guestsMax != null) parts.push(`guests ≤ ${when.guestsMax}`);
  if (when.type) parts.push(`type = ${EVENT_TYPE_LABEL[when.type]}${when.kids ? " (kids)" : ""}`);
  if (when.centre)
    parts.push(`centre = ${centres.find((c) => c.code === when.centre)?.short ?? when.centre}`);
  if (when.source) parts.push(`source = ${LEAD_SOURCE_LABEL[when.source]}`);
  if (when.partyMonth) parts.push(`party month = ${monthOptionLabel(when.partyMonth)}`);
  return parts.length ? parts.join(" and ") : "any lead";
}

/** `ruleThen(r)` — "hold for Marketing Director", "route to Guest Services", … */
export function ruleThenLabel(then: RuleThen, reps: readonly PublicRep[]): string {
  const name = (slug: string) => reps.find((r) => r.slug === slug)?.displayName ?? slug;
  if (then.hold) return `hold for ${name(then.hold)}`;
  if (then.route) return `route to ${name(then.route)}`;
  if (then.skipOff) return "exclude reps marked off";
  // ONE rule, stated as one thing (owner, 2026-09-14: "I need this prefer with
  // balance combined"). The engine has always narrowed by shift and then picked
  // the lowest party-month volume among whoever is left — the card said only
  // the first half, so it read as a rule that ignored balance.
  if (then.onShift) return "on shift → next shift → lowest volume";
  if (then.standard) return "lowest party-month volume";
  return "leave in queue";
}

/** Move `id` one step; the same array when it cannot move. */
export function moveIndex(ids: readonly string[], id: string, dir: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return [...ids];
  const next = [...ids];
  [next[i], next[j]] = [next[j] as string, next[i] as string];
  return next;
}

/** Drop `dragId` at `overId`'s slot (before it when moving up, after it when moving down). */
export function reorderByDrop(ids: readonly string[], dragId: string, overId: string): string[] {
  const from = ids.indexOf(dragId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return [...ids];
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, dragId);
  return next;
}

// ---------------------------------------------------------------------------
// The rule sheet's form model
// ---------------------------------------------------------------------------

/** The sheet's "Action" select — the prototype's four plus the two availability kinds. */
export type RuleAction = "hold" | "route" | "standard" | "queue" | "skipOff" | "onShift";

export const ACTION_OPTIONS: { value: RuleAction; label: string }[] = [
  { value: "hold", label: "Hold for a person" },
  { value: "route", label: "Route to a person or team" },
  { value: "standard", label: "Use the standard volume rule" },
  { value: "queue", label: "Leave in the queue" },
  { value: "skipOff", label: "Exclude reps marked off" },
  { value: "onShift", label: "Prefer on shift → next shift, balanced by volume" },
];

export function actionOf(rule: Pick<AssignmentRule, "kind" | "then">): RuleAction {
  switch (rule.kind) {
    case "hold":
      return "hold";
    case "route":
      return "route";
    case "standard":
      return "standard";
    case "fallback":
      return "queue";
    case "avail":
      return rule.then.onShift ? "onShift" : "skipOff";
  }
}

export function kindOf(action: RuleAction): RuleKind {
  switch (action) {
    case "hold":
    case "route":
    case "standard":
      return action;
    case "queue":
      return "fallback";
    case "skipOff":
    case "onShift":
      return "avail";
  }
}

export function actionNeedsPerson(action: RuleAction): boolean {
  return action === "hold" || action === "route";
}

export interface RuleForm {
  label: string;
  why: string;
  guestsMin: string;
  guestsMax: string;
  type: EventType | "";
  kids: boolean;
  centre: CentreCode | "";
  source: LeadSource | "";
  partyMonth: string;
  action: RuleAction;
  person: string;
}

export function formFromRule(
  rule: AssignmentRule | undefined,
  reps: readonly PublicRep[],
): RuleForm {
  const firstRep = reps[0]?.slug ?? "";
  if (!rule) {
    return {
      label: "",
      why: "",
      guestsMin: "",
      guestsMax: "",
      type: "",
      kids: false,
      centre: "",
      source: "",
      partyMonth: "",
      action: "route",
      person: firstRep,
    };
  }
  return {
    label: rule.label,
    why: rule.why ?? "",
    guestsMin: rule.when.guestsMin == null ? "" : String(rule.when.guestsMin),
    guestsMax: rule.when.guestsMax == null ? "" : String(rule.when.guestsMax),
    type: rule.when.type ?? "",
    kids: rule.when.kids === true,
    centre: rule.when.centre ?? "",
    source: rule.when.source ?? "",
    partyMonth: rule.when.partyMonth ?? "",
    action: actionOf(rule),
    person: rule.then.hold ?? rule.then.route ?? firstRep,
  };
}

function intOrUndefined(s: string): number | undefined {
  const t = s.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** The sheet → the POST body; `null` when the form cannot be saved (with the reason). */
export function ruleFromForm(
  form: RuleForm,
  id: string | undefined,
): { rule: RuleInputWire } | { error: string } {
  const label = form.label.trim();
  if (!label) return { error: "A name is required." };
  if (form.guestsMin.trim() !== "" && intOrUndefined(form.guestsMin) === undefined)
    return { error: "Guests at least must be a whole number." };
  if (form.guestsMax.trim() !== "" && intOrUndefined(form.guestsMax) === undefined)
    return { error: "Guests at most must be a whole number." };
  const guestsMin = intOrUndefined(form.guestsMin);
  const guestsMax = intOrUndefined(form.guestsMax);
  if (guestsMin !== undefined && guestsMax !== undefined && guestsMin > guestsMax)
    return { error: "Guests at least cannot exceed guests at most." };
  if (actionNeedsPerson(form.action) && !form.person) return { error: "Pick a person or team." };

  const when: RuleWhen = {};
  if (guestsMin !== undefined) when.guestsMin = guestsMin;
  if (guestsMax !== undefined) when.guestsMax = guestsMax;
  if (form.type) when.type = form.type;
  if (form.type === "birthday" && form.kids) when.kids = true;
  if (form.centre) when.centre = form.centre;
  if (form.source) when.source = form.source;
  if (form.partyMonth) when.partyMonth = form.partyMonth;

  const then: RuleThen = {};
  switch (form.action) {
    case "hold":
      then.hold = form.person;
      break;
    case "route":
      then.route = form.person;
      break;
    case "standard":
      then.standard = true;
      break;
    case "queue":
      then.queue = true;
      break;
    case "skipOff":
      then.skipOff = true;
      break;
    case "onShift":
      then.onShift = true;
      break;
  }
  const rule: RuleInputWire = {
    label,
    kind: kindOf(form.action),
    why: form.why.trim() || null,
    when,
    then,
  };
  if (id) rule.id = id;
  return { rule };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-12" → "Dec 2026" */
export function monthOptionLabel(ym: string): string {
  const m = Number(ym.slice(5, 7));
  return `${MON[m - 1] ?? ym.slice(5, 7)} ${ym.slice(0, 4)}`;
}

/** The next 12 party months from an ET YYYY-MM-DD, as `{value: "2026-10", label: "Oct 2026"}`. */
export function monthOptions(todayYmd: string, count = 12): { value: string; label: string }[] {
  const y = Number(todayYmd.slice(0, 4));
  const m = Number(todayYmd.slice(5, 7));
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < count; i++) {
    const total = m - 1 + i;
    const yy = y + Math.floor(total / 12);
    const mm = (total % 12) + 1;
    const value = `${yy}-${String(mm).padStart(2, "0")}`;
    out.push({ value, label: monthOptionLabel(value) });
  }
  return out;
}

/**
 * How long a lead that arrived unassigned waits before the safety net retries
 * it — the prototype's three delays, kept as the choices. The current value is
 * kept even when it is not one of them.
 *
 * The prototype's second select ("Outside business hours: Hold until 9 AM /
 * Assign anyway") is GONE with the rail it drove: the rules assign at capture
 * at all hours (owner, 2026-09-13 14:50).
 */
export const SWEEP_DELAY_OPTIONS: { value: number; label: string }[] = [
  { value: 60, label: "60 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 120, label: "2 hours" },
];

export function delayOptions(current: number): { value: number; label: string }[] {
  if (SWEEP_DELAY_OPTIONS.some((o) => o.value === current)) return SWEEP_DELAY_OPTIONS;
  return [{ value: current, label: `${current} minutes` }, ...SWEEP_DELAY_OPTIONS];
}

/** The wire trace → the `RuleTrace` primitive's rows (codes as the visible id). */
export function traceRows(decision: DecisionWire): { steps: RuleTraceRow[]; finalRuleId?: string } {
  return {
    steps: decision.trace.map((t) => ({
      ruleId: t.code,
      hit: t.hit,
      note: t.note,
      label: t.label,
    })),
    finalRuleId: decision.finalRuleCode ?? undefined,
  };
}

/** Parse the guests field of "Try a lead"; null when it is not a positive whole number. */
export function parseGuests(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : null;
}

// ---------------------------------------------------------------------------
// "Try a lead" fields: component state, mirrored to the URL
// ---------------------------------------------------------------------------

export interface TryFields {
  /** The RAW text of the guests box — "" while the director is retyping it. */
  guests: string;
  type: EventType;
  centre: CentreCode;
  eventDate: string;
}

/**
 * The scenario a link restores. `guests` is read back only when it parses, so a
 * URL never carries a half-typed number.
 */
export function tryFieldsFromQuery(
  query: Record<string, string>,
  defaults: TryFields,
  centres: readonly CentreOption[],
): TryFields {
  const type = query.type;
  const centre = query.centre;
  return {
    guests:
      query.guests !== undefined && parseGuests(query.guests) !== null
        ? query.guests
        : defaults.guests,
    type: isEventType(type) ? type : defaults.type,
    centre: centres.some((c) => c.code === centre) ? (centre as CentreCode) : defaults.centre,
    eventDate: /^\d{4}-\d{2}-\d{2}$/.test(query.eventDate ?? "")
      ? (query.eventDate as string)
      : defaults.eventDate,
  };
}

function isEventType(v: string | undefined): v is EventType {
  return !!v && (EVENT_TYPES as readonly string[]).includes(v);
}

/**
 * "635186, 730648" → `[635186, 730648]`; null when the text is not a list of
 * whole numbers (the Save button stays disabled). An empty box is an empty
 * list — a director saying no department covers the bucket.
 */
export function parseDepartmentIds(text: string): number[] | null {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const out: number[] = [];
  for (const part of trimmed.split(",")) {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n <= 0 || n > 2_147_483_647) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

export function applyTryPatch(prev: TryFields, patch: Partial<TryFields>): TryFields {
  return { ...prev, ...patch };
}

/**
 * The URL patch for the current fields.
 *
 * The guests box is the reason this exists: the URL helper drops any key set to
 * "", so reading the field straight back out of the query made it SNAP BACK to
 * the default the moment it was cleared — backspacing "42" to type "120" gave
 * "4", then "42", then "427…". The raw text now lives in component state and
 * only a value that parses is mirrored; an unparseable one removes the key, so
 * a shared link falls back to the default instead of restoring nonsense.
 */
export function tryUrlPatch(fields: TryFields): Record<string, string | null> {
  return {
    guests: parseGuests(fields.guests) === null ? null : fields.guests.trim(),
    type: fields.type,
    centre: fields.centre,
    eventDate: fields.eventDate || null,
  };
}
