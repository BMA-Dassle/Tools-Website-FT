/**
 * Shared re-attach brain for kiosk_waiver_joins rows whose BMI attach never
 * landed — used by BOTH the manual admin backfill route
 * (/api/admin/waiver-attach-backfill, the archaeology tool) and the
 * kiosk-bmi-sync-sweep cron (the standing retry for recent failures).
 *
 * The safety rules live HERE so the two callers can never drift:
 *
 * 1. RECONCILE BEFORE RE-POSTING. `bmi_attach_status` is our record of what
 *    happened, not a statement about what BMI holds, and the two drift in BOTH
 *    directions (2026-08-08: the Fort Myers counter hand-added 16 of H3194's
 *    signers while our rows still said 'failed'). The live projectPersons
 *    roster is read from BMI first and treated as the authority; a row BMI
 *    already satisfies is corrected in Neon and never sent — whether a second
 *    POST creates a DUPLICATE projectPerson row is still unproven, so we never
 *    find out by accident.
 *
 * 2. UNREADABLE ≠ EMPTY. A project whose roster can't be read is skipped, not
 *    treated as "nobody attached" — a transient Office failure must never
 *    become a duplicate.
 *
 * 3. BARRIER A (cron only, `requirePersonVisible`). A kiosk-minted person is
 *    born on the Pandora/LOCAL side and reaches the cloud only via Fast WSync's
 *    local→cloud leg — the one that can jam for hours. Re-POSTing the attach
 *    before the person exists cloud-side just re-fails; the cron waits until
 *    the Office person GET resolves (owner 2026-08-12: "if they sign via
 *    pandora we need to wait for it to get to office"). The manual route skips
 *    this gate so archaeology on old rows (whose persons long since synced)
 *    behaves exactly as before.
 */
import redis from "@/lib/redis";
import { clientKeyForLocation } from "~/features/daily-events/service";
import {
  setJoinAttachStatus,
  type KioskWaiverJoinRow,
} from "~/features/kiosk/data/kiosk-waiver-joins-db";
import { registerProjectPersonServer } from "./bmi-attach";
import { resolveAttachOrderId } from "./attach-order-id";
import { fetchProjectRawIds, fetchOfficePerson } from "@/lib/bmi-office-actions";
import { rosterCacheKey } from "./cache";

export interface AttachRowOutcome {
  projectId: string;
  personId: string;
  displayName: string;
  priorStatus: string;
  outcome:
    | "would-reattach"
    | "attached"
    | "failed"
    /** BMI already has this person — nothing was POSTed; our row was the stale one. */
    | "already-on-bmi"
    | "would-mark-attached"
    /** Barrier A: the person isn't visible on the Office cloud yet — the
     *  local→cloud sync hasn't delivered them. Left untouched for a later tick. */
    | "waiting-person-sync"
    | "skipped-no-order"
    | "skipped-project-unreadable"
    | "skipped-no-clientkey"
    /** Deadline hit before this row was reached — next tick picks it up. */
    | "deferred";
  detail?: string;
}

export interface ReattachSummary {
  outcomes: AttachRowOutcome[];
  counts: Record<string, number>;
}

/** Person ids currently on the reservation, per BMI. Empty set ≠ "nobody" — see header. */
export function projectPersonIds(project: Record<string, unknown>): Set<string> {
  const rows = (project.projectPersons ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows)) return new Set();
  return new Set(
    rows
      .map((r) => (r?.personId === undefined || r?.personId === null ? "" : String(r.personId)))
      .filter(Boolean),
  );
}

export async function reattachJoinRows(
  candidates: KioskWaiverJoinRow[],
  opts: {
    dryRun: boolean;
    /** Barrier A — see header rule 3. The cron passes true. */
    requirePersonVisible?: boolean;
    /** Wall-clock cutoff (Date.now() ms): rows not reached report 'deferred'. */
    deadlineAtMs?: number;
  },
): Promise<ReattachSummary> {
  const outcomes: AttachRowOutcome[] = [];
  const touchedProjects = new Set<string>();

  // Per-project memo: the live BMI roster and the resolved order id are project
  // facts, not row facts — reading them once per project keeps a 20-person party
  // to one project GET instead of twenty.
  const rosterByProject = new Map<string, Set<string> | null>();
  const orderIdByProject = new Map<string, string | null>();

  for (const row of candidates) {
    const base = {
      projectId: row.projectId,
      personId: row.personId,
      displayName: row.displayName,
      priorStatus: row.bmiAttachStatus,
    };
    if (opts.deadlineAtMs && Date.now() > opts.deadlineAtMs) {
      outcomes.push({ ...base, outcome: "deferred" });
      continue;
    }
    const clientKey = clientKeyForLocation(row.locationId);
    if (!clientKey) {
      outcomes.push({ ...base, outcome: "skipped-no-clientkey" });
      continue;
    }

    // Rule 1: reconcile against the LIVE roster before any POST.
    if (!rosterByProject.has(row.projectId)) {
      const project = await fetchProjectRawIds(clientKey, row.projectId).catch(() => null);
      rosterByProject.set(row.projectId, project ? projectPersonIds(project) : null);
    }
    const roster = rosterByProject.get(row.projectId) ?? null;
    if (roster === null) {
      // Rule 2: unreadable ≠ empty.
      outcomes.push({ ...base, outcome: "skipped-project-unreadable" });
      continue;
    }
    if (roster.has(row.personId)) {
      if (opts.dryRun) {
        outcomes.push({ ...base, outcome: "would-mark-attached" });
      } else {
        await setJoinAttachStatus(row.projectId, row.personId, "attached").catch(() => {});
        touchedProjects.add(row.projectId);
        outcomes.push({ ...base, outcome: "already-on-bmi" });
      }
      continue;
    }

    // Rule 3 (cron): don't POST an attach for a person the cloud can't see yet.
    if (opts.requirePersonVisible) {
      const person = await fetchOfficePerson(row.personId, clientKey);
      if (!person) {
        outcomes.push({ ...base, outcome: "waiting-person-sync" });
        continue;
      }
    }

    if (!orderIdByProject.has(row.projectId)) {
      const resolved = await resolveAttachOrderId({ clientKey, projectId: row.projectId }).catch(
        () => null,
      );
      orderIdByProject.set(row.projectId, resolved?.orderId ?? null);
    }
    const orderId = orderIdByProject.get(row.projectId) ?? null;
    if (!orderId) {
      outcomes.push({ ...base, outcome: "skipped-no-order" });
      continue;
    }
    if (opts.dryRun) {
      outcomes.push({ ...base, outcome: "would-reattach", detail: `orderId ${orderId}` });
      continue;
    }
    try {
      const result = await registerProjectPersonServer({
        clientKey,
        orderId,
        personId: row.personId,
        // Old rows may predate the first/last name columns — the display name's
        // leading token is the best available fallback for BMI's required field.
        firstName: row.firstName ?? row.displayName.split(" ")[0] ?? "Guest",
        lastName: row.lastName ?? "",
      });
      if (result.ok) {
        await setJoinAttachStatus(row.projectId, row.personId, "attached").catch(() => {});
        touchedProjects.add(row.projectId);
        outcomes.push({ ...base, outcome: "attached" });
      } else {
        const detail = `${result.status}: ${result.body.slice(0, 300)}`;
        await setJoinAttachStatus(row.projectId, row.personId, "failed", detail).catch(() => {});
        outcomes.push({ ...base, outcome: "failed", detail });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "attach error";
      await setJoinAttachStatus(row.projectId, row.personId, "failed", detail).catch(() => {});
      outcomes.push({ ...base, outcome: "failed", detail });
    }
  }

  // Bust roster caches for every project whose attach state changed.
  for (const pid of touchedProjects) {
    redis.del(rosterCacheKey(pid)).catch(() => {});
  }

  const counts = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.outcome] = (acc[o.outcome] ?? 0) + 1;
    return acc;
  }, {});

  return { outcomes, counts };
}
