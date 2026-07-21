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
 * Group & online waiver flow on the kiosk — OPT-IN, defaults OFF (owner
 * 2026-07-19: "turn the event thing off by default for now", reversing the
 * earlier default-on ask after the first live look). Gates the attract-screen
 * entry button; the /kiosk/waiver page itself stays reachable by typed URL
 * for staff testing. Set the literal "true" in Vercel + redeploy to show the
 * button (NEXT_PUBLIC_* values are build-baked).
 */
export function kioskGroupWaiverEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_GROUP_WAIVER_ENABLED === "true";
}

/**
 * Kiosk self-service CHECK-IN flow — OPT-IN, defaults OFF. A guest with an
 * existing reservation finds it at the kiosk, sees a "what's next" itinerary,
 * finishes the party's waivers, binds people to purchased slots, and the whole
 * party checks in at once (BMI marked -5 Arrived, bowling lane-open offered).
 * Gates only the attract-screen entry button; the /kiosk/checkin page stays
 * reachable by typed URL for staff testing. Set the literal "true" in Vercel +
 * redeploy to show the button (NEXT_PUBLIC_* values are build-baked). Read at
 * call time (never module scope) so tests can stub process.env.
 */
export function kioskCheckinEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_CHECKIN_ENABLED === "true";
}

/**
 * BMI registerProjectPerson attach for kiosk CHECK-IN party binds — OPT-IN,
 * defaults OFF, server-side only. Deliberately SEPARATE from the group-waiver's
 * KIOSK_WAIVER_BMI_ATTACH (which is live + default-ON): check-in ships dark, and
 * the billId-vs-projectId attach semantics against an existing confirmed
 * reservation are still A3-probe-gated. Until this is set to "1" (after the A3
 * APPLY run + owner sign-off), a check-in bind persists to Neon
 * (kiosk_checkin_people) but performs NO BMI write — so a staff tester reaching
 * /kiosk/checkin by typed URL never mutates a real reservation. Read at call
 * time so tests can stub process.env.
 */
export function kioskCheckinAttachEnabled(): boolean {
  return process.env.KIOSK_CHECKIN_BMI_ATTACH === "1";
}

/**
 * BMI registerProjectPerson attach for kiosk waiver joins — kill switch,
 * defaults ON (owner 2026-07-19), server-side only (the join route is the
 * sole consumer, so no NEXT_PUBLIC prefix). registerProjectPerson is proven
 * on fresh booking bills; against an existing confirmed project the
 * scripts/kiosk-waiver-attach-probe.mts APPLY run is still the recommended
 * verification (public-booking orderId and Office projectId can differ — see
 * /api/bmi verifyPostConfirm). The failure mode is contained either way: a
 * rejected attach is recorded on the Neon row as 'failed' (never surfaced to
 * the guest) and the kiosk roster unions the Neon join in. Set
 * KIOSK_WAIVER_BMI_ATTACH=0 in Vercel to stop the BMI writes.
 */
export function kioskWaiverBmiAttachEnabled(): boolean {
  return process.env.KIOSK_WAIVER_BMI_ATTACH !== "0";
}

/**
 * Mobile join — the people-step QR that lets guests sign in / register (and
 * sign their waiver) on their own phone and pop into the kiosk's player list.
 * Kill switch, defaults ON (owner 2026-07-20): set the literal "false" in
 * Vercel + redeploy to hide the QR panel. The /join/{code} page and API
 * routes stay deployed either way.
 */
export function kioskMobileJoinEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_MOBILE_JOIN_ENABLED !== "false";
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

/**
 * Merged cart+checkout screen (owner 2026-07-21): ONE "review your order"
 * screen replaces the separate cart + contact-confirm screens (contact is
 * already captured at player-add), re-adds HeadPinz/FastTrax Rewards on the
 * kiosk, and frees the post-"Review & Pay" slot for the Game Zone upsell
 * page — OPT-IN, defaults OFF (v2 cutover rule: the two-screen path stays
 * the default until ops signs off on a live kiosk). Set the literal "true"
 * in Vercel + redeploy to enable (NEXT_PUBLIC_* values are build-baked).
 * Read at call time (never module scope) so tests can stub process.env.
 */
export function kioskMergedCheckoutEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_MERGED_CHECKOUT === "true";
}

/**
 * Kiosk POV code claiming — kill switch, defaults ON, server-side only
 * (unified-reserve + kiosk-post-reserve are the sole consumers, so no
 * NEXT_PUBLIC prefix / no rebuild needed). Set KIOSK_POV_CODES=0 in Vercel to
 * stop kiosk claims from consuming the Redis pool — every delivery surface
 * (email block, SMS clause, memo line, confirmation display) gates on
 * codes.length so it degrades silently to today's behavior, and owed bills
 * remain backfillable via the admin POV tooling (claim is idempotent per
 * billId). Read at call time so tests can stub process.env.
 */
export function kioskPovCodesEnabled(): boolean {
  return process.env.KIOSK_POV_CODES !== "0";
}
