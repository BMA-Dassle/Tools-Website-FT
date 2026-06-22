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
 *  2. mega-opening-heats-express-only — the first N heats of the Mega day are
 *     bookable only by express-lane-eligible parties (all returning racers with
 *     valid waivers); new racers need time to check in. DISABLED + labelled
 *     (replaces a BMI dayplanner restriction we're moving in-house).
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
   * Constraint: the first `count` heats of the day (earliest by start time in
   * the product's availability) require express-lane eligibility. Blocks the
   * pick when the party is NOT express-eligible (has a new racer, or a returning
   * racer without a valid waiver).
   */
  openingHeatsExpressOnly?: { count: number };
}

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
    id: "mega-opening-heats-express-only",
    label: "Mega: first 3 heats are express-lane only",
    enabled: true,
    appliesTo: { tracks: ["Mega"] }, // all tiers
    presentation: {
      action: "disable",
      cardLabel: "Express Lane Only",
      tooltip:
        "Returning racers with a valid waiver only — new racers need time to check in for the first heats of the day.",
    },
    openingHeatsExpressOnly: { count: 3 },
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
  /** Now, epoch ms (passed in so the function stays pure / testable). */
  nowMs: number;
  /**
   * All heats from the SAME product's availability response (the same tier +
   * track the candidate is being booked against). `freeSpots`/`capacity` is the
   * global occupancy signal; the set + ordering give each heat's rank in the day.
   */
  productBlocks: RestrictionBlock[];
  /**
   * Whether the booking party is express-lane eligible (all returning racers,
   * every one with a valid waiver). Required by `openingHeatsExpressOnly`.
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

/** Zero-based rank of the candidate among the day's heats (earliest = 0). */
function dayRank(ctx: RestrictionContext): number {
  return ctx.productBlocks.filter((b) => b.startMs < ctx.candidateStartMs).length;
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

    // Constraint: opening heats reserved for express-lane parties.
    if (rule.openingHeatsExpressOnly) {
      const isOpeningHeat = dayRank(ctx) < rule.openingHeatsExpressOnly.count;
      if (isOpeningHeat && !ctx.expressEligible) return block(rule);
    }
  }
  return ALLOWED;
}
