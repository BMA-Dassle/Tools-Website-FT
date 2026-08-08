/**
 * Reconcile the reservation's RACES against BMI, which owns them.
 *
 * ── Why (live failure 2026-08-07) ───────────────────────────────────────────
 * Race slots are built from Neon `booking_metadata.heats`, written once at
 * booking. When staff move a heat in BMI, Neon never hears: the kiosk showed
 * 10:12 PM for a race BMI had moved to 11:12 PM, and the check-in assignment
 * failed because it targeted a heat that no longer existed. Measured over 25
 * recent race reservations, 2 (8%) already disagreed with BMI on start time.
 *
 * ── What BMI gives us ───────────────────────────────────────────────────────
 * `project.schedules[]` is the authoritative race list, one row per race:
 *   { id, start, stop, persons, productLines, resourceId }
 *
 * `persons` is the seat count for THAT RACE — not the reservation's headcount
 * (owner 2026-08-07: "2 person in reservation doesn't mean there is two people
 * on that heat"). Proven live: bill …7654581 carries `[4, 0]` and …7642089
 * carries `[1, 1]` across two different race types. So a 2-person booking can
 * legitimately put one racer alone on a second heat, and BMI is the only place
 * that says so.
 *
 * ── The safety rule ─────────────────────────────────────────────────────────
 * FAIL CLOSED. We only rewrite a time when the two sides line up exactly — same
 * number of races, same seats in each. If anything is ambiguous we change
 * NOTHING and say why, because the alternative is silently moving a guest to a
 * race they aren't booked on. A stale time sends someone to the wrong place;
 * a wrong-but-confident time does the same thing while looking correct.
 */

export interface BmiSchedule {
  id?: string | null;
  /** Centre-local naive ET, e.g. "2026-08-07T23:12:00". */
  start?: string | null;
  stop?: string | null;
  /** Seats on THIS race. */
  persons?: number | null;
  /** Human race label, e.g. "Starter Race Blue - New Web". */
  productLines?: string | null;
  resourceId?: string | null;
}

/** The subset of a Neon heat row this module reads or rewrites. */
export interface HeatLike {
  heatId?: string;
  track?: string | null;
  productId?: string | null;
}

export type ReconcileReason =
  | "ok"
  | "no-bmi"
  | "no-heats"
  | "race-count-mismatch"
  | "seat-count-mismatch";

export interface ReconcileResult<T> {
  heats: T[];
  /** Heat rows whose start time was corrected. */
  changed: number;
  reason: ReconcileReason;
  /** Human-readable, for the server log when something is left alone. */
  detail?: string;
}

/** Naive-ET comparison key; BMI and Neon both store seconds precision. */
function startKey(v: unknown): string {
  return String(v ?? "").slice(0, 19);
}

/**
 * Schedules that describe a real, bookable race.
 *
 * BMI projects carry placeholder rows — bill …7654581 has a second schedule
 * with `persons: 0` and an empty `productLines`. Treating one as a race would
 * invent a seat nobody bought and make every reconcile look ambiguous.
 */
export function usableSchedules(schedules: BmiSchedule[]): BmiSchedule[] {
  return schedules
    .filter((s) => Number(s?.persons ?? 0) > 0)
    .filter((s) => String(s?.productLines ?? "").trim().length > 0)
    .filter((s) => startKey(s?.start).length === 19)
    .sort((a, b) => startKey(a.start).localeCompare(startKey(b.start)));
}

/**
 * Correct Neon heat start times from BMI, or leave them completely alone.
 *
 * Pairs the two lists in time order — the only ordering both sides agree on —
 * and requires the seat counts to match pairwise before touching anything. That
 * pairing is what lets a MOVED race be recognised: its time differs, but its
 * position and seat count still line up. Returns a new array; never mutates.
 */
export function reconcileHeatTimes<T extends HeatLike>(
  heats: T[],
  schedules: BmiSchedule[],
): ReconcileResult<T> {
  if (heats.length === 0) return { heats, changed: 0, reason: "no-heats" };

  const usable = usableSchedules(schedules);
  // No usable schedule is NOT evidence the races vanished — BMI may have failed
  // or the project may be shaped unusually. Keep what we have.
  if (usable.length === 0) return { heats, changed: 0, reason: "no-bmi" };

  // Neon rows grouped by the race they belong to, in time order.
  const byStart = new Map<string, T[]>();
  const order: string[] = [];
  for (const h of heats) {
    const k = startKey(h.heatId);
    if (!k) continue;
    if (!byStart.has(k)) {
      byStart.set(k, []);
      order.push(k);
    }
    byStart.get(k)!.push(h);
  }
  order.sort();

  if (order.length !== usable.length) {
    return {
      heats,
      changed: 0,
      reason: "race-count-mismatch",
      detail: `BMI has ${usable.length} race(s), Neon has ${order.length}`,
    };
  }

  // Seats must agree race-for-race, or we cannot know which moved where.
  for (let i = 0; i < order.length; i++) {
    const neonSeats = byStart.get(order[i])!.length;
    const bmiSeats = Number(usable[i].persons ?? 0);
    if (neonSeats !== bmiSeats) {
      return {
        heats,
        changed: 0,
        reason: "seat-count-mismatch",
        detail: `race ${i + 1}: BMI ${bmiSeats} seat(s), Neon ${neonSeats}`,
      };
    }
  }

  // Shapes agree — adopt BMI's time for every row of each race.
  const corrected = new Map<string, string>();
  for (let i = 0; i < order.length; i++) {
    const to = startKey(usable[i].start);
    if (to && to !== order[i]) corrected.set(order[i], to);
  }
  if (corrected.size === 0) return { heats, changed: 0, reason: "ok" };

  let changed = 0;
  const out = heats.map((h) => {
    const to = corrected.get(startKey(h.heatId));
    if (!to) return h;
    changed++;
    return { ...h, heatId: to };
  });
  return {
    heats: out,
    changed,
    reason: "ok",
    detail: [...corrected.entries()].map(([a, b]) => `${a}→${b}`).join(", "),
  };
}
