/**
 * NFL game-day bowling kill switches.
 *
 * House rule: a merged feature is ON, and a flag exists only to turn it OFF.
 * So every check here is `!== "false"` — never `=== "true"`. Env is read at CALL
 * time so vitest can stub it; Next.js still inlines NEXT_PUBLIC_* client-side,
 * which is why one variable can gate both the picker and the server guard.
 *
 * Unknown centers fail CLOSED. Naples has no blocks defined and no verified
 * lane-group mapping, so it must never accidentally sell.
 */

import { NFL_BLOCKS_BY_CENTER } from "./blocks";

function masterEnabled(): boolean {
  return process.env.NEXT_PUBLIC_NFL_VIP_ENABLED !== "false";
}

/**
 * Can this center sell NFL game day?
 *
 * Deliberately keyed on whether blocks are DEFINED rather than on a per-center
 * env var. World Cup carried `NEXT_PUBLIC_WORLD_CUP_VIP_NAPLES_ENABLED=false`
 * for weeks to keep an unverified center dark; a center with no block model
 * simply cannot be sold, so the config is the gate and there is no second
 * switch to forget.
 */
export function nflCenterEnabled(centerId: number | null | undefined): boolean {
  if (!masterEnabled() || !centerId) return false;
  return (NFL_BLOCKS_BY_CENTER[centerId] ?? []).some((b) => b.enabled);
}

/** Centers that can sell today. */
export function nflEnabledCenters(): number[] {
  if (!masterEnabled()) return [];
  return Object.keys(NFL_BLOCKS_BY_CENTER)
    .map(Number)
    .filter((id) => nflCenterEnabled(id));
}

/**
 * Sync preseason games too?
 *
 * OFF by default: a Thursday preseason game is football, but the package is
 * priced and marketed for the real thing and preseason would clutter the picker
 * with games nobody books. Flip with NFL_INCLUDE_PRESEASON="true" — this one is
 * a genuine either/or rather than a feature that has shipped, so it reads as an
 * opt-in without breaking the kill-switch rule.
 */
export function nflIncludePreseason(): boolean {
  return process.env.NFL_INCLUDE_PRESEASON === "true";
}
