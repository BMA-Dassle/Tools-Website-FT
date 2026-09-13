import { CENTRES, OFFICE_CLIENT_KEYS, centresForClientKey } from "~/features/crm/core/centres";
import type { HistoryAccount, MirrorEvent } from "~/features/crm/core/contracts";
import { fDateY, shiftYmd, todayEasternYmd } from "~/features/crm/core/dates";
import { money, plural } from "~/features/crm/core/format";
import type { CentreCode, OfficeClientKey } from "~/features/crm/core/types";

/**
 * Pure helpers behind the History & Account screens — the part a test can
 * hold. Copy comes from the prototype (`crm-shared.js:428-436`).
 */

export function centreShort(code: CentreCode | null): string | null {
  return code ? CENTRES[code].short : null;
}

export function centreName(code: CentreCode | null): string | null {
  return code ? CENTRES[code].name : null;
}

/** `["3 events", "HP Fort Myers", "Renee Alvarado, Thomas Ng"]` — the account row's meta. */
export function accountMeta(a: HistoryAccount): string[] {
  const out = [plural(a.eventCount, "event")];
  const c = centreShort(a.centre);
  if (c) out.push(c);
  if (a.contactNames.length) out.push(a.contactNames.join(", "));
  return out;
}

/** `Business · HeadPinz Fort Myers · lifetime $14,260` — the account page's sub line. */
export function accountSub(a: HistoryAccount): string {
  const parts = [a.kind === "business" ? "Business" : "Household"];
  const n = centreName(a.centre);
  if (n) parts.push(n);
  parts.push(`lifetime ${money(a.lifetimeCents)}`);
  return parts.join(" · ");
}

export function avgSpendCents(
  a: Pick<HistoryAccount, "lifetimeCents" | "eventCount">,
): number | null {
  return a.eventCount > 0 ? Math.round(a.lifetimeCents / a.eventCount) : null;
}

/** The host line for an event: the person, else the project name, else the ref. */
export function eventHost(e: MirrorEvent): string {
  return e.personName || e.name || e.number || `Project ${e.projectId}`;
}

/** `[fDateY, "38 guests", "$2,890", "HP Fort Myers", "H2306"]` — the last-year row's meta. */
export function eventMeta(e: MirrorEvent): string[] {
  const out: string[] = [];
  if (e.eventDate) out.push(fDateY(e.eventDate));
  if (e.persons !== null) out.push(plural(e.persons, "guest"));
  if (e.totalValueCents !== null) out.push(money(e.totalValueCents));
  const c = centreShort(e.centre);
  if (c) out.push(c);
  if (e.number) out.push(e.number);
  return out;
}

const RANGE_A = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
});
const RANGE_B = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  year: "numeric",
});

function midday(ymd: string): Date {
  return new Date(`${ymd}T12:00:00-04:00`);
}

/** `"Oct 5 – Nov 7, 2025"` — the prototype's window pill. */
export function windowLabel(w: { from: string; till: string }): string {
  return `${RANGE_A.format(midday(w.from))} – ${RANGE_B.format(midday(w.till))}`;
}

/** What "was Kelsea's" says under the reach-out button; null when unattributed. */
export function wasRepLabel(e: MirrorEvent): string | null {
  const first = e.rep?.firstName ?? e.responsibleName?.split(/\s+/)[0] ?? null;
  return first ? `was ${first}'s` : null;
}

export interface TenantOption {
  clientKey: OfficeClientKey;
  /** "HP Fort Myers · FastTrax" */
  label: string;
}

/** One backfill target per Office tenant, labelled by the centres it serves. */
export function tenantOptions(): TenantOption[] {
  return OFFICE_CLIENT_KEYS.map((ck) => ({
    clientKey: ck,
    label: centresForClientKey(ck)
      .map((c) => c.short)
      .join(" · "),
  }));
}

/** The backfill form's defaults: the last 12 months, ET. */
export function backfillDefaults(now: Date = new Date()): { from: string; until: string } {
  const until = todayEasternYmd(now);
  return { from: shiftYmd(until, -365), until };
}

export function isYmd(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));
}

/** `+12395551234` → `(239) 555-1234`; anything else verbatim. */
export function prettyPhone(e164: string | null): string | null {
  if (!e164) return null;
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
