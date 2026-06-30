/**
 * Add-on capacity — can we seat `addCount` more guests, and does it need another
 * bowling lane?
 *
 * Two gates:
 *   1. Race heats — every race leg's heat must have ≥ addCount free spots.
 *   2. Bowling lane — guests/lane is registry-driven (comboLaneCapacity). When
 *      current + added exceeds the seated lanes' capacity, an extra lane is
 *      required (only allowed when combo.addon.allowAddLane).
 *
 * The lane math is pure (lanePlan) and unit-tested. The heat check takes an
 * injected `heatFreeSpots` lookup so it's testable without live BMI, and so the
 * route can supply the server-side (proxy-via-origin) implementation.
 */
import {
  comboLaneCapacity,
  comboLanesForPlayers,
  comboMaxAddPerTransaction,
  type ComboSpecial,
} from "~/features/combos";

import type { AddOnCapacity, AddOnContext } from "./types";

/** Pure lane arithmetic for an add. Exported for unit tests. */
export function lanePlan(
  combo: ComboSpecial,
  currentPlayers: number,
  currentLanes: number,
  addCount: number,
): { newPlayers: number; newLanes: number; lanesToAdd: number; allowAddLane: boolean } {
  const newPlayers = currentPlayers + addCount;
  const neededLanes = comboLanesForPlayers(combo, newPlayers);
  // Never "remove" a lane the party already holds.
  const newLanes = Math.max(currentLanes, neededLanes);
  const lanesToAdd = Math.max(0, newLanes - currentLanes);
  return { newPlayers, newLanes, lanesToAdd, allowAddLane: combo.addon?.allowAddLane === true };
}

/**
 * Largest add that fits without booking a new lane — the empty seats on the
 * lanes already held. Pure; used to tell a blocked guest "we can add up to N".
 */
export function seatsOnExistingLanes(
  combo: ComboSpecial,
  currentPlayers: number,
  currentLanes: number,
): number {
  return Math.max(0, currentLanes * comboLaneCapacity(combo) - currentPlayers);
}

export interface CapacityDeps {
  /** Free spots in the heat for one race leg (BMI freeSpots). Injected so the
   *  pure lane logic stays testable and the route supplies the live lookup. */
  heatFreeSpots: (leg: AddOnContext["raceLegs"][number]) => Promise<number>;
}

/**
 * Full capacity check. Returns ok=false with a specific reason (and `maxAddable`)
 * when heats are full or a needed lane can't be added.
 */
export async function checkAddOnCapacity(
  combo: ComboSpecial,
  ctx: AddOnContext,
  addCount: number,
  deps: CapacityDeps,
): Promise<AddOnCapacity> {
  const currentPlayers = ctx.bowling?.playerCount ?? 0;
  const currentLanes = ctx.bowling?.laneCount ?? 1;
  const maxPerTxn = comboMaxAddPerTransaction(combo);

  const base: AddOnCapacity = {
    ok: false,
    addCount,
    heatFreeByLeg: [],
    currentPlayers,
    currentLanes,
    newLanes: currentLanes,
    lanesToAdd: 0,
    maxAddable: 0,
  };

  if (addCount < 1) return { ...base, blockedReason: "Choose at least one guest to add." };
  if (addCount > maxPerTxn) {
    return {
      ...base,
      maxAddable: maxPerTxn,
      blockedReason: `You can add up to ${maxPerTxn} guests online — call us for a larger group.`,
    };
  }

  // 1) Race heat free spots (parallel — independent dayplanner reads).
  const heatFreeByLeg = await Promise.all(ctx.raceLegs.map((leg) => deps.heatFreeSpots(leg)));
  const minHeatFree = heatFreeByLeg.length ? Math.min(...heatFreeByLeg) : 0;

  const { newPlayers, newLanes, lanesToAdd, allowAddLane } = lanePlan(
    combo,
    currentPlayers,
    currentLanes,
    addCount,
  );

  // Largest add allowed by HEATS and by per-txn cap.
  const heatMax = Math.min(minHeatFree, maxPerTxn);

  // 2) Lane gate.
  if (lanesToAdd > 0 && !allowAddLane) {
    return {
      ...base,
      heatFreeByLeg,
      newLanes: currentLanes,
      lanesToAdd,
      // Without a new lane, only the empty seats on existing lanes fit.
      maxAddable: Math.min(heatMax, seatsOnExistingLanes(combo, currentPlayers, currentLanes)),
      blockedReason:
        "Adding this many needs another bowling lane, which isn't available online — please call us.",
    };
  }

  if (minHeatFree < addCount) {
    return {
      ...base,
      heatFreeByLeg,
      newLanes,
      lanesToAdd,
      maxAddable: heatMax,
      blockedReason:
        heatMax > 0
          ? `Only ${heatMax} more ${heatMax === 1 ? "spot" : "spots"} left on the races — call us for a larger group.`
          : "The races for this booking are full — please call us.",
    };
  }

  return {
    ok: true,
    addCount,
    heatFreeByLeg,
    currentPlayers,
    currentLanes,
    newLanes,
    lanesToAdd,
    maxAddable: heatMax,
  };
}
