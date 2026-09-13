/**
 * In-memory `MirrorDeps` for the mirror / delta tests: an Office reader fed
 * from the RAW-TEXT fixtures under `test/msw/fixtures` (parsed exactly as the
 * transport parses — `parseWithRawIds(text, OFFICE_ID_FIELDS)` — so the
 * 17-digit ids are exercised, never a JS object literal), a store that keeps
 * rows in a Map and reports `inserted` honestly, a linker that hands out
 * account ids per key, and an enqueue recorder.
 */

import { parseWithRawIds } from "@ft/db";
import type { EnqueueInput } from "~/features/crm/jobs";
import { fixtureText } from "@/test/msw/handlers/fixture";
import type { MirrorLink, SyncKind, SyncRun } from "./data/projects-mirror-db";
import type {
  HostLinker,
  MirrorDeps,
  MirrorStore,
  OfficeMetadata,
  OfficeReader,
} from "./service/deps";
import type {
  MirrorRow,
  OfficeDayPlanner,
  OfficeLiveReservation,
  OfficePersonEntity,
  OfficeProjectDetail,
  Projected,
} from "./service/projection";
import { OFFICE_ID_FIELDS } from "./transport";

export function officeParse<T>(text: string): T {
  return parseWithRawIds<T>(text, OFFICE_ID_FIELDS);
}

export const FIXTURE_PROJECT_ID = "58454076";
export const FIXTURE_ONLINE_PROJECT_ID = "58454077";
export const FIXTURE_HOST_PERSON_ID = "63000000009561437";
export const FIXTURE_ONLINE_PERSON_ID = "63000000009561440";
/** The BUSINESS record project 58454076 points at with `companyId`. */
export const FIXTURE_COMPANY_PERSON_ID = "63000000009561447";

export function fixtureMetadata(): OfficeMetadata {
  const meta = officeParse<{
    states: { id: string; name: string }[];
    users: { id: string; name: string }[];
    resources: { id: string; name: string }[];
    products: { id: string; name: string }[];
  }>(fixtureText("office-metadata.json.txt"));
  return {
    stateNames: Object.fromEntries(meta.states.map((s) => [s.id, s.name])),
    userNames: Object.fromEntries(meta.users.map((u) => [u.id, u.name])),
    productNames: Object.fromEntries(meta.products.map((p) => [p.id, p.name])),
    resourceIds: meta.resources.map((r) => r.id),
    stateIds: [
      "-2",
      "-3",
      "-4",
      "-5",
      "-106",
      ...meta.states.map((s) => s.id).filter((id) => Number(id) > 0),
    ],
  };
}

export const FIXTURE_PROJECTS: Record<string, () => OfficeProjectDetail> = {
  [FIXTURE_PROJECT_ID]: () => officeParse(fixtureText("office-project-58454076.json.txt")),
  [FIXTURE_ONLINE_PROJECT_ID]: () => officeParse(fixtureText("office-project-58454077.json.txt")),
};

export const FIXTURE_PERSONS: Record<string, () => OfficePersonEntity> = {
  [FIXTURE_HOST_PERSON_ID]: () =>
    officeParse(fixtureText("office-person-63000000009561437.json.txt")),
  [FIXTURE_ONLINE_PERSON_ID]: () =>
    officeParse(fixtureText("office-person-63000000009561440.json.txt")),
  [FIXTURE_COMPANY_PERSON_ID]: () =>
    officeParse(fixtureText("office-person-63000000009561447.json.txt")),
};

export interface OfficeCall {
  op: "metadata" | "dayPlanner" | "project" | "person" | "liveReservations";
  args: unknown[];
}

export interface MemoryOffice extends OfficeReader {
  calls: OfficeCall[];
  /** Ids whose `project()` read should throw (simulate a 404 / timeout). */
  failProjects: Set<string>;
  /** When set, `metadata()` throws. */
  failMetadata: Error | null;
  /** Override the tenant's resource ids (default: the metadata fixture's two). */
  resourceIds: string[] | null;
  /** Serve the dayPlanner fixture with every project as a GROUP event (kindId -1). */
  allGroupEvents: boolean;
  liveRows: () => OfficeLiveReservation[];
}

export function memoryOffice(): MemoryOffice {
  const office: MemoryOffice = {
    calls: [],
    failProjects: new Set(),
    failMetadata: null,
    resourceIds: null,
    allGroupEvents: false,
    liveRows: () =>
      officeParse<OfficeLiveReservation[]>(fixtureText("office-livereservations.json.txt")),
    async metadata(ck) {
      office.calls.push({ op: "metadata", args: [ck] });
      if (office.failMetadata) throw office.failMetadata;
      const meta = fixtureMetadata();
      return office.resourceIds ? { ...meta, resourceIds: office.resourceIds } : meta;
    },
    async dayPlanner(ck, resourceIds, from, till) {
      office.calls.push({ op: "dayPlanner", args: [ck, [...resourceIds], from, till] });
      const dp = officeParse<OfficeDayPlanner>(fixtureText("office-dayplanner-2025-09.json.txt"));
      if (office.allGroupEvents) {
        for (const p of dp.reservations?.projects ?? [])
          if (String(p.kindId) === "-10") p.kindId = "-1";
      }
      return dp;
    },
    async project(ck, id, tag) {
      office.calls.push({ op: "project", args: [ck, id, tag] });
      if (office.failProjects.has(id)) throw new Error(`Office GET project/${id} failed: 404`);
      const f = FIXTURE_PROJECTS[id];
      if (!f) throw new Error(`Office GET project/${id} failed: 404 Not found`);
      return f();
    },
    async person(ck, id, tag) {
      office.calls.push({ op: "person", args: [ck, id, tag] });
      const f = FIXTURE_PERSONS[id];
      return f ? f() : null;
    },
    async liveReservations(ck, from, until, stateIds) {
      office.calls.push({ op: "liveReservations", args: [ck, from, until, [...stateIds]] });
      return office.liveRows();
    },
  };
  return office;
}

export interface MemoryStore extends MirrorStore {
  rows: Map<string, { row: MirrorRow; link: MirrorLink; writes: number }>;
  runs: SyncRun[];
  /** Seed the delta watermark. */
  seedRun(run: Partial<SyncRun> & { clientKey: string; kind: SyncKind }): void;
}

export function memoryStore(): MemoryStore {
  let nextId = 1;
  const store: MemoryStore = {
    rows: new Map(),
    runs: [],
    seedRun(run) {
      store.runs.push({
        id: String(nextId++),
        windowFrom: null,
        windowUntil: null,
        rowsSeen: 0,
        rowsUpserted: 0,
        ok: true,
        error: null,
        startedAt: "2026-09-12T20:00:00.000Z",
        finishedAt: "2026-09-12T20:00:05.000Z",
        ...run,
      });
    },
    async upsert(row, link) {
      const prev = store.rows.get(row.projectId);
      store.rows.set(row.projectId, {
        row,
        link: {
          accountId: link.accountId ?? prev?.link.accountId ?? null,
          contactId: link.contactId ?? prev?.link.contactId ?? null,
        },
        writes: (prev?.writes ?? 0) + 1,
      });
      return { inserted: !prev };
    },
    async upsertMany(rows) {
      let inserted = 0;
      for (const row of rows) {
        const { inserted: ins } = await store.upsert(row, { accountId: null, contactId: null });
        if (ins) inserted++;
      }
      return { inserted, written: rows.length };
    },
    async kinds(ids) {
      const out = new Map<string, string | null>();
      for (const id of ids) {
        const r = store.rows.get(id);
        if (r) out.set(id, r.row.kindId);
      }
      return out;
    },
    async startRun(input) {
      const id = String(nextId++);
      store.runs.push({
        id,
        clientKey: input.clientKey,
        kind: input.kind,
        windowFrom: input.windowFrom,
        windowUntil: input.windowUntil,
        rowsSeen: null,
        rowsUpserted: null,
        ok: false,
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      });
      return id;
    },
    async finishRun(id, result) {
      const run = store.runs.find((r) => r.id === id);
      if (!run) return null;
      Object.assign(run, { ...result, finishedAt: new Date().toISOString() });
      return run;
    },
    async lastOkRun(clientKey, kind) {
      const ok = store.runs.filter(
        (r) => r.clientKey === clientKey && r.kind === kind && r.ok && r.finishedAt,
      );
      ok.sort((a, b) => (b.windowUntil ?? "").localeCompare(a.windowUntil ?? ""));
      return ok[0] ?? null;
    },
  };
  return store;
}

export interface MemoryLinker extends HostLinker {
  accounts: Map<string, string>;
  contacts: Map<string, string>;
  refreshed: string[][];
  linked: Projected[];
}

export function memoryLinker(): MemoryLinker {
  let next = 100;
  const linker: MemoryLinker = {
    accounts: new Map(),
    contacts: new Map(),
    refreshed: [],
    linked: [],
    async link(projected) {
      linker.linked.push(projected);
      let accountId: string | null = null;
      if (projected.account) {
        const key = `${projected.account.kind}:${projected.account.nameKey}`;
        if (!linker.accounts.has(key)) linker.accounts.set(key, String(next++));
        accountId = linker.accounts.get(key)!;
      }
      let contactId: string | null = null;
      if (projected.contact) {
        const key =
          projected.contact.bmiPersonId ??
          projected.contact.phoneE164 ??
          projected.contact.emailKey ??
          "?";
        if (!linker.contacts.has(key)) linker.contacts.set(key, String(next++));
        contactId = linker.contacts.get(key)!;
      }
      return { accountId, contactId };
    },
    async refresh(ids) {
      linker.refreshed.push([...ids]);
    },
  };
  return linker;
}

export interface MemoryDeps extends MirrorDeps {
  office: MemoryOffice;
  store: MemoryStore;
  linker: MemoryLinker;
  enqueued: Array<EnqueueInput & { created: boolean }>;
  clock: { now: Date; advanceMs: number };
}

/** `advanceMs` moves the clock forward on EVERY `now()` call (budget tests). */
export function memoryDeps(now = new Date("2026-09-12T23:30:00.000Z"), advanceMs = 0): MemoryDeps {
  const keys = new Set<string>();
  const deps: MemoryDeps = {
    office: memoryOffice(),
    store: memoryStore(),
    linker: memoryLinker(),
    enqueued: [],
    clock: { now, advanceMs },
    async enqueue(input) {
      const created = !keys.has(input.idempotencyKey);
      keys.add(input.idempotencyKey);
      deps.enqueued.push({ ...input, created });
      return { created };
    },
    now() {
      const t = deps.clock.now;
      deps.clock.now = new Date(t.getTime() + deps.clock.advanceMs);
      return t;
    },
  };
  return deps;
}
