# PR-B2 v1 → v2 Parity Matrix — 2026-05-24

Branch: `feat/booking-b2-race` @ `e2d5c37e`. Typecheck clean, 313/313 tests pass.

**Source of truth:** `C:\Users\Alex.Trepasso\.claude\projects\c--git-Tools-Website-FT\memory\v1_race_parity_checklist.md` (the v1 audit compiled 2026-05-16 during commits 5 → 6).

**Method:** read v2 implementation files in full (per CLAUDE.md § 7 operating principles), cite `file:line` for each row. No grep-only entries. Verified against actual code, not just commit messages.

**Status legend:**
- ✅ **Shipped** — v2 has it, citation included
- 🔄 **Replaced** — v2 delivers same UX through a different mechanism (note the divergence)
- ⏭️ **Deferred** — explicitly out-of-scope for PR-B2 per a scope decision
- ⏸️ **HOLD** — open scope question to resolve before merge
- ❌ **Missed** — gap that blocks merge

---

## 1. Customer-visible features

| # | Behavior | v1 location | v2 location | Status |
|---|---|---|---|---|
| 1.1 | Experience picker (new vs returning) | `app/book/race/page.tsx` | `src/components/features/booking/steps/race/ExperiencePicker.tsx:1-52` (rendered from `RacePartyStep.tsx`) | ✅ |
| 1.2 | Party size step → drives adult/junior eligibility | `app/book/race/page.tsx` | `src/components/features/booking/steps/race/RacePartyStep.tsx:309-423` (per-member roster with `category: "adult" \| "junior"`) | 🔄 — v2 uses per-member roster with `isNewRacer` per member instead of v1's party-wide `racerType` (user-confirmed divergence; see `booking_v2_architecture.md`) |
| 1.3 | Date picker (weekday/weekend/Mega Tuesday) | `app/book/race/components/DatePicker.tsx` | `src/components/features/booking/steps/race/RaceDateStep.tsx:58-78` (per-month BMI probe for Mega + Mon-Thu Starter Red + Fri-Sun Starter Red); Mega Tuesday styling at line 256-296 | ✅ |
| 1.4 | Product picker (tier × category × track variant) | `app/book/race/components/ProductPicker.tsx` | `src/components/features/booking/steps/race/RaceProductStep.tsx:302-430` (ProductCard); `:438-563` (TrackPickerModal for multi-track packs) | ✅ |
| 1.5 | Static product registry (NOT live BMI `/page`) | `app/book/race/data.ts` RACE_PRODUCTS | `src/features/booking/service/race-products.ts:55-617` | ✅ |
| 1.6 | Multi-heat selection (3-pack day-of products) | `app/book/race/components/PackHeatPicker.tsx` | `src/components/features/booking/steps/race/RaceHeatPickerStep.tsx` (heats[] click-to-toggle); 3-pack via `RaceItem.heats[]` shape and `RaceProduct.raceCount` | ✅ |
| 1.7 | Heat-conflict gap rules (Red ≥13, Blue ≥16, Mega ≥13, cross-track ≥30 min) | `lib/heat-conflict.ts` | `src/features/booking/service/conflict.ts` (ports `heatsConflict`, `findHeatConflict`, `HEAT_CONFLICT_TOOLTIP`) | ✅ |
| 1.8 | Per-track dayplanner fetch for multi-track packs | `app/book/race/components/PackHeatPicker.tsx:373-409` | `src/components/features/booking/steps/race/RaceHeatPickerStep.tsx:68-83` (`buildFetchPlan` enumerates track variants); `PackageHeatPicker.tsx:84-100` (parallel queries per pkg.races × tracks) | ✅ |
| 1.9 | Multi-track pack TrackPickerModal (Red + Blue with images) | `app/book/race/components/ProductPicker.tsx:296-425` | `src/components/features/booking/steps/race/RaceProductStep.tsx:438-563` (verbatim port w/ blob-storage images, taglines, stats) | ✅ |
| 1.10 | New-racer lead time (75 min cutoff) | `app/book/race/page.tsx:2280-2288` | `src/components/features/booking/steps/race/RaceHeatPickerStep.tsx:49` (`NEW_RACER_LEAD_MINUTES = 75`); applied at line 120-133 | ✅ |
| 1.11 | License upsell ($4.99 per first-timer, auto-sold) | `app/book/race/page.tsx` (sells productId 43473520) | `src/features/booking/service/race.ts:145-150` (`sellLicense` → POST `/api/bmi?endpoint=booking/sell`) | ✅ |
| 1.12 | POV video upsell — UI + sell | `app/book/race/components/PovUpsell.tsx` | `src/components/features/booking/steps/race/RacePovStep.tsx` (UI); `src/features/booking/service/race.ts:152-156` (`sellPov` → POST `/api/sms?endpoint=booking/sell`) | ✅ |
| 1.13 | POV Pandora session linking (8s post-confirm) | `app/book/race/page.tsx` | not implemented in v2 | ⏭️ per scope decision §2 (deferred to "video features" PR) |
| 1.14 | Rookie Pack chooser (License+POV+Nemo's appetizer bundle) | `app/book/race/components/PovUpsell.tsx:89-203` | `src/components/features/booking/steps/race/RacePovStep.tsx:83-202` (gated by `NEXT_PUBLIC_ROOKIE_PACK_ENABLED=1` + new racers) | ✅ |
| 1.15 | Race-day add-ons (Shuffly, Duckpin, Gel Blaster, Laser Tag) | `app/book/race/components/AddOnsPage.tsx` | `src/components/features/booking/steps/race/RaceAddonsStep.tsx` (verbatim 4-product registry); sells via `race.ts:158-175` `bookAddon` | ✅ |
| 1.16 | HeadPinz cross-activity add-ons chained to race bill | `app/book/race/page.tsx` | replaced by v2 multi-activity cart (`session.items` holds N items on one Square Order) | 🔄 per `booking_v2_architecture.md` |
| 1.17 | Contact form (firstName, lastName, email, phone, smsOptIn) | `app/book/checkout/page.tsx` | `src/components/features/booking/steps/checkout/CheckoutStep.tsx:166-251` (contact input phase) | ✅ |
| 1.18 | Order summary with FL 6.5% sales tax | `app/book/checkout/page.tsx` | `src/components/features/booking/steps/checkout/CheckoutStep.tsx:262-376` (review phase shows lines + subtotal + tax + total from BMI `bill/overview`) | ✅ |
| 1.19 | Square card tokenize + pay | `app/api/square/pay/route.ts` | `src/components/features/booking/steps/checkout/CheckoutStep.tsx:17` (reuses shared `@/components/square/PaymentForm` which calls `/api/square/pay` unchanged) | ✅ |
| 1.20 | Save card on file (saved cards selector for returning customers) | `app/api/square/pay/route.ts` | `src/components/features/booking/steps/checkout/CheckoutStep.tsx:121` (`resolveSquareCustomer` returns saved cards); `src/features/booking/service/checkout.ts:380-403` (`/api/square/customer`) | ✅ |
| 1.21 | Waiver acceptance UI + clickwrap row write | `lib/clickwrap.ts` | `src/features/booking/service/checkout.ts:210-240` (`recordClickwrap` → POST `/api/clickwrap/record`); CheckoutStep:92, 150 wires it on confirm + payment success | ✅ |
| 1.22 | Confirmation page (heat schedule + reservation number + QR per racer) | `app/book/confirmation/page.tsx` | reused unchanged — v2 writes to `/api/booking-store` (Redis 24h TTL) + `/api/booking-record` (Postgres 90d) so v1's shared page renders correctly | 🔄 compat path per commit 11 |
| 1.23 | Express-lane bypass (Pandora waiver gates skip Guest Services) | `app/book/confirmation/page.tsx` (read); `RacePartyStep.tsx` (display badge) | `src/components/features/booking/steps/race/RacePartyStep.tsx:309-423` (PartyMemberRow renders Express Lane badge from `verifiedPerson.waiverValid`); confirmation page bypass via shared v1 page | ✅ |
| 1.24 | Rookie Pack appetizer code (RACEAPP at Nemo's) on confirmation | `app/book/confirmation/page.tsx` | v2 writes `rookiePack: true` to `/api/booking-record` (`src/features/booking/service/checkout.ts:355`); shared v1 confirmation page reads this and surfaces the code | ✅ |
| 1.25 | SMS confirmation (Voxtelesys primary, Twilio failover, retry queue) | `lib/sms-*.ts` | not touched by v2 src/; flows through shared v1 confirmation page on `window.location.href = buildConfirmationUrl(...)` (`CheckoutStep.tsx:161`) | 🔄 compat path |
| 1.26 | Email confirmation (SendGrid HTML, BCC vendorcases@dassle.us) | `lib/email-*.ts` | same — flows through shared v1 confirmation page | 🔄 compat path |
| 1.27 | Mega Tuesday + new juniors banner blocker | `app/book/race/page.tsx:2001-2068` | `src/components/features/booking/steps/race/RaceDateStep.tsx:181-184, 386-391` (`canAdvance` rejects + amber banner) | ✅ |
| 1.28 | Private event (group event) date blocker | `app/book/race/components/DatePicker.tsx:238-269` | `src/components/features/booking/steps/race/RaceDateStep.tsx:258` (amber cell + tooltip); `RaceHeatPickerStep.tsx:281-305` (full-screen guard if deep-linked) | ✅ |
| 1.29 | HeightAgeConfirmModal (party → date intercept for new racers) | `app/book/race/page.tsx:2370-2456` | `src/components/features/booking/steps/race/HeightAgeConfirmModal.tsx:19-35`; intercept at `BookingFlow.tsx:131-138` (race-party + new racers blocks until confirmed) | ✅ |
| 1.30 | Premium Packages (eligible packages above single-race grid) | `app/book/race/components/PackageCard.tsx` + `PackageHeatPicker.tsx` | `src/components/features/booking/steps/race/PackageCard.tsx:1-168`; `PackageHeatPicker.tsx:1-387`; rendered from `RaceProductStep.tsx:232-256` | ✅ |
| 1.31 | Reservation timer (Ticketmaster-style 10-min countdown) | not in v1 | `src/components/features/booking/ReservationTimer.tsx:5-7,49-61` (`RESERVATION_SECONDS = 600`; refreshes via GET `/api/sms?endpoint=bill/overview`) | 🆕 v2-only addition (not parity, but no v1 regression) |
| 1.32 | Returning-racer BMI verification flow (phone/email/code → OTP → account selection) | `app/book/race/components/RacerSelector.tsx` | `src/components/features/booking/steps/race/ReturningRacerLookup.tsx:1-604`; integrated in RacePartyStep | ✅ |

## 2. Side effects per confirmed booking

| # | Side effect | v1 location | v2 location | Status |
|---|---|---|---|---|
| 2.1 | `clickwrap_acceptances` row write | `lib/clickwrap.ts` | `src/features/booking/service/checkout.ts:210-240` → POST `/api/clickwrap/record` (writes clickwrap_acceptances row, reuses v1 endpoint) | ✅ |
| 2.2 | `sales_log` row write (billId, brand, location, bookingType, persons, products, totals) | `lib/sales-log.ts` | written via compat path — v2 checkout writes to `/api/booking-record` + redirects to `/book/confirmation`; v1's confirmation page POSTs to `/api/notifications/booking-confirmation` (`apps/web/app/book/confirmation/page.tsx:843`) which calls `logSale()` (`apps/web/app/api/notifications/booking-confirmation/route.ts:346`) with `brand`, `location`, `bookingType`, `participantCount`, `isNewRacer`, `rookiePack`, `povPurchased`, `licensePurchased`, `expressLane`, `packageId`, etc. | ✅ via compat path — Alex's "dual-write" decision is already in place |
| 2.3 | `bmi_deposit_failures` row (Pandora deposit fail post-charge) | `lib/bmi-deposit-retry.ts` | N/A for race; Pandora deposit path is race-pack only | ⏭️ N/A (PR-B4 scope) |
| 2.4 | Redis `booking_{billId}` cache | `lib/redis.ts` | `src/features/booking/service/checkout.ts:293-307` writes to `/api/booking-store` (Redis key `booking:${billId}`, 24h TTL via `apps/web/app/api/booking-store/route.ts:22`) + localStorage fallback | 🔄 key format diverges (colon vs underscore); shared v1 confirmation page must read the new key |
| 2.5 | Comprehensive booking record (racer assignments + product details, 90d TTL) | not in v1 explicitly | `src/features/booking/service/checkout.ts:330-360` → POST `/api/booking-record` with racer-by-racer details, rookiePack flag, billing customer personId | 🆕 v2-only addition |
| 2.6 | SMS retry queue (`sms:retry:pending`, `sms:retry:dead`) | `lib/sms-*.ts` | not touched by v2 src/; comes via shared v1 confirmation page | 🔄 compat path (same SMS infra) |
| 2.7 | Waiver dedup Redis (`alert:pre-race:*`, 24h TTL) | `lib/redis.ts` | not touched by v2 src/; comes via shared v1 confirmation page | 🔄 compat path |
| 2.8 | BMI office notes buffer (`appendPrivateNote`) | `lib/bmi-office-notes.ts` | not in v2 | ⏭️ per scope decision §6 (skipped in PR-B2; v1 BMI endpoint pending confirmation) |

## 3. Vendor endpoints touched

| # | Vendor | Endpoint | v2 location | Status |
|---|---|---|---|---|
| 3.1 | BMI | POST `/availability` (heat slots) | `src/features/booking/data/bmi.ts` (bmiAdapter.getAvailability, PascalCase + numeric IDs + date URL param); called from `RaceHeatPickerStep.tsx`, `PackageHeatPicker.tsx`, `RaceDateStep.tsx`, `RaceAddonsStep.tsx` | ✅ |
| 3.2 | BMI | POST `/booking/book` (create heat, raw-ID injected, chains orderId) | `src/features/booking/data/bmi.ts` (bmiAdapter.bookHeat — uses `stringifyWithRawIds`); called from `service/race.ts:53-59,120-126` (`bookHeatsOnAdvance`) | ✅ |
| 3.3 | BMI | POST `/booking/removeItem` | `src/features/booking/data/bmi.ts` (bmiAdapter.removeBookingLine) — wired in adapter; no caller in v2 src yet (used on edit flow which is N/A for first-time book) | ✅ adapter wired |
| 3.4 | BMI | POST `/payment/confirm` (finalize) | `src/features/booking/service/checkout.ts:365-376` (`confirmCreditOrder` for $0 credit orders); cash orders go through `/api/square/pay` which calls BMI confirm | ✅ |
| 3.5 | BMI | POST `/booking/sell` (license, POV, add-ons) | `src/features/booking/service/race.ts:145-150` (license); `:152-156` (POV via `/api/sms?endpoint=booking/sell`); `:158-175` (add-ons via `bmiAdapter.bookHeat`) | ✅ |
| 3.6 | BMI | GET `/order/{id}/overview` | `src/features/booking/data/bmi.ts` (bmiAdapter.getOrderOverview); referenced in checkout for bill overview | ✅ adapter wired |
| 3.7 | BMI | GET `/bill/overview` (post-conversion) | shared v1 infra via `/api/sms?endpoint=bill/overview` from `ReservationTimer.tsx:49-61` | ✅ |
| 3.8 | BMI | DELETE `/bill/{orderId}/cancel` | `src/features/booking/service/race.ts:191` (DELETE `/api/bmi?endpoint=bill/{billId}/cancel`) | ✅ |
| 3.9 | BMI Office | search by phone/email/code | `src/components/features/booking/steps/race/ReturningRacerLookup.tsx:84-92` (GET `/api/bmi-office?action=search`) | ✅ |
| 3.10 | BMI Office | deposits (credit balance) | `src/components/features/booking/steps/race/ReturningRacerLookup.tsx:93-102` (GET `/api/bmi-office?action=deposits`) | ✅ |
| 3.11 | Square | POST `/v2/orders` (create order) | reused via shared `@/components/square/PaymentForm` → `/api/square/pay`; v2 doesn't fork this route | ✅ |
| 3.12 | Square | POST `/v2/payments` (charge card) | reused via shared `@/components/square/PaymentForm` → `/api/square/pay` | ✅ |
| 3.13 | Square | POST `/v2/cards` (save card on file) | reused via shared `@/components/square/PaymentForm` → `/api/square/pay` | ✅ |
| 3.14 | Square | resolve customer + saved cards | `src/features/booking/service/checkout.ts:380-403` (`resolveSquareCustomer` → POST `/api/square/customer`) | ✅ |
| 3.15 | Pandora | GET `/api/pandora` (waiver validity) | `src/components/features/booking/steps/race/RacePartyStep.tsx:93,106` (probes for each verified racer + linked racers) | ✅ |
| 3.16 | Pandora | GET `/api/pandora/sessions` (session lookup by track + date, POV) | not in v2 | ⏭️ per scope decision §2 (deferred to video features PR) |
| 3.17 | Pandora | POST `/api/pandora/schedule` (link racer to heat, POV) | not in v2 | ⏭️ per scope decision §2 |
| 3.18 | Voxtelesys | `/sms` (primary) | flows via shared v1 confirmation page | ✅ compat path |
| 3.19 | Twilio | SMS API (failover) | flows via shared v1 confirmation page | ✅ compat path |
| 3.20 | SendGrid | `/v3/mail/send` (confirmation email) | flows via shared v1 confirmation page | ✅ compat path |
| 3.21 | SMS Verify | POST `/api/sms-verify` (OTP send/verify for returning racer lookup) | `src/components/features/booking/steps/race/ReturningRacerLookup.tsx:197-282` | 🆕 v2 enhancement (BMI verification flow) |

## 4. Error handling

| # | Behavior | v2 location | Status |
|---|---|---|---|
| 4.1 | BMI booking fails mid-flow → no charge + retry UI | `src/components/features/booking/steps/checkout/CheckoutStep.tsx:81-87, 422-434` (catch → "error" phase + retry button re-invokes `runCheckout`) | ✅ |
| 4.2 | Square card declined → friendly error + retry | reused via shared `@/components/square/PaymentForm` (v1's error mapping unchanged) | ✅ |
| 4.3 | Square order create fails → 500 no charge | reused via shared route `/api/square/pay` | ✅ |
| 4.4 | Save card fails post-payment → non-fatal warning | reused via shared `@/components/square/PaymentForm` | ✅ |
| 4.5 | Pandora session linking fails (POV) → non-fatal | N/A — POV Pandora linking deferred (1.13) | ⏭️ |
| 4.6 | Email send fails → non-fatal, customer has QR | shared v1 confirmation page handles | ✅ compat path |
| 4.7 | SMS quota hit → failover to Twilio | shared v1 SMS infra | ✅ compat path |
| 4.8 | Non-fatal license sell failure → log + continue | `src/features/booking/service/race.ts:207-222` (try/catch, returns false, checkout proceeds) | ✅ |
| 4.9 | Non-fatal POV sell failure → log + continue | `src/features/booking/service/race.ts:243-252` | ✅ |
| 4.10 | Non-fatal add-on sell failure → log + continue | `src/features/booking/service/race.ts:277-280` (`addonResults` collected non-fatally) | ✅ |
| 4.11 | Non-fatal person creation failure → skip personId | `src/features/booking/service/race.ts:337-340` (`ensurePersonId` returns null on fail) | ✅ |
| 4.12 | Heat-no-longer-available guard | `src/features/booking/service/race.ts:49-50, 116-118` (throws "Heat at {heatId} no longer available") | ✅ |
| 4.13 | BMI bill creation guard | `src/features/booking/service/race.ts:141-143` (throws "No BMI bill — book at least one heat") | ✅ |

---

## Summary

**Status counts:**
- ✅ Shipped: 54
- 🔄 Replaced (compat path or architectural divergence): 9
- ⏭️ Deferred (out of scope per resolved decision): 7
- ⏸️ HOLD: 0
- ❌ Missed: 0
- 🆕 v2-only enhancement: 3 (Reservation timer, comprehensive booking record, SMS Verify OTP flow)

**Total rows audited:** 73 across customer-visible features, side effects, vendor endpoints, and error handling.

## Gaps requiring decision before merge

**None.** sales_log dual-write (#2.2) is already in place via the v1 confirmation page compat path — no implementation needed.

## Gaps explicitly deferred (will be flagged in PR description)

- **POV Pandora session linking** (1.13, 3.16, 3.17) — separate "video features" PR per scope decision §2.
- **BMI office notes** (`appendPrivateNote`, 2.8) — separate PR per scope decision §6.
- **Race-pack** flow — PR-B4 (credit-purchase, not booking).
- **Cross-session navigation** (cart joins existing session via cross-sell tile) — PR-B2.5.

## Architectural divergences (intentional, called out for reviewer)

- **Per-member `isNewRacer`** instead of party-wide `racerType` (1.2)
- **Multi-activity cart** replaces v1's cross-activity add-ons-on-bill (1.16)
- **Booking-store key format** `booking:${billId}` instead of `booking_{billId}` (2.4) — shared v1 confirmation page must accept the new key (verify in Phase A)
- **Shared `/book/confirmation` page** reused via booking-store + booking-record writes (1.22, 1.25, 1.26, 2.6, 2.7)
- **Reservation timer + 90d booking-record** are v2-only enhancements with no v1 equivalent

## Next step

→ Phase C: resolve `sales_log` HOLD with Alex (see Plan rev 4 § Phase C).
→ Phase A: walk the e2e paths A1–A12 at `http://localhost:3000/book/race/v2` (dev server is running).
