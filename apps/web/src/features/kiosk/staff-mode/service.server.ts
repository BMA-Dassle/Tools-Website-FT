import "server-only";
import { addMembership } from "@/lib/pandora-memberships";
import { addDeposit } from "@/lib/pandora-deposits";
import { PANDORA_LOCATION_MAP } from "@/lib/pandora-locations";
import {
  fetchOfficePerson,
  fetchOfficeDepositHistory,
  fetchOfficeRaceHistory,
} from "@/lib/bmi-office-actions";
import { hasActiveLicenseMembership } from "~/features/booking/service/license";
import { personLocalBarrier } from "@/lib/bmi-sync-barriers";
import {
  MAX_COMP_QTY,
  MAX_TERM_YEARS,
  addYears,
  clientKeyForStaffLocation,
  compKind,
  membershipKind,
} from "./catalog";
import {
  markStaffActionDone,
  markStaffActionFailed,
  recordStaffActionPending,
} from "./data/staff-actions-db";
import type { StaffEmployee, StaffLocation } from "./types";
import {
  shapeRaceHistory,
  summarizeRaceHistory,
  type RaceHistoryRow,
  type RaceHistorySummary,
} from "./race-history";

/**
 * Staff-mode SERVICE — the three things a staff member can do to a guest's BMI
 * account from a kiosk. Route handlers parse + authenticate and delegate here.
 *
 * WRITES ride the rails that already exist and are live-proven:
 *   membership → Pandora POST /v2/bmi/membership  (pandora-memberships.addMembership)
 *   comp       → Pandora POST /v2/bmi/deposit     (pandora-deposits.addDeposit — the
 *                same call the kiosk admin panel's comp action makes)
 * and every write is PERSIST-FIRST: a `kiosk_staff_actions` row goes in as
 * 'pending' before Pandora is called and is settled after (done / failed + error).
 *
 * WHICH PERSON ID. Pandora prefers the SHORT id (it rejects 17-digit Office ids
 * on several endpoints — 2026-07-18), so a resolved `pandoraPersonId` wins and
 * the Office id is the fallback. Office READS (the account view) use the Office
 * id. Both are raw digit strings end-to-end.
 *
 * ON-SITE FIRST (owner 2026-09-04: "just disable the buttons if it's not local
 * yet"). Pandora writes land on the center's LOCAL server, and a person created
 * cloud-side (web booking, Office desk) is not there until BMI's sync carries
 * them down. `isPersonLocal` is the one probe — the sync queue's own
 * `personLocalBarrier` (404 = not here yet, anything else = present) — used by
 * the kiosk to grey the Membership / Comp chips AND by both writes below to
 * refuse rather than fail against a person who is not local. No queueing: the
 * chips come back on their own once the sync lands and the kiosk re-checks.
 *
 * READS: the account view is Office person (memberships, raw, with dates) +
 * Office deposit history (balances) + Office `personStats/races` (every
 * finished heat, owner 2026-09-04) shaped by race-history.ts into rows, a best
 * per track and the closest climb to the next level.
 */

interface StaffContext {
  employee: StaffEmployee;
  kioskId: string | null;
  location: StaffLocation;
}

interface PersonRef {
  personId: string;
  pandoraPersonId?: string;
  personName?: string;
}

function pandoraLocationId(location: StaffLocation): string {
  return PANDORA_LOCATION_MAP[location];
}

function writeId(p: PersonRef): string {
  return p.pandoraPersonId || p.personId;
}

export interface PersonLocalStatus {
  /** true = on the local server; false = not yet (404); null = could not tell
   *  (vendor unreachable / errored) — the kiosk treats null as "not yet" and
   *  offers a re-check. */
  local: boolean | null;
  detail: string;
}

export async function isPersonLocal(
  personId: string,
  location: StaffLocation,
): Promise<PersonLocalStatus> {
  // diagnoseElsewhere off: a staff chip does not need the other-center hunt
  // the sync queue does before parking a row; it just needs yes / not yet.
  const r = await personLocalBarrier(pandoraLocationId(location), personId, {
    diagnoseElsewhere: false,
  });
  if (r.verdict === "open") return { local: true, detail: r.detail };
  if (r.verdict === "closed" || r.verdict === "impossible") {
    return { local: false, detail: r.detail };
  }
  return { local: null, detail: r.detail };
}

/** Refuse a write against a person who is not on the local server yet. */
async function assertLocal(p: PersonRef, location: StaffLocation): Promise<void> {
  const status = await isPersonLocal(writeId(p), location);
  if (status.local === true) return;
  throw new Error(
    status.local === false
      ? "This guest hasn't reached the on-site server yet — try again in a few minutes"
      : `Couldn't confirm the guest is on the on-site server (${status.detail})`,
  );
}

export interface StaffMembershipInput extends PersonRef {
  kindKey: string;
  /** ISO. Omitted → now (Pandora's own default). */
  activates?: string;
  /** ISO. Required — Pandora will not default it. */
  expires: string;
}

export async function grantStaffMembership(
  ctx: StaffContext,
  input: StaffMembershipInput,
): Promise<{ resultId: string; kindLabel: string }> {
  const kind = membershipKind(input.kindKey);
  if (!kind) throw new Error(`Unknown membership "${input.kindKey}"`);
  const kindId = kind.kindId[clientKeyForStaffLocation(ctx.location)];
  if (!kindId) {
    throw new Error(`${kind.label} has no membership-kind id configured for this center yet`);
  }
  const starts = input.activates ? new Date(input.activates) : new Date();
  const ends = new Date(input.expires);
  if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) {
    throw new Error("Start or end date is not a valid date");
  }
  if (ends <= starts) throw new Error("End date must be after the start date");
  if (ends > addYears(starts, MAX_TERM_YEARS)) {
    throw new Error(`Term is longer than ${MAX_TERM_YEARS} years`);
  }
  await assertLocal(input, ctx.location);

  const rowId = await recordStaffActionPending({
    kioskId: ctx.kioskId,
    location: ctx.location,
    employeeId: ctx.employee.id,
    employeeName: ctx.employee.name,
    cardTail: ctx.employee.cardTail,
    personId: input.personId,
    personName: input.personName ?? null,
    action: "membership",
    kindKey: kind.key,
    kindLabel: kind.label,
    kindId,
    activates: starts.toISOString(),
    expires: ends.toISOString(),
  });
  try {
    const id = await addMembership({
      personId: writeId(input),
      locationId: pandoraLocationId(ctx.location),
      membershipKindId: kindId,
      ...(input.activates ? { activates: starts.toISOString() } : {}),
      expires: ends.toISOString(),
    });
    await markStaffActionDone(rowId, id);
    console.log(
      `[staff-mode] ${ctx.employee.name} (${ctx.employee.id}) added ${kind.label} ` +
        `to person ${writeId(input)} until ${ends.toISOString()} — membership ${id}`,
    );
    return { resultId: id, kindLabel: kind.label };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "membership write failed";
    await markStaffActionFailed(rowId, msg).catch(() => {});
    throw new Error(msg);
  }
}

export interface StaffCompInput extends PersonRef {
  kindKey: string;
  qty: number;
  reason?: string;
}

export async function grantStaffComp(
  ctx: StaffContext,
  input: StaffCompInput,
): Promise<{ resultId: string; kindLabel: string }> {
  const kind = compKind(input.kindKey);
  if (!kind) throw new Error(`Unknown comp "${input.kindKey}"`);
  const kindId = kind.depositKindId[clientKeyForStaffLocation(ctx.location)];
  if (!kindId) {
    throw new Error(`${kind.label} comps have no deposit-kind id configured for this center yet`);
  }
  const qty = Math.trunc(input.qty);
  if (!(qty >= 1 && qty <= MAX_COMP_QTY)) {
    throw new Error(`Quantity must be between 1 and ${MAX_COMP_QTY}`);
  }
  const reason = input.reason?.trim() || null;
  await assertLocal(input, ctx.location);

  const rowId = await recordStaffActionPending({
    kioskId: ctx.kioskId,
    location: ctx.location,
    employeeId: ctx.employee.id,
    employeeName: ctx.employee.name,
    cardTail: ctx.employee.cardTail,
    personId: input.personId,
    personName: input.personName ?? null,
    action: "comp",
    kindKey: kind.key,
    kindLabel: kind.label,
    kindId,
    qty,
    reason,
  });
  try {
    const id = await addDeposit({
      personId: writeId(input),
      locationId: pandoraLocationId(ctx.location),
      depositKindId: kindId,
      amount: qty,
    });
    await markStaffActionDone(rowId, id);
    console.log(
      `[staff-mode] ${ctx.employee.name} (${ctx.employee.id}) added ${qty} × ${kind.label} comp ` +
        `to person ${writeId(input)}${reason ? ` — "${reason}"` : ""} — deposit ${id}`,
    );
    return { resultId: id, kindLabel: kind.label };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "comp write failed";
    await markStaffActionFailed(rowId, msg).catch(() => {});
    throw new Error(msg);
  }
}

export interface StaffAccountMembership {
  name: string;
  kindId: string | null;
  starts: string | null;
  stops: string | null;
  active: boolean;
}

export interface StaffAccountView {
  memberships: StaffAccountMembership[] | null;
  licenseActive: boolean | null;
  credits: Array<{ kind: string; balance: number }> | null;
  /** Finished heats, newest first. null = the read failed; [] = never raced. */
  heats: RaceHistoryRow[] | null;
  /** Derived from `heats`; null when heats is null. */
  summary: RaceHistorySummary | null;
}

/** The account view for the Race history sheet. Each source is independent
 *  and fail-open (null = that read failed, [] = genuinely nothing). */
export async function readStaffAccount(
  personId: string,
  location: StaffLocation,
): Promise<StaffAccountView> {
  const clientKey = clientKeyForStaffLocation(location);
  const [person, deposits, races] = await Promise.all([
    fetchOfficePerson(personId, clientKey),
    fetchOfficeDepositHistory(personId, clientKey),
    fetchOfficeRaceHistory(personId, clientKey),
  ]);
  const now = Date.now();
  let memberships: StaffAccountMembership[] | null = null;
  let licenseActive: boolean | null = null;
  if (person) {
    const raw = Array.isArray(person.memberships)
      ? (person.memberships as Array<Record<string, unknown>>)
      : [];
    memberships = raw
      .filter((m) => typeof m?.name === "string")
      .map((m) => {
        const stops = typeof m.stops === "string" ? m.stops : null;
        const starts = typeof m.starts === "string" ? m.starts : null;
        const kid = m.membershipKindId;
        return {
          name: m.name as string,
          kindId: kid == null ? null : String(kid),
          starts,
          stops,
          active: !stops || new Date(stops).getTime() > now,
        };
      })
      .sort((a, b) => Number(b.active) - Number(a.active));
    licenseActive = hasActiveLicenseMembership(
      raw as Array<{ name?: unknown; stops?: string | null }>,
    );
  }
  const credits = deposits
    ? deposits
        .filter((d) => typeof d?.balance === "number" && d.balance > 0 && d.depositKind)
        .map((d) => ({ kind: String(d.depositKind), balance: d.balance as number }))
    : null;
  const heats = races ? shapeRaceHistory(races) : null;
  return {
    memberships,
    licenseActive,
    credits,
    heats,
    summary: heats ? summarizeRaceHistory(heats) : null,
  };
}
