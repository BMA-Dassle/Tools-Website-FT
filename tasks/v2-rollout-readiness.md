# v2 Race Rollout — Readiness Audit (2026-06-07)

Source:  workflow (34 agents). Every blocker/high below was independently verified (real=true). Severity in [brackets] is the verifier's corrected severity.

## Resolution log

### 2026-06-07 — Theme #2 (payment failure-safety) + #3 (idempotency) — DONE

Both reserve paths are now **safe to retry** (no double charge) and **always leave a durable, recoverable record**. Verified: `tsc --noEmit` clean, 370 unit tests pass (incl. new `reserve-idempotency.test.ts`), eslint clean. Live dev smoke (double-submit, BMI-confirm-fail, Neon-fail, gc-activate-fail, crash-replay, reconcile, race-dayof-pay integration, happy-path regression) is the operator's to run against prod Square/BMI.

Closed:
- **#3 — Deterministic idempotency.** `baseKey` now derives from a stable per-session anchor (`reserveBaseKey(bmiBillId)` in reserve; `bmiBillId ?? squareOrderId ?? qamf hold` in unified) via one shared helper (`reserve-idempotency.ts`) — so a retry/double-submit replays the SAME Square order/payment/gift card. Added a route-entry guard: `bmi:confirmed` already-confirmed short-circuit + per-bill NX `reserve:lock:{id}` (409 `RESERVE_IN_PROGRESS` for a concurrent loser). Stable unified GAN (`bill.slice(-8)`, was `baseKey.slice(0,8)`). → closes "No idempotency guard on reserve-all", "Double-submit of /api/booking/v2/reserve double-charges", "Per-request randomBytes idempotency key".
- **#2 — Recover forward, never auto-refund a captured charge.** New ordering in both paths: `createDepositAndCharge` → write durable `confirm_pending` anchor (with Square ids, idempotent via `findReusableReservation`) → BMI confirm → promote to `confirmed`. On BMI-confirm failure the anchor is marked `confirm_failed` (NOT rolled back — a captured payment can't be voided). `deposit.ts` returns a partial result (`giftCardPending`) on post-capture gift-card failure instead of throwing away context. New `race-confirm-reconcile` cron (`*/5`, `?token`/`?dryRun`/`?billId`) re-runs gc create+activate and re-confirms forward. `rollbackDeposit` removed (footgun). Admin-only `refundSquarePayment` added as the genuine-refund escape hatch. → closes "Deposit CAPTURED before BMI confirm; rollback cannot refund", "gift-card create/activate failure strands money", "Neon insert is non-fatal → never auto-settled", "Funded gift card orphaned when Neon insert fails", "money path has no durable failure queue".

NOT in this PR (next plan, theme #1 — packages/combos): wrong combo/package `pageId` in `bmiBookingTarget`, combo overcharge / Blue-twin $0 drop in `buildCombinedLineItems`+`buildRaceChargeLines`, `useZeroModel` gating for non-$0 carts, the `parseWithRawIds` MEDIUM on the confirm responses, and the race-dayof-pay detection/partial-pay items. **Packages still won't price/book correctly until #1 lands** — #2/#3 only make whatever charge happens idempotent + recoverable.

## Race selection flow (v2 booking: party → contact → product → heats → POV; service: race.ts, race-products.ts, conflict.ts, packages.ts)
**rolloutReady: False** — The STANDARD single-race path is solid and ready: ContactStep is wired as a required gate before any heat books (steps.ts:84-98, BookingFlow gates Next on canAdvance), returning-racer lookup/verify, new-racer creation, linked-family add, adult/junior split, waivers/Express-Lane, multi-heat + cross-track gap/conflict + atCap + new-racer 75-min lead + private-event guard, book-once-via-bmiLineId + license-once-via-licenseHeatIndices, and deselect/cart-removal orphan release all read correctly. The $0 BMI model resolves cleanly for in-registry single-race products. HOWEVER, two product combos tha

- **[BLOCKER]** Mixed-track 3-Pack combos book against wrong pageId → heat booking throws
  - file: apps/web/src/features/booking/service/race-products.ts:720-735
  - detail: The Blue-track twins of mixed-track combo packs (45094906, 45095003, 45095051) appear ONLY inside trackProducts (race-products.ts:578-579,595-596,614-615), never as top-level RACE_PRODUCTS entries, so getRaceProductById returns null for them. bmiBookingTarget therefore returns {productId:'45094906', pageId:'45094906'} — pageId equals productId instead of the real page (25850629/25850669/25850598).
  - test: Book a weekday Intermediate Weekday 3-Pack (productId 45094857), pick at least one BLUE heat, click Next — observe 'Failed to reserve heats: Heat ... no longer available'. Then add the missing track-t
- **[BLOCKER]** Packages (Rookie Pack / Ultimate Qualifier) book against package-only SKUs with wrong/unverified pageId and break booking
  - file: apps/web/src/features/booking/service/race-products.ts:720-735
  - detail: Packages are LIVE by default (packages.ts:188,190 default both flags ON; RaceProductStep.tsx:293-323 renders eligiblePackages). Package-only Intermediate SKUs (45810775, 45810802, 45811366, 45811390, 45811415, 45811531, 45811475) are not in RACE_PRODUCTS, and their pageIds are flagged 'best guess / verify before launch' in packages.ts comments. When the wizard advances past PackageHeatPicker, book
  - test: On a Tuesday date pick Ultimate Qualifier (Mega), select Starter + Intermediate heats, advance — observe heat-reserve failure. Verify each package-only SKU's real pageId against /api/bmi?endpoint=avai
- **[BLOCKER]** Package Intermediate race is never charged by Square, yet BMI bill confirmed as $0 credit (money leak + displayed≠charged)
  - file: apps/web/src/features/booking/service/unified-reserve.ts:192-203,743-751
  - detail: For packages raceUsesZeroBmiModel is false (package SKUs aren't in RACE_PRODUCTS), so the BMI bill carries REAL package prices via the legacy path. But buildCombinedLineItems (unified-reserve.ts:192 `if(!product) continue`) and checkout.buildRaceChargeLines (checkout.ts:615 same skip) drop every heat whose productId isn't in RACE_PRODUCTS — so the package Intermediate race never reaches the Square
  - test: Force a package past the heat step (after fixing the pageId blocker), reach checkout review, note the displayed total, complete a cash payment, then compare the Square day-of order line items + total 
- **[HIGH]** unifiedReserve assumes $0 model for ALL race carts unconditionally
  - file: apps/web/src/features/booking/service/unified-reserve.ts:743
  - detail: `const useZeroModel = raceItems.length > 0;` ignores raceUsesZeroBmiModel. Any race booking that is NOT eligible for the $0 model (packages, mixed-track combos, or any heat whose product lacks a build pair / future product added without a build twin) will still be confirmed at BMI as a $0 credit while its real-priced bill goes unpaid. checkout.ts's credit/full path uses the correct gate (raceItems
  - test: Construct a race cart that fails raceUsesZeroBmiModel (e.g. povQuantity>0, or a combo) and pay cash; verify the BMI bill is left with an unpaid real balance because it was confirmed asCredit. Replace 
- **[HIGH]** No unit coverage for the booking/charge logic (race.ts, checkout.ts, unified-reserve.ts, bmiBookingTarget)
  - file: apps/web/src/features/booking/service/race.ts
  - detail: Tests exist only for conflict.ts, race-products.ts (filter/lookup), race-pricing.ts, machine, and catalog. bookHeatsOnAdvance, licenseHeatIndices, raceUsesZeroBmiModel, bmiBookingTarget combo/package resolution, buildZeroModelOverview, applyCreditRedemptionsToOverview, and unifiedReserve's line-item/charge math are entirely untested — exactly the code carrying the package/combo defects above. The 
  - test: Add vitest specs: licenseHeatIndices (new vs returning, multi-heat once), bmiBookingTarget for a combo Blue-twin and a package SKU (assert correct pageId, currently failing), raceUsesZeroBmiModel fals

## Booking v2 — Cart, Session State & Wizard Navigation (CartView, BookingFlow, state machine, usePersistedReducer)
**rolloutReady: False** — The cart/session/wizard-nav layer is well-built and largely solid for the single-race happy path: the reducer is pure and well-tested (74 booking tests green), sessionStorage persistence with SCHEMA_VERSION discard-on-mismatch is correct, per-heat ✕ and whole-item removal both release BMI lines via the exact bmiLineId, leave-confirm and allItemsReady gating work, and multi-activity time-sort is sound. For SINGLE races the cart estimate mirrors buildRaceChargeLines per-heat so displayed≈charged. HOWEVER I found one BLOCKER: combo/3-pack race products are selectable in the wizard but are mispric

- **[BLOCKER]** Combo/3-pack races are overcharged price×raceCount in the cash path (displayed≠charged)
  - file: apps/web/src/features/booking/service/unified-reserve.ts:183-218
  - detail: buildCombinedLineItems prices every heat at getRaceProductById(heat.productId).price with no packType/raceCount handling. For combo packs the registry price IS the pack TOTAL (race-products.ts:533-535 says '`price` here is the customer-facing pack TOTAL'), and each of the 3 picked heats stores a track-product id that resolves to that same $49.98 price (RaceHeatPickerStep stores productId=trackProd
  - test: Add a Pro Mega 3-Pack (productId 45094787) to the cart, pick 3 heats, pay cash; assert the Square day-of order total equals one pack price (~$49.98 + tax), not $149.94. Unit-test buildCombinedLineItem
- **[HIGH]** Cart 'Est. total' shows 3× the pack price for combo packs
  - file: apps/web/src/components/features/booking/CartView.tsx:301-312
  - detail: The combo branch computes racesTotal = adultProduct.price × max(1,raceCount) × max(1,racerCount). Since the registry combo price is already the pack TOTAL, multiplying by raceCount (3) inflates the cart preview to ~$149.94 for a $49.98 pack. Same root cause as the charge bug. Even after the charge is fixed, this preview is wrong and will alarm customers. Should be price × racerCount (no raceCount 
  - test: Add a combo pack to the cart and read the 'Est. total' on the RaceCartCard; confirm it equals the pack price (×racers), not pack price ×3.
- **[HIGH]** All cart/charge pricing-parity math is unit-test-untested
  - file: apps/web/src/features/booking/service/checkout.ts:609-724
  - detail: There are zero unit tests for buildRaceChargeLines, buildZeroModelOverview, applyCreditRedemptionsToOverview (checkout.ts), buildCombinedLineItems (unified-reserve.ts), or the CartView estimate functions. The 74 passing booking tests cover the reducer, conflict detection, race-pricing primitives, and race-products lookups — none assert that the displayed cart/review total equals the Square charge.
  - test: Add a parity test: for representative carts (single race, multi-heat, combo, credit-redeem, race+attraction) assert buildZeroModelOverview/buildRaceChargeLines totals === buildCombinedLineItems totals

## Booking v2 — Checkout + Overview + Credit Redemption (race $0-model)
**rolloutReady: False** — The SINGLE-RACE happy path is sound and honors displayed==charged: runCheckout builds buildZeroModelOverview from the registry, the same lines flow into reserve cartItems, FL 6.5% (Lee) tax is applied once and matches Square's ORDER-scope catalog tax, and credit redemption ($0 split + addDeposit(-1)) is consistent between display (applyCreditRedemptionsToOverview) and charge (unifiedReserve/buildCombinedLineItems), with charge-time live-balance re-validation and idempotent deduction. BMI id precision rules are respected (raw-text injection, last-10-digit projectId math).

However, the subsyste

- **[BLOCKER]** Combo 3-pack charges ~3x the displayed pack price (Red components)
  - file: apps/web/src/features/booking/service/unified-reserve.ts:183-218
  - detail: Combo heats carry per-track component productIds. The Red component (e.g. 45094857 Int Weekday 3-Pack) IS in RACE_PRODUCTS with price=49.98 (the PACK TOTAL, race-products.ts:565-581). buildCombinedLineItems groups the 3 booked heats and charges qty 3 × $49.98 = $149.94; buildRaceChargeLines (checkout.ts:609-638) has the same flaw. CartView displays packageBundleTotal/combo price = $49.98 (CartView
  - test: In the v2 wizard book an 'Intermediate Weekday 3-Pack' (productId 45094857), pick 3 Red heats, reach Review (note displayed total ~$49.98+tax), pay, and inspect the Square day-of order total — it will
- **[BLOCKER]** Blue-track combo heats charged $0 (component ids missing from registry)
  - file: apps/web/src/features/booking/service/race-products.ts:577-616
  - detail: The Blue combo component ids (45094906, 45095003, 45095051) appear only inside trackProducts, never as top-level RACE_PRODUCTS entries. getRaceProductById returns null for them, so buildCombinedLineItems (unified-reserve.ts:194 `if (!product) continue;`) and buildRaceChargeLines (checkout.ts:616) silently drop those heats from the Square charge — the customer races for free on Blue picks while the
  - test: Book a weekday Intermediate/Pro 3-Pack and pick at least one BLUE heat; pay; confirm the Square order line items are missing the Blue heat(s) and the charge is short by ~$49.98/3 per dropped heat.
- **[BLOCKER]** Package (Rookie/Ultimate Qualifier) Intermediate race + POV not charged → undercharge, displayed!=charged
  - file: apps/web/lib/packages.ts:447-685
  - detail: Ultimate Qualifier (default-enabled, displayOrder 10 featured) bundles a package-only Intermediate SKU (45810775/45810802/45811366/45811531/45811390/45811415/45811475) that is NOT in RACE_PRODUCTS, so getRaceProductById returns null and buildCombinedLineItems/buildRaceChargeLines drop the Intermediate heat from the Square charge. POV is includesPov but the charge builders never add a POV line. The
  - test: Book 'Ultimate Qualifier' (weekday adult), pick a Starter + Intermediate heat, reach Review (displayed ≈ $20.99+$20.99+$4.99+$5+tax), pay, and inspect the Square day-of order — only Starter + License 
- **[HIGH]** No idempotency guard on reserve-all → double-submit/retry double-charges card
  - file: apps/web/src/features/booking/service/unified-reserve.ts:273,313-340
  - detail: baseKey = randomBytes(8) is generated fresh on every unifiedReserve call, and the Square idempotency keys derive from it (unified-dayof-${baseKey}, dep-order/gc/gc-act in deposit.ts). There is no dedup keyed on session.bmiBillId or a client-supplied request id. A double-click, a network-timeout-then-retry, or the error-phase Retry → re-review → re-pay (CheckoutStep.tsx:778-797 + handleTokenize) is
  - test: Fire two POST /api/booking/v2/reserve-all with the identical session/bmiBillId back-to-back (simulate double-submit) and confirm two distinct Square payments/gift cards are created instead of one.
- **[HIGH]** Combo/package undercharge also leaves BMI bill confirmed for heats Square didn't collect
  - file: apps/web/src/features/booking/service/unified-reserve.ts:740-751
  - detail: For combos/packages the order is NOT zero-model (raceUsesZeroBmiModel returns false for combos, race.ts:43; packages book real heats). unifiedReserve sets useZeroModel = raceItems.length>0 and confirms BMI as a $0 credit anyway (line 743,749) even though the legacy BMI bill carries real per-heat prices — so the BMI bill is confirmed/zeroed while Square only collected a subset. Net: heats booked + 
  - test: Book an Ultimate Qualifier via the cash path, then inspect the BMI bill state and the Square day-of order: BMI confirmed $0, Square order missing the Intermediate/POV lines — the difference is never c

## Booking v2 — race $0-model reserve paths (reserve + reserve-all), BMI confirm, idempotency, deposit/gift-card, credit redemption, partial-failure
**rolloutReady: False** — The happy path is well-built and the idempotency + day-of-pay design is sound, but the deposit charge is CAPTURED (via payOrder) before BMI is confirmed, and the only "rollback" is payments/{id}/cancel — which fails on an already-captured payment and never refunds or deactivates the funded gift card. So any BMI-confirm failure (or gift-card create/activate failure) after capture leaves a real customer charged with no booking and money stranded on a gift card, with no automated recovery. Separately, two id-bearing BMI responses are read with JSON.parse instead of parseWithRawIds — a direct viol

- **[BLOCKER]** Deposit is CAPTURED before BMI confirm; rollback cannot refund a captured payment or the funded gift card
  - file: apps/web/src/features/booking/service/deposit.ts:130-238 + apps/web/lib/square-gift-card.ts:434-450 + apps/web/app/api/booking/v2/reserve/route.ts:435-440,521-526
  - detail: In createDepositAndCharge the funds are CAPTURED at step 2 — authorizeMultiTender's step C calls payOrder (square-gift-card.ts:442) which settles the payments — BEFORE the gift card is created (step 3) and activated (step 4), and well before BMI confirm runs in the route. When BMI payment/confirm fails (reserve/route.ts:428-444, 519-531; unified-reserve.ts:889-897) the route calls rollbackDeposit,
  - test: In a dev (=PRODUCTION) booking, force the BMI payment/confirm to fail after deposit capture (e.g. send a valid card but a bmiBillId that BMI will reject), then inspect Square: confirm the deposit paym
- **[MEDIUM]** BMI payment/confirm response parsed with JSON.parse instead of parseWithRawIds (CLAUDE.md hard-rule violation)
  - file: apps/web/app/api/booking/v2/reserve/route.ts:447 and apps/web/src/features/booking/service/bmi-confirm.ts:78
  - detail: Both call JSON.parse(bmiText) on the BMI payment/confirm response and read reservationNumber/reservationCode. CLAUDE.md: 'NEVER res.json()/JSON.parse a BMI/Pandora response that carries an id … a : string annotation does NOT prevent the corruption … flag each violation BLOCKER.' The fields currently read (W-number reservationNumber, reservationCode) are strings so today's blast radius is limited, 
  - test: Grep the three confirm sites (reserve/route.ts:447, bmi-confirm.ts:78, data/bmi.ts:326) and replace JSON.parse(bmiText) with parseWithRawIds. Add a unit test feeding a payment/confirm body containing 
- **[HIGH]** createDepositAndCharge: gift-card create OR activate failure after capture strands the customer's money with no card and no booking
  - file: apps/web/src/features/booking/service/deposit.ts:171-224
  - detail: After payOrder captures (step 2), if gift-card create (step 3, deposit.ts:185-196) or activate (step 4, 219-224) throws, createDepositAndCharge throws but the payment is already captured. The route catch then calls rollbackDeposit which (same as the blocker above) cannot refund a captured payment, and here there is either no gift card at all (create failed) or an unactivated/$0 card (activate fail
  - test: Temporarily point the gift-cards create call at an invalid location_id (or inject a 400) so step 3 fails after a real card capture; confirm the Square payment is COMPLETED, no gift card exists, the ro

## Booking v2 — FastTrax race $0 build-product model, pricing, and gift-card creation
**rolloutReady: True** — The $0 build-product model is correctly and completely wired for rollout. RACE_BUILD_PRODUCTS is complete and clean: 14 keys (category:tier:track) × 2 variants = 28 BMI product ids, all unique, none blank, and the 14 keys exactly cover every distinct single (non-combo) priced RaceProduct (verified programmatically). Combo packs correctly do NOT resolve a build pair (track:null → raceBuildKey returns null → getRaceBuildPair returns null → bmiBookingTarget falls back to the priced product/page), and raceUsesZeroBmiModel correctly excludes combos, POV, and addons. License-once is deterministic (l

- **[HIGH]** Double-submit of /api/booking/v2/reserve double-charges then fails on duplicate GAN
  - file: apps/web/app/api/booking/v2/reserve/route.ts
  - detail: The route has NO idempotency guard on bmiBillId. baseKey is randomBytes() per request (line 174), so all Square idempotency keys (v2-dayof-${baseKey}, gc-${baseKey}, gc-act-${baseKey}) differ between two submits of the SAME bill. A retry/double-click therefore: (1) creates a SECOND day-of order, (2) charges the customer's card a SECOND time via createDepositAndCharge, then (3) tries to create a gi
  - test: Fire two concurrent (or rapid sequential) POSTs to /api/booking/v2/reserve with the SAME bmiBillId + a real card token. Confirm whether two day-of orders + two card charges are created and whether the
- **[MEDIUM]** $0-model functions (build-pair resolution, zero-model gating, license-once) have zero unit test coverage
  - file: apps/web/src/features/booking/service/race-products.test.ts
  - detail: race-products.test.ts and race-pricing.test.ts cover the catalog/filter/tax helpers but NOT the functions that actually decide the $0 vs legacy path: RACE_BUILD_PRODUCTS (28-id uniqueness / no-blank invariant), raceBuildKey, getRaceBuildPair, bmiBookingTarget (build twin vs priced fallback vs passthrough), raceUsesZeroBmiModel (combo/POV/addon exclusion), and licenseHeatIndices (once-per-new-racer
  - test: Add vitest cases: (a) every RACE_BUILD_PRODUCTS value has non-empty raceOnly+withLicense ids and all 28 are unique; (b) bmiBookingTarget(<single priced id>, {withLicense:true/false}) returns the corre

## Race day-of payout cron (/api/cron/race-dayof-pay) — auto-detect sweep + gift-card→day-of-order settlement
**rolloutReady: False** — The MANUAL single-settle path (?billId=) is sound and prod-verified (W39308). The CHARGE half is well-built: idempotency key is stable per reservation (race-dayof-pay-${r.id}, line 198) so Square dedupes; overpay is capped at remaining (line 193); order-already-COMPLETED (184) and $0-remaining (186) are treated as settled; the stamp is conditional on res.paid via updateBowlingReservationLaneOpen's WHERE dayof_order_sent_at IS NULL guard (bowling-db.ts:2262-2264). The DETECTION half is plausibly correct — OFFICE_CLIENT_KEY (lines 58-62) exactly mirrors the proven CLIENT_KEYS map, stored centerC

- **[BLOCKER]** Auto-detect sweep is live-scheduled (*/2) despite never being prod-verified; docstring says it is NOT scheduled
  - file: apps/web/vercel.json:91-94
  - detail: This branch's vercel.json registers /api/cron/race-dayof-pay at */2 * * * * (git diff vs main ADDS this block). But the route docstring at route.ts:31 still says 'NOT yet registered in vercel.json — dry-run in production first, then schedule', and the prompt states the auto-detect sweep has never been prod-verified (office API 401s in dev). Deploying this branch turns the unverified sweep loose on
  - test: In prod, hit GET /api/cron/race-dayof-pay?token=<ADMIN_CAMERA_TOKEN>&dryRun=1 and confirm the JSON shows candidates>0, arrived>0 for headpinzftmyers, and wouldPay lists exactly the W-numbers of races 
- **[HIGH]** Partial gift-card pay stamps the reservation as settled while leaving the day-of order OPEN and underpaid, with no error persisted and no retry
  - file: apps/web/app/api/cron/race-dayof-pay/route.ts:193-241
  - detail: If gcBalance < remaining, chargeDayof pays min(gcBalance,remaining), skips the COMPLETE block (remaining>0), and returns {paid:true, note:'... ($X remaining)'}. The caller then unconditionally stamps dayof_order_sent_at via updateBowlingReservationLaneOpen (route.ts:331-337 and manual 276-282), permanently burning the idempotency guard. Result: order left OPEN/underpaid, no further auto-settlement
  - test: Create a $0-model race booking, manually deduct a few cents from its gift card in Square (or simulate a smaller GC balance), then run the sweep and confirm the reservation is NOT marked permanently se
- **[HIGH]** Neon insert is non-fatal in both reserve paths → a booking with no Neon row is never auto-settled and money parks indefinitely
  - file: apps/web/app/api/booking/v2/reserve/route.ts:578-581
  - detail: Both reserve paths treat the Neon insert as non-fatal (reserve route:578-581 'Non-fatal — BMI reservation is already confirmed'; unified-reserve.ts:886-887). If the insert fails, the customer is still charged, the gift card is funded, the BMI bill is confirmed, and the day-of order is OPEN — but there is no bowling_reservations row. getRaceReservationsAwaitingDayofPay (bowling-db.ts:957) reads onl
  - test: Force the insertBowlingReservation call to throw (e.g. temporary DB outage) during a staged $0-model race booking, then confirm the gift-card→day-of-order is still recoverable by SOME mechanism; today

## Booking v2 — confirmation page (/book/confirmation/v2)
**rolloutReady: True** — The v2 confirmation page is structurally sound for rollout testing. Its data source is correct for resilience: the multi-activity hub, race groups, attraction cards, and bowling cards all read from PERSISTED Redis (bookingrecord:{billId}, 90d TTL) plus booking-store (booking:{billId}, 24h) and the bmi:confirmed:{billId} idempotency cache (7d) — NOT in-memory session. So clearBookingSession at checkout does not affect it, and the emailed receipt link (correctly v2-aware via confirmationV2:true, app/.../page.tsx:513) reopens the full page with the billId. The /api/booking/confirm call is server-

- **[HIGH]** Entire multi-activity confirmation view depends on one non-fatal Redis write at checkout
  - file: apps/web/src/features/booking/service/checkout.ts
  - detail: The hub's attraction & bowling cards read ONLY bookingRec (bookingrecord:{billId}). That record is written by saveBookingDetails via /api/booking-record POST inside a try/catch that swallows failure (checkout.ts:333-367 '/* non-fatal */'). If that POST fails (transient Redis/network), bookingRec is null on the confirmation page, so attractionList/bowlingList are [] (page.tsx:1101-1116) and only ra
  - test: Place a real mixed booking (race + attraction + bowling), then before loading the confirmation page delete the Redis key bookingrecord:{billId} (simulating the failed write). Load /book/confirmation/v

## v2 booking (FastTrax race $0-model: reserve / reserve-all / race-dayof-pay) + cross-cutting rollout concerns
**rolloutReady: False** — The v2 race $0-model happy path is well-built and the HARD RULES are respected: no BMI-id corruption (every id-bearing payload uses stringifyWithRawIds in the adapter or raw template-literal injection in bmi-confirm/reserve/sellLicense; the JSON.parse calls only read non-id fields; the projectId `Number(billId.slice(-10))+1` carry math is provably equal to BigInt truth and stays under MAX_SAFE_INTEGER). No SHARED_TOP_LEVEL_ROUTES violation — v2 lives under /book/* and /hp/book/*, which middleware explicitly handles, not a new host-switching top-level route. No session-replay/Statsig code anywh

- **[HIGH]** Funded gift card orphaned when Neon insert fails after the Square charge (no recoverable record for dayof-pay cron)
  - file: apps/web/src/features/booking/service/unified-reserve.ts:886
  - detail: In reserve-all, the deposit (real card charge → funded gift card, depositResult) happens at step 5 (417-453). The bowling_reservations row that records squareGiftCardId + squareDayofOrderId is inserted only inside the BMI-confirm block (855-884) and its failure is caught NON-FATALLY (886-888: 'Neon insert (BMI) failed (non-fatal)'). Same in reserve/route.ts:578-581. getRaceReservationsAwaitingDayo
  - test: In a dev/staging copy of unifiedReserve, force insertBowlingReservation to throw AFTER createDepositAndCharge + confirmBmiPayment succeed (e.g. point DATABASE_URL at an unreachable host post-charge). 
- **[HIGH]** Per-request randomBytes idempotency key allows double-charge on retry/double-submit
  - file: apps/web/src/features/booking/service/unified-reserve.ts:273
  - detail: baseKey = randomBytes(8) is generated fresh on every call (also reserve/route.ts:174, deposit.ts:96). Every Square idempotency_key derives from it (unified-dayof-${baseKey}, dep-order-${baseKey}, gc-${baseKey}, pay-card-${baseKey}, etc.). The UI guards a double-CLICK (PaymentForm.tsx:574 disables while status===processing; CheckoutStep transitions to 'confirming'), but it does NOT guard a retry ac
  - test: POST /api/booking/v2/reserve-all twice with the identical body (same session.bmiBillId, same card nonce simulated) back-to-back; confirm whether two day-of orders / two deposit charges are created. Fi
- **[HIGH]** Square→gift-card→day-of-order money path has no durable failure queue
  - file: apps/web/src/features/booking/service/deposit.ts:185
  - detail: enqueueDepositFailure (lib/bmi-deposit-retry.ts) is wired ONLY for Pandora addDeposit() credit deducts (race-credit-redeem.ts:115). The core $0-model money path (createDepositAndCharge → gift card create/activate; unifiedReserve day-of order create; BMI confirm) has no equivalent durable queue. deposit.ts:185-190 and :219-224 throw 'Payment captured but gift card creation/activation failed' — at t
  - test: Simulate gift-card creation failure (e.g. invalid custom GAN collision) after authorizeMultiTender captures the card; verify whether (a) the card charge is reliably reversed and (b) any durable record
- **[HIGH]** AUTO-DETECT dayplanner sweep is unverified end-to-end and not scheduled
  - file: apps/web/app/api/cron/race-dayof-pay/route.ts:31
  - detail: Header comment: 'NOT yet registered in vercel.json — dry-run in production first, then schedule.' The Office dayplanner scan (arrivedNumbers, 131-167) 401s in dev so the -5 Arrived auto-detection has never run against real data; only the MANUAL ?billId= single-settle path is prod-verified (per session notes). arrivedNumbers matches reservations by normalized W-number across a SHARED tenant (headpi
  - test: In production, hit /api/cron/race-dayof-pay?dryRun=1&token=... after a real $0 race is booked AND the guest is checked in (state -5). Confirm arrived.size > 0, the W-number matches (no normalize miss)
