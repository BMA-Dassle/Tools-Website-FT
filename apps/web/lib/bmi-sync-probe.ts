/**
 * Which barrier a queue row wants, resolved to a probe.
 *
 * Extracted from `/api/cron/bmi-sync-queue` so the cron and the Vercel Queues
 * consumer ask the SAME question. Two copies of this would drift, and the drift
 * would be silent: a barrier the cron knows and the consumer does not (or the
 * reverse) reads as "unknown barrier" and burns attempts on a row that is fine.
 * That already happened once across deploys — a preview wrote a `persons-local`
 * row into the production table and production's code did not recognise it
 * (2026-08-13, row #170, 20 attempts).
 *
 * DO NOT fork this. Import it.
 */
import {
  personLocalBarrier,
  personsLocalBarrier,
  personCloudBarrier,
  projectLocalBarrier,
  partyReadyBarrier,
  partySeatedBarrier,
  type BarrierResult,
  nyWallClockKey,
  type SeatRef,
} from "@/lib/bmi-sync-barriers";
import type { SyncQueueRow } from "@/lib/bmi-sync-queue";

/** FastTrax racing. The historical default for rows written without a location. */
const DEFAULT_LOCATION_ID = "LAB52GY480CJF";

/** Rows whose barrier needs a ref it does not have are treated as unbarriered
 *  rather than stuck forever. */
export async function probeBarrier(row: SyncQueueRow): Promise<BarrierResult> {
  const ref = row.barrierRef;
  const loc = row.locationId || DEFAULT_LOCATION_ID;
  switch (row.barrier) {
    case "none":
      return { verdict: "open", detail: "no barrier" };
    case "person-local":
      if (!ref) return { verdict: "open", detail: "no barrierRef — treating as unbarriered" };
      return personLocalBarrier(loc, ref);
    case "person-cloud":
      if (!ref) return { verdict: "open", detail: "no barrierRef — treating as unbarriered" };
      return personCloudBarrier(ref, (row.payload.clientKey as string) || undefined);
    case "project-local":
      if (!ref) return { verdict: "open", detail: "no barrierRef — treating as unbarriered" };
      return projectLocalBarrier(loc, ref);
    case "persons-local": {
      // Presence of EVERY named person, no waiver required — the guardian-signed
      // waiver write names both the minor and the signing adult. Falls back to
      // barrierRef so a row written with a single id still works.
      const ids = Array.isArray(row.payload.personIds)
        ? (row.payload.personIds as unknown[]).map(String).filter(Boolean)
        : ref
          ? [ref]
          : [];
      return personsLocalBarrier(loc, ids);
    }
    case "party-ready": {
      // The member list lives in the PAYLOAD, not barrierRef — this gate is about
      // N people, and an empty list closes rather than waving through.
      const ids = Array.isArray(row.payload.personIds)
        ? (row.payload.personIds as unknown[]).map(String).filter(Boolean)
        : [];
      return partyReadyBarrier(loc, ids);
    }
    case "party-seated": {
      const ids = Array.isArray(row.payload.personIds)
        ? (row.payload.personIds as unknown[]).map(String).filter(Boolean)
        : [];
      // Seats are the racer→heat pairs this check-in bound. A row written before
      // seats existed in the payload degrades to party-ready semantics rather
      // than blocking forever — an older deploy's row must never wedge.
      const seats: SeatRef[] = Array.isArray(row.payload.seats)
        ? (row.payload.seats as unknown[])
            .map((s) => s as { personId?: unknown; heatStart?: unknown })
            .filter(
              (s) => s && typeof s.personId !== "undefined" && typeof s.heatStart === "string",
            )
            .map((s) => ({ personId: String(s.personId), heatStart: String(s.heatStart) }))
        : [];
      // The row's own createdAt IS the check-in time — the stamp is enqueued
      // during check-in, and a resumed check-in refreshes the payload without
      // moving created_at. Converted to the same naive-ET key the seats use;
      // created_at is UTC, so it must NOT be sliced raw.
      return partySeatedBarrier(loc, ids, seats, nyWallClockKey(row.createdAt));
    }
    default:
      // Unknown barrier value (a row written by a newer deploy, say). Do NOT run
      // the handler blind — that is the whole class of bug this exists to stop.
      return { verdict: "error", detail: `unknown barrier "${row.barrier}"` };
  }
}
