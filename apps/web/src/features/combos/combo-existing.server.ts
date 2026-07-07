/**
 * Existing VIP combo groups on a date — SERVER-ONLY (imports the Neon lib;
 * keep out of features/combos/index.ts so client bundles never pull it).
 *
 * Feeds the combo wizard's "joins the 4 PM group" hint (via
 * /api/booking/v2/combo/existing) and the staff booking alert's match note.
 * Reads booking_metadata heat times as persisted at reserve — good enough for
 * an ADVISORY hint: the badge only ever attaches to a live fetched candidate,
 * so a group rescheduled by the office simply degrades to a same-hour/no
 * match. Deliberately NOT overlaying live BMI heats (the admin portal does) —
 * that would multiply BMI calls on a customer-facing step.
 */
import { listVipComboReservations, type BowlingReservationWithLines } from "@/lib/bowling-db";

import { chipHourOfIso, type ComboExistingGroup } from "./combo-group-match";

/** Statuses that still represent a real visit to align with. */
const ACTIVE_STATUSES = new Set(["confirmed", "confirm_pending", "arrived", "completed"]);

interface HeatMeta {
  heatId: string;
  track: string | null;
  tier: string | null;
  assignedTo: string | null;
}

function heatsOf(r: BowlingReservationWithLines): HeatMeta[] {
  const raw = r.bookingMetadata?.heats;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((h) => {
      const e = h as Record<string, unknown>;
      return {
        heatId: typeof e.heatId === "string" ? e.heatId : "",
        track: typeof e.track === "string" ? e.track : null,
        tier: typeof e.tier === "string" ? e.tier : null,
        assignedTo: typeof e.assignedTo === "string" ? e.assignedTo : null,
      };
    })
    .filter((h) => h.heatId);
}

/**
 * The date's already-booked combo groups (one per shared deposit order) with
 * their Starter anchor + bowling start. No PII in the return shape. All ids
 * stay strings end-to-end (BMI precision rule). `excludeDepositOrderId` drops
 * the caller's own booking (staff-email use — a booking must not match itself).
 */
export async function listComboGroupsForDate(opts: {
  dateYmd: string;
  comboSpecialId: string;
  excludeDepositOrderId?: string | null;
}): Promise<ComboExistingGroup[]> {
  const legs = (
    await listVipComboReservations({ startDate: opts.dateYmd, endDate: opts.dateYmd })
  ).filter(
    (r) =>
      r.comboSpecialId === opts.comboSpecialId &&
      ACTIVE_STATUSES.has(r.status) &&
      (!opts.excludeDepositOrderId || r.squareDepositOrderId !== opts.excludeDepositOrderId),
  );

  // Legs of one combo share the deposit order (the ONE cross-leg key after the
  // order split); rows without one (shouldn't happen for paid combos) fall back
  // to their own day-of order so they at least don't merge into someone else's.
  const byGroup = new Map<string, BowlingReservationWithLines[]>();
  for (const leg of legs) {
    const key = leg.squareDepositOrderId ?? leg.squareDayofOrderId ?? `row-${leg.id}`;
    byGroup.set(key, [...(byGroup.get(key) ?? []), leg]);
  }

  const groups: ComboExistingGroup[] = [];
  for (const groupLegs of byGroup.values()) {
    const heats = groupLegs.flatMap(heatsOf);
    const starterHeats = heats.filter((h) => h.tier === "starter");
    const anchor = (starterHeats.length ? starterHeats : heats).sort((a, b) =>
      a.heatId.localeCompare(b.heatId),
    )[0];
    if (!anchor) continue; // no race leg recorded — nothing to align to
    const bowlingLeg = groupLegs.find((l) => l.productKind !== "race");
    const racers = new Set(heats.map((h) => h.assignedTo).filter(Boolean));
    groups.push({
      anchorHeatIso: anchor.heatId,
      startHour: chipHourOfIso(anchor.heatId),
      track: anchor.track,
      bowlingStartIso: bowlingLeg?.eventAt ?? null,
      partySize: racers.size || (bowlingLeg?.playerCount ?? null),
    });
  }
  return groups.sort((a, b) => a.anchorHeatIso.localeCompare(b.anchorHeatIso));
}
