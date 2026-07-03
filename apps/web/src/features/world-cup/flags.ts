/**
 * World Cup VIP Bowling — per-center kill switches (owner requirement 7/3:
 * "option to enable/disable from each center in case something is wrong
 * with the screens").
 *
 * House env-flag pattern (see NEXT_PUBLIC_COMBO_RACE_BOWL_ENABLED in
 * combo-specials.ts): default ON, set the var to the string "false" in
 * Vercel to kill. NEXT_PUBLIC_* is inlined into client bundles AND readable
 * via process.env on the server, so ONE var per center gates all three
 * surfaces — the /book/v2 tile + popup, the match picker step, and the
 * server-side reserve validation (fail-closed). Flipping = env change +
 * redeploy, same as the combo kill switch.
 *
 * Launch config (owner 7/3): FM on, NEXT_PUBLIC_WORLD_CUP_VIP_NAPLES_ENABLED
 * = "false" until the Naples LED wall is verified.
 *
 * Env reads happen at CALL time (not module load) so vitest can stub them;
 * Next.js still inlines the literal process.env.NEXT_PUBLIC_* expressions in
 * client bundles.
 */
import type { CenterCode } from "~/features/booking/types";

/** QAMF numeric center ids (see qamfCenterIdForCode in features/booking/types). */
const QAMF_ID_TO_CENTER: Record<number, CenterCode> = {
  9172: "fort-myers",
  3148: "naples",
};

function masterEnabled(): boolean {
  return process.env.NEXT_PUBLIC_WORLD_CUP_VIP_ENABLED !== "false";
}

/** Is World Cup VIP Bowling sellable at this center right now (flags only —
 *  callers combine with worldCupWindowActive for the date gate)? */
export function worldCupCenterEnabled(center: CenterCode | string | null | undefined): boolean {
  if (!masterEnabled() || !center) return false;
  if (center === "fort-myers") {
    return process.env.NEXT_PUBLIC_WORLD_CUP_VIP_FM_ENABLED !== "false";
  }
  if (center === "naples") {
    return process.env.NEXT_PUBLIC_WORLD_CUP_VIP_NAPLES_ENABLED !== "false";
  }
  return false; // unknown center — fail closed
}

/** Same gate keyed by the QAMF numeric center id (what bowling steps carry). */
export function worldCupCenterEnabledByQamfId(centerId: number | null | undefined): boolean {
  const center = centerId != null ? QAMF_ID_TO_CENTER[centerId] : undefined;
  return worldCupCenterEnabled(center ?? null);
}

/** Centers currently enabled — drives the tile/popup visibility + link target. */
export function worldCupEnabledCenters(): CenterCode[] {
  return (["fort-myers", "naples"] as CenterCode[]).filter(worldCupCenterEnabled);
}
