/**
 * HOUSE RULE — FLAGS ARE KILL SWITCHES ONLY (owner 2026-07-31: "if we do flags,
 * it's only to turn features off — I don't want to fight it 24/7").
 *
 * A merged feature is ON. A flag, when one exists at all, DEFAULTS ON and is an
 * emergency OFF switch (`!== "false"`), never an opt-in gate (`=== "true"`) that
 * ships a feature dark and then demands an env-var + rebuild scavenger hunt to
 * see it. Features that aren't ready to be on don't merge — they live on a
 * branch and get tested on its preview deployment. (Born from the split-tender
 * rollout: two stacked opt-in flags left the owner staring at old UI through
 * three "did you redeploy?" rounds.)
 *
 * Mechanics: a NEXT_PUBLIC_* env var is BUILD-BAKED — changing it in Vercel does
 * nothing until a redeploy, and an open kiosk tab keeps the old bundle until
 * reload. Read at call time (never module scope) so tests can stub process.env.
 *
 * Kiosk kill switch below: the /kiosk URL is not linked from any nav — this is
 * the emergency off switch, not an exposure gate.
 */
export function kioskEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_ENABLED !== "false";
}

// kioskTerminalEnabled is GONE (owner 2026-07-31: "stop trying to make
// everything flags") — the direct-Terminal reader charge IS the kiosk payment
// rail, unconditionally, and the interim SAVE_CARD path is retired. NO card is
// ever vaulted (owner rule: "Kiosk is NOT going to use saved card").

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
 * Voucher-QR party prefill — kill switch, DEFAULTS ON (owner 2026-07-31:
 * "flags on by default"). When a guest scans their booking-minted voucher QR
 * (the /v/{code} image in the VIP welcome email) at check-in, the code
 * resolves to its booking via vouchers.bill_id (possession = proof, same
 * posture as the emailed reservation QR — owner 2026-07-25) and the party
 * panel offers "Load your party" so nobody re-types names the booking already
 * knows. Gates BOTH the server resolution arm and the client banner — and the
 * code-entry receipt's "Who's here from your booking?" chips (KioskCodeEntry),
 * which ride the same lookup rail. Set the
 * literal "false" in Vercel + redeploy to turn it off (build-baked). Read at
 * call time so tests can stub process.env.
 */
export function kioskVoucherPrefillEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_VOUCHER_PARTY_PREFILL !== "false";
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
 * Race Sims tile on the Fort Myers kiosks — kill switch, defaults ON. The tile
 * carries its own staff gate during the placeholder phase (guests see a locked
 * "Coming Soon" card; the kiosk admin PIN opens the flow), so this switch is
 * NOT the exposure gate — it exists only to pull the tile entirely in an
 * emergency. Set the literal "false" in Vercel + redeploy to hide it
 * (NEXT_PUBLIC_* values are build-baked). Read at call time (never module
 * scope) so tests can stub process.env.
 */
export function kioskRaceSimEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS !== "false";
}

/**
 * Does the Race Sims door open on THIS kiosk? Venue rule + kill switch in one
 * named place, so the answer is testable and cannot drift between surfaces.
 *
 * Keyed on the CENTER, not the brand (owner 2026-09-01: "SIMS need to show on
 * the kiosk at headpinz fort myers"). The sims sit in the FastTrax building,
 * but HeadPinz FM is the same complex serving the same guests, so both brands'
 * Fort Myers kiosks show the tile — the FT:* fleet and the nine HPFM:* units.
 * Naples (HPN:*) is a different building and the center check alone excludes
 * it. Same shape as the Race Info hub's door, which is already brand-agnostic.
 *
 * This governs who SEES the tile, never who can book: the tile renders locked
 * ("Coming Soon") until the kiosk-admin PIN unlocks it for that session.
 */
export function kioskRaceSimDoorOpen(center: string | null | undefined): boolean {
  return center === "fort-myers" && kioskRaceSimEnabled();
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
 * The kiosk-bmi-sync-sweep cron (kill switch, defaults ON, server-side only) —
 * the queue that finishes what check-in/waiver-join couldn't do inline: seats
 * 'waiting-sync' racers once the cloud attach crosses to the center's local
 * server, and re-drives recent failed waiver-join attaches once the person is
 * visible cloud-side. Turning it OFF returns to the pre-sweep world where a
 * sync-lagged racer stays unseated until staff notice — an emergency valve if
 * the sweep misbehaves, never a steady state. The BMI writes inside it ALSO
 * respect kioskCheckinAttachEnabled / kioskWaiverBmiAttachEnabled, so the
 * per-rail switches keep working. Set KIOSK_BMI_SYNC_SWEEP=false to stop it.
 */
export function kioskBmiSyncSweepEnabled(): boolean {
  return process.env.KIOSK_BMI_SYNC_SWEEP !== "false";
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
 * already captured at player-add) and carries HeadPinz/FastTrax Rewards.
 *
 * KILL SWITCH — default ON. It shipped as an opt-in `=== "true"` gate, which is
 * exactly what the owner's 2026-07-31 flag rule forbids ("flags are kill
 * switches only, never opt-in gates"), and the cost was invisible: with the var
 * unset, every kiosk fell back to the legacy two-screen path, where CheckoutStep
 * is rendered with `hideRewards` — so the rewards section built for this screen
 * had never appeared, while the checkout subtitle still promised "unlock
 * rewards" (owner 2026-08-04: "something happen to rewards on this page?").
 * `NEXT_PUBLIC_KIOSK_MERGED_CHECKOUT=false` restores the legacy path.
 * Read at call time (never module scope) so tests can stub process.env.
 */
export function kioskMergedCheckoutEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_MERGED_CHECKOUT !== "false";
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
 * website's /book/v2 attraction selector). Gates the "Coupon or voucher?" chip
 * on KioskCategories, the code-entry screen, and the applied-promo row.
 *
 * Kill switch, **defaults ON** (owner instruction 2026-08-02: "make sure those
 * flags are on by default"). Set NEXT_PUBLIC_KIOSK_PROMO=false in Vercel +
 * redeploy to hide it (NEXT_PUBLIC_* values are build-baked).
 *
 * Was an opt-in `=== "true"` until 2026-08-02, which violated the repo's
 * flags-are-kill-switches-only rule and left the entry-screen scan router
 * refusing a voucher on kiosks where the code screen was in fact reachable
 * (the door already opened on `voucherRedeemEnabled()`, which is on by
 * default — the two gates disagreed).
 *
 * Turning this on adds only the ENTRY point: the pricing seams have been live
 * the whole time (the kiosk cart runs promoFactor/applyPromoToBillLines
 * transitively). Preview opt-in without env changes is still
 * /kiosk/flow?kioskPromo=1. Read at call time (never module scope) so tests
 * can stub process.env.
 */
export function kioskPromoEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_PROMO !== "false";
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
 * Ambient checkout (2026-08) — kill switch, defaults ON, SERVER-side only.
 * ON: every kiosk Terminal checkout arms auth-only with partial authorization,
 * and capture is one atomic PayOrder over the tender set. ANY tender that
 * partially approves rides the same loop — Square gift cards are the headline
 * (swipe or scan, no button), but prepaid/debit partials board and re-arm
 * identically (owner 2026-08-06: "it's not just gift cards"). Scanned eGifts
 * auto-apply through the same rail. OFF: checkouts arm capture-on-tap exactly
 * like the pre-ambient rail (a low-balance card swipe declines at the reader).
 *
 * The CLIENT never reads this flag — a non-NEXT_PUBLIC var is undefined in the
 * bundle and `!== "false"` would silently read ON. The client keys off the
 * prepare response's `ambient` field and the poll's `captured`/`tender`
 * fields, so a mid-session flip degrades gracefully in both directions: the
 * flag only changes how NEW checkouts arm, and the split routes an in-flight
 * ambient session finishes on are never disabled by it. Read at call time so
 * tests can stub process.env.
 */
export function kioskAmbientCheckoutEnabled(): boolean {
  return process.env.KIOSK_AMBIENT_CHECKOUT !== "false";
}

/**
 * The tender sweep cron (kill switch, defaults ON, server-side only) — the
 * observer that drains stale kiosk payment sessions: forward-captures covered
 * sets, voids abandoned holds, alerts ops on captured-but-unfinalized orders.
 * Turning it OFF leaves walk-away holds to Square's ~36h auto-cancel and
 * captured-but-unfinalized sessions to manual discovery — an emergency valve
 * if the sweep itself misbehaves, never a steady state.
 */
export function kioskTenderSweepEnabled(): boolean {
  return process.env.KIOSK_TENDER_SWEEP !== "false";
}

/**
 * The standalone "Your Crew" page (/kiosk/racers) — kill switch, defaults ON.
 * A group adds / signs in everyone (accounts + waivers) with no prices and no
 * cart, then hands the assembled party into the booking flow; it is also where
 * a scanned racing licence lands when the racer has nothing booked today.
 * Gates the DOORS only: the session banner's tap-through + its chooser empty
 * state, and the entry-scan racer arm's navigation (which falls back to the
 * `entryscan.racerSignedIn` toast, exactly the pre-crew behavior). The
 * /kiosk/racers page itself stays reachable by typed URL for staff testing.
 * Set the literal "false" in Vercel + redeploy to withdraw the doors
 * (NEXT_PUBLIC_* values are build-baked). Read at call time (never module
 * scope) so tests can stub process.env.
 */
export function kioskCrewEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_CREW !== "false";
}

/**
 * Kiosk STAFF MODE (2026-09-04) — a staff Intercard card scanned on a staff
 * surface (Your Crew first) arms Membership / Comp / Race history actions on
 * every roster card for 10 s past the last touch. Kill switch, defaults ON.
 * Gates the scan GATE only (useStaffCardScan): with it off a staff card is just
 * another unrecognised scan and nothing staff-shaped renders. Set the literal
 * "false" in Vercel + redeploy to withdraw it (NEXT_PUBLIC_* values are
 * build-baked). Read at call time (never module scope) so tests can stub
 * process.env.
 */
export function kioskStaffModeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_STAFF_MODE !== "false";
}

// kioskSplitTenderEnabled is GONE (owner 2026-07-31) — paying with a gift card
// (ONE gift card + ONE reader tap, "match web") is unconditional on every kiosk
// checkout. History: tasks/split-tender-probes.md.
