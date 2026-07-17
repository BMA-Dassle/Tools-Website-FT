/**
 * Kiosk kill switch.
 *
 * House convention (see src/features/world-cup/flags.ts): a NEXT_PUBLIC_* env
 * var that defaults ON and is disabled by setting the literal string "false"
 * in Vercel + redeploy (NEXT_PUBLIC_* values are build-baked). The /kiosk URL
 * is not linked from any nav — this flag is the emergency off switch, not an
 * exposure gate.
 *
 * Read at call time (never module scope) so tests can stub process.env.
 */
export function kioskEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_ENABLED !== "false";
}

/**
 * Race packs on the kiosk — OPT-IN (defaults OFF). Race packs charge a customer
 * and grant Pandora credits, and the owner-chosen "fund today" model re-sequences
 * charge/grant/redeem — a money path that must ship WITH a live payment smoke
 * (H3074 rule). The pack step stays hidden and no pack charge/grant runs until
 * this is set to "true" in Vercel + redeployed, after the smoke.
 */
export function kioskPacksEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_PACKS_ENABLED === "true";
}
