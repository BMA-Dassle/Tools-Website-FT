/**
 * Admin read model for the BMI sync queue — the watch surface the owner asked
 * for (2026-08-12): "on reservation admin, can you add a BMI sync that shows
 * anything that is in that table. Also can you add a pill to each bmi
 * reservation that is green when on-site is done. will help watch for these
 * problems."
 *
 * Two questions, one query each:
 *
 *  1. WHAT IS OUTSTANDING RIGHT NOW — `listSyncQueueForAdmin`. Every row, newest
 *     first, with the fields that tell an operator what to do: which kind, which
 *     barrier it is waiting behind, how many attempts, the last error, and how
 *     long it has been waiting. Parked rows sort FIRST because they are the ones
 *     nobody is coming to fix automatically.
 *
 *  2. IS THE ON-SITE WORK DONE FOR THIS RESERVATION — `syncStateForReservations`.
 *     Under cloud-first the guest's booking completes on the BMI cloud while the
 *     local (Pandora) work — waiver record, licence, grid seat — lands seconds to
 *     minutes later. The pill is how staff see that landing without opening BMI.
 *
 * The pill is deliberately THREE states, not two. "No rows" cannot mean "done":
 * a reservation that never needed local followups and one whose followups were
 * never enqueued look identical in this table, and painting the second one green
 * would be the same class of lie as a status field that claims more than it
 * knows (lessons § "a status field IS a claim"). So absence reads as `unknown`
 * and only positive evidence earns green.
 *
 * Read-only. Never throws — the board must render if the queue is unreachable.
 */
import { sql, isDbConfigured } from "@/lib/db";

export interface AdminSyncRow {
  id: number;
  kind: string;
  status: string;
  barrier: string;
  barrierRef: string | null;
  reservationRef: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  nextAttemptAt: string;
  giveUpAt: string | null;
  resolvedAt: string | null;
  /** Minutes since the row was created — how long this has been outstanding. */
  ageMin: number;
  /** Best-effort display name from the payload, so a row reads as a person. */
  who: string | null;
}

/** `green` = every local followup landed. `waiting` = something is still owed.
 *  `attention` = a row parked (gave up) — a human is needed.
 *  `unknown` = no rows at all, which is NOT the same as done. */
export type OnsiteState = "green" | "waiting" | "attention" | "unknown";

export interface ReservationSyncState {
  state: OnsiteState;
  pending: number;
  parked: number;
  done: number;
  /** The kinds still outstanding, for the pill's tooltip. */
  waitingKinds: string[];
  /** Oldest outstanding row's age in minutes — what makes a stall obvious. */
  oldestWaitingMin: number | null;
}

const EMPTY: ReservationSyncState = {
  state: "unknown",
  pending: 0,
  parked: 0,
  done: 0,
  waitingKinds: [],
  oldestWaitingMin: null,
};

function nameFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const first = typeof p.firstName === "string" ? p.firstName : "";
  const last = typeof p.lastName === "string" ? p.lastName : "";
  const name = typeof p.name === "string" ? p.name : "";
  const joined = `${first} ${last}`.trim() || name.trim();
  return joined || null;
}

/**
 * Everything in the table, for the admin panel. Parked first (needs a human),
 * then still-pending, then the resolved tail for context.
 */
export async function listSyncQueueForAdmin(
  opts: { limit?: number; includeDone?: boolean } = {},
): Promise<AdminSyncRow[]> {
  if (!isDbConfigured()) return [];
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  const includeDone = opts.includeDone ?? true;
  try {
    const q = sql();
    const rows = (await q`
      SELECT id, kind, status, barrier, barrier_ref, reservation_ref, attempts,
             last_error, created_at, next_attempt_at, give_up_at, resolved_at, payload,
             EXTRACT(EPOCH FROM (now() - created_at)) / 60 AS age_min
      FROM bmi_sync_queue
      WHERE (${includeDone} OR status <> 'done')
      ORDER BY
        CASE status WHEN 'parked' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
        created_at DESC
      LIMIT ${limit}
    `) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      kind: String(r.kind),
      status: String(r.status),
      barrier: String(r.barrier),
      barrierRef: r.barrier_ref === null ? null : String(r.barrier_ref),
      reservationRef: r.reservation_ref === null ? null : String(r.reservation_ref),
      attempts: Number(r.attempts),
      lastError: r.last_error === null ? null : String(r.last_error),
      createdAt: String(r.created_at),
      nextAttemptAt: String(r.next_attempt_at),
      giveUpAt: r.give_up_at === null ? null : String(r.give_up_at),
      resolvedAt: r.resolved_at === null ? null : String(r.resolved_at),
      ageMin: Math.round(Number(r.age_min ?? 0)),
      who: nameFromPayload(r.payload),
    }));
  } catch (err) {
    console.warn("[bmi-sync-view] queue list failed:", err);
    return [];
  }
}

/**
 * Per-reservation on-site verdict for the board's pill, in ONE grouped query
 * (the board renders dozens of reservations — a per-row query would be a
 * classic N+1 on a page staff keep open all day).
 *
 * Keyed on whatever the enqueuers recorded as `reservation_ref` — a BMI bill id
 * or a W-number — so the caller passes both forms it knows for a reservation and
 * takes whichever answers.
 */
export async function syncStateForReservations(
  refs: string[],
): Promise<Map<string, ReservationSyncState>> {
  const out = new Map<string, ReservationSyncState>();
  const wanted = [...new Set(refs.filter(Boolean).map(String))];
  if (!isDbConfigured() || wanted.length === 0) return out;
  try {
    const q = sql();
    const rows = (await q`
      SELECT reservation_ref,
             status,
             kind,
             COUNT(*)::int AS n,
             MAX(EXTRACT(EPOCH FROM (now() - created_at)) / 60) AS oldest_min
      FROM bmi_sync_queue
      WHERE reservation_ref = ANY(${wanted})
      GROUP BY reservation_ref, status, kind
    `) as Array<Record<string, unknown>>;

    for (const r of rows) {
      const ref = String(r.reservation_ref);
      const cur = out.get(ref) ?? { ...EMPTY, waitingKinds: [] };
      const n = Number(r.n);
      const status = String(r.status);
      if (status === "pending") {
        cur.pending += n;
        cur.waitingKinds = [...new Set([...cur.waitingKinds, String(r.kind)])];
        const age = Math.round(Number(r.oldest_min ?? 0));
        cur.oldestWaitingMin = Math.max(cur.oldestWaitingMin ?? 0, age);
      } else if (status === "parked") {
        cur.parked += n;
      } else if (status === "done") {
        cur.done += n;
      }
      out.set(ref, cur);
    }

    // Verdict, worst-first: a parked row outranks a pending one, because
    // something has stopped retrying and only a person will move it.
    for (const [ref, s] of out) {
      s.state =
        s.parked > 0 ? "attention" : s.pending > 0 ? "waiting" : s.done > 0 ? "green" : "unknown";
      out.set(ref, s);
    }
    return out;
  } catch (err) {
    console.warn("[bmi-sync-view] reservation sync state failed:", err);
    return out;
  }
}

/** The pill's label + palette. Kept next to the verdict so the board and any
 *  future surface describe the same state the same way. */
export function onsitePillCopy(s: ReservationSyncState): {
  label: string;
  tone: "green" | "amber" | "red" | "grey";
  title: string;
} {
  switch (s.state) {
    case "green":
      return {
        label: "On-site ✓",
        tone: "green",
        title: `All ${s.done} on-site sync step(s) landed on the center's server.`,
      };
    case "waiting":
      return {
        label:
          s.oldestWaitingMin && s.oldestWaitingMin >= 10
            ? `On-site ${s.oldestWaitingMin}m`
            : "On-site…",
        tone: s.oldestWaitingMin && s.oldestWaitingMin >= 10 ? "amber" : "grey",
        title:
          `${s.pending} step(s) still syncing to the center: ${s.waitingKinds.join(", ")}.` +
          (s.oldestWaitingMin ? ` Oldest ${s.oldestWaitingMin} min.` : "") +
          ` Normal is under a minute — over ~10 min means Fast WSync is behind.`,
      };
    case "attention":
      return {
        label: "On-site ⚠",
        tone: "red",
        title: `${s.parked} step(s) gave up retrying and need a human. Check the BMI sync panel.`,
      };
    default:
      return {
        label: "On-site ?",
        tone: "grey",
        // Saying "done" here would be a claim we cannot back — see the header.
        title:
          "No on-site sync steps recorded for this reservation (nothing to report either way).",
      };
  }
}
