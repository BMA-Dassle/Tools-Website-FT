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
  // PREVIEW BRANCH ONLY (preview/kiosk-split-smoke): forced ON so the smoke
  // needs no env-var/bake dance. NEVER merge this hardcode to main.
  return true;
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
 * Kiosk self-service CHECK-IN flow — LIVE, kill switch, defaults ON (owner
 * 2026-07-25, after the racer-scheduling smoke passed). A guest with an existing
 * reservation finds it at the kiosk, sees a "what's next" itinerary, finishes
 * the party's waivers, binds people to purchased slots, and the whole party
 * checks in at once (BMI marked "Confirmation Kiosk", racers scheduled onto the
 * session, bowling lane-open offered). Gates the attract-screen entry button
 * (which is also Fort-Myers-only in AttractScreen — racing venue). Set the
 * literal "false" in Vercel + redeploy to hide it. Read at call time (never
 * module scope) so tests can stub process.env.
 */
export function kioskCheckinEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_CHECKIN_ENABLED !== "false";
}

/**
 * Race Info hub on the kiosk — OPT-IN, defaults OFF. A view-only destination
 * (owner 2026-07-21): tile landing → Upcoming Races (live availability grid,
 * nothing bookable), Race Records, Race Types, The Tracks, plus a Book Now
 * bar back into the booking flow. Gates only the attract-screen entry button
 * (which also requires center === "fort-myers" — racing is FM-only); the
 * /kiosk/race-info page stays reachable by typed URL for staff testing. Set
 * the literal "true" in Vercel + redeploy to show the button (NEXT_PUBLIC_*
 * values are build-baked). Read at call time (never module scope) so tests
 * can stub process.env.
 */
export function kioskRaceInfoEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_RACE_INFO_ENABLED === "true";
}

/**
 * BMI writes for kiosk CHECK-IN (registerProjectPerson attach, racer schedule,
 * "Confirmation Kiosk" state stamp, staff memo, interactive lane-open) — kill
 * switch, defaults ON (owner 2026-07-25, after the live smoke: register → attach
 * → schedule linked 2/2 → state stamped, on W54518). Server-side only. Set
 * KIOSK_CHECKIN_BMI_ATTACH=0 in Vercel to make check-in dark again (persists to
 * Neon only, no BMI writes) without a redeploy. Read at call time so tests can
 * stub process.env.
 */
export function kioskCheckinAttachEnabled(): boolean {
  return process.env.KIOSK_CHECKIN_BMI_ATTACH !== "0";
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
 * In-house waivers (owner 2026-07-26) — serve OUR OWN waiver template (adult/minor
 * × en/es, versioned) and store the signed waiver in Neon, instead of fetching the
 * template from and signing only into BMI/Pandora. Kill switch, **defaults ON**:
 * set NEXT_PUBLIC_KIOSK_WAIVER_INHOUSE=false in Vercel + redeploy to revert to the
 * BMI-only path (byte-identical to before). NEXT_PUBLIC because the decision is
 * made both client-side (which template/sign route the pandora.ts wrappers hit)
 * and server-side (the routes). Safety: while ON we STILL dual-write the signature
 * to BMI so `waiverExpiry` keeps advancing and every waiverValid consumer + every
 * returning-guest validity read is unaffected. Read at call time so tests can stub.
 */
export function kioskWaiverInhouseEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_WAIVER_INHOUSE !== "false";
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
 * already captured at player-add) and re-adds HeadPinz/FastTrax Rewards on
 * the kiosk — OPT-IN, defaults OFF (v2 cutover rule: the two-screen path
 * stays the default until ops signs off on a live kiosk). Set the literal
 * "true" in Vercel + redeploy to enable (NEXT_PUBLIC_* values are
 * build-baked — scope the var to Preview too or preview builds bake it off).
 * Read at call time (never module scope) so tests can stub process.env.
 */
export function kioskMergedCheckoutEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_MERGED_CHECKOUT === "true";
}

/**
 * Game Zone checkout-upsell page (owner 2026-07-21) — its OWN switch,
 * separate from the merged-checkout rollout (owner: "separate out the
 * merged checkout and upsell flags"). Kill switch, defaults ON: the page is
 * only reachable inside the merged flow anyway, so the merged flag stays
 * the single rollout decision and this one exists to turn the OFFER off
 * without touching the screen. Set the literal "false" in Vercel + redeploy
 * to hide it. Read at call time so tests can stub process.env.
 */
export function kioskCheckoutUpsellEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_CHECKOUT_UPSELL !== "false";
}

/**
 * Guest-facing multi-language (i18n) on the kiosk — OPT-IN, defaults OFF. Gates
 * the top-right flag LanguageSwitcher and any locale-aware copy fallback; with
 * it off, the kiosk is English-only exactly as before (the switcher renders
 * null and every screen keeps its default-locale text). Set the literal "true"
 * in Vercel + redeploy to expose the language switcher (NEXT_PUBLIC_* values are
 * build-baked — scope it to Preview too or preview builds bake it off). Read at
 * call time (never module scope) so tests can stub process.env. See
 * tasks/kiosk-i18n-spanish-plan.md.
 */
export function kioskI18nEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_I18N === "true";
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

/**
 * Attract-screen bank BILLBOARD (owner pick 2026-07-26) — HeadPinz kiosks
 * only: every screen in the physical bank takes one activity (photo + neon
 * word) lighting up down the row, then the whole bank lands "All right
 * here." together. Clock-locked to the shared kiosk wall clock; per-venue
 * physical order lives in attract/billboard.ts.
 *
 * Rollout (owner 2026-07-26): **ON by default at BOTH HeadPinz venues**
 * (Fort Myers and Naples). Kill switch: set the literal "false" in Vercel +
 * redeploy to turn it off everywhere. FastTrax never shows it (its picked
 * events are the drive-by + relay wave, later PR). NEXT_PUBLIC_* values are
 * build-baked. Read at call time so tests can stub process.env.
 */
export function kioskBillboardEnabled(venue: "FT" | "HPFM" | "HPN"): boolean {
  if (process.env.NEXT_PUBLIC_KIOSK_BILLBOARD === "false") return false;
  return venue !== "FT";
}

/**
 * Rotating attract welcome line — "Let's play." / "Let's bowl." / "Let's
 * party." (HeadPinz) and play/race/bowl (FastTrax), clock-synced 4s fade
 * cycle (owner 2026-07-26: "we need to rotate lets play, lets bowl etc").
 * Kill switch, defaults ON — set the literal "false" in Vercel + redeploy to
 * pin the static "Let's play." Read at call time so tests can stub
 * process.env.
 */
export function kioskWelcomeRotateEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_WELCOME_ROTATE !== "false";
}

/**
 * Coupon / promo codes on the kiosk (owner 2026-07-27, reversing the 2026-07-21
 * "no promo input" call — entry moved to the CATEGORY screen, mirroring the
 * website's /book/v2 attraction selector) — OPT-IN, defaults OFF. Gates the
 * "Coupon or voucher?" chip on KioskCategories and the code-entry screen. The
 * pricing seams have been live the whole time (the kiosk cart runs
 * promoFactor/applyPromoToBillLines transitively), so enabling this only adds
 * the ENTRY point. Set the literal "true" in Vercel + redeploy to show it
 * (NEXT_PUBLIC_* values are build-baked — scope the var to Preview too or
 * preview builds bake it off). Preview opt-in without env changes:
 * /kiosk/flow?kioskPromo=1 (same pattern as ?bowlingV3=1). Read at call time
 * (never module scope) so tests can stub process.env.
 */
export function kioskPromoEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_PROMO === "true";
}

/**
 * Game Zone COMP voucher redemption — scan a BMI "Complimentary N Token Game
 * Card" voucher and the kiosk dispenses a loaded card, no payment involved
 * (owner 2026-07-29, five live codes minted at Office).
 *
 * Kill switch, **defaults ON** (owner instruction: "make flag on by default").
 * Set NEXT_PUBLIC_KIOSK_VOUCHER_GZ=false in Vercel + redeploy to hide it
 * (NEXT_PUBLIC_* values are build-baked).
 *
 * Deliberately INDEPENDENT of kioskPromoEnabled(): the Game Zone chooser tile
 * is the primary entry point precisely because a guest may arrive holding only
 * the voucher, with an empty cart and no booking — gating it behind the cart's
 * coupon screen would mean "on by default" wasn't actually on. (The secondary
 * hand-off from that coupon screen still follows the promo flag, since that
 * whole screen does.)
 *
 * Gates only the ENTRY. The server refuses on its own terms regardless: no
 * live BMI peek → no grant, no claim → no load. Read at call time (never module
 * scope) so tests can stub process.env.
 */
export function kioskVoucherGzEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_VOUCHER_GZ !== "false";
}

/**
 * Kiosk "Next available" EXPERIENCES fan-out — kill switch, defaults ON,
 * server-side only (the cached availability compute is the sole consumer, so no
 * NEXT_PUBLIC prefix / no rebuild needed — flip in Vercel + it takes effect on
 * the next cache-miss compute).
 *
 * The Experiences legs — the VIP combo (race-bowl) feasible-chain probe and the
 * Ultimate Qualifier package feasibility — are by far the heaviest vendor cost
 * in computeExperienceAvailability: each fans out across many BMI heat-product
 * availability calls (race legs + cross-tier occupancy unions, UQ variants ×
 * races) plus a full-day QAMF bowling scan. When BMI/QAMF are under load, set
 * KIOSK_EXPERIENCE_AVAIL=0 to shed those two legs instantly — their tiles fall
 * back to open-with-no-line (available, no "Next available" text; they never
 * false-lock). Every other tile (racing, attractions, bowling, KBF) is
 * unaffected. Read at call time so tests can stub process.env.
 */
export function kioskExperienceAvailEnabled(): boolean {
  return process.env.KIOSK_EXPERIENCE_AVAIL !== "0";
}

/**
 * Kiosk split-tender v1 — "match web": ONE gift card (scan/swipe/typed GAN)
 * + ONE reader tap per checkout (owner 2026-07-29). Gates the gift-card-lookup
 * + deposit-tenders routes AND the client split UI. Opt-in, default OFF —
 * money-path change; flip only after probe #2 (gc-id-as-source) passes and a
 * live card-present smoke (tasks/split-tender-probes.md). Inert unless
 * kioskTerminalEnabled() is also on (the split rides the terminal rail).
 */
export function kioskSplitTenderEnabled(): boolean {
  // PREVIEW BRANCH ONLY (preview/kiosk-split-smoke): forced ON so the smoke
  // needs no env-var/bake dance. NEVER merge this hardcode to main.
  return true;
}
