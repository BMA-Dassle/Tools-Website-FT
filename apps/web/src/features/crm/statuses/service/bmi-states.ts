/**
 * Office project-state names, per tenant, and the map proposals built from
 * them (brief §1.8 "New Lead / Contacted / Quote / Deposit Requested ids
 * UNKNOWN → resolve by name").
 *
 * READ RAIL: `getMetadataLookups(clientKey).stateNames` from
 * `~/features/daily-events/data/bmi-office.ts` — the precision-safe transport
 * (Redis-cached 2 h). Nothing here calls Office any other way.
 *
 * NEVER INVENTS AN ID. A proposal is (seeded status id → the Office state whose
 * NAME matches the prototype's `bmi` column, `crm-data.js:44-55`). A name that
 * is not in the tenant's metadata yields no proposal; the Statuses screen shows
 * the status "unmapped" and the director picks by hand.
 *
 * WHEN OFFICE IS UNREACHABLE (auth failure, timeout, no Redis) the result is
 * `source: "unavailable"` with the error text — a 200 the screen can render,
 * never a 500. A local box whose `.env.local` lacks `BMI_OFFICE_PASSWORD_B64`
 * takes this path unless the transport's built-in default still authenticates.
 *
 * PROTOTYPE TABLE, VERBATIM — with two deliberate gaps:
 *   - "Pending Signed Contract" (the real Office label; the brief shortens it
 *     to "Pending Signed") gets NO proposal. Office moves a project there
 *     itself when the dispatch cron has emailed the contract (the Send
 *     Contract rail, `lib/bmi-office-actions.ts` / `app/api/cron/*`); writing
 *     it from the CRM would skip that rail. Our `contract` ("Contract sent")
 *     maps to "Send Contract", exactly as the prototype has it.
 *   - "Deposit Requested" gets NO proposal. The prototype maps `deposit`
 *     ("Deposit paid", a WON status) to "Confirmation"; "Deposit Requested" is
 *     a pre-payment Office state with no CRM counterpart in the seed. A
 *     director may still map it by hand. Fort Myers carries it PER CENTRE —
 *     "Deposit Requested (HPFM)" 3272786 and "Deposit Requested (FT)" 15737202
 *     — which `normalizeStateName` folds together on purpose.
 *
 * RESOLVED FROM LIVE METADATA (headpinzftmyers, 2026-09-12, via the local
 * `_crm-bmi-states.mts` wrapper): New Lead 3891928 · Contacted 7845185 · Send
 * Contract 49130082 · Pending Signed Contract 48952154 · Confirmation -3 ·
 * Confirmation + Waiver 3274635 · Cancellation -4 · Pending Quote -2. There is
 * NO state named "Quote" at Fort Myers, so `waiting` and `quote` receive no
 * proposal there; the director maps them (probably to "Pending Quote") on the
 * Statuses screen. Naples is read the same way when the screen asks for HPN.
 */

import { getMetadataLookups } from "~/features/daily-events/data/bmi-office";
import { CENTRES, isCentreCode } from "../../core/centres";
import type { OfficeStateName, OfficeStateProposal } from "../../core/contracts";
import type { CentreCode, OfficeClientKey } from "../../core/types";

/** Seeded status id → the Office state NAME the prototype pairs it with. */
export const STATUS_BMI_STATE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  new: "New Lead",
  assigned: "New Lead",
  contacted: "Contacted",
  waiting: "Quote",
  quote: "Quote",
  contract: "Send Contract",
  deposit: "Confirmation",
  confirmed: "Confirmation + Waiver",
  lost: "Cancellation",
  noresp: "Cancellation",
});

/** Office state names the prototype knows but the seed deliberately leaves unmapped. */
export const UNPROPOSED_OFFICE_STATES: readonly string[] = [
  "Pending Signed Contract",
  "Deposit Requested",
];

/** Lowercase, collapse whitespace, drop a trailing "(…)" suffix — the portal's KPI rule. */
export function normalizeStateName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** `{id, name}` list from the transport's `stateNames` record, sorted by name. */
export function stateNamesToList(stateNames: Readonly<Record<string, string>>): OfficeStateName[] {
  return Object.entries(stateNames)
    .map(([id, name]) => ({ id: String(id), name: String(name) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * Match seeded status ids to the tenant's states BY NAME. Pure. When two Office
 * states normalise to the same name the lowest positive id wins (custom ids are
 * positive; built-ins like Confirmation are negative and are preferred last
 * only because a tenant that redefined a built-in did so on purpose).
 */
export function proposeStatusMap(
  states: readonly OfficeStateName[],
  table: Readonly<Record<string, string>> = STATUS_BMI_STATE_NAMES,
): OfficeStateProposal[] {
  const byName = new Map<string, OfficeStateName>();
  for (const s of states) {
    const key = normalizeStateName(s.name);
    const prev = byName.get(key);
    if (!prev || rank(s.id) < rank(prev.id)) byName.set(key, s);
  }
  const out: OfficeStateProposal[] = [];
  for (const [statusId, wanted] of Object.entries(table)) {
    const hit = byName.get(normalizeStateName(wanted));
    if (hit) out.push({ statusId, bmiStateId: hit.id, bmiStateName: hit.name });
  }
  return out;
}

function rank(id: string): number {
  const n = Number(id);
  if (!Number.isFinite(n)) return Number.MAX_SAFE_INTEGER;
  return n > 0 ? n : Number.MAX_SAFE_INTEGER - 1;
}

export interface OfficeStatesResult {
  centre: CentreCode;
  clientKey: OfficeClientKey;
  source: "office" | "unavailable";
  error?: string;
  states: OfficeStateName[];
  proposals: OfficeStateProposal[];
}

/** Injected in tests; defaults to the real transport. */
export type MetadataReader = (clientKey: string) => Promise<{ stateNames: Record<string, string> }>;

/**
 * The tenant's state names for a centre code (or a clientKey directly), plus
 * proposals. Never throws.
 */
export async function listOfficeStateNames(
  centreOrClientKey: CentreCode | OfficeClientKey | string,
  read: MetadataReader = getMetadataLookups,
): Promise<OfficeStatesResult> {
  const centre: CentreCode = isCentreCode(centreOrClientKey)
    ? centreOrClientKey
    : centreOrClientKey === "headpinznaples"
      ? "HPN"
      : "HPFM";
  const clientKey = CENTRES[centre].clientKey;
  try {
    const meta = await read(clientKey);
    const states = stateNamesToList(meta.stateNames ?? {});
    return { centre, clientKey, source: "office", states, proposals: proposeStatusMap(states) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn("[crm] office state names unavailable", { clientKey, error });
    return { centre, clientKey, source: "unavailable", error, states: [], proposals: [] };
  }
}
