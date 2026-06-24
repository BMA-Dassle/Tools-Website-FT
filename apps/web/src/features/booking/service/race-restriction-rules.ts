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
 *  2. opening-heats-express-only-12min / -15min — on every race track, the
 *     first TWO heats of the day are reserved for walk-in / express-lane parties
 *     (all returning racers with valid waivers); new racers need time to check
 *     in when the track first opens, so the third heat is the first one they can
 *     book online. DISABLED + labelled "Walk-In or Express Only" (replaces a BMI
 *     dayplanner restriction we're moving in-house). Implemented as a
 *     center-local clock window = open .. open + 2×cadence, matched against the
 *     heat's wall-clock start — NOT its rank in the availability response (which
 *     slides as the day's earliest heats pass or sell out and drop off the
 *     list). Two rules because Red/Mega run a 12-min cadence (opens at :24) and
 *     Blue a 15-min cadence (opens at :30).
 *
 * ── How a "Pro session" is detected (no Pandora / no check-in needed) ──
 * BMI's per-tier dayplanner pages mean an OCCUPIED heat belongs to exactly one
 * tier: it shows up only in that tier's `/availability`, never another's
 * (verified live 2026-06-22 against Mega Tuesday — empty heats are shared across
 * tiers, occupied heats are tier-exclusive). So a neighbor Mega slot with
 * `freeSpots < capacity` in the Pro availability is unambiguously an active Pro
 * session — global ("regardless of person"), populated the instant anyone books.
 *
 * ── To add a rule ──
 * Push another entry onto RACE_RESTRICTION_RULES. To add a new *kind* of
 * constraint, add an optional constraint block to RaceRestrictionRule and a
 * branch in `evaluateRaceRestrictions`.
 */
import type { RaceTier } from "./race-products";

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
   * Which bookings this rule guards. `tiers` omitted = every tier. `tracks`
   * matched case-insensitively (e.g. ["Mega"]).
   */
  appliesTo: { tiers?: RaceTier[]; tracks: string[] };
  /** How a blocked slot is presented in the picker. */
  presentation: RestrictionPresentation;
  /**
   * Constraint: no adjacent OCCUPIED same-tier slot. Block the pick when another
   * slot of the same product within `gapMinutes` is occupied (freeSpots <
   * capacity). `gapMinutes` = track cadence + 1 (Mega = 12 + 1).
   */
  noAdjacentOccupiedSameTier?: { gapMinutes: number };
  /**
   * Exception for `noAdjacentOccupiedSameTier`: lift the block when the slot
   * being booked starts within this many minutes of now (fill near-term empty
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
// the window length is 2 × the track's heat cadence — the THIRD heat is the
// first one a non-express party can book online. The cadence differs by track,
// hence two windows / two rules:
//   • 12-min cadence (Red, Mega): blocks :00 + :12, opens at :24
//     (1:24 PM weekday / 11:24 AM weekend).
//   • 15-min cadence (Blue):      blocks :00 + :15, opens at :30
//     (1:30 PM weekday / 11:30 AM weekend).
const OPENING_WINDOWS_12MIN = openingWindows(
  { openMinutes: at(13), untilMinutes: at(13, 24) }, // weekday 1:00–1:24 PM
  { openMinutes: at(11), untilMinutes: at(11, 24) }, // weekend 11:00–11:24 AM
);
const OPENING_WINDOWS_15MIN = openingWindows(
  { openMinutes: at(13), untilMinutes: at(13, 30) }, // weekday 1:00–1:30 PM
  { openMinutes: at(11), untilMinutes: at(11, 30) }, // weekend 11:00–11:30 AM
);

/** Shared presentation for the opening-heats rules (both cadences). */
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
    noAdjacentOccupiedSameTier: { gapMinutes: 13 }, // Mega cadence 12 min + 1
    lastMinuteOverrideMinutes: 60,
  },
  {
    id: "opening-heats-express-only-12min",
    label: "Opening heats walk-in / express only — 12-min tracks (Red, Mega)",
    enabled: true,
    appliesTo: { tracks: ["Red", "Mega"] }, // 12-min cadence, all tiers
    presentation: WALK_IN_OR_EXPRESS_PRESENTATION,
    openingWindowExpressOnly: { windows: OPENING_WINDOWS_12MIN },
  },
  {
    id: "opening-heats-express-only-15min",
    label: "Opening heats walk-in / express only — 15-min track (Blue)",
    enabled: true,
    appliesTo: { tracks: ["Blue"] }, // 15-min cadence, all tiers
    presentation: WALK_IN_OR_EXPRESS_PRESENTATION,
    openingWindowExpressOnly: { windows: OPENING_WINDOWS_15MIN },
  },
];

/** One availability heat reduced to what the evaluator needs. */
export interface RestrictionBlock {
  startMs: number;
  freeSpots: number;
  capacity: number;
}

export interface RestrictionContext {
  /** Tier of the slot being booked. */
  tier: RaceTier | null | undefined;
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

/** Does an OCCUPIED same-product neighbor sit within `gapMinutes` of the candidate? */
function hasOccupiedNeighbor(ctx: RestrictionContext, gapMinutes: number): boolean {
  const gapMs = gapMinutes * 60_000;
  return ctx.productBlocks.some((b) => {
    if (b.startMs === ctx.candidateStartMs) return false; // not the candidate itself
    if (b.freeSpots >= b.capacity) return false; // empty — doesn't count
    return Math.abs(b.startMs - ctx.candidateStartMs) < gapMs;
  });
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

    // Constraint: no back-to-back occupied same-tier slot.
    if (rule.noAdjacentOccupiedSameTier) {
      if (hasOccupiedNeighbor(ctx, rule.noAdjacentOccupiedSameTier.gapMinutes)) {
        const override = rule.lastMinuteOverrideMinutes;
        const lastMinute =
          override != null && ctx.candidateStartMs - ctx.nowMs <= override * 60_000;
        if (!lastMinute) return block(rule);
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
