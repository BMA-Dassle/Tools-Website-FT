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
