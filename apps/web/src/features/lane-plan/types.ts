/**
 * Lane arrangement engine — shared types.
 *
 * The grid is built from QAMF `POST /reservations/search`, never from Neon:
 * `bowling_reservations` only learns about a Conqueror front-desk booking when its
 * lane OPENS, so leagues, maintenance blocks and any walk-in that never opened are
 * invisible to our DB. See tasks/lane-arrangement-plan.md §3.
 */

/** One lane occupied for [startMs, endMs). Half-open: an interval ending at T does
 *  not collide with one starting at T. */
export interface BusyInterval {
  /**
   * Which vendor read produced this.
   *
   * `schedule` — `POST /reservations/search`, what is booked.
   * `floor`    — `GET /lanes`, what is physically running right now.
   *
   * They genuinely disagree, and both are needed. Observed live at Naples 2026-08-24
   * 23:48: lane 27 was still running reservation X85285 whose booked window had ENDED at
   * 23:45 (sessions overrun), and lane 8 was Open with `Reservation: null` — a lane
   * opened straight in Conqueror that no reservation will ever explain. Trusting the
   * schedule alone would have sold both lanes out from under a playing group.
   *
   * The engine consumes both; `findGridGaps` compares only the `schedule` half against
   * the floor, so the check keeps its teeth instead of trivially agreeing with itself.
   */
  source: "schedule" | "floor";
  laneNumber: number;
  startMs: number;
  endMs: number;
  /** QAMF reservation id — `X…` our API, `C…` Conqueror front desk, `K…` kiosk. */
  reservationId: string;
  /** The lane row's own status (Temporary | Confirmed | Ready | Running | Completed | …). */
  laneStatus: string;
  /** Reservation-level status. */
  reservationStatus: string;
  /** `Type.Description` — "Walk-in > Classic", "League", "Maintenance", "Birthday Party", … */
  kind: string;
  /** Occupies a lane but is not sellable open play (league / maintenance / non-bookable). */
  isBlock: boolean;
  webOfferId: number | null;
  players: number;
  /** Reservation title, for the staff-facing diff. */
  title: string;
  /** When the booking was made. Drives the greenfield backtest, which must place
   *  reservations in the order they actually arrived — at create time you only know the
   *  bookings that came before you. */
  createdAtMs: number | null;
}

export interface LaneGrid {
  centerId: number;
  /** Every lane the center has, ascending. */
  lanes: number[];
  /** Lanes reporting `Status: "Error"` (under maintenance) right now — never place here. */
  errorLanes: ReadonlySet<number>;
  /** Lanes currently `Open` — a session is physically running. */
  openLanes: ReadonlySet<number>;
  /**
   * The live floor as `GET /lanes` reports it — an INDEPENDENT read from the schedule.
   *
   * Kept alongside `busy` rather than merged into it, because the whole point is to have
   * two sources that can disagree. `findGridGaps` compares them, and a disagreement means
   * the schedule is missing occupancy we would otherwise sell twice.
   */
  liveLanes: ReadonlyArray<{
    laneNumber: number;
    status: string;
    /** Estimated for a lane opened directly in Conqueror rather than through the API. */
    closedAtMs: number | null;
    reservationId: string | null;
  }>;
  busy: readonly BusyInterval[];
  /** The window this grid is authoritative for. Reads outside it are not trustworthy. */
  windowStartMs: number;
  windowEndMs: number;
  /** When the grid was read from the vendor. */
  readAtMs: number;
  /**
   * Expected occupancy learned from history, used to correct the pressure signal.
   *
   * Bookings alone under-state how full a session will be — 76% of a Saturday arrives
   * same-day — so without this the engine spreads a 6pm booking at 2pm into a pair that is
   * still occupied at 8pm. Optional: a grid with no forecast simply scores on what it can
   * see, which is correct behavior for a board that is already complete.
   */
  forecast?: import("./forecast").OccupancyForecast | null;
}

/** A placement request: k lanes for one window. */
export interface PlanRequest {
  /** Set when re-placing a reservation that already exists (its own intervals are ignored). */
  reservationId?: string;
  laneCount: number;
  startMs: number;
  endMs: number;
  players: number;
  webOfferId: number | null;
  /** The offer's Conqueror lane group, derived from history. `null` = unknown, allow all. */
  allowedLanes: readonly number[] | null;
}

/** Tunable weights — persisted in `lane_plan_config.policy` so ops can retune without a deploy. */
export interface LanePolicy {
  /** Reward per free neighbour lane flanking the placement. The "don't sit next to
   *  strangers" term. Scaled by spread bias, so it inverts under pressure. */
  buffer: number;
  /** Reward per whole untouched pair still free after placing. The "save the other 8 for
   *  bigger reservations" term. Weight rises with pressure. */
  wholePairs: number;
  /** Reward for landing on a true odd-even pair (k=2) or seeding a clean pair (k=1). */
  pairIntegrity: number;
  /** Penalty per lane of gap when a multi-lane placement is not contiguous. */
  contiguity: number;
  /**
   * Reward for a placement that butts straight onto an existing booking on that lane,
   * leaving no dead time between them.
   *
   * This does NOT create capacity — which lane a booking sits on is a permutation, and
   * cannot change how many lanes are free at 8pm. What it protects is DURATION: keeping
   * some lanes clear in long stretches so a 90 or 120-minute session is still sellable.
   * Measured at FM 2026-08-15 17:00 — 13 lanes free, none able to host 90 minutes.
   *
   * Scaled by pressure, so a dead afternoon still spreads guests out rather than
   * shoulder-to-shoulder for a long session nobody is waiting to book.
   */
  timeFit: number;
  /** Penalty for stranding a gap too short to sell to anyone. Always on. */
  sliverPenalty: number;
  /**
   * The shortest session this center actually sells, in minutes — a gap below it is dead.
   * PER-CENTER: HeadPinz's shortest open-play option is 60 (options 1226/1258); FastTrax
   * duckpin genuinely sells 30 (option 33). A single global floor would either strand
   * FastTrax inventory or fail to protect HeadPinz.
   */
  minSellableMinutes: number;
  /**
   * How much of the house, measured in whole free pairs, must remain before the engine
   * stops spreading. Expressed as a fraction of total pairs: 0.35 on 14 pairs means the
   * dial reaches full-spread at ~5 fresh pairs and full-backfill at 0.
   */
  spreadPairSpan: number;
  /**
   * Share of still-to-arrive demand that needs a WHOLE pair rather than one lane.
   * Measured: 94 of 428 FM Saturday reservations took more than one lane (~22%).
   * Drives how many fresh pairs are held back for bookings not yet on the board.
   */
  multiLaneShare: number;
  /** Sweep only: fixed cost of moving a reservation at all. Suppresses churn — a move
   *  must beat this to be worth making. */
  moveCost: number;
  /** Sweep only: may we move a reservation the front desk created in Conqueror? Staff may
   *  have placed it deliberately. */
  moveConquerorBookings: boolean;
}

export const DEFAULT_POLICY: LanePolicy = {
  buffer: 10,
  wholePairs: 6,
  pairIntegrity: 14,
  contiguity: 25,
  timeFit: 12,
  sliverPenalty: 10,
  minSellableMinutes: 60,
  spreadPairSpan: 0.35,
  multiLaneShare: 0.22,
  moveCost: 8,
  moveConquerorBookings: false,
};

/** One scored candidate placement. */
export interface Placement {
  lanes: number[];
  score: number;
  /** Per-term breakdown — persisted on shadow decisions so weights can be tuned from real days. */
  terms: Record<string, number>;
}

/** A move the sweep proposes. */
export interface ProposedMove {
  reservationId: string;
  title: string;
  kind: string;
  startMs: number;
  endMs: number;
  from: number[];
  to: number[];
  gain: number;
  reason: string;
}
