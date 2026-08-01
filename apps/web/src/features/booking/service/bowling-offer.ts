/**
 * Shared bowling offer/hold logic, extracted verbatim from BowlingOfferStep.tsx
 * (2026-07-19) so the v3 Experience/Time steps and the kiosk can reuse it
 * without duplicating the money-adjacent line-item math or the option-
 * precedence guard. Pure except `holdBowlingSlot` (fetch).
 */

import type {
  BowlingExperienceWithDetails,
  BowlingExperienceDurationOption,
} from "@/lib/bowling-db";
import { apiBase } from "@/lib/api-base";

export interface BowlingLineItem {
  squareProductId: number;
  quantity: number;
  label?: string;
  priceCents?: number;
  depositPct?: number;
  squareCatalogObjectId?: string;
}

/** Lanes needed for a party (QAMF lanes hold up to 6 bowlers). */
export function bowlingLaneCount(playerCount: number): number {
  return Math.max(1, Math.ceil(playerCount / 6));
}

/** Hourly rentals and Pizza Bowl price per LANE; everything else per person. */
export function isPerLaneExperience(exp: {
  kind: BowlingExperienceWithDetails["kind"];
  slug: string;
}): boolean {
  return exp.kind === "hourly" || exp.slug.startsWith("pizza-bowl");
}

/**
 * Resolve the Square line items for an experience pick. Primary items
 * (sortOrder 0) scale by lane-or-player count AND the duration multiplier;
 * bundled secondaries scale per lane. Duration overrides (2-hour product
 * variants) swap the primary product/price/deposit.
 */
export function buildBowlingLineItems(
  exp: BowlingExperienceWithDetails,
  durationOpt: BowlingExperienceDurationOption | null,
  playerCount: number,
  laneCount: number,
): BowlingLineItem[] {
  const qtyMultiplier = isPerLaneExperience(exp) ? laneCount : playerCount;
  const durationMultiplier = durationOpt?.squareMultiplier ?? 1;

  return (exp.items ?? []).map((ei) => {
    const isPrimary = ei.sortOrder === 0;
    const useOverride = isPrimary && durationOpt?.overrideSquareProductId;

    return {
      squareProductId: useOverride ? durationOpt!.overrideSquareProductId! : ei.squareProductId,
      quantity: isPrimary
        ? ei.quantity * qtyMultiplier * durationMultiplier
        : ei.quantity * laneCount,
      label: ei.label,
      priceCents: useOverride ? (durationOpt!.overridePriceCents ?? ei.priceCents) : ei.priceCents,
      depositPct: useOverride ? (durationOpt!.overrideDepositPct ?? ei.depositPct) : ei.depositPct,
      squareCatalogObjectId: useOverride
        ? (durationOpt!.overrideCatalogObjectId ?? ei.squareCatalogObjectId)
        : ei.squareCatalogObjectId,
    };
  });
}

/**
 * Option precedence:
 *  1. durationOpt    — the duration the customer explicitly picked (hourly).
 *  2. exp.qamfOptionId — the experience's seeded offer option. Open packages
 *     (Pizza Bowl 2hr, Fun 4 All 1.5hr) have no duration buttons but DO carry
 *     the correct Time option here.
 *  3. slotOptionId   — QAMF-derived, last resort ONLY.
 * We must NOT trust the slot's optionId for fixed-duration packages: QAMF
 * returns a 60/90/120-min option triple with Minutes often undefined and lists
 * the 60-min option first, so a "longest Minutes" guess degrades to 1 hour —
 * the Pizza Bowl / Fun 4 All short-booking bug.
 */
export function effectiveBowlingOptionId(
  durationOpt: BowlingExperienceDurationOption | null,
  exp: Pick<BowlingExperienceWithDetails, "qamfOptionId">,
  slotOptionId: number | undefined,
): number | undefined {
  return durationOpt?.qamfOptionId ?? exp.qamfOptionId ?? slotOptionId;
}

/**
 * Longest close-fitting Time option for an experience that seeds NO option of
 * its own (Midnight Madness riding the shared Fri-Sun hourly offer). The
 * availability route already strips per-slot Time options that would run past
 * closing, so the longest option REMAINING on a slot is exactly "the closest
 * duration that doesn't pass close" (owner 2026-08-01): 2hr sells until a
 * midnight start, 1.5hr until 12:30, 1hr until the 1 AM last start. Durations
 * resolve from OUR config across the experiences sharing the slot's web offer
 * (QAMF's Minutes field is absent from availability responses — never read;
 * trusting response order degrades to the shortest option, the Pizza Bowl
 * short-booking bug). Undefined when nothing resolves — callers fall back to
 * the slot's own optionId, so Game/Unlimited offers are unaffected.
 */
export function longestFittingOptionId(
  slot: { webOfferId: number; availableTimeOptionIds?: number[] },
  experiences: Array<Pick<BowlingExperienceWithDetails, "qamfWebOfferId" | "durationOptions">>,
): number | undefined {
  let best: number | undefined;
  let bestMinutes = -1;
  for (const id of slot.availableTimeOptionIds ?? []) {
    for (const exp of experiences) {
      if (exp.qamfWebOfferId !== slot.webOfferId) continue;
      const d = (exp.durationOptions ?? []).find((o) => o.qamfOptionId === id);
      if (d && d.durationMinutes > bestMinutes) {
        bestMinutes = d.durationMinutes;
        best = id;
      }
    }
  }
  return best;
}

/**
 * Midnight Madness rides the all-day Fri-Sun Time offer (its dedicated QAMF
 * Unlimited offers reject every reservation create — vendor ticket open,
 * 2026-08-01), so its late-night sales window must be enforced on OUR side.
 * Without this gate the MM card would sell $11.99/person lanes at noon next
 * to the full-price hourly card. 11:45 PM first start (owner 2026-08-01) —
 * matches the original QAMF MM offer schedule. Minutes are ET minutes-of-day
 * in the 0-26h notation (11:45 PM = 1425, 1 AM = 1500).
 */
export const MM_EARLIEST_START_MINUTES = 23 * 60 + 45;

export function slotAllowedForExperience(slug: string, etMinutes: number): boolean {
  if (!slug.startsWith("midnight-madness")) return true;
  return etMinutes >= MM_EARLIEST_START_MINUTES;
}

export interface HoldBowlingSlotInput {
  centerId: number;
  webOfferId: number;
  optionId: number | undefined;
  optionType: "Game" | "Time" | "Unlimited" | undefined;
  bookedAt: string;
  players: number;
  service?: "BookForLater" | "PlayNow";
  /**
   * A hold this one supersedes (re-pick, duration change, VIP upgrade).
   * Released best-effort AFTER the new hold succeeds — so a failed re-hold
   * leaves the customer's existing hold standing (the VIP-upsell guarantee),
   * while a successful one no longer leaks the old hold for its 10-min TTL.
   * Callers must no-op a re-tap of the already-held slot themselves (creating
   * a second hold for the identical slot can 409 against our own hold when
   * it consumed the last lane).
   */
  previousHoldId?: string | null;
  previousCenterId?: number | null;
}

export interface HoldBowlingSlotResult {
  qamfReservationId: string;
  expiresAt: string | null;
  status: string;
}

export class HoldRejectedError extends Error {
  readonly code: string | null;
  readonly status: number;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "HoldRejectedError";
    this.status = status;
    this.code = code;
  }
}

/** Best-effort release of a QAMF Temporary hold. An expired/gone hold is
 *  fine — QAMF 404s are swallowed by the route; failures TTL out in 10 min. */
export async function releaseBowlingHold(centerId: number, qamfId: string): Promise<void> {
  await fetch(`${apiBase()}/api/bowling/v2/reserve/hold/${encodeURIComponent(qamfId)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ centerId }),
  }).catch(() => {});
}

/** Create a QAMF Temporary hold, then release any superseded hold. */
export async function holdBowlingSlot(input: HoldBowlingSlotInput): Promise<HoldBowlingSlotResult> {
  const res = await fetch(`${apiBase()}/api/bowling/v2/reserve/hold`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      centerId: input.centerId,
      webOfferId: input.webOfferId,
      optionId: input.optionId,
      optionType: input.optionType,
      bookedAt: input.bookedAt,
      players: input.players,
      service: input.service ?? "BookForLater",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    qamfReservationId?: string;
    expiresAt?: string | null;
    status?: string;
    error?: string;
    code?: string;
  };

  if (!res.ok || !data.qamfReservationId) {
    throw new HoldRejectedError(
      data.error ?? "Couldn't reserve this slot. Try another time.",
      res.status,
      data.code ?? null,
    );
  }

  // New hold secured — now the superseded one can go.
  if (input.previousHoldId && input.previousHoldId !== data.qamfReservationId) {
    await releaseBowlingHold(input.previousCenterId ?? input.centerId, input.previousHoldId);
  }

  return {
    qamfReservationId: data.qamfReservationId,
    expiresAt: data.expiresAt ?? null,
    status: data.status ?? "Temporary",
  };
}
