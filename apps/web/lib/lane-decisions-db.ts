/**
 * Every lane decision we make, written down.
 *
 * Owner, 2026-09-01: "start logging ALL THIS so you self learn when I ask you to and reset
 * things." Until now, answering "how is it going?" meant reading Vercel logs and the
 * Conqueror board by hand — which is exactly how the 8/31 investigation went, and why it
 * took an evening to establish something the system should simply have known.
 *
 * WHAT THIS IS FOR. Three questions it has to answer without anyone guessing:
 *   - what did we see on the floor, and what did we offer?
 *   - what did QAMF say back — and if it refused, why?
 *   - where did the guest actually end up?
 *
 * With those three, the weights stop being tuned against a handful of Saturdays that
 * disagreed with each other, a refusal becomes a fact rather than a memory, and "it put me
 * on 16 and I'm not sure I agree" can be answered by reading the row instead of
 * reconstructing the board.
 *
 * WRITING HERE MUST NEVER COST A BOOKING. Every function swallows its own errors: a missing
 * table, an unconfigured database, a Neon blip — all of it degrades to "no row written" and
 * the booking proceeds. Callers are expected to fire this without awaiting on the guest's
 * critical path.
 */
import { sql, isDbConfigured } from "@/lib/db";

let schemaReady = false;

/** What kind of moment produced the row. */
export type LaneDecisionKind =
  /** Choosing a lane as a booking is created. */
  | "place"
  /** The near-start cron finding a booking whose lane will not be free. */
  | "recheck"
  /** Improving a lane after the fact, when the pin found no home. */
  | "move";

export interface LaneDecision {
  centerId: number;
  kind: LaneDecisionKind;
  reservationId: string | null;
  /** The slot, not the moment of booking. */
  bookedAt?: string | null;
  players?: number | null;
  webOfferId?: number | null;
  /** Lanes the floor said were physically free when we looked. */
  freeLanes?: number[] | null;
  /** The offer's section, when we could tell. */
  allowedLanes?: number[] | null;
  /** Ranked lane sets we were willing to ask for, best first. */
  candidates?: number[][] | null;
  /** Where the booking ended up. */
  chosenLanes?: number[] | null;
  /** Where it was before a move or repair. */
  fromLanes?: number[] | null;
  /** True when every candidate was refused and QAMF assigned instead. */
  failedOpen?: boolean | null;
  /** Each attempt and the vendor's answer — the refusal record. */
  attempts?: unknown;
  /** One line a human can read. */
  outcome: string;
}

async function ensureSchema(): Promise<boolean> {
  if (schemaReady) return true;
  if (!isDbConfigured()) return false;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS lane_decisions (
      id              BIGSERIAL PRIMARY KEY,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      center_id       INTEGER     NOT NULL,
      kind            TEXT        NOT NULL,
      reservation_id  TEXT,
      booked_at       TEXT,
      players         INTEGER,
      web_offer_id    INTEGER,
      free_lanes      INTEGER[],
      allowed_lanes   INTEGER[],
      candidates      JSONB,
      chosen_lanes    INTEGER[],
      from_lanes      INTEGER[],
      failed_open     BOOLEAN,
      attempts        JSONB,
      outcome         TEXT        NOT NULL
    )`;
  await q`CREATE INDEX IF NOT EXISTS lane_decisions_recent ON lane_decisions(center_id, created_at DESC)`;
  await q`CREATE INDEX IF NOT EXISTS lane_decisions_res ON lane_decisions(reservation_id)`;
  schemaReady = true;
  return true;
}

/**
 * Write one decision. Never throws, never blocks a booking.
 *
 * Returns whether a row landed, so a caller that cares (a script, a test) can tell the
 * difference between "logged" and "silently skipped" — which the logs themselves could not.
 */
export async function recordLaneDecision(d: LaneDecision): Promise<boolean> {
  try {
    if (!(await ensureSchema())) return false;
    const q = sql();
    await q`
      INSERT INTO lane_decisions
        (center_id, kind, reservation_id, booked_at, players, web_offer_id,
         free_lanes, allowed_lanes, candidates, chosen_lanes, from_lanes,
         failed_open, attempts, outcome)
      VALUES
        (${d.centerId}, ${d.kind}, ${d.reservationId ?? null}, ${d.bookedAt ?? null},
         ${d.players ?? null}, ${d.webOfferId ?? null},
         ${d.freeLanes ?? null}, ${d.allowedLanes ?? null},
         ${d.candidates ? JSON.stringify(d.candidates) : null},
         ${d.chosenLanes ?? null}, ${d.fromLanes ?? null},
         ${d.failedOpen ?? null},
         ${d.attempts ? JSON.stringify(d.attempts) : null},
         ${d.outcome})`;
    return true;
  } catch (err) {
    console.warn("[lane-decisions] write failed (booking unaffected):", err);
    return false;
  }
}

export interface LaneDecisionRow extends LaneDecision {
  id: number;
  createdAt: string;
}

/** Most recent decisions, newest first. For reading back what actually happened. */
export async function readLaneDecisions(opts: {
  centerId?: number;
  limit?: number;
  sinceHours?: number;
}): Promise<LaneDecisionRow[]> {
  try {
    if (!(await ensureSchema())) return [];
    const q = sql();
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const hours = opts.sinceHours ?? 24 * 14;
    const rows = opts.centerId
      ? await q`SELECT * FROM lane_decisions
                WHERE center_id = ${opts.centerId}
                  AND created_at > NOW() - (${hours} * INTERVAL '1 hour')
                ORDER BY created_at DESC LIMIT ${limit}`
      : await q`SELECT * FROM lane_decisions
                WHERE created_at > NOW() - (${hours} * INTERVAL '1 hour')
                ORDER BY created_at DESC LIMIT ${limit}`;
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      createdAt: String(r.created_at),
      centerId: Number(r.center_id),
      kind: String(r.kind) as LaneDecisionKind,
      reservationId: (r.reservation_id as string) ?? null,
      bookedAt: (r.booked_at as string) ?? null,
      players: r.players == null ? null : Number(r.players),
      webOfferId: r.web_offer_id == null ? null : Number(r.web_offer_id),
      freeLanes: (r.free_lanes as number[]) ?? null,
      allowedLanes: (r.allowed_lanes as number[]) ?? null,
      candidates: (r.candidates as number[][]) ?? null,
      chosenLanes: (r.chosen_lanes as number[]) ?? null,
      fromLanes: (r.from_lanes as number[]) ?? null,
      failedOpen: (r.failed_open as boolean) ?? null,
      attempts: r.attempts ?? null,
      outcome: String(r.outcome),
    }));
  } catch (err) {
    console.warn("[lane-decisions] read failed:", err);
    return [];
  }
}

/**
 * Wipe the log.
 *
 * Deliberately a real delete rather than a soft flag: the owner asked to be able to "reset
 * things", and a reset that leaves the old rows behind would go on skewing whatever we
 * conclude from the next stretch. Returns how many rows went, so a reset can be reported
 * rather than assumed.
 */
export async function resetLaneDecisions(centerId?: number): Promise<number> {
  try {
    if (!(await ensureSchema())) return 0;
    const q = sql();
    const rows = centerId
      ? await q`DELETE FROM lane_decisions WHERE center_id = ${centerId} RETURNING id`
      : await q`DELETE FROM lane_decisions RETURNING id`;
    return (rows as unknown[]).length;
  } catch (err) {
    console.warn("[lane-decisions] reset failed:", err);
    return 0;
  }
}
