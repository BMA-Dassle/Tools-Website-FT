/**
 * Config-driven race-type booking restrictions.
 *
 * Some race tiers / time slots can't be booked freely. Rules live here as plain
 * const config (no Statsig, no Neon — mirrors race-credits.ts /
 * membership-discounts.ts) plus one pure evaluator shared by the heat-picker UI
 * and the booking service (the authoritative guard before BMI books a heat).
 * Same pure-module style as `conflict.ts`.
 *
 * Current rules:
 *  1. mega-no-back-to-back-pro — don't book a Pro Mega session adjacent to an
 *     already-occupied Pro Mega session (kart/staff reconfiguration spacing),
 *     unless the slot starts within 1 hour (last-minute fill). HIDDEN.
 *  2. opening-heats-express-only — on every race track, the first TWO heats of
 *     the day are reserved for walk-in / express-lane parties (all returning
 *     racers with valid waivers); new racers need time to check in when the
 *     track first opens, so the third heat is the first one they can book
 *     online. DISABLED + labelled "Walk-In or Express Only" (replaces a BMI
 *     dayplanner restriction we're moving in-house). Implemented as a
 *     center-local clock window = open .. open + 2×cadence, matched against the
 *     heat's wall-clock start — NOT its rank in the availability response (which
 *     slides as the day's earliest heats pass or sell out and drop off the
 *     list). One rule for all tracks since 2026-07-02: every track now runs the
 *     12-min cadence (opens at :24). (Blue ran 15-min — window until :30 — as a
 *     separate -15min rule before the owner moved it to 12-min.)
 *  3. blue/mega-no-back-to-back-junior — no Junior session adjacent to another
 *     occupied Junior session on Blue or Mega (gap 13 both), counted across
 *     EVERY junior tier ("regardless of anything", owner 2026-07-02): a junior
 *     pro neighbor blocks a junior intermediate pick and vice versa (scope
 *     "category" reads `categoryTrackBlocks`). UNCONDITIONAL — no last-minute
 *     override. HIDDEN.
 *  4. mega-junior-two-per-hour — on Mega, at most two Junior races may start in
 *     any center-local clock hour, counted across BOTH junior tiers
 *     (intermediate + pro) — "regardless of type". Reads `categoryTrackBlocks`
 *     (every junior heat on the track, tiers merged), not `productBlocks` (one
 *     tier). HIDDEN. (Blue carries no per-hour cap.)
 *  5. starter-room-per-hour / -junior-starter — every track keeps room for TWO
 *     ADULT STARTER races in each center-local clock hour (owner 2026-07-02:
 *     new racers must always be able to get in). A non-adult-starter pick
 *     (adult intermediate/pro, any junior — the two rules' scopes union to
 *     "everything except adult starter") is blocked when booking it would leave
 *     fewer than 2 slots in its hour that are still empty or already running an
 *     adult Starter session. Booked Starter races count toward the guarantee —
 *     the reserve is "two Starter races can happen", not "two slots frozen".
 *     60-min last-minute lift so unused reserved slots still fill. HIDDEN.
 *
 * ── How a "Pro session" is detected (no Pandora / no check-in needed) ──
 * BMI's per-tier dayplanner pages mean an OCCUPIED heat belongs to exactly one
 * tier: it shows up only in that tier's `/availability`, never another's
 * (verified live 2026-06-22 against Mega Tuesday — empty heats are shared across
 * tiers, occupied heats are tier-exclusive). So a neighbor Mega slot with
 * `freeSpots < capacity` in the Pro availability is unambiguously an active Pro
 * session — global ("regardless of person"), populated the instant anyone books.
 * The same per-tier exclusivity is why every cross-tier rule (junior
 * back-to-back / per-hour, the Starter room reserve) unions the availability of
 * every in-scope product on the track: an occupied heat shows up in only its
 * own tier's response, so a single tier's blocks can't see the others'.
 *
 * ── To add a rule ──
 * Push another entry onto RACE_RESTRICTION_RULES. To add a new *kind* of
 * constraint, add an optional constraint block to RaceRestrictionRule and a
 * branch in `evaluateRaceRestrictions`.
 */
import type { RaceCategory, RaceTier } from "./race-products";

/** How a blocked slot is surfaced to the customer. */
export interface RestrictionPresentation {
  /** "hide" drops the slot from the grid; "disable" greys it out with a label. */
  action: "hide" | "disable";
  /** Short label shown on a disabled card (e.g. "Express Lane Only"). */
  cardLabel?: string;
  /** Tooltip / hold-error text explaining the block. */
  tooltip?: string;
}

export interface RaceRestrictionRule {
  /** Stable identifier (shown in block reasons / logs). */
  id: string;
  /** Human label for logs / future admin tooling. */
  label: string;
  /** Kill-switch — matches the `enabled` pattern in membership-discounts.ts. */
  enabled: boolean;
  /**
   * Which bookings this rule guards. `tiers` omitted = every tier; `categories`
   * omitted = every category (adult + junior). `tracks` matched
   * case-insensitively (e.g. ["Mega"]).
   */
  appliesTo: { tiers?: RaceTier[]; categories?: RaceCategory[]; tracks: string[] };
  /** How a blocked slot is presented in the picker. */
  presentation: RestrictionPresentation;
  /**
   * Constraint: no adjacent OCCUPIED slot. Block the pick when another slot
   * within `gapMinutes` is occupied (freeSpots < capacity). `gapMinutes` =
   * track cadence + 1 (Mega = 12 + 1). `scope` picks the occupancy signal:
   * "tier" reads `productBlocks` (the candidate's own product only);
   * "category" reads `categoryTrackBlocks` (every same-category heat on the
   * track, tiers merged — falls back to `productBlocks` when the caller can't
   * supply the union).
   */
  noAdjacentOccupied?: { gapMinutes: number; scope: "tier" | "category" };
  /**
   * Exception for the blocking constraints that honor it (`noAdjacentOccupied`,
   * `reserveStarterRoomPerClockHour`): lift the block when the slot being
   * booked starts within this many minutes of now (fill near-term empty
   * slots). Omit for an unconditional block.
   */
  lastMinuteOverrideMinutes?: number;
  /**
   * Constraint: heats that start inside the day's *opening window* require
   * express-lane eligibility. Blocks the pick when the party is NOT
   * express-eligible (has a new racer, or a returning racer without a valid
   * waiver) AND the heat's wall-clock start falls in the window for its weekday.
   *
   * Anchored to the clock — not to the heat's rank in the availability response
   * — so the block stays on the genuine opening heats all day instead of
   * sliding forward as earlier heats pass or sell out.
   */
  openingWindowExpressOnly?: {
    /**
     * Per center-local-weekday opening window, in minutes since local midnight.
     * Key: 0=Sun … 6=Sat. A heat whose local start time is in
     * `[openMinutes, untilMinutes)` on that weekday is express-only. Weekdays
     * absent from the map carry no opening-window restriction.
     */
    windows: Record<number, { openMinutes: number; untilMinutes: number }>;
  };
  /**
   * Constraint: cap how many OCCUPIED same-scope heats may start within the
   * candidate's center-local clock hour (:00–:59) on this track — counted across
   * ALL tiers ("regardless of type"). Reads `categoryTrackBlocks` (the union of
   * every in-scope heat on the track, tiers merged), NOT `productBlocks` (one
   * tier). Blocks the pick when `limit` such heats are already occupied in the
   * hour (the candidate would be the limit+1-th). No-op when `categoryTrackBlocks`
   * or `candidateStartLocal` aren't supplied (epoch-only / non-aggregating caller).
   */
  maxOccupiedPerClockHour?: { limit: number };
  /**
   * Constraint: keep room for `minRoom` ADULT STARTER races in the candidate's
   * center-local clock hour. Reads `trackAllTierBlocks` (every heat on the
   * track across ALL tiers + categories, each tagged with whether it came from
   * the adult-starter product's availability). A slot counts as "Starter room"
   * when nothing non-adult-starter occupies it — i.e. it is still empty, or it
   * is an active adult Starter session (booked Starter races satisfy the
   * guarantee). Blocks the pick when consuming the candidate's slot would leave
   * fewer than `minRoom` such slots in the hour. Counting remaining room —
   * rather than capping occupied non-Starter heats at heats-per-hour − minRoom
   * — stays correct when BMI drops passed/sold-out heats from availability and
   * in partial (end-of-day) hours. No-op when `trackAllTierBlocks` or
   * `candidateStartLocal` aren't supplied (epoch-only / non-aggregating caller).
   */
  reserveStarterRoomPerClockHour?: { minRoom: number };
}

/** Minutes since local midnight for an `HH:MM` clock time. */
const at = (hour: number, minute = 0): number => hour * 60 + minute;

type OpeningWindow = { openMinutes: number; untilMinutes: number };

/**
 * Build a per-weekday opening-window map (0=Sun … 6=Sat) from one weekday
 * window (Mon–Fri) and one weekend window (Sat/Sun). FastTrax (Fort Myers)
 * opens at 1:00 PM Mon–Fri and 11:00 AM Sat/Sun.
 */
function openingWindows(
  weekday: OpeningWindow,
  weekend: OpeningWindow,
): Record<number, OpeningWindow> {
  return { 0: weekend, 1: weekday, 2: weekday, 3: weekday, 4: weekday, 5: weekday, 6: weekend };
}

// The opening window reserves the first TWO heats of the day for walk-in /
// express-lane parties (new racers need check-in time when the track opens), so
// the window length is 2 × the heat cadence — the THIRD heat is the first one a
// non-express party can book online. Every track runs the 12-min cadence
// (owner 2026-07-02 — Blue was 15-min before): blocks :00 + :12, opens at :24
// (1:24 PM weekday / 11:24 AM weekend).
const OPENING_WINDOWS = openingWindows(
  { openMinutes: at(13), untilMinutes: at(13, 24) }, // weekday 1:00–1:24 PM
  { openMinutes: at(11), untilMinutes: at(11, 24) }, // weekend 11:00–11:24 AM
);

/** Presentation for the opening-heats rule. */
const WALK_IN_OR_EXPRESS_PRESENTATION: RestrictionPresentation = {
  // DISABLED (not hidden) for non-express parties — the opening heats stay
  // visible but greyed with a "Walk-In or Express Only" label, so guests know
  // those slots are still available as a walk-in or via the express lane; they
  // just can't be booked online by a party that needs check-in time. The
  // tooltip doubles as the server-side hold-error reason.
  action: "disable",
  cardLabel: "Walk-In or Express Only",
  tooltip:
    "These opening heats are reserved for walk-in guests and express-lane racers (returning racers with a valid waiver). New racers, please pick a later heat or check in at Guest Services.",
};

/**
 * Active restriction rules. Plain const config — edit here to expand.
 */
export const RACE_RESTRICTION_RULES: RaceRestrictionRule[] = [
  {
    id: "mega-no-back-to-back-pro",
    label: "Mega: no back-to-back Pro sessions",
    enabled: true,
    appliesTo: { tiers: ["pro"], tracks: ["Mega"] },
    presentation: {
      action: "hide",
      tooltip: "That time is too close to another Pro session on Mega — pick another slot.",
    },
    noAdjacentOccupied: { gapMinutes: 13, scope: "tier" }, // Mega cadence 12 min + 1
    lastMinuteOverrideMinutes: 60,
  },
  // Junior back-to-back is UNCONDITIONAL (owner 2026-07-02: "regardless of
  // anything") — cross-tier (scope "category") and no last-minute override.
  {
    id: "blue-no-back-to-back-junior",
    label: "Blue: no back-to-back Junior sessions (any tier, no exceptions)",
    enabled: true,
    appliesTo: { categories: ["junior"], tracks: ["Blue"] },
    presentation: {
      action: "hide",
      tooltip: "That time is too close to another Junior session on Blue — pick another slot.",
    },
    noAdjacentOccupied: { gapMinutes: 13, scope: "category" }, // Blue cadence 12 min + 1 (12-min since 2026-07-02)
  },
  {
    id: "mega-no-back-to-back-junior",
    label: "Mega: no back-to-back Junior sessions (any tier, no exceptions)",
    enabled: true,
    appliesTo: { categories: ["junior"], tracks: ["Mega"] },
    presentation: {
      action: "hide",
      tooltip: "That time is too close to another Junior session on Mega — pick another slot.",
    },
    noAdjacentOccupied: { gapMinutes: 13, scope: "category" }, // Mega cadence 12 min + 1
  },
  {
    id: "mega-junior-two-per-hour",
    label: "Mega: at most two Junior races per clock hour (any tier)",
    enabled: true,
    appliesTo: { categories: ["junior"], tracks: ["Mega"] },
    presentation: {
      action: "hide",
      tooltip:
        "Mega already has two Junior races booked this hour — pick a slot in a different hour.",
    },
    maxOccupiedPerClockHour: { limit: 2 },
  },
  // Reserve room for two ADULT STARTER races per clock hour on every track
  // (owner 2026-07-02). Two entries because appliesTo can't express "everything
  // except adult starter": the first covers intermediate + pro (both
  // categories); the second covers junior starter (Blue is the only junior
  // starter track). Together = every non-adult-starter booking.
  {
    id: "starter-room-per-hour",
    label: "All tracks: keep room for two adult Starter races per clock hour",
    enabled: true,
    appliesTo: { tiers: ["intermediate", "pro"], tracks: ["Red", "Blue", "Mega"] },
    presentation: {
      action: "hide",
      tooltip:
        "That hour is holding its last spots for Starter races — pick a slot in a different hour.",
    },
    reserveStarterRoomPerClockHour: { minRoom: 2 },
    lastMinuteOverrideMinutes: 60,
  },
  {
    id: "starter-room-per-hour-junior-starter",
    label: "Blue: junior Starter also respects the adult-Starter hourly room reserve",
    enabled: true,
    appliesTo: { tiers: ["starter"], categories: ["junior"], tracks: ["Blue"] },
    presentation: {
      action: "hide",
      tooltip:
        "That hour is holding its last spots for Starter races — pick a slot in a different hour.",
    },
    reserveStarterRoomPerClockHour: { minRoom: 2 },
    lastMinuteOverrideMinutes: 60,
  },
  {
    id: "opening-heats-express-only",
    label: "Opening heats walk-in / express only (all race tracks)",
    enabled: true,
    appliesTo: { tracks: ["Red", "Blue", "Mega"] }, // 12-min cadence, all tiers
    presentation: WALK_IN_OR_EXPRESS_PRESENTATION,
    openingWindowExpressOnly: { windows: OPENING_WINDOWS },
  },
];

/** One availability heat reduced to what the evaluator needs. */
export interface RestrictionBlock {
  startMs: number;
  freeSpots: number;
  capacity: number;
}

/** A RestrictionBlock tagged with which product's availability it came from —
 *  the `reserveStarterRoomPerClockHour` signal needs to tell an active adult
 *  Starter session (counts as room) from every other occupied heat. */
export interface TrackTierBlock extends RestrictionBlock {
  /** True when this block came from the ADULT STARTER product's availability. */
  adultStarter: boolean;
}

export interface RestrictionContext {
  /** Tier of the slot being booked. */
  tier: RaceTier | null | undefined;
  /** Category (adult/junior) of the slot being booked. Required by category-scoped rules. */
  category?: RaceCategory | null;
  /** Track of the slot being booked. */
  track: string | null | undefined;
  /** Start time (epoch ms) of the slot being booked. */
  candidateStartMs: number;
  /**
   * The candidate heat's center-local wall-clock start as the naive ISO string
   * BMI returns (e.g. "2026-06-23T13:24:00", no timezone). Read directly for the
   * opening-window rule's clock + weekday so the check is independent of where
   * the code runs (browser TZ / UTC server). Optional — the epoch-only
   * back-to-back rule works without it.
   */
  candidateStartLocal?: string;
  /** Now, epoch ms (passed in so the function stays pure / testable). */
  nowMs: number;
  /**
   * All heats from the SAME product's availability response (the same tier +
   * track the candidate is being booked against). `freeSpots`/`capacity` is the
   * global occupancy signal the back-to-back rule reads for neighboring slots.
   */
  productBlocks: RestrictionBlock[];
  /**
   * Every same-category heat on the candidate's track, with ALL tiers merged
   * (e.g. junior intermediate + junior pro Mega unioned). The occupancy signal
   * the `maxOccupiedPerClockHour` rule reads — `productBlocks` only carries the
   * candidate's own tier, so it can't see the other tier's occupied heats.
   * Optional: omit it and `maxOccupiedPerClockHour` no-ops.
   */
  categoryTrackBlocks?: RestrictionBlock[];
  /**
   * Every heat on the candidate's track with ALL tiers AND categories merged,
   * each tagged with whether it came from the adult-starter product's
   * availability. The occupancy signal `reserveStarterRoomPerClockHour` reads.
   * Optional: omit it and that constraint no-ops.
   */
  trackAllTierBlocks?: TrackTierBlock[];
  /**
   * Whether the booking party is express-lane eligible (all returning racers,
   * every one with a valid waiver). Required by `openingWindowExpressOnly`.
   */
  expressEligible?: boolean;
}

export interface RestrictionResult {
  blocked: boolean;
  ruleId?: string;
  /** "hide" | "disable" — how the picker should treat a blocked slot. */
  action?: RestrictionPresentation["action"];
  /** Short label for a disabled card. */
  cardLabel?: string;
  /** Tooltip / hold-error reason. */
  reason?: string;
}

const ALLOWED: RestrictionResult = { blocked: false };

function matchesScope(rule: RaceRestrictionRule, ctx: RestrictionContext): boolean {
  if (!ctx.track) return false;
  if (rule.appliesTo.tiers) {
    if (!ctx.tier || !rule.appliesTo.tiers.includes(ctx.tier)) return false;
  }
  if (rule.appliesTo.categories) {
    if (!ctx.category || !rule.appliesTo.categories.includes(ctx.category)) return false;
  }
  const track = ctx.track.toLowerCase();
  return rule.appliesTo.tracks.some((t) => t.toLowerCase() === track);
}

function block(rule: RaceRestrictionRule): RestrictionResult {
  return {
    blocked: true,
    ruleId: rule.id,
    action: rule.presentation.action,
    cardLabel: rule.presentation.cardLabel,
    reason: rule.presentation.tooltip,
  };
}

/** Does an OCCUPIED neighbor in `blocks` sit within `gapMinutes` of the candidate? */
function hasOccupiedNeighbor(
  blocks: RestrictionBlock[],
  candidateStartMs: number,
  gapMinutes: number,
): boolean {
  const gapMs = gapMinutes * 60_000;
  return blocks.some((b) => {
    if (b.startMs === candidateStartMs) return false; // not the candidate itself
    if (b.freeSpots >= b.capacity) return false; // empty — doesn't count
    return Math.abs(b.startMs - candidateStartMs) < gapMs;
  });
}

/** True when the rule's last-minute override lifts a would-be block. */
function lastMinuteLift(rule: RaceRestrictionRule, ctx: RestrictionContext): boolean {
  const override = rule.lastMinuteOverrideMinutes;
  return override != null && ctx.candidateStartMs - ctx.nowMs <= override * 60_000;
}

/**
 * Read the center-local weekday + minutes-since-midnight straight from a naive
 * wall-clock ISO string ("2026-06-23T13:24:00"). TZ-independent: the weekday is
 * built from the explicit Y/M/D in UTC (so it's the calendar weekday of the
 * wall-clock date regardless of runtime TZ), and the clock minutes come from the
 * literal HH:MM, so DST never shifts them. Returns null if unparseable.
 */
function localClockParts(naiveIso: string): { weekday: number; minutes: number } | null {
  const m = naiveIso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  const weekday = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).getUTCDay();
  return { weekday, minutes: Number(hh) * 60 + Number(mm) };
}

/**
 * Evaluate the config rules against a single candidate slot. Pure — no fetch,
 * no React. Returns the first matching block (or ALLOWED). Used by both the
 * picker (to hide / disable slots) and the booking service (to reject a hold).
 */
export function evaluateRaceRestrictions(ctx: RestrictionContext): RestrictionResult {
  for (const rule of RACE_RESTRICTION_RULES) {
    if (!rule.enabled) continue;
    if (!matchesScope(rule, ctx)) continue;

    // Constraint: no back-to-back occupied slot. Scope "tier" sees only the
    // candidate's own product; "category" sees every same-category heat on the
    // track (tiers merged) when the caller supplied the union.
    if (rule.noAdjacentOccupied) {
      const blocks =
        rule.noAdjacentOccupied.scope === "category" && ctx.categoryTrackBlocks?.length
          ? ctx.categoryTrackBlocks
          : ctx.productBlocks;
      if (hasOccupiedNeighbor(blocks, ctx.candidateStartMs, rule.noAdjacentOccupied.gapMinutes)) {
        if (!lastMinuteLift(rule, ctx)) return block(rule);
      }
    }

    // Constraint: keep room for N adult-Starter races in the candidate's
    // center-local clock hour. A slot is "Starter room" when nothing
    // non-adult-starter occupies it (still empty, or an active adult Starter
    // session — occupied heats are tier-exclusive, so an occupied start appears
    // in exactly one product's response). The candidate's own slot is excluded:
    // booking consumes it (and if it's already an occupied same-tier session,
    // it was never room to begin with).
    if (rule.reserveStarterRoomPerClockHour && ctx.trackAllTierBlocks && ctx.candidateStartLocal) {
      // Joining an already-running session at the candidate's start consumes no
      // new room — the slot left the Starter pool when its first racer booked
      // — so the reserve never blocks it, even in an hour already under quota.
      const joiningActiveSession = ctx.trackAllTierBlocks.some(
        (b) => b.startMs === ctx.candidateStartMs && b.freeSpots < b.capacity,
      );
      const parts = joiningActiveSession ? null : localClockParts(ctx.candidateStartLocal);
      if (parts) {
        const minutesIntoHour = parts.minutes % 60;
        const hourStartMs = ctx.candidateStartMs - minutesIntoHour * 60_000;
        const hourEndMs = hourStartMs + 60 * 60_000;
        const starts = new Set<number>();
        const consumed = new Set<number>(); // occupied by a NON-adult-starter session
        for (const b of ctx.trackAllTierBlocks) {
          if (b.startMs === ctx.candidateStartMs) continue;
          if (b.startMs < hourStartMs || b.startMs >= hourEndMs) continue;
          starts.add(b.startMs);
          if (b.freeSpots < b.capacity && !b.adultStarter) consumed.add(b.startMs);
        }
        const room = starts.size - consumed.size;
        if (room < rule.reserveStarterRoomPerClockHour.minRoom) {
          if (!lastMinuteLift(rule, ctx)) return block(rule);
        }
      }
    }

    // Constraint: cap occupied same-category heats per center-local clock hour,
    // counted across every tier on the track (categoryTrackBlocks).
    if (rule.maxOccupiedPerClockHour && ctx.categoryTrackBlocks && ctx.candidateStartLocal) {
      const parts = localClockParts(ctx.candidateStartLocal);
      if (parts) {
        const minutesIntoHour = parts.minutes % 60;
        const hourStartMs = ctx.candidateStartMs - minutesIntoHour * 60_000;
        const hourEndMs = hourStartMs + 60 * 60_000;
        // Distinct occupied start times in the hour (dedupe so a slot present in
        // both tiers' responses counts once), excluding the candidate's own slot.
        const occupiedStarts = new Set<number>();
        for (const b of ctx.categoryTrackBlocks) {
          if (b.startMs === ctx.candidateStartMs) continue;
          if (b.freeSpots >= b.capacity) continue; // empty — doesn't count
          if (b.startMs >= hourStartMs && b.startMs < hourEndMs) occupiedStarts.add(b.startMs);
        }
        if (occupiedStarts.size >= rule.maxOccupiedPerClockHour.limit) return block(rule);
      }
    }

    // Constraint: heats inside the day's opening window are express-lane only.
    if (rule.openingWindowExpressOnly && !ctx.expressEligible && ctx.candidateStartLocal) {
      const parts = localClockParts(ctx.candidateStartLocal);
      if (parts) {
        const win = rule.openingWindowExpressOnly.windows[parts.weekday];
        if (win && parts.minutes >= win.openMinutes && parts.minutes < win.untilMinutes) {
          return block(rule);
        }
      }
    }
  }
  return ALLOWED;
}
