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

export interface HoldBowlingSlotInput {
  centerId: number;
  webOfferId: number;
  optionId: number | undefined;
  optionType: "Game" | "Time" | "Unlimited" | undefined;
  bookedAt: string;
  players: number;
  service?: "BookForLater" | "PlayNow";
  /** A hold this one supersedes (re-pick, duration change, back-nav). Released
   *  best-effort BEFORE the new hold so we never carry two live QAMF holds —
   *  the old flow leaked the superseded hold for its full 10-min TTL. */
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

/** Create a QAMF Temporary hold, releasing any superseded hold first. */
export async function holdBowlingSlot(input: HoldBowlingSlotInput): Promise<HoldBowlingSlotResult> {
  if (input.previousHoldId) {
    await fetch(
      `${apiBase()}/api/bowling/v2/reserve/hold/${encodeURIComponent(input.previousHoldId)}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ centerId: input.previousCenterId ?? input.centerId }),
      },
    ).catch(() => {
      // Best-effort — an expired/gone hold is fine; QAMF 404s are swallowed
      // by the route anyway.
    });
  }

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

  return {
    qamfReservationId: data.qamfReservationId,
    expiresAt: data.expiresAt ?? null,
    status: data.status ?? "Temporary",
  };
}
