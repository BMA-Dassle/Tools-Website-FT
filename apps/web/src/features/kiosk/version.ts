/**
 * Kiosk self-update check. A kiosk browser stays open for days; when we deploy a
 * new build it otherwise keeps running the old JS until someone closes + reopens
 * it. Instead, record the deploy this tab BOOTED on, and on each between-guest
 * reset (Start Over / post-booking auto-reset) compare it to what the server is
 * serving now — if a newer deploy is live, HARD-reload to pick it up; otherwise
 * soft-nav (which preserves the engaged fullscreen). Owner 2026-07-19.
 *
 * Module-level state is per JS context: a hard reload re-captures the boot
 * version against the new deploy, so it never reload-loops.
 */

/**
 * Human-facing kiosk software version — shown in the admin header AND bottom-
 * right of every kiosk screen (KioskShell) so staff can confirm at a glance
 * what a kiosk is running. Bump on every kiosk feature release (the deploy-SHA
 * self-update below is what actually drives reloads).
 * 1.32.1 — STAFF CHIPS GREY UNTIL THE GUEST IS ON-SITE (owner 2026-09-04: "just
 *         disable the buttons if it's not local yet"). Pandora writes land on the
 *         center's LOCAL server; a guest created cloud-side (web booking, desk)
 *         is not there until BMI's sync carries them down, and a membership or
 *         comp posted before that would 404. Each roster card now asks
 *         /api/kiosk/staff-actions?action=local (the sync queue's own
 *         person-local probe) and keeps Membership / Comp disabled with "Not on
 *         the on-site server yet — tap to re-check" until it answers yes; Race
 *         history reads the cloud and stays live. The server refuses the same
 *         write for the same reason, so the chip and the route can't disagree.
 * 1.32.0 — STAFF MODE ON YOUR CREW (owner 2026-09-04). A MANAGER's Intercard
 *         card scanned on /kiosk/racers arms staff-only actions on every roster
 *         card — Add membership (kind chips, start/end dates; License defaults
 *         to 1 year, everything else to 99), Add comp (kind, qty, free-text
 *         reason) and Race history (memberships + balances; heats not yet
 *         connected — no per-person source exists) — for 10 s past the last
 *         touch, with a green Staff bar (name, idle ring, Staff logout). The
 *         card resolves Office person-by-card → Pandora staff-roles; only a
 *         group containing "Manager" opens the menu. Writes go through the
 *         signed staff token (/api/kiosk/staff-actions), persist-first into
 *         Neon kiosk_staff_actions, then Pandora addMembership / addDeposit.
 *         Built as kiosk-wide pieces (staff-mode/): StaffModeSurface, StaffBar,
 *         StaffPersonActions (mounted in both roster components, null outside
 *         a surface), sheets. Kill switch NEXT_PUBLIC_KIOSK_STAFF_MODE.
 * 1.31.1 — THE CARD DISPENSER IS ALREADY CONNECTED WHEN YOU TAP GAME ZONE
 *         (owner 2026-09-01: "we often click game zone and have to wait for
 *         this to connect"). The CRT-591 connection was only ever created when
 *         a screen that USES it mounted, and the first one in the guest flow is
 *         Game Zone itself — so the tap paid for the whole handshake (open the
 *         COM port, EOT line-clear, INIT, three identity reads) behind a
 *         full-screen "Connecting to the card dispenser…" loader. Park-and-adopt
 *         (2026-07-21) already keeps ONE live connection across screen changes,
 *         so this only ever bit the first Game Zone entry after a page load —
 *         which the idle self-update reload makes a daily event, not a one-off.
 *         A new renderless KioskDispenserPrewarm now opens that connection
 *         AMBIENTLY — on the attract loop and on every flow screen — and parks
 *         it, so Game Zone adopts a connection that is already up and the loader
 *         never appears. Web Serial only needs a user gesture for the port
 *         PICKER, not to reopen a granted port, which is what the existing
 *         silent auto-reconnect already relied on.
 *         The pre-warm tries only ports it can NAME (remembered/saved index,
 *         saved USB ids, lone grant) and never blind-probes: it runs alongside
 *         EntryScanListener, and a blind probe opens each granted port and sits
 *         on it for up to 12s per baud, which would take the scanner's port away
 *         mid-scan. Game Zone's own connect still scans, so a stale hint costs a
 *         pre-warm, never a dispense. Gated to kiosks that actually have a
 *         dispenser (capability "full"), and unmounted while Game Zone is open —
 *         the reader's busy mutex is per hook INSTANCE, not per client, so two
 *         live instances must never share the parked connection.
 *         No guest-facing copy added; the connecting loader survives as the
 *         fallback for a cold or stale-hint connect.
 * 1.31.0 — "YOUR CREW": SIGN EVERYONE IN BEFORE ANYTHING IS BOOKED (owner
 *         2026-08-31: "I want it mature on first launch"; page planned
 *         2026-08-06). A standalone /kiosk/racers page mounts the live people
 *         monolith over the PERSISTED kiosk session — add/remove/sign-in,
 *         accounts + waivers, no prices and no cart — then "Book something"
 *         lands on the chooser with the party already built. Three doors, all
 *         behind the NEXT_PUBLIC_KIOSK_CREW kill switch (default ON): the
 *         session banner's WHO half becomes a button (hold bar untouched — no
 *         nested buttons), the chooser gets the strip's new EMPTY state
 *         ("Nobody signed in yet · Add your people") docked ABOVE the utility
 *         doors, not at the top (owner 2026-09-01: "needs a better spot other
 *         than the top" — picked option A of four mocks; chooser only, never
 *         a new box mid-wizard), and the entry-scan racer arm now navigates
 *         there from BOTH the attract screen and the chooser instead of
 *         dumping a no-reservation racer on the activity chooser with a
 *         stashed code (the people step claims the `racer` hand-off on the
 *         crew page the moment it mounts). Idle/start-over on the crew page
 *         runs the FULL teardown (abandonBooking → clearBookingSession →
 *         resetToKiosk) — the roster is guest PII and must never survive to
 *         the next group. Fully bilingual (parts/crew.ts).
 * 1.30.0 — BOGO WEDNESDAYS IS A SCHEDULED-RACE RULE, NOT A PACK (owner
 *         2026-08-31: "this special is here to stay and was never meant to be
 *         a race pack — buy one get one, all races must be scheduled").
 *         Every 2nd scheduled single race on a Wednesday race date is FREE,
 *         priced directly on the booked heats (every-2nd floor pairing,
 *         cheaper of each pair goes free, no cap, after credits/packs/
 *         vouchers so only cash heats pair; a racing pass — Employee 50%,
 *         League 20% — takes priority and never combines). Nothing banks any
 *         more. The two BOGO credit-pack SKUs are retired from every sell
 *         surface (defs kept so old ledger rows resolve; the resolver refuses
 *         them outright); the pay-mode promoted row is now a static banner —
 *         the deal applies itself. First-timers keep the bogo-weekday
 *         PACKAGE, same day rule. Also reverts the unreleased-in-practice
 *         1.28.0 multi-deal qty machinery (registry maxPerRacer, qty
 *         pointers, steppers, grid auto-raise) — the scheduled rule makes all
 *         of it unnecessary: picking more races on the grid IS the deal now.
 * 1.29.0 — GAME-CARD LOADS GO ONSITE; THE ON-PREM EIS BRIDGE IS RETIRED. Card
 *         reads and loads now run through the onsite Intercard proxy (real-time
 *         at the center) with cloud SOAP as the fallback, instead of the local
 *         EIS bridge on the kiosk PC. Loads are synchronous — no more charging a
 *         card and deferring the credit into a queue that hoped a bridge showed
 *         up; a dispensed blank is still captured, never handed over, if the
 *         load doesn't confirm. The card-system chip now reads Onsite / Cloud /
 *         Unlicensed (a red Unlicensed flags a MAC/token config fault instead of
 *         hiding it as a normal cloud fallback), driven by a real onsite probe
 *         rather than the old 127.0.0.1 bridge health. Combine cards is no longer
 *         cloud-only — the onsite path can consolidate, so it shows on every
 *         kiosk with a card backend. The EIS queue + its reconcile machinery are
 *         gone; the reconcile cron is now a dedup-safe recover-forward replay.
 * 1.27.0 — THE VIP QR NOW REACHES THE SCREEN THAT SEEDS. 1.26.0 made the
 *         voucher receipt auto-link a booking's party, but a scan on the
 *         attract screen or the chooser never got there. `/v/{code}` was
 *         classified `resolve-then-code-entry`, so the router asked whether the
 *         code resolved to a reservation first — and every VIP grant carries
 *         `vouchers.bill_id`, so `if (res.ok) return toCheckin()` fired on 100%
 *         of them. The guest landed in check-in: no game-card legs, no laser
 *         tag, and no seeding that outlives the screen (check-in's roster
 *         auto-load writes to a LOCAL, non-persisted reducer, not the kiosk
 *         booking session). Measured: 340 completed kiosk check-ins, exactly
 *         ONE ever from a scanned code. An `HPW` is our own unmistakable shape,
 *         so it is now decided by shape and goes straight to the voucher
 *         screen, where 1.26.0's auto-link finally runs. Reverses the routing
 *         half of owner decision #4 of 2026-08-02 ("decide by bill_id"), which
 *         predates the receipt having anything on it worth reaching; the
 *         booking's OWN reservation QR still opens check-in, unchanged.
 * 1.26.0 — A SCANNED BOOKING VOUCHER AUTO-LINKS ITS PARTY (owner 2026-08-30:
 *         "we already know who is on it — no need to ask/lookup/create
 *         profiles again"). When a VIP (or any guest holding a reservation-
 *         minted voucher) scans their redemption QR, the coupon/voucher
 *         receipt used to OFFER the booking's people as tap-to-add chips and
 *         then warn if nobody was tapped — the people we had already
 *         identified at booking sat one un-obvious tap away from being re-
 *         typed at the next people step. The roster now lands directly on the
 *         session party the moment it resolves, through the same prefill rail
 *         a chip tap used (BMI ids attached, isNewRacer false, live waiver
 *         truth carried), so racing / laser tag / gel blaster steps open with
 *         the group already named and nobody is looked up or minted twice.
 *         Chips render pre-selected and stay tap-to-REMOVE for anyone who
 *         didn't come today; a deliberate removal is never re-added, and a
 *         person already signed in by phone or check-in is left alone
 *         (session truth wins). Mirrors check-in's 2026-08-07 auto-load —
 *         the receipt was the last surface still asking. The "nobody picked"
 *         warning survives only as a safety net for a guest who removed
 *         every chip. New copy EN + ES.
 * 1.25.0 — KIOSKS WITHOUT A DISPENSER SELL NEW GAME ZONE CARDS (owner
 *         2026-08-28, reversing the 2026-07-20 reload-only rule). An MSR-only
 *         kiosk gets a holder of blank cards under the screen; the guest takes
 *         one and swipes it — "Step 1 take a new card · Step 2 swipe it" on
 *         every prompt (SwipeBlankGuide). The swipe happens BEFORE paying: each
 *         cart row is verified blank (Intercard answers result 1 for an account
 *         it has never seen — probed live; -1 stays ambiguous and is never sold
 *         as new; a card with any tokens/eTickets/time/cash/history is refused
 *         with "Reload this card instead"), and Pay arms only when every row
 *         holds one. After the charge the loads are a pure credit loop —
 *         nothing dispenses, nothing is retained, an unconfirmed credit leaves
 *         the row pending WITH its account (persisted at prepare) for the
 *         reconcile cron and the guest keeps the card. A swiped card is NEVER
 *         clear-on-encoded. Reload / Check balance: a swiped card Intercard
 *         has never seen now reads "Looks like a new card → Set up this card"
 *         (re-verified in the cart) instead of dead-ending on "not found";
 *         lookup failures still say "couldn't check — swipe again". Comp
 *         vouchers with card legs fulfil here too (swipe → claim → credit;
 *         Cancel + 90 s timeout while nothing is claimed), the coupon receipt
 *         says "Load my cards", and cards bought with a booking load on the
 *         confirmation screen (pre-swiped rows directly; upsell rows prompt a
 *         swipe there). Every hardware wait on the confirmation screen is now
 *         bounded — a device that never connects releases the screen after
 *         5 min instead of freezing it (dispenser kiosks too). useSerialMsr
 *         releases the COM port when disabled, so the pay screen's gift-card
 *         swipe works after a Game Zone sale on msrUse "both". Capability
 *         "reload" is renamed "swipe"; the checkout upsell no longer requires
 *         a dispenser. All new copy EN + ES.
 * 1.24.1 — CHECK-IN SHOWED EVERY BOWLING RESERVATION FOUR HOURS LATE (owner
 *         2026-08-19). A 9:00 PM lane read "1:00 AM" on the find-your-
 *         reservation list, and the whole HeadPinz board was shifted the same
 *         four hours — which also sorted the evening rows past midnight, to the
 *         bottom of a list ordered by the wrong times. The list picks a row's
 *         time from its heats and falls back to `bookedAt` for a leg that has
 *         none; the fallback handed that stamp back verbatim, but Neon
 *         serializes `booked_at` as a UTC instant while `timeKey`/`fmtTime12`
 *         both read the string as a naive ET wall-clock and simply drop the
 *         `Z`. So the board printed the UTC hour. The bug was latent until
 *         1.23.x-era bowling check-in (owner 2026-08-16) put heat-less rows on
 *         a list that had been racing-only — a race always has a heat, so the
 *         fallback never reached a screen before. `browseRowTime` now converts
 *         through `toEtWallClock`, the same helper the itinerary and the front-
 *         desk TV already use for this exact column (the TV was right all
 *         along, which is why the two boards disagreed), and it normalizes
 *         before sorting so a group whose legs disagree about zone orders on
 *         the clock instead of on the suffix.
 * 1.24.0 — BOGO RACES IS NOW A WEEKLY WEDNESDAY PROMO, not a two-day flash sale
 *         (owner 2026-08-19). Both halves of the offer — the returning-racer
 *         credit pack and the new-racer package — swapped their fixed
 *         2026-08-12 → EOD 8/13 purchase window for a recurring day-of-week
 *         rule that keys off the RACE DATE: a guest booking Tuesday for a
 *         Wednesday race gets the deal, and a Wednesday walk-up booking
 *         Thursday does not. Race-date keying is what makes "every Wednesday"
 *         mean what it says on a booking site; it also rides seams that already
 *         existed (`packSkusForRaceDate` filters packs by race day, and the
 *         reducer already re-validated pack picks when the date moves), so a
 *         date change now adds and removes the deal in both registries
 *         together. Packages got the same treatment via a new registry field
 *         (`raceDays`), plus the matching invalidation the reducer never had —
 *         previously ANY package survived a date change, so a bundle picked for
 *         one schedule kept its price on a day it isn't sold. The Mon–Thu
 *         deposit kind the free credit lands on is unchanged: the banked race
 *         stays good on any Mon–Thu visit, which the copy now says outright in
 *         EN + ES rather than implying the deal runs all week. Ribbons that
 *         named the two August dates now name the day ("★ BOGO — EVERY
 *         WEDNESDAY" / "★ BOGO — TODOS LOS MIÉRCOLES"), so they cannot go stale
 *         week to week. Standalone attract-screen behaviour is untouched — BOGO
 *         still never reaches the screen with no tier filter (1.22.x).
 * 1.23.0 — TWO NEW ACKNOWLEDGMENT SCREENS ON THE KIOSK, both EN + ES.
 *         (1) JUNIOR STARTER IS THE SLOW RACE (owner 2026-08-16). A parent
 *         books Junior Starter for a kid who already races karts, then finds
 *         out at the track that Starter is our slowest speed and everyone
 *         starts there whatever their experience — the disappointment lands on
 *         Guest Services and the reservation says nothing about what they were
 *         told. Picking Junior Starter (or a junior Rookie Pack, which is the
 *         same one slow race plus a licence and a video) now raises a
 *         tick-every-box modal that says so and offers the Ultimate Qualifier
 *         instead. The upsell button only appears when a junior UQ variant is
 *         actually bookable that day, resolved from the same eligible list the
 *         cards render from — on a Mega Tuesday there is none, so it quietly
 *         drops to two buttons. Taking it routes back through the normal select
 *         path, so the UQ's own disclaimer still appears. Declining records the
 *         acknowledgment on the item and puts a staff note on the BMI bill.
 *         The rule is DATA (RACE_WARNINGS): covering adults later is one record
 *         plus its copy, no screen changes. Guarded at BOTH kiosk seams — the
 *         product step and the pay-mode bundle rows — because a Rookie Pack can
 *         be chosen a step earlier and gating only the product step let it
 *         through unwarned.
 *         (2) THE PACKAGE DISCLAIMER NOW ACTUALLY RENDERS HERE. race.ts has
 *         always written "customer acknowledged disclaimer at booking" onto the
 *         bill for any package carrying one — but the kiosk (and web v2) never
 *         showed pkg.disclaimers at all; only web v1 did. So a kiosk Ultimate
 *         Qualifier produced a bill asserting the guest accepted the
 *         no-cash-refund term with no such screen in existence. Both seams now
 *         raise it. That required moving the UQ and BOGO disclaimer copy out of
 *         packages.ts literals into the catalog: rendering the old raw strings
 *         would have asked a Spanish-speaking parent to tick three English
 *         boxes accepting a refund term. One shared modal serves both prompt
 *         kinds, so the kiosk cannot end up with a localized version of one and
 *         a hardcoded-English version of the other. Spanish is a first pass
 *         pending native review; the bill memos stay English (staff-facing).
 * 1.22.3 — THE ULTIMATE QUALIFIER NO LONGER INCLUDES THE FREE APPETIZER (owner
 *         2026-08-12), in-center AND online. Cleared appetizerCode / note /
 *         items from all five UQ variants in the registry, which is the single
 *         switch every surface reads: the kiosk pay-mode "incl." chip, the
 *         picker checklist, the cart row, the web v1 picker + order summary,
 *         both confirmation pages and the confirmation email all gate on it,
 *         so one data edit drops the offer everywhere. The copy that spelled it
 *         out in prose rather than reading the flag was updated too — the five
 *         UQ short descriptions, the shared long description, and the kiosk
 *         Experiences-shelf blurb in EN + ES. No package carries an appetizer
 *         now (the Rookie Pack dropped its own in 1.14.3), so the mechanism is
 *         dormant rather than deleted — turning it back on is a registry edit.
 *         No price changes: the appetizer was never in packagePerRacerPrice,
 *         only in the retail comparison, so the displayed "you save" figure
 *         drops by $15 and nothing charged moves.
 * 1.22.2 — The flash-sale row SELECTS the pack instead of just revealing it.
 *         Tapping it only expanded the picker, so the guest chose the same
 *         thing twice. A single eligible racer now applies straight away
 *         (mirroring the picker own one-person shortcut) and it cancels the
 *         "pay per race" row like any pack; only a party with a real choice
 *         still gets the "who is this for?" panel. Tap again to remove.
 * 1.22.1 — HOTFIX: the packages page crashed on load. The party-eligibility
 *         filter added in 1.22.0 read `eligible` one line before it was
 *         declared — a temporal-dead-zone ReferenceError that took out the
 *         whole screen. tsc cannot catch it: the read sits inside a .filter()
 *         callback, so the compiler cannot know it runs during init.
 * 1.22.0 — BOGO RACES FLASH SALE, 8/12 → EOD 8/13 (owner 2026-08-12). Buy one
 *         race, get one free, shipped as TWO instruments so it reaches both
 *         kinds of racer. RETURNING racers see a 2-race credit pack on the
 *         pack picker (adult $20.99 / junior $15.99, credits land on the
 *         Mon–Thu kind so the free race is weekday-locked by the existing
 *         redeem rail). NEW racers instead get a "BOGO Races" PACKAGE on the
 *         pay-mode screen — Starter + Intermediate, the Ultimate Qualifier's
 *         structure and 60/30 gap rule minus the license, POV and appetizer —
 *         because a credit can't be redeemed by someone who isn't a returning
 *         racer yet. `maxQualifiedTier` keeps a racer from ever being offered
 *         both halves. Sale SKUs wear an amber FLASH SALE ribbon with a
 *         was/now price so they read apart from the standing packs at a
 *         glance, and the tier-restricted ones narrow the "who's this for?"
 *         row to racers who can actually receive them. Savings now compare
 *         against a sale SKU's own regular price rather than the weekend-adult
 *         baseline — that baseline would have advertised $32.99 off a deal
 *         that saves $20.99. Both halves speak EN+ES. The window is enforced
 *         server-side (the offered-slug list feeds resolveKioskPacks, and
 *         eligiblePackages re-checks bookableUntil per request), so a cached
 *         screen can't sell it on 8/14.
 * 1.21.0 — THE VIDEO SCREEN NOW SELLS EXTRAS TOO (owner 2026-08-10). "Race
 *         Video & Extras": the POV pitch is unchanged on top, and below it the
 *         first retail add-on — a $3 replacement headsock ("your first one is
 *         included with your FastTrax license"). The guest picks WHO needs one
 *         by name, because the $3 grants a headsock credit on that racer's own
 *         account — so the check-in scan pops "Headsock Due — hand guest a
 *         headsock" for the right person, and the e-ticket shows the credit on
 *         file. Cart shows one row per racer with per-row Remove and a Change
 *         that reopens the screen. The POV stepper finally has a ceiling: max
 *         one camera per racer, with the + greying out at the cap. A party
 *         whose package already includes the video still sees the extras page
 *         (just without the camera pitch). Everything speaks EN+ES. New
 *         add-ons later are one catalog row + copy — no new screens. Kill
 *         switch: NEXT_PUBLIC_BOOKING_ADDONS_ENABLED=false darkens sell,
 *         charge, and grant together.
 * 1.20.0 — THE POV SCREEN SELLS THE VIDEO, NOTHING ELSE (owner 2026-08-10).
 *         The in-step "Rookie Pack" — a $9.98 license+POV pseudo-product that
 *         never behaved like the real packages — is gone everywhere: the radio
 *         chooser, the mixed-party auto-enroll, its charge line. The real
 *         Rookie Pack package on the pay-mode page is untouched. License never
 *         appears on this screen (the roster step already shows "+ $4.99
 *         licence" per racer, and the charge was always independent). The
 *         video offer counts ONLY racers whose package doesn't include it —
 *         a partially-packaged party is no longer offered cameras the bundle
 *         already carries. And the cart finally treats POV like a package:
 *         its row shows Change (reopens the video step) and Remove, on both
 *         cart surfaces. Whole screen speaks EN+ES now (it was hardcoded
 *         English).
 * 1.19.0 — CHECK-IN TELLS THE TRUTH ABOUT WHO AND WHEN. The roster now resolves
 *         against BMI instead of whichever row arrived first, so racers who ARE
 *         registered stop reading "Account + waiver needed" and one person stops
 *         appearing twice. The at-home /waiver link finally attaches anyone at
 *         all (its join had been rejected on every call since it shipped, so
 *         that table had never held a row). A racer deleted from the booking in
 *         BMI no longer walks back onto the roster. Race times re-sync FROM BMI,
 *         which is what silently broke assignment: Pandora matches the session
 *         by start time, so a heat staff moved matched nothing. And a booking
 *         person with no birthdate — which makes Pandora 500 on its own
 *         response schema and reads to us as "no waiver" — is repaired with the
 *         DOB Set up already collected, then scheduled on that same id instead
 *         of minting a duplicate. Partial check-in works: one racer is enough,
 *         latecomers resume, and an explicit assignment always re-posts.
 *         "Who's racing" is one card per RACE with its own seat count, inline
 *         name chips instead of a modal, pre-filled where unambiguous, locked
 *         while submitting; the done screen names the drivers.
 * 1.18.0 — RACERS SIGN IN BY SCANNING, FROM THE ENTRY SCREENS. A racing licence
 *         (the wallet pass barcode, or our `/r/{code}` deep link) or the
 *         SMS-Timing app's personal QR now works on the attract screen and the
 *         category chooser/shelves, not just deep inside the people step.
 *         Until now the kiosk classified that barcode as `unsupported/unknown`
 *         and simply did nothing — a licence scanned at a kiosk pulled up
 *         nothing at all (owner, 2026-08-07).
 *         The scan resolves to a PERSON, so it has two destinations and the
 *         server picks: a racer with a booking here today goes straight into
 *         check-in with no OTP (possession of the code is the identity — the bar
 *         the people-step sign-in already used), and a racer with nothing booked
 *         has their identity carried into the flow so the people step signs them
 *         in without a second scan.
 *         Both handles are URLs on purpose: a bare 13-char login code is
 *         indistinguishable from a reservation short code and from a promo, so
 *         it deliberately gets NO verdict.
 * 1.17.0 — AMBIENT GIFT CARDS (owner 2026-08-06): no more "Use a gift card"
 *         button — on the pay screen a guest just swipes a physical gift card
 *         at the Square reader or scans an eGift QR at the kiosk scanner, in
 *         any order, and it works. A gift card that can't cover the total
 *         PARTIALLY APPROVES (Square accept_partial_authorization); the screen
 *         shows "applied $X — left to pay $Y" and the reader re-arms for the
 *         remainder automatically. NOT gift-card-specific under the hood: any
 *         tender that partially approves (prepaid/debit) boards the same way.
 *         Up to 3 gift cards + a card per checkout.
 *         Typed entry survives as a small "Enter a gift card number" link.
 *         Under the hood every kiosk payment is now an auth captured atomically
 *         by PayOrder once the tenders cover the total (the split rail's shape
 *         became the ONE rail); every exit path — idle reset, start-over, the
 *         kiosk-update hard reload — releases holds through a session registry,
 *         with a server sweep behind it. Kill switch: KIOSK_AMBIENT_CHECKOUT
 *         (server env; OFF = capture-on-tap exactly as before, the amber
 *         gift-card button returns). EN + ES on every new string.
 * 1.16.11 — Mega days run JUNIOR PRO races only (owner 2026-08-05, effective
 *         2026-08-10): no Junior Starter, no Junior Intermediate. The people
 *         step's Mega-day notice and the date step's block reason say so in
 *         English AND Spanish, and the Mega Tuesday attract slide now reads
 *         "Junior Pro only on Mega". Staff get asked about this at the counter,
 *         so the version is the quickest way to confirm a kiosk is showing the
 *         new rule rather than the old "no first-time Juniors".
 *         Behind it, Junior Intermediate Race Mega left the catalog entirely, so
 *         the kiosk has no such product to offer — and the date-step guard now
 *         blocks every junior below Junior Pro, not just first-timers.
 *         FastTrax also opens at 3 PM Mon–Fri from the same date. The kiosk shows
 *         no hours, but the race opening-heats "walk-in or express only" window
 *         moves with it (weekdays 1:00–1:24 PM → 3:00–3:24 PM), and it now
 *         resolves per HEAT DATE, so heats before the 10th keep the old window.
 * 1.16.10 — THE ON-SCREEN KEYBOARD NO LONGER BURIES THE FIELD YOU'RE TYPING IN
 *         (owner 2026-08-04, the NEW PLAYER form: focusing Email left it half
 *         behind the keys). The sheet is 454px (numeric/phone) to 556px
 *         (qwerty/email) of the 1920px canvas and NOTHING reserved that space:
 *         `.k-flow-body`'s scroll extent stops 24px past its last element, so
 *         for anything in the bottom third `scrollIntoView` clamped at max
 *         scroll and the field stayed under the keys — on a screen whose body
 *         doesn't overflow at all there was no scroll range to use, either. No
 *         `scroll-padding-bottom` existed anywhere, so "center" also counted the
 *         occluded strip as visible.
 *         While the sheet is open it now MEASURES itself and reserves its own
 *         height on the focused field's scrolling ancestor — padding-bottom for
 *         the scroll range, scroll-padding-bottom so "center" means the centre
 *         of the UNCOVERED part — then scrolls, restoring both on close. The
 *         ancestor is found by computed overflow, not by class, so every typing
 *         surface is covered at once (the wizard body, the fixed-overlay
 *         guardian form and account picker, check-in, the waiver flows) and so
 *         is the next one someone writes; a short inner list that ends above the
 *         sheet is left alone. `--k-osk-h` is published on the canvas for
 *         screens that want to lay out around the keyboard.
 * 1.16.9 — /api/bmi was ROUNDING every id it forwarded. Found by live-testing
 *         1.16.8's read-back against the dev server: BMI returned
 *         orderId 63000000007234468 and the proxy emitted ...460. The GET handler
 *         did `NextResponse.json(await upstream.json())` — a parse + re-encode,
 *         exactly what CLAUDE.md's first hard rule forbids. Callers that dig the
 *         id back out of the body (`extractRawField`, `parseWithRawIds`) were
 *         pulling a CORRUPTED id out of a response that looked perfectly healthy,
 *         and the same handler serves `person/*`, where the casualty is a
 *         personId. Now a byte-for-byte text passthrough (`jsonPassthrough`);
 *         re-verified live: 63000000007234468 arrives whole.
 * 1.16.8 — the start-over cancel was working all along; the CHECK was broken.
 *         `[race.cancel] bill cancel NOT confirmed after retries` +
 *         `[kiosk] start-over could not confirm hold release` fire on every kiosk
 *         start-over. Probed bill 63000000007234468 read-only (new
 *         scripts/race-cancel-bill-probe.mts): its Office project has products:0
 *         and all 13 schedule rows at stateId -4, userUpdatedId -17 — cancelled,
 *         by us, holding nothing. The cancel LANDED every time.
 *         Root cause: BMI answers a cancel with raw `true`. The proxy
 *         JSON.parse'd it and forwarded the boolean, while `cancelRaceOrder`
 *         demanded `{success:true}` — so `body?.success` was forever undefined
 *         and NO cancel could ever report success. The suite was green because
 *         every fixture mocked `{success:true}`, the shape the code wanted rather
 *         than the one BMI sends.
 *         Fixed on both sides: the proxy normalizes a boolean body to
 *         `{success:<bool>}`, and the client accepts either shape (a kiosk tab
 *         runs stale JS for days — old client + new proxy has to work too). Then
 *         the real backstop: when nothing confirms, READ the bill. Empty = the
 *         cancel took effect, log it and move on; lines still there = the loud
 *         error it was always meant to be, now with "heats remain held" attached.
 *         Note for future probes: the public-booking overview canNOT tell
 *         cancelled from converted — every order past the open-cart stage reads
 *         statusId -4 with zero lines, including live bookings (W56178/83/84).
 *         Only the Office project distinguishes them.
 * 1.16.7 — "None of these" no longer eats the phone + email (owner 2026-08-04:
 *         "when new player does search to see if you have existing account then
 *         you click none of these and it returns — it removes mobile phone and
 *         email"). The search-before-create gate interrupts a submit the guest
 *         has ALREADY filled in; the form is still mounted behind the picker
 *         with every field intact, but "None of these" ran the license-SCAN
 *         path — resetForm() then refill from name+DOB — so the two fields the
 *         scan can't supply came back blank, and the guest re-typed them (or
 *         hit the phone/email validation wall). The picker now knows which door
 *         it came in by (`fromForm`): from the form it just RESUMES the submit
 *         the gate interrupted, so the create runs with what was typed; from a
 *         license scan it still builds the form. Fixed in BOTH roster twins —
 *         KioskPeopleStep (booking) and KioskPartyManager (standalone race-pack
 *         + check-in flows).
 * 1.16.6 — three owner notes from the live pass (2026-08-04):
 *           · the single-race row was misleading: it read "Starter race / Pay for
 *             the races you run today / $25.98", but that row is ALSO the only way
 *             through for a guest whose race is already covered by banked credits,
 *             a comp, or the pack they just added. Now "Single race · Pay per race
 *             — or use credits, comps, or a pack · from $X / racer" (owner's own
 *             wording). It names NO tier — page 2 asks for the tier, and a guest
 *             who hasn't seen that screen reads "Starter" as a product being sold.
 *             The price keeps the licence in it when every racer owes one, so the
 *             +$delta chips on the bundle rows still add up against it.
 *           · the "★ FastTrax recommended" pill hangs 16px above the hero card and
 *             was covering the intro line. The card now carries its own top margin.
 *           · POV moved $5.00 → $4.99. Both constants (v1 lib/packages.ts and v2
 *             race-pricing.ts) plus RacePovStep, which had SHADOWED all three price
 *             constants with local copies — it now imports them, so the screen can
 *             never quote a price the charge does not use. Derived totals shift a
 *             penny: Rookie Pack $30.98 → $30.97, Ultimate Qualifier $51.97 →
 *             $51.96, the rookie licence+POV line $9.99 → $9.98, and the upsell's
 *             "save vs check-in" $2 → $2.01.
 * 1.16.5 — appetizer audit (owner 2026-08-04: "double check rookie pack has app
 *         taken out — emails, web and kiosk and confirmation pages? Leave it in
 *         for ultimate qualifier"). 1.14.3 pulled the FIELD; this pass found two
 *         places that still promised it:
 *           · the Rookie Pack's OWN copy — `shortDescription` ("… + free
 *             appetizer") and ROOKIE_LONG, which the picker card renders. Fixed;
 *             the Ultimate Qualifier's copy untouched.
 *           · both confirmation pages had a hardcoded CATCH fallback that asserted
 *             a Rookie Pack appetizer if the registry import failed. Removed — a
 *             freebie the bar won't honour is worse than showing nothing.
 *         Verified clean and data-driven: registry (6 rookie variants no code, all
 *         5 UQ variants keep theirs), the email call-out (`emailPkg.appetizerCode`),
 *         both confirmation cards, the v1 cart + picker rows, and both POV steps.
 *         Also: the top strip is ONE line with only what it needs — who's signed
 *         in, plus the hold clock inline on the right (owner: "take out number of
 *         players … as well as racing on right. Just need to show signed in").
 * 1.16.4 — two more owner notes from the live pass (2026-08-04). The Mega Tuesday
 *         junior warning moved ABOVE the intro line — a rule that stops a racer
 *         from booking at all shouldn't sit under a sentence about waivers. And
 *         the signed-in banner collapsed to ONE line with the cart link removed:
 *         the footer util strip already carries a Cart pill on every screen, so a
 *         second door up there cost a band of the fold and bought nothing. It is
 *         no longer a button — it states who is signed in and what is in the
 *         visit.
 * 1.16.3 — SIGN-IN decides the licence too, closing the other half of 1.16.0.
 *         `licenseActive` was only written by the mid-session qualification
 *         refresh, so a lapsed returning racer signed in and never refreshed still
 *         fell back to the `isNewRacer` flag — the same hole, one path over. The
 *         kiosk sign-in lookup (license/lookup.server.ts) already reads the Office
 *         person's memberships to derive the tier; it now derives the licence from
 *         the SAME read and carries it onto the party member through every add
 *         path (scan match, phone/name match, roster patch).
 * 1.16.2 — the licence chip lands on the roster the kiosk ACTUALLY renders.
 *         1.16.1 put it in KioskPartyManager (`party.*` keys); the race people
 *         step on screen is KioskPeopleStep (`peopleUi.*`), a separate kiosk-native
 *         component — so the owner refreshed and saw nothing. Both carry it now;
 *         KioskPartyManager still serves the standalone race-pack flow, check-in
 *         and the group waiver.
 * 1.16.1 — the roster says the LICENCE, not just the tier (owner 2026-08-04:
 *         "then why didn't 1 2 get forced a license"). The badge said "Starter
 *         only" — a qualification fact — and it reads as "needs a licence", so
 *         there was no way to see that a racer flagged new already holds one.
 *         Each racer now carries "Licence on file" or "+ $4.99 licence" from the
 *         same verified state the charge uses; an unverified returning racer stays
 *         silent rather than guessing at money.
 * 1.16.0 — A LAPSED LICENCE CAN NO LONGER SLIP THROUGH (owner 2026-08-04: "two
 *         people are new racers and one isn't but it's allowing me to skip by
 *         licensing"). The $4.99 Square line AND the +licence BMI build product
 *         (the ONLY thing that records a licence) both keyed off `isNewRacer`, a
 *         client flag set by how a person was added to the roster — so a
 *         returning racer whose annual licence had expired raced with nothing
 *         charged and nothing recorded. Both now read one verified signal,
 *         `licenseActive`, computed server-side from the Office person's
 *         memberships (name contains "license", `stops` in the future) during the
 *         qualification refresh: verified-licensed never pays, verified-lapsed
 *         pays, unverified falls back to the old flag so an Office outage can't
 *         surprise-charge a regular. `licensePrepaid` (race-pack hand-off) still
 *         wins over everything.
 *         Deliberately NOT inferred from the `memberships` NAME list: two of this
 *         repo's own test fixtures populate that list narrowly, which would have
 *         charged a licensed racer $4.99 — the failing tests caught it.
 *         Mixed parties also stop hiding the licence: page 1 shows "+ $4.99
 *         license for Max" instead of folding it into a per-racer price that only
 *         some racers pay, and the cart estimate reads the same helper as the
 *         charge so the two can't drift.
 *         Also fixed the console error the owner reported: IdleWatcher called
 *         onReset() from inside a setState updater, i.e. during render, which set
 *         state in KioskFlow mid-render. A reset is an event — it now runs in the
 *         interval callback.
 * 1.15.1 — attractions stop asking twice, and the review screen says WHO
 *         (owner 2026-08-04). The kiosk's "Who's playing?" step already writes
 *         `item.participants` and keeps `item.qty` in sync for waiver-gated
 *         attractions (gel blaster, laser tag) — then the shared web product step
 *         asked "how many people?" anyway, so the same question was asked twice
 *         and the two could disagree. With a roster present the count is now
 *         SHOWN, not edited ("3 players — Ava · Max · Kenyon"); duckpin and web
 *         have no roster and keep their stepper.
 *         The cart / review card showed a bare head count for an attraction, so
 *         it could not answer "who's on it" — it now lists the names.
 *         Wizard step bodies float VERTICALLY CENTRED until they outgrow the body
 *         (`justify-content: safe center`, the rule the cart already used): short
 *         steps sit in the reach band, tall ones top-align and scroll as before.
 * 1.15.0 — THE QUALIFICATION LADDER IS VISIBLE, and page 1 stops naming a race
 *         the guest hasn't chosen (owner 2026-08-04).
 *         Race screen: every rung now renders in ladder order. A tier the party
 *         isn't qualified for is greyed, priceless and untappable, with what
 *         unlocks it ("Qualify in Starter first to race this level") — hiding the
 *         rungs hid the reason the Ultimate Qualifier exists. Derived from the
 *         existing-racer catalog, so a first-timer sees Intermediate and Pro
 *         greyed rather than not at all.
 *         Package screen: the single-race row said "Starter Race Mega" — it
 *         presumed the tier they pick on the NEXT screen and leaked the schedule
 *         variant. It now names a tier only when the category is restricted to
 *         exactly one (a first-timer, or a returning racer who has only ever run
 *         Starter) and otherwise reads "One race", priced "from" when the tiers
 *         differ.
 *         Bundle eligibility gains a qualification CEILING in the registry
 *         (`maxQualifiedTier`) so it can stop keying on "new racer" — see the
 *         next release for the returning-Starter-only pricing.
 * 1.14.4 — REWARDS WERE NEVER ON THE KIOSK (owner 2026-08-04: "something happen
 *         to rewards on this page?"). Not a regression — a flag. The merged
 *         cart+checkout screen carries the rewards section; it shipped behind
 *         `NEXT_PUBLIC_KIOSK_MERGED_CHECKOUT === "true"`, an OPT-IN gate the
 *         owner's 2026-07-31 rule forbids, and with the var unset every kiosk
 *         fell back to the legacy two-screen path — where CheckoutStep is
 *         rendered with `hideRewards`. So the checkout promised "unlock rewards"
 *         under a screen that had none. The flag is now a KILL SWITCH, default
 *         ON (`!== "false"`), which also folds contact confirmation into the one
 *         review screen as designed. Note the merged screen has no promo-code
 *         input (owner decision 2026-07-21) — say the word if that should come
 *         back now that it is the only checkout.
 *         "BACK TO CART" NOW REACHES THE CART on both paths: the legacy branch
 *         only closed checkout and landed "per render precedence", i.e. the
 *         category chooser or mid-flow — a button that named its destination and
 *         went somewhere else.
 * 1.14.3 — four notes from the owner's live pass on page 1 (2026-08-04).
 *         STEPS NO LONGER CHANGE AFTER A TAP: two steps hide themselves once a
 *         bundle is chosen (the product step — the bundle owns the race — and the
 *         POV upsell, which the bundle includes), so the live count took "Step 3
 *         of 6" to "Step 3 of 4" the instant a card was tapped. The bar now
 *         measures the PLANNED path (visibility evaluated with the bundle choice
 *         neutralised), so a choice can skip a segment but never remove one, and
 *         the redundant "Step X of Y" line is gone.
 *         A CREDIT PACK AND "PAY PER RACE" ARE ONE SLOT: they could both light up,
 *         which read as two purchases. Choosing one now clears the other, and the
 *         pack row shows "1 pack added" so nothing disappears silently.
 *         MORE ROOM UP TOP: head padding 44→28px, progress margin 36→20px, step
 *         title 74→60px (it was the biggest thing on a screen it isn't the subject
 *         of), banner padding trimmed. ~110px more, every flow screen.
 *         The Qualifier's spot is saved "for later", not "for tonight".
 *         Separately, per owner: THE ROOKIE PACK NO LONGER INCLUDES THE FREE
 *         APPETIZER (web + kiosk). Removed from all six rookie variants in the
 *         registry, which drops it from the picker checklist, the cart row, the
 *         confirmation block and the email call-out in one edit; the four v1
 *         places that hardcoded it were updated too. The Ultimate Qualifier keeps
 *         its appetizer. No price changes — the appetizer was never in
 *         packagePerRacerPrice, only in the retail comparison, so the displayed
 *         savings shrink and nothing charged moves. The Rookie Pack still includes
 *         the licence.
 * 1.14.2 — nothing is pre-picked and nothing jumps (owner 2026-08-04). The
 *         single-race row used to derive its "selected" ring from "no bundle
 *         selected", so the screen opened already showing a choice the guest had
 *         not made; it is now an explicit local pick. Tapping anything used to
 *         auto-advance a beat later — bundles, the single race — which took the
 *         screen away mid-read. The footer Continue is now the only way forward,
 *         so a guest can look at all four prices, change their mind, and remove a
 *         bundle without the screen moving under them.
 *         Also freed ~140px above the fold: this step dropped its eyebrow (the
 *         chrome already stacks a brand row, the progress bars and the step
 *         title) and shrank its headline 40px → 32px, and `.k-flow-head` lost
 *         28px of top padding on EVERY flow screen.
 * 1.14.1 — page 1 gets the owner's approved layout (five design passes, 8/3–8/4):
 *         the HOUSE RECOMMENDATION leads as a hero card — a new registry flag,
 *         `recommended: true` on the five Ultimate Qualifier variants, so moving
 *         the ribbon is a data edit, not a code change — with its race count set
 *         huge. Every other bundle is a thin row carrying a +$delta against the
 *         cheapest way to race (a first-timer's real decision is the difference,
 *         not the total: the licence is unavoidable, so the Rookie Pack is +$5).
 *         The plain single race is the last row; race packs collapse to ONE line
 *         until tapped. Type moved to the KIOSK's scale (body 21px, hero 34px,
 *         price 40px) — the shared booking components are web-sized, which read
 *         tiny beside 112px buttons.
 *         The pack picker itself stops rendering a cross product: a day segment
 *         (Mon–Thu / Any-day) plus ONE row of size tiles, instead of six
 *         near-identical cards. That fixes the teaser and the cart block too.
 *         A bundle preselected from the Experiences shelf now renders even when
 *         it is not in today's eligible list — otherwise the guest could neither
 *         see nor remove what they were buying.
 * 1.14.0 — TWO PAGES INSTEAD OF ONE on the race step (owner 2026-08-03: "split to
 *         packages first then race type"). Page 1 asks HOW — single races, a
 *         prepaid 3/5/10 credit pack, or a bundle (Rookie Pack / Ultimate
 *         Qualifier) — and page 2 is nothing but the tier list. The old screen
 *         carried all three at once, and at six pack SKUs the tier cards sat
 *         below the fold.
 *         Per CATEGORY, like the product and heat steps it precedes: a bundle IS
 *         a per-category purchase. Picking a bundle SKIPS page 2 (the bundle owns
 *         the race) and goes to its heat picker; Back lands on page 1, where the
 *         1.13.4 Remove lives. Picking "just today's races" clears any bundle, so
 *         the tier list is always reachable. Page 1 hides itself when there is
 *         nothing to choose (no packs offered, no eligible bundle) and never
 *         appears on web, so nothing gains a speed bump it doesn't need.
 *         Both screens read ONE seam (`payModeStepVisible`) to decide who owns
 *         the pack/bundle blocks, so they cannot both show — or both drop — them.
 *         NOT a flag: this branch IS the gate until the owner picks a layout.
 * 1.13.4 — a PREMIUM PACKAGE CAN BE TAKEN OFF AGAIN (owner report 2026-08-03:
 *         "users have no way of removing rookie pack"). Tapping Rookie Pack (or
 *         the Ultimate Qualifier) was one-way: the card auto-advances to the heat
 *         picker, re-tapping it means "yes, this one", and the cart turned the
 *         race card's title into the package name with only Edit / Remove — where
 *         Remove deletes the WHOLE race. The only real escape was picking a single
 *         race on the product step, discoverable via one amber sentence.
 *         Now the selected package card carries an explicit Remove, and the kiosk
 *         cart carries one per selected variant (a family can drop the junior
 *         Rookie Pack and keep the adult one). Both run the SAME pure edit —
 *         `clearPackageForCategory` — which nulls that category's package id and
 *         drops only the heats the package itself was holding, so single races
 *         added alongside it survive and the package's BMI-held lines are released
 *         instead of orphaning on the bill. Removing the last thing on the item
 *         removes the item, same rule per-heat removal already followed.
 * 1.13.3 — 5- and 10-RACE PACKS sell inside the booking (owner 2026-08-03: "the
 *         kiosk doesn't let existing racers purchase a 5 or 10 pack"). The race
 *         product step's pack teaser was 3-packs only, and mid-booking it is the
 *         ONLY pack surface — the bigger packs lived exclusively in the
 *         standalone attract flow, reachable only by abandoning the booking and
 *         paying on a second reader tap. The ledger agrees: of every 5/10 pack
 *         ever sold, not one came from a booking. Both surfaces now read ONE
 *         catalog (3/5/10 × Mon–Thu/Any-Day, Mon–Thu still hidden Fri–Sun), so
 *         they cannot drift apart again, and the teaser derives its sizes,
 *         prices and savings from that catalog instead of hardcoding "3".
 *         The teaser + picker copy also moved into the i18n catalog (EN+ES) —
 *         it had been hardcoded English on a Spanish-capable screen.
 * 1.13.2 — RACE RESERVATION CHECK-IN goes down with the BMI booking outage too
 *         (owner 2026-08-03: "should also be down because no way to create new
 *         people"). It looked healthy — finding a reservation is the Office API,
 *         which is up — but FINISHING one is not: registerProjectPerson (attach a
 *         person to the reservation), the racer schedule write and the
 *         "Confirmation Kiosk" state stamp all go to the dark public-booking API.
 *         Those writes are Neon-first with a deliberately CONTAINED failure mode
 *         that is never surfaced to the guest, so the kiosk was confirming
 *         check-ins BMI never recorded: the racer never reaches the grid and
 *         staff never see the stamp. A confident false success is worse than a
 *         closed door. Modeled as needing BOTH BMI rails, so it also goes down in
 *         an Office-only outage. The chooser's door is withdrawn and the page
 *         guards itself server-side, so a typed URL or a scanned reservation QR
 *         lands on the outage screen instead of a dead end.
 * 1.13.1 — maintenance mode: a locked thing now says WHY, and the VIP popup gets
 *         out of the way. "Temporarily unavailable" alone read like the product
 *         had been discontinued, so every locked card/tile carries its vendor's
 *         one-line reason — "System issue with one of our vendors — please check
 *         back later today." The reason is resolved per PRODUCT, so with two
 *         vendors down each surface shows its own vendor's cause rather than
 *         whichever outage leads the banner. The unsolicited Ultimate VIP site
 *         popup self-hides while the pack's vendor is down (no new flag — it
 *         reads the same registry, so it returns on its own when the outage
 *         clears); interrupting the site to sell a product whose Book button can
 *         only reach an outage notice is worse than showing nothing.
 * 1.13.0 — VENDOR MAINTENANCE MODE (owner 2026-08-03, live BMI booking outage).
 *         A vendor being down now takes its whole product line off sale with its
 *         own sentence, instead of every tile quietly failing mid-flow.
 *         Modeled per VENDOR, not per attraction (~/features/maintenance), and
 *         "BMI" is deliberately TWO vendors: the public-booking API (selling) and
 *         the Office API (reservation/account lookup). On 8/3 only the SELLING
 *         rail was dark — so racing, laser tag, gel blasters, Shuffle Showdown,
 *         race packs, the Ultimate Qualifier and the Ultimate VIP combo locked
 *         (the VIP needs BMI heats AND a QAMF lane — either one down locks it),
 *         while bowling, duckpin, KBF, Game Zone, CHECK-IN and waivers kept
 *         working. Lumping the two BMI hosts together would have needlessly
 *         killed check-in.
 *         Locked tiles read "Temporarily unavailable — one of our vendors is
 *         having a system issue. Please see Guest Services." (EN+ES) — NOT the
 *         end-of-day note, because the front desk is on the same vendor and
 *         "ask about a walk-in" would be a dead end. The Experiences and
 *         Attractions category cards lock too when everything behind them is out.
 *         Paused products are no longer PROBED at all: a dead vendor answers in
 *         timeouts, which was burning the whole availability compute and taking
 *         the working bowling/KBF lines down with it. Kiosk 99's clock-artifact
 *         override does NOT bypass an outage.
 *         Controlled by ONE env var: MAINTENANCE_VENDORS_DOWN lists the vendors
 *         that are down ("bmi" today; comma-separated for more). Unset = nothing
 *         down, everything sells. No redeploy — tiles lock/unlock within one
 *         3-min availability TTL.
 * 1.12.1 — the voucher receipt says it's looking for your group. A booking-
 *         linked voucher resolves its party through BMI, which can take the
 *         better part of a minute (owner 2026-08-02) — the chips used to just
 *         appear out of nowhere, with nothing on screen meanwhile. Now the
 *         section renders as soon as the lookup starts, with the branded logo
 *         loader under a header that doesn't promise a booking we haven't
 *         found yet ("Checking your voucher"); it flips to "Who's here from
 *         your booking?" when the roster lands, and disappears when the
 *         voucher has no booking behind it.
 * 1.12.0 — SCAN ANYWHERE on the way in (owner 2026-08-02). The four screens a
 *         guest sees before choosing anything — the attract loop, "What are we
 *         doing today?", and the Attractions / Experiences shelves — now
 *         listen to the QR reader and route what they read: a reservation QR
 *         goes straight into check-in (no find screen), a voucher opens "Your
 *         codes", a Game Zone card opens its balance. Previously the reader
 *         was only live DEEP inside flows, so a guest holding a code at the
 *         attract screen had to guess which button led to a listening screen.
 *         One precedence router (entry-scan/classify-entry.ts) composes the
 *         two existing classifiers — order matters: a 16-digit game card and
 *         an 8-char coupon both look like reservation short codes, and a
 *         W-number looks like a promo. An HPW voucher is decided by DATA, not
 *         shape: booking-minted (carries vouchers.bill_id) → check-in with the
 *         party prefilled; standalone comp → redeem. Gift cards and licences
 *         get a brief toast and stay put until they have screens to land on.
 * 1.11.6 — SEARCH BEFORE CREATE on every person-minting surface (owner
 *         2026-08-01, the Gipson check-in: 13 person records for two guests
 *         because every path created blind). New Member / Set up / new-
 *         guardian submits — kiosk people step, check-in party, group waiver,
 *         mobile /waiver, race packs — now run the Office name+DOB lookup
 *         FIRST (the proven license-scan rail): an existing account signs in
 *         (roster dedupe + waiver re-check included), several candidates open
 *         the account picker ("None of these" still creates), and only a
 *         genuine stranger mints a person. Eager as-you-type prefetch +
 *         "Checking for your account…" spinner; lookup warmed on every
 *         kiosk, not just scanner-equipped ones. Pure verdict logic in
 *         license/match-gate.ts (tested — a lone hit with a foreign first
 *         name is a sibling, never auto-attached).
 * 1.11.5 — a dispense run covers EVERY card leg of a scanned voucher (one
 *         claim per card, sequential): the VIP voucher's whole family of
 *         cards comes out in ONE "Get my cards" instead of one card per visit
 *         with a "continue" loop between each (owner 2026-08-01). Basket rows
 *         show "× N cards", the button/progress/done counts are CARDS not
 *         codes, and the outcome report is per-LEG scoped to the run (a
 *         prior run's cards can never be double-cleared from the pending
 *         list). A "used" refusal after cards already came out finishes the
 *         row (server truth won a race) instead of erroring it.
 * 1.11.4 — voucher receipt: already-used legs render as struck-through
 *         "already used" rows (a re-scan explains where a leg went), a native
 *         leg's ✕ removes ONLY that leg (the code's other legs stay; re-scan
 *         restores a mis-tap), and the review bill renders the SERVER quote —
 *         covered items as $0 lines tagged Credit / Race Pack / Voucher …XXXX.
 *         TEST kiosks (kioskNumber 99): operating day flips at calendar
 *         midnight ET instead of the 2 AM business rollover.
 * 1.11.3 — the Ultimate VIP tile's "Next available · TIME · N slots" line is
 *         back: the 7/31 V2 cutover changed the combo id to race-bowl-v2, but
 *         the availability payload keys the VIP pack by the stable wire key
 *         "race-bowl" — the tile now looks it up by that key (any race-bowl*
 *         pack), so the line survives future pack revisions too.
 * 1.10.14 — the coupon/voucher module unified onto ONE screen (owner live
 *         walk-through: "make this all make sense"). "Your codes" is now the
 *         single hub — coupons, BMI vouchers, our vouchers and comp game
 *         cards ALL land there; the terminal "Accepted!" / "Code applied!"
 *         panels (no way to scan more) and the separate voucher-sheet screen
 *         are gone; the cart's voucher chip and the categories promo chip
 *         (previously display-only — a dead end) open it too. Layout reads
 *         top-down: scanned items → ONE "Add another" panel (scan + type
 *         share the box, input in the TOP half so the OSK never covers it
 *         and nothing moves when the keyboard opens — which is also what
 *         fixes "hit Apply twice"; Apply keeps field focus so the keyboard
 *         stops bouncing). The 1.10.13 auto-print countdown is GONE (owner:
 *         hated) — the primary comes from receiptPlan() (tested): "Print my
 *         cards" / "Print & continue" / "Start picking" / "Done". Every row
 *         is removable (✕), errored vouchers are VISIBLE with "needs help",
 *         and a kiosk with NO dispenser stops promising cards ("pick up at
 *         the front kiosk or Guest Services"). Full logging: [kiosk] console
 *         lines + Clarity events on every scan, reject (with reason), print,
 *         leave-warn/leave, removal, restore, claim release and dispense
 *         outcome. New unit suites: receipt-plan, pending-cards.
 *         Pre-merge adversarial review fixes: one dispensed card clears ONE
 *         leg of a multi-card voucher (not all — the server spends one gz
 *         item per claim, so the remainder keeps the way-back tile alive);
 *         basket guards + the outcome report read a live ref (the seed loop's
 *         snapshot bypassed the 10-per-run cap; the outcome callback ran
 *         inside a state updater); ✕-removal frees the code for a clean
 *         re-scan (upsert-idempotent end to end); guest-facing counts are
 *         LEGS everywhere; and PARKED BMI comps (GZ_VOUCHER_BMI unset) are
 *         routed to Guest Services at SCAN time — validate is now issuer-
 *         routed like claims (validateAnyVoucher + test), so the receipt can
 *         no longer promise a card the dispenser will refuse.
 * 1.11.1 — the gift-card option reaches STANDALONE Game Zone purchases too
 *         (buy/reload cards with no booking): that rail now writes the shared
 *         split anchor at prepare and its finalize verifies the gift-card +
 *         tap payments as a sum. Same button, same flow, same screen.
 * 1.11.0 — pay with a GIFT CARD on every checkout (split-tender v1, "match
 *         web": one gift card + one reader tap). The pay screen gains an amber
 *         "Use a gift card" button → scan the QR / swipe / type the GAN →
 *         balance confirm → applied board with LEFT TO PAY → tap for the
 *         remainder (a card covering the whole total skips the reader). Works
 *         on EVERY cart type — racing, mixed, bowling, KBF — through the one
 *         shared checkout; bowling's prepare rail joined the same anchor +
 *         token model this release. $0-due orders (vouchers/credits cover
 *         everything) no longer arm the reader at all: "Nothing to pay today"
 *         confirms directly. 1.11.2 removed the terminal + split-tender FLAGS
 *         entirely (owner: no flags) — the direct-reader charge and the
 *         gift-card option are unconditional on any kiosk with a paired
 *         reader, and the interim SAVE_CARD path is deleted. The footer
 *         version is the fastest way to confirm a kiosk picked up a bundle.
 * 1.10.13 — voucher receipt round 2 (owner walk-through feedback). The OSK no
 *         longer covers the typed-code field (focus swaps in bottom padding so
 *         the column lifts above the key rows — same fix on the Game Zone
 *         voucher screen); the field clears after a successful scan/apply
 *         instead of parking the last code. Card-only receipts now AUTO-PRINT
 *         on an 8s countdown (reset per scan, paused while typing/checking/
 *         error) — the "get my cards" tap only remains when race/attraction
 *         legs give the guest an order to continue. Backing out with unprinted
 *         cards asks first and says plainly that nothing prints later on its
 *         own. "Your game card" pluralizes.
 * 1.10.12 — voucher game cards can't be stranded by backing out. The coupon
 *         receipt's card list now lives in flow state: Back, a promo scan, or
 *         any panel swap no longer loses it; a pink "game cards to pick up"
 *         tile on the categories row is the guaranteed way back, cleared
 *         per-code only when a card actually dispenses. The receipt gained a
 *         typed-code field (coupons enterable there — no backing out) and the
 *         session promo renders inline on it. "Get my cards & continue" now
 *         dispenses IMMEDIATELY when every code validates — the second,
 *         identical basket screen inside Game Zone is gone from that path;
 *         Game Zone's own voucher screen keeps a mid-entry basket intact when
 *         a guest backs out and returns.
 * 1.10.11 — the height & age safety confirm now speaks Spanish too.
 *         1.10.10 left it English on purpose, reading its four disclaimers as
 *         legal text needing the same attorney review as the ES waiver body.
 *         Owner overruled that: it needs Spanish and does not need a lawyer. And
 *         the call was right — it is the one screen where not understanding the
 *         words is a safety problem, not an inconvenience: a Spanish-speaking
 *         parent was ticking four English boxes attesting to their kids' age and
 *         height.
 *         The enforced FIGURES are untouched and a test now pins them in every
 *         locale, so a future translation can't drift 13 / 59 / 7-13 / 49 / 70.
 *         Spanish restates them in meters inside the same parenthetical the
 *         English uses to restate 59" as 4'11".
 *         Each requirement is one whole sentence PER PLURAL BRANCH, not a stem
 *         plus a spliced verb — Spanish has to agree across tiene/tienen AND
 *         mide/miden at once, which a shared stem can't express.
 *         The inch/foot marks in the English are now true primes rather than an
 *         ASCII apostrophe and quote: a bare ' is ICU's own escape character, so
 *         `4'11"` risked swallowing the rest of the branch as a quoted literal.
 *         Renders the same; a test asserts the glyphs survive formatting.
 * 1.10.10 — the attraction flow spoke English even in Spanish mode.
 *         The i18n pass converted the screens that had kiosk-NATIVE components;
 *         attractions are the one guest flow that still runs the web wizard's
 *         steps, so a Spanish guest booking laser tag hit an English "Your Info"
 *         form and an English attraction page (name, description, product cards,
 *         "How many people?"). Both are keyed now — they are shared with the web
 *         wizard, which is unaffected because useLocale() falls back to English
 *         with no LocaleProvider above it.
 *         The exit-confirm sheet — the one that pops up when you back out of an
 *         attraction ("Remove it & go to main page") — was fully hardcoded, and
 *         so was the rest of the flow SHELL around every step: the activity name
 *         in the header, "Step 3 of 5", Back / Continue / Add to my visit, the
 *         signed-in banner, the guest-assistance overlay, the unracered + phone
 *         sign-in sheets, the vendor loaders, and every flow error. All keyed
 *         (~110 new EN+ES strings), plus the reused-web step titles and the
 *         "why Continue is blocked" hint lines via English→key lookup maps,
 *         since module-scope StepDefs can't reach useT().
 *         Attraction tile names/blurbs and per-attraction descriptions and
 *         product names are DATA, so they got `es` blocks (activities-catalog +
 *         lib/attractions-data) the way the combo marketing copy did.
 *         Still English by decision: the race height/age modal's legal
 *         disclaimers, which need the same attorney review as the ES waiver.
 * 1.10.9 — check-in: "Express lane" now means THIS reservation is express.
 *         The badge rendered on every racing row (it gated on kind === "racing",
 *         not on eligibility), so guests who genuinely had to check in were told
 *         to skip it — 8 of 25 Fort Myers reservations on 7/28, including the one
 *         ops flagged. It now reads real per-reservation truth: the browse list
 *         from the `fastLane` flag checkout wrote (one Redis GET, issued in the
 *         same Promise.all as the existing ref mint, so no extra round trip), the
 *         itinerary from the live per-racer Pandora waiver read it already does,
 *         which also catches a waiver that lapsed since booking. Any racer with
 *         no personId disqualifies the party, and a combo is never express
 *         because its bowling lane still needs opening.
 *         And express now REPLACES check-in rather than decorating it: tapping
 *         an express row pops the message and stops — no last-4 gate, no OTP, no
 *         itinerary — which is what the owner had asked for more than once. The
 *         destination copy said "the pits"; it now says Race Check-In, 1st floor,
 *         left of the Red Track, like the eTicket and the race-day email. Fully
 *         EN + ES: the old body was stuck in English because its inline bold made
 *         it rich text, so it is now split at SENTENCE boundaries where each key
 *         is a whole translatable unit.
 * 1.10.8 — the chooser's utility boxes are ONE shape, in ONE grid.
 *         1.10.7 gave them a common height and called it done; they still had
 *         three border alphas, three type treatments and — the real problem —
 *         sat in TWO separate flex rows, whose columns can never line up. Now a
 *         single UtilityTile (components/UtilityTile.tsx) owns the shape and
 *         EXPORTS its class string, so the voucher chip and the language
 *         switcher style themselves from it and cannot drift again. Laid out as
 *         one 2-column grid: every tile identical width, rows aligned, and an
 *         odd last tile spans both columns instead of leaving a hole.
 *         Also: the "Coupon or voucher?" tile now hides once a voucher is
 *         scanned (owner 2026-07-28) — the voucher summary tile replaces it and
 *         the sheet it opens is where further codes get added, so two doors onto
 *         the same sheet was one too many.
 * 1.10.7 — REGRESSION FIX + the last of the attract cleanup.
 *         (1) RACE PACKS OPENED A BLANK SCREEN. 1.10.5 widened the banner to
 *         "any kiosk that offers racing" so HeadPinz FM could sell packs, but
 *         KioskRacePackFlow still returns null for a non-FastTrax brand — so the
 *         tap swapped the screen for nothing. Reverted to FastTrax-only, and the
 *         banner gate now MATCHES the flow's own guard so they cannot diverge
 *         again. Selling packs from the HeadPinz bank is not a display change:
 *         the flow passes `brand` to KioskPartyManager as `brandLocation`, which
 *         drives pandoraFetchWaiverTemplate / pandoraCheckWaiver — i.e. WHICH
 *         WAIVER the guest signs. That needs an explicit decision plus a live
 *         card-present smoke, so it is not inferred here.
 *         (2) The attract screen drops the footer logo band and the language
 *         switcher: the venue's own logo is already the biggest thing on that
 *         screen, so a second smaller pair of both logos was the same
 *         information twice, and the switcher belongs where a guest stops to
 *         read. That is another 130px back in the reach band.
 *         (3) The chooser's bottom boxes are now ONE shape — side doors, code
 *         chip, voucher chip and language switcher all 96px tall, 18px radius,
 *         1.5px border, flex-1. Three different heights and radii read as three
 *         unrelated controls.
 *         (4) The language switcher renders IN FLOW there rather than fixed.
 *         1.10.6 only moved it; the real bug is that `.kiosk-canvas` is
 *         transformed (so `fixed` resolves against it) and `.k-flow-body`
 *         scrolls, so a fixed switcher is CLIPPED at the body edge — no offset
 *         could have fixed it.
 * 1.10.6 — the attract screen finally has NOTHING on it but the poster. The
 *         three "not booking" side doors (Race Reservation, View race grid,
 *         Online & Group Waiver) move to the "What are we doing today?" chooser
 *         as ONE even row — equal widths, one line each, so two or three read
 *         as a deliberate row instead of the old full-width-bar-plus-two-halves.
 *         1.10.4 only moved VIP and race packs; these were the buttons still
 *         sitting on the poster (owner 2026-07-28). Flag + venue gating moved
 *         into KioskFlow so it is not duplicated: a callback only reaches the
 *         chooser when that door applies.
 *         The waiver door hides once a voucher is applied — a LAYOUT rule to
 *         give the row a slot back, NOT a legal one: a voucher is not a signed
 *         waiver, and /kiosk/waiver plus the in-flow waiver are untouched.
 *         Also: the chooser's language switcher was UNTAPPABLE. At
 *         bottom-[34px] it sat underneath the flow's 140px util bar (Start Over
 *         / Guest Assistance); the attract screen has no util bar, which is why
 *         the same slot worked there. Lifted to bottom-[168px], still
 *         bottom-right.
 *         TRADE-OFF, flagged: check-in is now two taps from idle instead of
 *         one, and it is the one time-sensitive door in that set.
 * 1.10.5 — the shortcut row is gone again (owner 2026-07-28). VIP Experience is
 *         DROPPED outright — the Experiences card already leads there, so it was
 *         a second door onto the same room. Race packs moved INTO the
 *         Experiences shelf as a banner beside the VIP combo and the Ultimate
 *         Qualifier, where a guest is already comparing premium racing, and they
 *         now show at BOTH Fort Myers venues (FastTrax and HeadPinz FM share the
 *         campus and guests walk between them). Gated on whether the kiosk
 *         offers racing at all rather than on brand — the same condition, and it
 *         keeps karting-less Naples out without naming venues. A pack is credit
 *         to spend later, not a timed booking, so its banner carries no
 *         availability line, never locks out, and counts toward the Experiences
 *         card staying open when a pack is the only thing left on the shelf.
 * 1.10.4 — VIP + race-pack shortcuts move OFF the attract screen and onto the
 *         "What are we doing today?" chooser, as an even row of buttons under
 *         the Game Zone card (owner 2026-07-28). The attract screen is a poster
 *         with one instruction: a button there both competes with "touch
 *         anywhere" and is the one thing a tap anywhere does NOT do. The
 *         chooser is where a guest is already deciding. Same destinations the
 *         ?goto=vip / ?goto=packs deep links seed, so the entry points cannot
 *         drift. Each is hidden unless it is actually reachable (VIP combo
 *         enabled at this center and fits today; packs are FastTrax + kill
 *         switch). The chooser's language switcher also moves bottom-right to
 *         match the attract screen, so it stops jumping between the first two
 *         screens a guest sees.
 * 1.10.3 — the 1.10.2 vehicle fix was itself broken, and took the Mega
 *         headline with it. (1) `left-[calc(100%+64px)]` emits
 *         `calc(100%+64px)`, and CSS requires whitespace around `+` inside
 *         calc() — so the browser dropped the declaration, `left` fell back to
 *         `auto`, and the car and ball rendered at their STATIC position, parked
 *         mid-lane in plain view. Worse than the 64px sliver it was meant to
 *         fix. Now an inline style, where the spaces survive.
 *         (2) The headline carried `whitespace-pre-line` AND
 *         `[text-wrap:nowrap]`. `white-space: pre-line` is a shorthand that
 *         also sets `text-wrap: wrap`, so the winner depended on stylesheet
 *         order; when wrap won, "LET'S GO MEGA." broke onto a second line that
 *         clipped. Whitespace is now set inline and per-case: pre-line only for
 *         billboard words, which carry deliberate \n breaks.
 *         (3) fitOneLine measured, then the style prop re-applied the base size
 *         on the next render and wiped the result — five times a second during
 *         a billboard poll. The hook owns fontSize outright now.
 *         (4) "Videos load a split second different": the clips were encoded
 *         with a default ~10s GOP — the race cut had NO keyframe in its first
 *         8 seconds — so a clock-seek had to decode forward from frame 0 and
 *         every machine arrived at its own pace. All four re-encoded with a
 *         keyframe every second, which is what makes the shared-clock seek
 *         land instantly and identically. Drift watchdog tightened 4s -> 2s
 *         now that a correction is cheap.
 *         (5) Bowling re-cut from 6.2s: earlier in the reel a lit HEADPINZ
 *         sign is on the wall, and the bowling slide also runs on FASTTRAX
 *         kiosks as cross-promo. Also clears the food and robot segments.
 * 1.10.2 — attract fixes. (1) The car and ball sat 64px INTO view, parked at
 *         the right edge, then lurched off — the lane lives inside the hero's
 *         64px padding, so left:100% is x=1016 on a 1080 canvas. Parked at the
 *         canvas edge now, so they are genuinely hidden until they cross.
 *         (2) The billboard raised its curtain raggedly: each screen swapped
 *         PICTURE on its own staggered beat, so five screens changed a second
 *         apart and read as five glitches rather than one sign. Now every
 *         screen cuts to its solid image TOGETHER and only the WORDS travel
 *         down the row, one per second, before the shared closing line.
 *         (3) Mega Tuesday no longer appears on HeadPinz Fort Myers: both FM
 *         venues share one center code, so a racing-only dated promo (with an
 *         operational junior-racer rule) was landing on the one bank that also
 *         runs the billboard, and the two fought over the same screen.
 *         Everyday racing cross-promo stays.
 * 1.10.1 — attract footer tidy: the venue name ("Fort Myers" / "Naples") is
 *         gone from the headline layout — a guest at the kiosk knows which
 *         building they are standing in, and it crowded the language switcher
 *         that now sits in that footer band. Brand lockup stays centred, the
 *         switcher owns the right side. Ad-zone layout keeps the venue line.
 * 1.10.0 — NEW ATTRACT SCREEN (attractLayout "headline", now the default; the
 *         old ad-zone layout is kept and selectable per device via the config
 *         field or ?attract=adzone). The 480px display-only ad zone is gone —
 *         it painted a second full-bleed photo over the backdrop photo, which
 *         is why it needed its own heavier scrim, and the screen said "start"
 *         three times (neon sign, marquee, cyan pill). Now: the slide drives
 *         the screen's own backdrop + a "Let's race." / "Let's bowl." headline
 *         (EN+ES, measured to one line), the cyan pill becomes a prompt because
 *         a tap anywhere already starts, and VIP / race packs stay as the only
 *         two real buttons. Backdrops are real footage, alternating video and
 *         still by (cycle + index) parity so no two consecutive slides move and
 *         each activity flips every lap. Vehicles are per-ACTIVITY now — the
 *         car on racing, the ball on bowling — crossing THROUGH the headline on
 *         the shared clock. The HeadPinz bank billboard is INTEGRATED rather
 *         than overlaid: it swaps the backdrop and the headline for its ~11s
 *         and leaves the prompt and buttons alone, so the 94% navy veil and the
 *         text-on-text bleed it hid are both gone. Clips are kiosk-encoded
 *         (31.9MB race hero → 2.5MB; 38MB Nexus montage → 3.9MB gel; arcade
 *         trimmed before the axe-throwing segment) because Chrome will not
 *         cache an entry over ~1/8 of its disk cache, and an evicted clip
 *         re-downloads on every attract re-mount. Video playback position is
 *         clock-locked like the CSS animations, so the whole bank shows the
 *         same frame.
 * 1.9.0 — race packs sell to the whole group + are cart-editable (manager
 *         report 7/27: a 4-person party got a pack on only ONE racer, then got
 *         trapped re-entering the wizard to fix it). (1) The "who's this pack
 *         for?" prompt is a MULTI-SELECT — checkbox chips + Everyone + one
 *         "Add N packs · $X" apply (was one name per tap). (2) The cart's race
 *         card grows a "Race packs" block: assigned packs listed by name with
 *         remove ×, "+ Add race pack" opens the same picker right in the cart
 *         — no wizard re-entry; cart Est. total now includes pack lines and
 *         their covered-today discount (mirrors the pay screen's math).
 *         (3) Mid-wizard cart/main-menu exits on a BOOKED item (heats held)
 *         now lead with "Keep my race & view cart" — before, the only path to
 *         the cart was "Remove it & view cart", which released the booking.
 * 1.8.2 — RECOVERY for the 1.8.0 outage. (1) Config-envelope stamp reverted to 2
 *         and readStorage made VERSION-AGNOSTIC: it reads the stored config
 *         whatever the version (2, 3, anything), backfills new fields via
 *         resolveKioskConfig, and only rejects a genuinely unusable envelope — so
 *         no shape change can wipe a kiosk to KIOSK SETUP again, and kiosks
 *         re-provisioned to v3 during the outage keep working. (2) useLocale no
 *         longer throws without a provider (it falls back to the default locale),
 *         fixing the /join/[code] phone page crash from the i18n rollout.
 * 1.8.1 — HOTFIX for the 1.8.0 rollout: the config-envelope version bump (v2→v3
 *         for `locale`) was DISCARDING every older stored config on read, which
 *         sent all already-provisioned kiosks back to the KIOSK SETUP screen.
 *         readStorage now MIGRATES older envelopes forward (additive fields
 *         backfill from resolveKioskConfig) and re-persists at the current
 *         version, so a device keeps its venue + hardware across a shape bump.
 * 1.8.0 — SPANISH (guest i18n): the whole guest-facing kiosk speaks Spanish now,
 *         behind NEXT_PUBLIC_KIOSK_I18N. A flag switcher (US / ES) sits on the
 *         attract screen and the "what are we doing today?" chooser; the choice
 *         rides in KioskConfig and resets to the device default on Start Over.
 *         Ships with the IN-HOUSE WAIVER (NEXT_PUBLIC_KIOSK_WAIVER_INHOUSE,
 *         default ON): we serve our OWN adult/minor waiver body (EN + ES) so it
 *         can be translated, while keeping BMI's real contentID/duration so the
 *         sign path is byte-identical. Minor waivers lead with a red
 *         guardian-MUST-sign banner + a Florida Statute § 831.01 (forgery)
 *         notice; the kiosk signing UI is enlarged to use the portrait screen.
 * 1.7.2 — scanner model #2's brand corrected: it's an OPTICON 2D imager, not
 *         Posiflex. Registry id renamed posiflex-2d → opticon-2d, expected
 *         VID now 0x065A (Opticon's registered VID; was Posiflex 0x0D3A).
 *         Still fully unconfirmed until a unit is provisioned — 9600 default
 *         + the panel's baud-stepping test flow unchanged.
 * 1.7.1 — device check reports the COM QR scanner (live serial-grant match
 *         against the saved port, model + baud shown) instead of the retired
 *         USB keyboard-wedge toggle; the sign-in boxes fold/unfold on an
 *         always-visible "More ways to add people" bar at any time (roster
 *         state is just the default), keeping the amber "N phones signing in"
 *         status in every state.
 * 1.7.0 — the people-step sign-in methods are now three equal, tappable boxes
 *         under the entry buttons — "Sign in from your phone" (mobile-join QR,
 *         inline + tap to enlarge to a focused sheet), "Scan your license"
 *         (driver's license / state ID), and "Scan your FastTrax license" —
 *         each shown only when its method is live, folding into a slim bar once
 *         someone's on the roster. Race Packs gains phone sign-in (reuses the
 *         existing mobile-join feature). One shared KioskSignInBoxes across
 *         racing, gel blaster, laser tag, and race packs. UI only — scanning /
 *         parsing / lookup unchanged.
 * 1.6.6 — Posiflex 2D imaging scanner added to the QR-scanner model registry
 *         (admin → QR scanner tab → Model select). Output format, baud and
 *         USB ids are all UNCONFIRMED until a unit is provisioned — the
 *         panel's scan feed + baud stepping is the test surface, exactly the
 *         flow the 3320g used. Default model stays the Honeywell.
 * 1.6.5 — SMS-Timing member QR sign-in: scanning the app's personal QR
 *         (https://smstim.in?["<clientKey>","<code>"]) Office-searches the
 *         code and signs the member straight in (~1 s) — same rail as the
 *         license scan; foreign clientKeys and junk codes are rejected.
 * 1.6.4 — license lookup rebuilt on the BMI Office token search with a
 *         combined "LastName M/D/YYYY" token (owner's vector — no leading
 *         zeros, raw https; undici 500s on these tokens): ~1 s live vs ~8.5 s
 *         on Pandora person search. Waiver resolves post-sign-in via the
 *         OTP path's "Checking waiver…" rail; live duplicate ranks first
 *         (plausible-name recency beats exact-name staleness).
 * 1.6.3 — Combine cards rebuilt on the real rails: TPI_ConsolidateAccounts on
 *         the standard cloud SOAP host (WSDL-exact envelope — <long> account
 *         array, LocID position, GMT_DateTime; no raw sockets / extra hosts).
 *         Failures HALT the accept loop and show the actual cause + Try again
 *         (was: silent "see attendant" + 30s reset loop); button hides itself
 *         when the backend isn't configured; card always returned promptly.
 *         Done/Back are tappable while waiting for a card (the wait had them
 *         disabled ~permanently — guests were stuck) and exit INSTANTLY by
 *         cancelling the pending insert wait; only the live money-move
 *         (seconds) disables them, and the wait screen shows the insert
 *         animation instead of a false "Combining…" spinner.
 * 1.6.2 — license lookup shows EVERY matching account (duplicates included —
 *         the picker appears whenever more than one record matches; 1.6.1
 *         silently collapsed dupes to one) and returns faster: the 2-year
 *         deposit pull moved out of the lookup (qualification refresh fills
 *         credits at step exits) and the kiosk pre-warms Pandora when a
 *         scan-capable screen mounts, so the first scan skips the cold start.
 * 1.6.1 — license lookup rebuilt on Pandora GET /bmi/person/search (lastName +
 *         birthday, filter=false, cold-start 5xx retry). 1.6.0 searched the
 *         Office token API, which 500s on name tokens — scans parsed but never
 *         found the account. Duplicate records now collapse to one sign-in
 *         (waiver-carrying copy preferred). Verified against the live route.
 * 1.6.0 — driver's-license scan (hardware QR scanner): scanning a license at
 *         the people/party/bowling screens signs a returning guest in by last
 *         name + DOB (Pandora-matched; multi-match → account picker) or opens
 *         the new-player form prefilled; guardian + setup forms scan-fill too.
 *         Only name + DOB are read off the license — nothing else is kept.
 * 1.5.0 — mid-session qualification refreshing: tier/memberships, waiver, and
 *         credits re-pull from BMI/Pandora at the people-step exit + review→pay,
 *         so desk upgrades / phone-signed waivers land without re-adding anyone.
 *         Fixes: minor-vs-adult waiver template now uses the BMI birthdate
 *         (guardian paths no longer default unknown ages to adult); confirmation-
 *         screen card fulfillment gets the out-of-cards/bin-full/jam hold with
 *         staff Resume (was dead-ending the basket); Combine cards re-enabled
 *         on the documented ConsolidateCards op.
 * 1.4.1 — fix: new-card clear-on-encode (GC_CLEAR_ON_ENCODE) now actually clears.
 *         TPI_ClearAccount was sending the account array as <string> items,
 *         which the server ignored (empty array → no-op, still code 0); the
 *         array item must be <long> (int64). Verified live 2026-07-23.
 * 1.4.0 — Game Zone honors the global INTERCARD_LOAD_MODE switch: forcing
 *         `cloud` stops the kiosk dialing the on-prem bridge, so the card-system
 *         chip reads Cloud and every load rides the cloud SOAP path.
 * 1.3.1 — Game Zone shows a Local/Cloud card-system chip (bridge status) on
 *         the New cards + Reload screens; util-bar helper text clamps to two
 *         lines instead of towering when the bar is crowded.
 * 1.3.0 — race product step reads as one directed step: packages auto-advance
 *         to scheduling; covered-by-pack pricing + "now pick your race"
 *         guidance; Race-today hand-off carries fresh pack credits.
 * 1.2.0 — guest-assist radio alerts (+ card-fault auto-beacon); MSR kiosks
 *         are swipe-only (no typed card entry); version tag on every screen.
 * 1.1.0 — serial-COM MSR swipe reader (reload-only kiosks) + Windows
 *         touch-keyboard suppression on OSK fields.
 */
import { clearEntryScan } from "./entry-scan/handoff";

export const KIOSK_VERSION = "1.32.1";

let bootVersion: string | null = null;
let captured = false;

async function fetchVersion(): Promise<string | null> {
  try {
    const res = await fetch("/api/kiosk/version", { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

/**
 * Record the deploy this tab booted on. Idempotent — safe to call on every
 * mount. Only latches once we ACTUALLY have a version: if the boot-time fetch
 * fails (a network blip right at load — exactly what happens on a kiosk whose
 * WiFi is flaky), we leave it uncaptured so a later call can still snapshot it.
 * Previously this latched `captured = true` even on a failed fetch, which left
 * `bootVersion` null for the life of the tab and SILENTLY disabled self-update
 * until someone manually reopened the browser (found 2026-07-24).
 */
export async function captureKioskBootVersion(): Promise<void> {
  if (captured) return;
  const v = await fetchVersion();
  if (v == null) return; // fetch failed — don't latch; retry on the next call
  bootVersion = v;
  captured = true;
}

/**
 * True when the server is serving a DIFFERENT (newer) deploy than this tab booted
 * on, so a reset should hard-reload. Fails safe to false — unknown boot version,
 * a dev build, or a fetch error never forces a reload (and never loops).
 *
 * If the boot version was never captured (boot-time fetch failed), retry the
 * capture here first — the 5-min attract poll calls this, so a device that
 * booted during a blip recovers self-update on its own instead of staying
 * stuck on the old build forever.
 */
export async function kioskUpdateAvailable(): Promise<boolean> {
  if (!bootVersion) {
    await captureKioskBootVersion();
    if (!bootVersion) return false; // still couldn't capture — try again next tick
  }
  if (bootVersion === "dev") return false;
  const current = await fetchVersion();
  return !!current && current !== "dev" && current !== bootVersion;
}

/**
 * Reset to the attract screen, self-updating if a newer deploy is live: hard
 * reload to load the new build (fullscreen re-engages on the first attract tap),
 * else soft-nav via the caller's router.replace so fullscreen is preserved.
 */
export async function resetToKiosk(softNav: () => void, path = "/kiosk"): Promise<void> {
  // Between-guest boundary: drop any entry-screen scan that was stashed but
  // never consumed (its destination was flag-dark, or the guest walked away
  // mid-navigation). One place covers every reset path — otherwise a leftover
  // reservation scan could replay into the NEXT guest's session. Imported from
  // the module, not the barrel, so this stays free of React components.
  clearEntryScan();
  if (await kioskUpdateAvailable()) {
    window.location.href = path;
  } else {
    softNav();
  }
}
