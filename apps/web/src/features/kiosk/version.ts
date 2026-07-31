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
export const KIOSK_VERSION = "1.11.2";

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
  if (await kioskUpdateAvailable()) {
    window.location.href = path;
  } else {
    softNav();
  }
}
