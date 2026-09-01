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
 * Does this experience already include shoe rental in its price?
 *
 * ONE definition, imported by both the web shoe step and the kiosk details
 * step. It lived as a copy-pasted array in each of them, and the copies drifted
 * the moment a package was added: NFL Ticket lists shoes in its own marketing
 * copy ("shoes, a one-topping pizza, 10 wings and a soda pitcher included") and
 * still charged for them, because only two files out of three knew.
 * Owner, 2026-09-01: "the package includes shoes and its charging."
 *
 * NFL matches by PREFIX because the package is sold through two day-banded
 * slugs — nfl-vip-fri-sun and nfl-vip-mon-thur — and a third band or a second
 * center must not silently start charging. Note World Cup is deliberately
 * ABSENT: that package priced shoes separately.
 */
export function shoesIncludedInExperience(slug: string | null | undefined): boolean {
  if (!slug) return false;
  if (slug.startsWith("nfl-vip-")) return true;
  return ["fun-4-all", "fun-4-all-vip", "pizza-bowl", "pizza-bowl-vip"].includes(slug);
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

/** Calendar day-of-week of the EVENING the MM window opens on: Fri(5), Sat(6).
 *  A post-midnight start (e.g. Sat 12:30 AM) belongs to the PREVIOUS night. */
export const MM_BUSINESS_NIGHTS: ReadonlySet<number> = new Set([5, 6]);

export function isMidnightMadnessSlug(slug: string | null | undefined): boolean {
  return !!slug && slug.startsWith("midnight-madness");
}

/**
 * MM's Square catalog products (both centers share catalog ids — see
 * scripts/seed-bowling-experiences.ts CAT.MIDNIGHT_MADNESS*). The reserve
 * route uses these to recognize an MM booking even when the client sends no
 * experienceSlug (the classic wizard doesn't): every MM booking must carry an
 * MM product line — that's where its per-person price comes from.
 */
export const MM_CATALOG_OBJECT_IDS: ReadonlySet<string> = new Set([
  "ND5N3PMV4AZ5I47U3BJZMLKW", // Midnight Madness $11.99/person
  "G6G2AZV3HHKAWLIZUJVVMOVD", // Midnight Madness VIP $13.99/person
]);

export function slotAllowedForExperience(slug: string, etMinutes: number): boolean {
  if (!isMidnightMadnessSlug(slug)) return true;
  return etMinutes >= MM_EARLIEST_START_MINUTES;
}

/**
 * Server-authoritative MM sales-window check (2026-08-01 incident: MM was
 * booked well before its window — the slot gates above are display-only and
 * live in the client, so a stale bundle or direct API call sails past them).
 * Validates the full rule from `bookedAt` alone: start on a Friday or
 * Saturday NIGHT, 11:45 PM or later ET (post-midnight starts roll back to the
 * previous calendar night before the day check). Returns the guest-facing
 * rejection message, or null when the start is inside the window. Fails
 * CLOSED on an unparseable timestamp — this guards money paths.
 */
export function midnightMadnessWindowError(bookedAt: string): string | null {
  const rejection =
    "Midnight Madness is only available Friday and Saturday nights starting at 11:45 PM.";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(bookedAt));
    let dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      parts.find((p) => p.type === "weekday")?.value ?? "",
    );
    let h = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? NaN);
    if (dow < 0 || Number.isNaN(h) || Number.isNaN(m)) return rejection;
    if (h === 24) h = 0; // midnight edge from hour12:false
    if (h < 6) {
      // Post-midnight start — same 0-26h notation as etMinutesOfDay, and the
      // night it belongs to is the previous calendar day.
      h += 24;
      dow = (dow + 6) % 7;
    }
    if (!MM_BUSINESS_NIGHTS.has(dow)) return rejection;
    if (h * 60 + m < MM_EARLIEST_START_MINUTES) return rejection;
    return null;
  } catch {
    return rejection;
  }
}

/** Typed for the reserve-all shell — unified-reserve throws it BEFORE any
 *  Square or QAMF write, so nothing is charged when the window check fails. */
export class MidnightMadnessWindowError extends Error {
  readonly code = "mm_outside_window";
  constructor(message: string) {
    super(message);
    this.name = "MidnightMadnessWindowError";
  }
}

export interface HoldBowlingSlotInput {
  centerId: number;
  webOfferId: number;
  optionId: number | undefined;
  optionType: "Game" | "Time" | "Unlimited" | undefined;
  bookedAt: string;
  players: number;
  service?: "BookForLater" | "PlayNow";
  /** Experience being held. MM shares its web offer with the all-day Fri-Sun
   *  hourly rail, so the slug is the only way the hold route can apply MM's
   *  sales window (the reserve route re-checks via the MM product lines). */
  experienceSlug?: string;
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
      ...(input.experienceSlug ? { experienceSlug: input.experienceSlug } : {}),
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
