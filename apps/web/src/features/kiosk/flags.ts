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

/**
 * Direct Square Terminal (card-present reader) charging — OPT-IN (defaults OFF).
 *
 * When ON, the kiosk charges the guest's card DIRECTLY on the paired Square
 * reader (Terminal checkout pays the deposit order → yields a completed
 * paymentId) instead of tokenizing a typed card. NO card is vaulted — the
 * SAVE_CARD path is retired for the kiosk (owner rule: "Kiosk is NOT going to
 * use saved card"). This re-sequences the money rail (charge on the reader
 * BEFORE reserve records it as an externalPayment), so it MUST ship with a live
 * card-present smoke on real hardware before going live (H3074 six-charge rule).
 * The reader flow stays dormant and the kiosk falls back to the proven typed-card
 * path until this is set to "true" in Vercel + redeployed, after the smoke.
 */
export function kioskTerminalEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_TERMINAL_ENABLED === "true";
}

/**
 * Group & online waiver flow on the kiosk — OPT-IN (defaults OFF). Gates the
 * attract-screen entry button. The /kiosk/waiver page itself stays reachable
 * by typed URL for the staff smoke; this flag is the public exposure switch,
 * flipped to "true" in Vercel + redeploy after the owner live smoke.
 */
export function kioskGroupWaiverEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_GROUP_WAIVER_ENABLED === "true";
}

/**
 * BMI registerProjectPerson attach for kiosk waiver joins — OPT-IN (defaults
 * OFF), server-side only (the join route is the sole consumer, so no
 * NEXT_PUBLIC prefix). registerProjectPerson is proven on fresh booking
 * bills; against an existing confirmed project it must pass the
 * scripts/kiosk-waiver-attach-probe.mts dry-run first (public-booking orderId
 * and Office projectId can differ — see /api/bmi verifyPostConfirm). Until
 * this is "1", joins persist to Neon with status 'skipped' and the kiosk
 * roster unions them in — the guest experience is whole either way.
 */
export function kioskWaiverBmiAttachEnabled(): boolean {
  return process.env.KIOSK_WAIVER_BMI_ATTACH === "1";
}

/**
 * Game Zone cards riding the booking cart (owner 2026-07-18: with items in the
 * cart, cards "should just be in the cart" — one payment at the shared
 * checkout, card lines on the DEPOSIT order, fulfillment on the confirmation
 * screen). Kill switch, defaults ON: the standalone empty-cart Game Zone
 * checkout is untouched either way, and the terminal rail this rides is
 * already live-smoked. Set the literal "false" in Vercel + redeploy to kill.
 */
export function kioskGzCartEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_GZ_CART_ENABLED !== "false";
}
