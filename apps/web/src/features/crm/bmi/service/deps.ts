/**
 * The seams the mirror jobs run through (brief §3.10: "pure services take a
 * `Db`-shaped dependency"). `mirror.test.ts` / `delta.test.ts` hand in an
 * Office reader fed from raw-text fixtures, an in-memory store and a fake
 * linker; production uses `defaultMirrorDeps()`.
 *
 * WHY THE LINKER IS A SEAM AND NOT AN IMPORT: accounts and contacts live in the
 * leads sub, and the declared import direction is `leads → bmi` (§3.2). The
 * bmi sub therefore never imports `~/features/crm/leads` statically; the
 * default linker resolves it with a dynamic import at call time, and the
 * static module graph stays acyclic.
 */

import { BUILTIN_PROJECT_STATES } from "~/features/daily-events/constants";
import type { EnqueueInput } from "~/features/crm/jobs";
import { RESOURCE_IDS } from "~/features/daily-events/constants";
import {
  finishSyncRun,
  getMirrorKinds,
  lastOkSyncRun,
  startSyncRun,
  upsertMirrorRow,
  upsertMirrorRowsBulk,
  type MirrorLink,
  type SyncKind,
  type SyncRun,
} from "../data/projects-mirror-db";
import {
  OfficeApiError,
  getMetadataLookups,
  mapWithConcurrency,
  officeDayPlanner,
  officeLiveReservations,
  officePerson,
  officeProject,
  tenantFacts,
} from "../transport";
import type {
  MirrorRow,
  NameLookups,
  OfficeDayPlanner,
  OfficeLiveReservation,
  OfficePersonEntity,
  OfficeProjectDetail,
  Projected,
} from "./projection";

export { mapWithConcurrency };

export interface OfficeMetadata extends NameLookups {
  /** Every resource id Office knows (incl. resource groups) — the dayPlanner filter. */
  resourceIds: string[];
  /** Built-in + positive custom state ids — the liveReservations filter. */
  stateIds: string[];
}

export interface OfficeReader {
  metadata(clientKey: string): Promise<OfficeMetadata>;
  dayPlanner(
    clientKey: string,
    resourceIds: readonly string[],
    fromYmd: string,
    tillYmd: string,
  ): Promise<OfficeDayPlanner>;
  project(clientKey: string, projectId: string, sessionTag: string): Promise<OfficeProjectDetail>;
  /** null when Office answers 404 for the person. */
  person(
    clientKey: string,
    personId: string,
    sessionTag: string,
  ): Promise<OfficePersonEntity | null>;
  liveReservations(
    clientKey: string,
    fromLocal: string,
    untilLocal: string,
    stateIds: readonly string[],
  ): Promise<OfficeLiveReservation[]>;
}

export interface MirrorStore {
  upsert(row: MirrorRow, link: MirrorLink): Promise<{ inserted: boolean }>;
  /** Stub rows by the thousand, one statement per 500; no links. */
  upsertMany(rows: readonly MirrorRow[]): Promise<{ inserted: number; written: number }>;
  /** `project_id → kind_id` for ids already mirrored. */
  kinds(projectIds: readonly string[]): Promise<Map<string, string | null>>;
  startRun(input: {
    clientKey: string;
    kind: SyncKind;
    windowFrom: string | null;
    windowUntil: string | null;
  }): Promise<string>;
  finishRun(
    id: string,
    result: { rowsSeen: number; rowsUpserted: number; ok: boolean; error: string | null },
  ): Promise<SyncRun | null>;
  lastOkRun(clientKey: string, kind: SyncKind): Promise<SyncRun | null>;
}

export interface HostLinker {
  /** Upsert the account + contact a projected row belongs to; ids or nulls. */
  link(projected: Projected): Promise<MirrorLink>;
  /** Recompute lifetime totals for the accounts a run touched. */
  refresh(accountIds: readonly string[]): Promise<void>;
}

export interface MirrorDeps {
  office: OfficeReader;
  store: MirrorStore;
  linker: HostLinker;
  enqueue(input: EnqueueInput): Promise<{ created: boolean }>;
  now(): Date;
}

/** Office through the CRM transport (precision-safe parse, tagged sessions). */
export const officeReader: OfficeReader = {
  async metadata(clientKey) {
    // Names from the shared 2 h lookup cache; resource ids from the tenant's
    // OWN metadata (`resourceNames` merges the Fort Myers constants into every
    // tenant and would send Naples 120 ids, past IIS's query-string limit).
    const [meta, facts] = await Promise.all([
      getMetadataLookups(clientKey),
      tenantFacts(clientKey),
    ]);
    const fromMetadata = facts.resourceIds;
    const custom = Object.keys(meta.stateNames).filter((id) => Number(id) > 0);
    // Union with the curated list daily-events queries: it carries the pseudo
    // resource "-1" (FastTrax) that the metadata blob does not list (probed
    // 2026-09-13: 1 December project only the curated list found).
    const resourceIds = [...new Set([...fromMetadata, ...(RESOURCE_IDS[clientKey] ?? [])])];
    return {
      stateNames: meta.stateNames,
      // The shared lookup's curated names win; the tenant's own `username`
      // fills the gaps it cannot (every Naples staff id — see `tenantFacts`).
      userNames: { ...facts.userNames, ...meta.userNames },
      productNames: meta.productNames,
      resourceIds,
      stateIds: [...new Set([...BUILTIN_PROJECT_STATES, ...custom])],
    };
  },
  dayPlanner(clientKey, resourceIds, fromYmd, tillYmd) {
    return officeDayPlanner<OfficeDayPlanner>(clientKey, resourceIds, fromYmd, tillYmd);
  },
  project(clientKey, projectId, sessionTag) {
    return officeProject<OfficeProjectDetail>(clientKey, projectId, sessionTag);
  },
  async person(clientKey, personId, sessionTag) {
    try {
      return await officePerson<OfficePersonEntity>(clientKey, personId, sessionTag);
    } catch (err) {
      if (err instanceof OfficeApiError && err.status === 404) return null;
      throw err;
    }
  },
  async liveReservations(clientKey, fromLocal, untilLocal, stateIds) {
    const rows = await officeLiveReservations<OfficeLiveReservation[]>(
      clientKey,
      fromLocal,
      untilLocal,
      stateIds,
    );
    return Array.isArray(rows) ? rows : [];
  },
};

export const neonMirrorStore: MirrorStore = {
  upsert: upsertMirrorRow,
  upsertMany: upsertMirrorRowsBulk,
  kinds: getMirrorKinds,
  startRun: startSyncRun,
  finishRun: finishSyncRun,
  lastOkRun: lastOkSyncRun,
};

/** Accounts + contacts through the leads sub, resolved at call time (see header). */
export const leadsLinker: HostLinker = {
  async link(projected) {
    const leads = await import("~/features/crm/leads");
    let accountId: string | null = null;
    if (projected.account) {
      const acct = await leads.upsertAccountByKey({
        kind: projected.account.kind,
        name: projected.account.name,
        nameKey: projected.account.nameKey,
        centre: centreOf(projected.row.locationId),
      });
      accountId = acct.id;
    }
    let contactId: string | null = null;
    if (projected.contact) {
      const { contact } = await leads.upsertContactFromBmi({
        firstName: projected.contact.firstName,
        lastName: projected.contact.lastName,
        phoneE164: projected.contact.phoneE164,
        email: projected.contact.email,
        emailKey: projected.contact.emailKey,
        bmiPersonId: projected.contact.bmiPersonId,
        accountId,
      });
      contactId = contact.id;
    }
    return { accountId, contactId };
  },
  async refresh(accountIds) {
    if (accountIds.length === 0) return;
    const leads = await import("~/features/crm/leads");
    await leads.refreshAccountLifetime(accountIds);
  },
};

function centreOf(locationId: number | null): "HPFM" | "FT" | "HPN" | null {
  if (locationId === 332160) return "HPFM";
  if (locationId === 467486) return "FT";
  if (locationId === 332145) return "HPN";
  return null;
}

/**
 * Production deps. The job store is reached with a dynamic import for the same
 * reason as the linker: `jobs/registry.ts` imports this sub's handlers, so a
 * static import of `~/features/crm/jobs` from here would be a cycle whose
 * `HANDLERS` literal could evaluate before the handler binding exists (TDZ).
 */
export function defaultMirrorDeps(): MirrorDeps {
  return {
    office: officeReader,
    store: neonMirrorStore,
    linker: leadsLinker,
    enqueue: async (input) => {
      const { neonJobStore } = await import("~/features/crm/jobs");
      const { created } = await neonJobStore.enqueue(input);
      return { created };
    },
    now: () => new Date(),
  };
}
