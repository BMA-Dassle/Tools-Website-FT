/**
 * The History & Accounts reads (brief B1): the three route handlers'
 * services, shaping mirror rows + accounts into the wire types in
 * `core/contracts.ts`. Reads only; nothing here touches Office.
 *
 * The REP on an event is joined server-side from `responsible_user_id` →
 * `crm_reps.bmi_user_id` (the KPI attribution key, §1.10), so the client
 * never needs a roster call to draw an avatar.
 */

import type {
  AccountResponse,
  HistoryAccount,
  HistoryResponse,
  LastYearResponse,
  MirrorEvent,
  MirrorRep,
  MirrorStatus,
} from "../../core/contracts";
import { listReps } from "~/features/crm/reps";
import {
  countMirrorProjects,
  listLastYearHosts,
  listMirrorProjectsForAccount,
  listSyncRuns,
  searchMirrorProjects,
  type MirrorProject,
} from "../data/projects-mirror-db";
import { centreCodeForLocation } from "./projection";
import { lastYearWindow } from "./windows";

// The account readers live in the leads sub; `leads → bmi` is the declared
// direction (§3.2), so they are reached with a dynamic import like the linker.
async function leads() {
  return import("~/features/crm/leads");
}

export type RepIndex = Map<string, MirrorRep>;

/** `bmi_user_id` → the rep chip. */
export async function repIndex(): Promise<RepIndex> {
  const reps = await listReps({ includeInactive: true });
  const idx: RepIndex = new Map();
  for (const r of reps) {
    if (r.bmiUserId)
      idx.set(r.bmiUserId, { slug: r.slug, firstName: r.firstName, initials: r.initials });
  }
  return idx;
}

export function toMirrorEvent(p: MirrorProject, reps: RepIndex): MirrorEvent {
  return {
    projectId: p.projectId,
    clientKey: p.clientKey,
    centre: centreCodeForLocation(p.locationId),
    number: p.number,
    name: p.name,
    eventDate: p.eventDate,
    eventStart: p.eventStart,
    persons: p.persons,
    stateId: p.stateId,
    stateName: p.stateName,
    kindId: p.kindId,
    responsibleUserId: p.responsibleUserId,
    responsibleName: p.responsibleName,
    rep: (p.responsibleUserId && reps.get(p.responsibleUserId)) || null,
    totalValueCents: p.totalValueCents,
    balanceCents: p.balanceCents,
    personName: p.personName,
    personPhone: p.personPhone,
    personEmail: p.personEmail,
    accountId: p.accountId,
    contactId: p.contactId,
    syncedAt: p.syncedAt,
  };
}

export async function mirrorStatus(): Promise<MirrorStatus> {
  const [count, runs] = await Promise.all([countMirrorProjects(), listSyncRuns({ limit: 8 })]);
  return {
    projects: count.total,
    groupEvents: count.groupEvents,
    runs: runs.map((r) => ({
      id: r.id,
      clientKey: r.clientKey,
      kind: r.kind,
      windowFrom: r.windowFrom,
      windowUntil: r.windowUntil,
      rowsSeen: r.rowsSeen,
      rowsUpserted: r.rowsUpserted,
      ok: r.ok,
      error: r.error,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    })),
  };
}

export interface HistoryQuery {
  q: string;
  limit?: number;
  accountsCursor?: string | null;
  eventsCursor?: string | null;
}

/** `GET /history?q=` — accounts + events matching, plus the mirror's state. */
export async function historySearch(input: HistoryQuery): Promise<Omit<HistoryResponse, "ok">> {
  const q = input.q.trim();
  const [{ searchAccounts }, reps] = await Promise.all([leads(), repIndex()]);
  const [accounts, events, mirror] = await Promise.all([
    searchAccounts(q, { limit: input.limit ?? 50, cursor: input.accountsCursor ?? null }),
    q
      ? searchMirrorProjects(q, { limit: input.limit ?? 50, cursor: input.eventsCursor ?? null })
      : { items: [], nextCursor: null },
    mirrorStatus(),
  ]);
  return {
    q,
    accounts: accounts.items.map(toHistoryAccount),
    accountsNextCursor: accounts.nextCursor,
    events: events.items.map((p) => toMirrorEvent(p, reps)),
    eventsNextCursor: events.nextCursor,
    mirror,
  };
}

function toHistoryAccount(a: {
  id: string;
  kind: "business" | "household";
  name: string;
  centre: HistoryAccount["centre"];
  lifetimeCents: number;
  eventCount: number;
  lastEventDate: string | null;
  contactNames: string[];
}): HistoryAccount {
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    centre: a.centre,
    lifetimeCents: a.lifetimeCents,
    eventCount: a.eventCount,
    lastEventDate: a.lastEventDate,
    contactNames: a.contactNames,
  };
}

/** `GET /accounts/[id]` — the account, its contacts and every mirrored event. */
export async function accountDetail(
  id: string,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<Omit<AccountResponse, "ok"> | null> {
  const { getAccountSummary, listContactsForAccount } = await leads();
  const account = await getAccountSummary(id);
  if (!account) return null;
  const [contacts, events, reps] = await Promise.all([
    listContactsForAccount(id),
    listMirrorProjectsForAccount(id, { limit: opts.limit ?? 100, cursor: opts.cursor ?? null }),
    repIndex(),
  ]);
  return {
    account: toHistoryAccount(account),
    contacts: contacts.map((c) => ({
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      phoneE164: c.phoneE164,
      email: c.email,
      bmiPersonId: c.bmiPersonId,
    })),
    events: events.items.map((p) => toMirrorEvent(p, reps)),
    eventsNextCursor: events.nextCursor,
  };
}

/** `GET /last-year` — hosts from the same 3–8 week window one year back, not yet back. */
export async function lastYearHosts(
  opts: { clientKey?: string; limit?: number; cursor?: string | null; now?: Date } = {},
): Promise<Omit<LastYearResponse, "ok">> {
  const window = lastYearWindow(opts.now ?? new Date());
  const [page, reps] = await Promise.all([
    listLastYearHosts({
      from: window.from,
      till: window.till,
      clientKey: opts.clientKey,
      limit: opts.limit ?? 50,
      cursor: opts.cursor ?? null,
    }),
    repIndex(),
  ]);
  return {
    window,
    items: page.items.map((p) => toMirrorEvent(p, reps)),
    nextCursor: page.nextCursor,
  };
}
