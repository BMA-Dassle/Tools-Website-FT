/**
 * World Cup VIP Bowling — server-side validation + staff-facing strings.
 *
 * The reserve rails call `validateWorldCupBooking` BEFORE any Square/QAMF
 * write (unified-reserve pre-charge guard + the v1 bowling reserve route).
 * Validation is config-driven off the server's own fixture table — the
 * client only ever sends a bookedAt/slug it cannot benefit from forging
 * (prices come from Neon/Square regardless); this guard enforces the
 * kickoff-window business rule and the per-center kill switch, fail-closed.
 */
import type { CenterCode } from "~/features/booking/types";
import {
  fixtureForBookedAt,
  fixtureKickoffMs,
  fixtureLabel,
  fixtureStaffLabel,
  isWorldCupSlug,
  type WorldCupFixture,
} from "./fixtures";
import { worldCupCenterEnabled, worldCupCenterEnabledByQamfId } from "./flags";

/** Typed so the reserve routes can map it to a 4xx instead of a 500. */
export class WorldCupReservationError extends Error {
  readonly code = "WORLD_CUP_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "WorldCupReservationError";
  }
}

/** Is this cart item a World Cup VIP Bowling booking? (slug-prefix keyed). */
export function isWorldCupBowlingItem(item: { experienceSlug?: string | null }): boolean {
  return isWorldCupSlug(item.experienceSlug);
}

/**
 * Throws WorldCupReservationError unless:
 *  - the center's kill switch is on (stale client sessions can't book a
 *    disabled center),
 *  - bookedAt is EXACTLY a fixture kickoff (ET date + hour, minute 0),
 *  - that kickoff is still in the future.
 * Returns the matched fixture so callers can persist/display the match.
 */
export function validateWorldCupBooking(args: {
  /** v2 CenterCode ("fort-myers" | "naples") — pass this OR centerQamfId. */
  center?: CenterCode | string | null;
  /** QAMF numeric center id (9172 / 3148) — what the bowling routes carry. */
  centerQamfId?: number | null;
  bookedAt: string | null | undefined;
  nowMs?: number;
}): WorldCupFixture {
  const nowMs = args.nowMs ?? Date.now();

  const centerOk =
    args.center != null
      ? worldCupCenterEnabled(args.center)
      : worldCupCenterEnabledByQamfId(args.centerQamfId ?? null);
  if (!centerOk) {
    throw new WorldCupReservationError(
      "World Cup VIP Bowling isn't available at this location right now.",
    );
  }
  if (!args.bookedAt) {
    throw new WorldCupReservationError("World Cup VIP Bowling needs a match start time.");
  }
  const fixture = fixtureForBookedAt(args.bookedAt);
  if (!fixture) {
    throw new WorldCupReservationError(
      "World Cup VIP Bowling can only start at an official match kickoff time.",
    );
  }
  if (fixtureKickoffMs(fixture) <= nowMs) {
    throw new WorldCupReservationError(
      "That match has already kicked off — pick an upcoming match.",
    );
  }
  return fixture;
}

/* ───────────────────── line items (match window) ───────────────────── */

/** The slice of a bowling experience item the line builder needs (client
 *  shape from GET /api/bowling/v2/experiences). */
export interface WorldCupExperienceItemLike {
  squareProductId: number;
  quantity: number;
  label: string;
  priceCents: number;
  depositPct: number;
  squareCatalogObjectId?: string;
  sortOrder: number;
}

/**
 * Cart line items for a World Cup lane window. Mirrors
 * BowlingOfferStep.buildLineItems for an hourly experience with NO duration
 * options: EVERY item scales × laneCount (the primary's duration multiplier
 * is 1), so chips & salsa lands one per lane. The PRIMARY (sortOrder 0)
 * label carries the match name — it becomes the Neon line label, which the
 * confirmation email + receipts surface as the experience label.
 */
export function buildWorldCupLineItems(
  items: WorldCupExperienceItemLike[],
  laneCount: number,
  fixture: WorldCupFixture,
): Array<{
  squareProductId: number;
  quantity: number;
  label: string;
  priceCents: number;
  depositPct: number;
  squareCatalogObjectId?: string;
}> {
  return items.map((ei) => ({
    squareProductId: ei.squareProductId,
    quantity: ei.quantity * laneCount,
    label: ei.sortOrder === 0 ? `${ei.label} — ${fixtureLabel(fixture)}` : ei.label,
    priceCents: ei.priceCents,
    depositPct: ei.depositPct,
    squareCatalogObjectId: ei.squareCatalogObjectId,
  }));
}

/* ───────────────────── staff-facing strings (QAMF) ─────────────────── */

/** Conqueror reservation Title — "VIP Exp." prefix precedent (unified-reserve). */
export function worldCupQamfTitle(guestName: string, players: number): string {
  return `World Cup ${guestName} (${players}p)`;
}

/** Lead line for the Conqueror Notes so front desk spots the package. */
export function worldCupQamfBanner(fixture: WorldCupFixture): string {
  return `*** WORLD CUP: ${fixtureStaffLabel(fixture)} (2.5-hr window, paid online) ***`;
}
