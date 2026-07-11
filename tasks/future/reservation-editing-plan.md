# Reservation Editing (Booking v2) — Complete Plan with Testing

**Status:** APPROVED 2026-07-11 (owner). **BUILT 2026-07-11** on branch
`claude/reservation-editing-plan-vvh9ee` — all engine phases + card vault + admin modal +
payment-link page landed (see §16 Implementation status at the bottom for flags, deferred
items, and the live-smoke gate that must run before any flag flips on).
**Related:** [tasks/todo.md § Self-service "edit reservation up to check-in"](../todo.md) — that guest-facing
spec becomes a thin client of this engine once the engine ships (its add-only/re-enter-card constraints
were interim; the engine supersedes them for admin use).

## Context

Staff currently have no way to modify a booked reservation — the admin board's only money action is Cancel (refund/store-credit), and Reschedule is time-only. Real operations need to add/remove players and racers, change lane counts, adjust shoes, and edit combo parties — with the money following: the day-of Square order must be updated, the deposit gift card kept in sync, differences charged or refunded, and QAMF (Conqueror) + BMI (Pandora) kept accurate when possible. Additionally, every booking must quietly retain the guest's card on file so staff can charge edit differences without calling the guest back, with automatic deletion 72h after completed reservations unless the card pre-existed or the guest opted into permanent save.

This document is the approved feature spec; no feature code has been written yet.

## Decisions locked (owner answers, 2026-07-11)

1. **Card-on-file disclosure:** one fine-print line added to the existing checkout terms/clickwrap text. UI flow otherwise unchanged.
2. **Permanent save consent:** optional unchecked checkbox at checkout ("Save this card to my account for faster checkout"). Checked ⇒ never auto-deleted.
3. **Charge fallback when saved card fails/absent:** staff send a **self-hosted payment-difference page** (our own Square Web Payments form, not a Square-generated link). Edit completes when the guest pays.
4. **Mid-session edits (checked in, order OPEN and gift-card-paid, not complete):** **edit the OPEN order in place** — adjust lines, load/refund the gift card by the difference. Not refund-and-rebuild.

## Verified ground truth (from code exploration)

- **Universal reservation table:** `bowling_reservations` (`apps/web/lib/bowling-db.ts`, schema `ensureBowlingSchema()` ~line 41) covers all v2 kinds (`product_kind` ∈ kbf|open|race|attraction) + child tables `bowling_reservation_lines`, `bowling_reservation_players`. Money-group resolver `listCancelGroupReservations` (one deposit/gift card can fund multiple legs — combos, mixed carts).
- **Money model:** deposit charge → internal DIGITAL gift card (custom GAN, blocked for guest use via `isInternalDepositGan`) → lane-open cron pays the day-of order from it (`lib/bowling-lane-open.ts`), order stays OPEN for KDS → `lib/bowling-order-complete.ts` marks COMPLETED. **Invariant: gift-card balance == day-of order tax-inclusive total** (lesson 2026-06-09).
- **Phase markers:** `dayof_order_sent_at` (NULL = pre-lane-open), tenders on the live order, `dayof_order_completed_at` / order `state === "COMPLETED"`.
- **Order-edit precedent:** `app/api/bowling/v2/reservations/[id]/food/route.ts` — charge-diff-FIRST, then sparse `PUT /orders/{id}` with OCC version, hard-fail when `expectedDiffCents !== diff`.
- **Architectural template:** `src/features/cancellation/` — dry-run plan → cascade (audit row → fatal money → Neon commit → best-effort teardown → notify), `reservation_cancel_events` ledger, attempt-bumped idempotency namespaces.
- **QAMF** (`lib/qamf-bowling.ts`): NO time/lane/size mutation. `patchReservation` = Title/Notes/Status only (Title required or 400). `setLanePlayers` (PUT per-lane player list) works. Lane-count/time change = delete→verify→create→confirm via `rescheduleQamfReservation` (`service/qamf-reschedule.ts`), with Neon-unlink-before-delete webhook guard.
- **BMI:** `bmiAdapter` (`src/features/booking/data/bmi.ts`) — `bookHeat` chains onto existing `orderId` (adds work), `removeBookingLine` needs `billLineId` (currently NOT persisted — `raceHeatsMetadata` drops it), `confirmPayment`, `getOrderOverview`. `rebuildRaceBill` (`bmi-rebuild.ts`) = cancel+rebook with dryRun + verify. `cancelBmiProject` (`cancellation/bmi-cancel.ts`) = Office project → stateId −4; the `bmi-cancel-sweep` cron reverts unintentional −4s — gates must be closed per-bill. ALL BMI ids via `@ft/db` raw-id helpers.
- **Pricing mode is implicit:** `isPerLane = exp.kind === "hourly" || slug.startsWith("pizza-bowl")` (`BowlingOfferStep.tsx:238`); primary line qty = base × (laneCount|playerCount) × durationMultiplier. Reservation rows do NOT store experience/laneCount today — only lines + `player_count`.
- **Cards:** `saveCardOnFile` (`src/features/account/data/cards.ts`), save-after-charge via `source_id: paymentId` (`lib/group-function-reprice.ts:144`), charge-saved-card precedent (`app/api/cron/group-balance-charge/route.ts:151`). **DeleteCard/disable + any delayed-deletion job = net-new.** `fetchSavedCards` already filters `enabled === false`.
- **Cron infra:** ~40 Vercel crons (`apps/web/vercel.json`), `lib/cron-auth.ts`, `?dryRun=1&limit=N` convention. Delayed work = cron scanning Neon.
- **Testing:** vitest colocated `*.test.ts`; mocks `src/test/mocks/square.ts`, `data/__fixtures__/{square,bmi}.ts`, `LOCAL_SQUARE_MOCK=1`. Build verify: `npx turbo run build --filter=fasttrax-web`.
- **Prior spec:** `tasks/todo.md` § "Self-service edit reservation" (guest-facing, add-only). THIS feature is the admin-side superset; the self-service spec later becomes a thin client of the same engine.

---

## 1. Architecture — two new feature modules

### `apps/web/src/features/reservation-edit/` (core engine)

```
types.ts          EditSpec (desired END STATE, not delta), EditPlan, EditPhase,
                  EditStep, EditGuardError, EditSettlement, PaymentSourceRef
guards.ts         phase selector + editability guards + combo phase checks
reprice.ts        PURE repricing engine + booked-pricing-mode resolver
plan.ts           buildEditPlan() — live Square facts + orders/calculate + steps + planHash
hash.ts           canonical-JSON sha256 planHash (displayed == executed)
square-actions.ts refundTenderPartial, updateDayofOrderLines (sparse PUT by uid),
                  createEditTopupOrderAndCharge, rebuildDayofOrder, payAndCompleteOrder
qamf-sync.ts      syncQamfPlayers (setLanePlayers + Title/memo re-patch),
                  rebookQamfForLaneChange (availability check + rescheduleQamfReservation)
bmi-sync.ts       addRacerHeats, removeRacerHeats (line-level preferred; cancel+rebook fallback)
service.ts        editReservationCascade() — executor mirroring cancellation/service.ts
notify.ts         updated-confirmation resend + Teams manager alert
index.ts          buildEditPlan, editReservationCascade, EditGuardError
```
Plus `apps/web/lib/reservation-edit-log.ts` (`reservation_edit_events` table) and thin route `apps/web/app/api/admin/reservations/edit/route.ts` (POST, `dryRun`, ADMIN_CAMERA_TOKEN auth). Flag-gated: `RESERVATION_EDIT_V2 === "true"` read at call time (v2 cutover pattern).

### `apps/web/src/features/card-vault/` (saved-card subsystem)

```
data.ts     reservation_saved_cards table + CRUD (lazy CREATE TABLE pattern)
service.ts  captureCardFromDeposit (never throws), chargeSavedCard, getChargeableCard
types.ts / index.ts
```
Plus `disableCard` added next to `saveCardOnFile` in `src/features/account/data/cards.ts`, and cron `app/api/cron/card-vault-sweep/route.ts`.

Both import shared Square primitives from `~/features/cancellation/square-actions` (`sq`, `fetchOrderFacts`, `fetchGiftCardFacts`, `fetchPaymentFacts`) and `lib/square-gift-card.ts` (`loadGiftCard`, `loadBalanceOntoGiftCards`, `drainGiftCard`-style exact decrement, `refundSquarePayment`, `issueStoreCredit` via cancellation).

---

## 2. Data model changes

**New: `reservation_saved_cards`** (in `card-vault/data.ts`, lazy schema):
`id, square_customer_id, square_card_id (NULL while capture pending), card_brand, card_last4, card_exp_month/year, fingerprint, source_reservation_id, source_deposit_order_id (money-group key), source_payment_id UNIQUE, we_added bool, permanent_consent bool, consent_source ('checkout_optin'|'admin'|'preexisting'), capture_attempts/last_error, disabled_at, disable_attempts/last_error, created_at, updated_at`.
No `delete_after` column — due-ness is **computed** by the sweep from live reservation state (handles combo legs completing at different times, cancellations, reschedules automatically).

**New: `reservation_edit_events`** (in `lib/reservation-edit-log.ts`, mirrors `reservation_cancel_events`):
`edit_id UNIQUE ('edit-{anchorId}-a{attempt}'), anchor_reservation_id, leg_ids[], phase ('pre'|'mid'|'post_complete'), spec JSONB, plan JSONB, diff_cents, settlement ('charge'|'card_refund'|'store_credit'|'none'), payment_ids[], refund_ids[], old/new_dayof_order_id, attempt, state ('started'|'pending_payment'|'completed'|'failed'), step_log JSONB, error, actor, created_at, completed_at`.
This is the authoritative money ledger for edits — and the input to cancel-awareness (§4-fine-print).

**Booking-time metadata stamps (PR 0, no behavior change):**
- `booking_metadata.bowling = { experienceSlug, laneCount, durationMultiplier, pricingMode }` stamped at insert in `unified-reserve.ts` / bowling reserve (bowling rows don't use `booking_metadata` today — free).
- `raceHeatsMetadata` (`service/checkout.ts:606`) gains `bmiLineId` per heat (already in-session on `RaceHeatAssignment`, currently dropped) → enables line-level BMI removal.
- New helper `updateReservationAfterEdit` in `bowling-db.ts` (lines/players/player_count/total_cents/deposit_cents in one call).

---

## 3. Edit-plan / dry-run flow (displayed == executed)

`POST /api/admin/reservations/edit` body:
```ts
{ neonId, spec: EditSpec, settlement?: "card_refund" | "store_credit",
  paymentSource?: {kind:"card_on_file",cardId} | {kind:"payment_link"} | {kind:"none"},
  dryRun?: boolean, planHash?: string, notifyGuest?: boolean, managerOverride?: boolean }
```

`buildEditPlan` (read-only; the modal calls it on open and debounced on every form change):
1. Load reservation + money group (`listCancelGroupReservations`).
2. **Phase from LIVE Square facts** (never Neon alone): `pre` = `dayof_order_sent_at IS NULL` AND order OPEN, 0 tenders; `mid` = OPEN with tenders; `post_complete` = COMPLETED. Neon/Square conflict → `EditGuardError("phase_conflict")`.
3. Reprice (§4) → new line set per leg.
4. **Authoritative diff via Square `POST /v2/orders/calculate`** on the would-be order body (same builder + `LOCATION_TAX` as `app/api/square/bowling-orders/route.ts`). `diffCents = calculatedTotal − currentOrderTotal`. This number is displayed AND charged — no client math.
5. Gather gift-card balance/state, deposit tenders + `refunded_money`, prior edit payments; resolve chargeable card via `getChargeableCard(customerId, depositOrderId)`.
6. Emit ordered `EditStep[]` + `warnings[]` (post-complete gets `severity:"manager"`).
7. `planHash = sha256(canonicalJson(...))`. Execution requires the hash, recomputes fresh, 409 `plan_stale` on mismatch — also catches the lane-open cron flipping the phase between preview and click.

---

## 4. Repricing engine (`reprice.ts` — pure)

**Resolve how it was booked:** prefer the PR 0 `booking_metadata.bowling` stamp; fallback for legacy rows: map primary line's product through `bowling_experience_items` (+ duration overrides) → `bowling_experiences` → `isPerLane = kind==="hourly" || slug.startsWith("pizza-bowl")`; derive `durationMultiplier = primaryQty / (isPerLane ? laneCount : playerCount)` with `laneCount = max(1, ceil(playerCount/6))`; non-integral → `EditGuardError("pricing_unresolvable")` (manual path — never guess).

**Recompute:**
- Bowling: primary qty = base × (isPerLane ? newLaneCount : newPlayerCount) × durationMultiplier; secondary items × newLaneCount; shoes from `spec.shoes`; $0 per-lane pass-throughs (pizza/soda) follow laneCount. Unit prices from live `bowling_square_products` EXCEPT lines whose stored `unit_price_cents` differs from catalog (promo/discount) — keep stored price + emit warning (never silently reprice a discounted booking to full).
- KBF: base $0, paid adults via `kbf-pricing.ts`, shoes per person.
- Race: per-heat products via `race-pricing.ts` with weekday/weekend schedule for the visit date.
- Combo: extract a session-independent `comboItemizedLinesForRacers({combo, date, racers})` seam from `combo-pricing.ts` (pure refactor, PR 0) shared by booking and edit — flat per-person cents, license reallocation, per-entity `revenueSplit` grouping → both day-of orders repriced from one seam.

Output is **lines**; money truth is always Square `orders/calculate` on those lines.

---

## 5. Money engine per phase

All Square idempotency keys derive from `editId = edit-{anchorId}-a{attempt}` (attempt = 1 + failed count, `nextCancelAttempt` pattern; longest key ≈ 26 chars < 45-char limit). Every mutation re-fetches its object first; `sq()` already treats 200-with-`errors[]` as failure.

### PRE (order OPEN, no tenders; gift card holds the full deposit)
**Increase (diff > 0):**
1. Audit row (fatal).
2. External capacity growth FIRST (fatal — never charge for lanes/heats we can't get): QAMF rebook / BMI bookHeat (§6).
3. `createEditTopupOrderAndCharge` — small closed Square order ("Reservation Edit — additional deposit", no tax, deposit-order shape) + payment from `paymentSource` (`{editId}-topup-pay`, autocomplete). Payment id persisted on the edit event BEFORE the next step (forward-recovery doctrine). If `paymentSource.kind === "payment_link"` → event goes `pending_payment` and stops here until the guest pays (§7).
4. `loadGiftCard` (`gc-load-{editId}`; `loadBalanceOntoGiftCards` if crossing the $2k/card cap) with `buyerPaymentInstrumentIds: [paymentId]`.
5. Sparse `PUT /orders/{dayof}` (fresh version, uid-preserving updates, `fields_to_clear` for removed lines, key `{editId}-order-{version}`). Verify returned `total_money` == plan's calculated total; mismatch → loud recoverable error (money is on the GC; re-run heals).
6. Neon commit (`updateReservationAfterEdit`).
7. Best-effort tail: QAMF Title/memo re-patch (`buildQamfMemo`), notify, audit finish.

**Decrease (diff < 0), settlement chosen in the modal:**
- `card_refund`: partial refunds newest-first — prior edit top-up payments before the original deposit tenders — via new `refundTenderPartial` (re-fetches payment, clamps to un-refunded remainder, key `{editId}-r{n}`, deterministic allocation).
- `store_credit`: reuse existing `store_credit_gift_card_id` via `loadGiftCard` if present, else `issueStoreCredit` (GAN persisted to Neon before activation — cancel's double-mint protection).
- Sequence: refund FIRST (exactly-once, replayable), then exact-amount `ADJUST_DECREMENT` on the internal GC (`{editId}-dec`, reason `PURCHASE_WAS_REFUNDED`), then order PUT, then Neon, then best-effort external shrink (shrink failures = warnings; excess external capacity is safe). End invariant check: `gcBalance === newOrderTotal`.

### MID (checked in, order OPEN + gift-card-paid, not complete) — **edit in place** (owner decision)
- $0 changes: line-note-preserving PUT (`Lane N |` KDS prefixes kept) + `setLanePlayers` + Neon. No money.
- Increase: food-route pattern generalized — charge diff directly against the day-of order (payment carries `order_id`, autocomplete, key `{editId}-mid-pay`) FIRST, then PUT new lines. Gift card untouched (already spent). New KDS-relevant lines get lane-note prefixes so the kitchen sees additions.
- Decrease: partial refund of the lane-open gift-card payment (`dayof_payment_id`) by |diff| — funds auto-return to the internal GC — then settle to card/store-credit + exact `ADJUST_DECREMENT`, then PUT, then Neon. (Assumption A1 below must be sandbox-verified first; until verified this sub-path ships behind its own sub-flag.)
- Lane-count changes mid-session are refused (`EditGuardError("lane_change_mid_session")`); player add/remove still syncs `setLanePlayers` (QAMF lanes exist/Running). BMI mid-session race edits are refused (session live).

### POST-COMPLETE (order COMPLETED) — refund + rebuild, no QAMF/BMI (owner requirement)
Plan carries `severity:"manager"` warning; UI requires explicit acknowledgment (`managerOverride: true`): **"QAMF and BMI will NOT be updated — session already open/closed there. Adjust Conqueror/BMI manually."** Also fires a Teams webhook card (pattern: `vip-move-alerts`).
1. Audit row.
2. Refund every tender on the completed order in full (`refund-{editId}-t{n}`). Gift-card tender refund auto-credits the internal deposit GC (Assumption A1 — smoke item #1).
3. Old order stays COMPLETED-but-refunded (Square can't reopen). QBO: original sale + refund + new sale all import — net correct, gross/refund noisier that day (noted in warning).
4. Settle diff: gap → saved-card charge + `loadGiftCard`; surplus → card refund or store credit + `ADJUST_DECREMENT`.
5. `rebuildDayofOrder` — NEW order (`{editId}-neworder`), edited lines, location tax, `customer_id`, **no fulfillment** (nothing hits KDS post-session).
6. Pay fully from GC (`{editId}-repay`) → immediately PUT `state: COMPLETED`. Do NOT re-accrue loyalty.
7. Neon: swap `square_dayof_order_id` (old id kept in the edit event + appended to notes), `dayof_payment_id`, re-stamp `dayof_order_completed_at`, lines/players/totals. Re-stamping keeps `reservation-status-close` away.
8. NO QAMF/BMI steps.

### Combo money groups
One GC + one deposit order funds TWO day-of orders (per entity). Reprice both via the combo seam; `orders/calculate` both; diff = Σ new − Σ current; per-order PUT keys. **v1 restriction:** combo edits only while BOTH orders are un-tendered; mixed-phase → `EditGuardError("combo_phase_split")`. Racer add/remove drives BMI heats ×2 legs, QAMF Title + `setLanePlayers`, both orders, flat per-person reprice.

### Cancel-awareness (non-negotiable pairing)
After an edit-increase, deposit money is split across the original deposit order AND edit top-up orders. `cancellation/plan.ts` must be extended (same PR as edit decreases) to load `reservation_edit_events` completed payments into the refunds-needed set — otherwise a later cancel under-refunds.

---

## 6. External sync

**QAMF (`qamf-sync.ts`):**
- Player change, same lane count → true PATCH path: `setLanePlayers` per lane (names/shoes/bumpers from `bowling_reservation_players`), then `patchReservation({Title: "<name> (Np)", Notes: buildQamfMemo(...)})` — Title required or 400.
- Lane-count change → `rebookQamfForLaneChange`: `searchAvailability` for same `bookedAt` + new TotalPlayers (fatal guard), then `rescheduleQamfReservation` (Neon-unlink-before-delete, delete→verify→delete, create, confirm). PRE phase only.
- Hoist `CENTER_CODE_TO_QAMF` out of the reschedule route into a shared constants module (now needed in 3 places).

**BMI (`bmi-sync.ts`)** — line-level first, full cancel+rebook only as fallback (full cancel is risky: sweep races, W-number churn):
- **Add racer/heats:** `getAvailability` → match proposals (export `findProposalForHeat` from `bmi-rebuild.ts`) → `bookHeat({orderId: bmiBillId, ...})` (chains onto the existing bill) → `registerProjectPerson` for new racers → `confirmPayment` $0 re-confirm → Pandora state −3. Lesson compliance: re-fetch `getOrderOverview` BEFORE any charge (auto-cancel-pending check) and verify-after (line/heat match). Update `booking_metadata.heats` + racer names.
- **Remove racer/heats:** (a) line-level `removeBookingLine({orderId, billLineId})` when `bmiLineId` stamped (post-PR-0 rows) + $0 re-confirm + verify-after; (b) legacy rows: cancel+rebook via `cancelBmiProject` + `rebuildRaceBill`, closing sweep gates for the OLD bill only (`markBookingRecordCancelled({bmiBillId: oldBillId})` before the −4; fresh record for the new bill). Ship (a) first; (b) behind a sub-flag until live-verified — legacy rows without it show "remove not available — use cancel & rebook".
- All ids through `@ft/db` raw-id helpers; never `Number()`/`JSON.parse`.

---

## 7. Card vault subsystem

### Capture (silent, at booking)
`captureCardFromDeposit({squareCustomerId, paymentId, reservationId, depositOrderId, baseKey, sourceKind, permanentConsent})` — **never throws, never fails the booking**:
1. Skip when `sourceKind !== "card"` (wallets aren't storable as cards — client tags the source; `PaymentForm.tsx` already distinguishes card/wallet/saved paths) or gift-card-only tender. `sourceKind === "saved"` (guest used `SavedCardSelector`, `ccof:` id) → record row `we_added=false, consent_source='preexisting'`.
2. `GET /payments/{id}` → `card_details.card` (fingerprint/brand/last4/exp).
3. Dedupe against `fetchSavedCards(customerId)`: fingerprint match, else brand+last4+exp fallback (Assumption A2). Match → row with existing card id, `we_added=false`.
4. No match → CreateCard `source_id: paymentId`, key `cof-${baseKey}` (20 chars). Record provenance (`we_added=true`, consent from the checkout checkbox).
5. Failure → `recordCaptureFailure` row; the sweep retries (≤5 attempts).

Call sites (all three deposit-charge paths, after reservation rows exist): `app/api/bowling/v2/reserve/route.ts`, `app/api/booking/v2/reserve/route.ts` (~line 585), `unified-reserve.ts` end of fan-out. Client plumbing: `PaymentForm.tsx` tags `sourceKind`; `CheckoutStep.tsx` forwards it + the opt-in flag through `ReserveParams` and the three route schemas — satisfies the "every payment entry point rides the same rail" lesson in one PR.

### Consent
- Default: silent save, `permanent_consent=false` → auto-disable ≥72h after the whole money group is terminal.
- Checkout checkbox (unchecked, card section only) ⇒ `permanent_consent=true, consent_source='checkout_optin'`; these guests get `SavedCardSelector` on future checkouts for free.
- Fine-print line appended to the clickwrap text already recorded in `CheckoutStep.tsx`: *"Your payment card may be securely retained by our payment processor to cover approved changes to your reservation, and is removed within 72 hours after your visit unless you choose to save it."*

### Deletion — `disableCard` + `card-vault-sweep` cron (hourly, `"15 * * * *"`)
- `disableCard(cardId)` → `POST /cards/{id}/disable`; "already disabled" errors map to success.
- Phase 1: retry pending captures from `source_payment_id` (same `cof-` key → replay-safe).
- Phase 2: disable due cards — `we_added AND NOT permanent_consent AND disabled_at IS NULL AND attempts < 8` AND entire source money group terminal (no leg outside `cancelled|completed|no-show-terminal` — confirm exact status set against `reservation-status-close`) AND latest terminal timestamp < now−72h AND the customer has NO other live reservation (its edit may still need the card) AND no other permanent row points at the same card id. Each disable → `markDisabled` + `recordAdminAction("card_vault_disable")`; failures bump attempts. Cancelled reservations flow through the same rule (~72h after cancellation).
- `dryRun=1` + `limit` params per cron convention.

### Charge surface for the edit engine
`chargeSavedCard({squareCustomerId, cardId, amountCents, locationId, orderId?, note, idempotencyKey})` — POST /payments with `source_id: cardId` + `customer_id` + autocomplete (modeled on `group-balance-charge`); throws `SquarePaymentError` mapped through `FRIENDLY_PAYMENT_ERRORS`. Plus `getChargeableCard(customerId, depositOrderId)` for the dry-run to display which card will be hit. COF charges are merchant-initiated — no CVV/SCA in US market.

### Self-hosted payment-difference page (owner decision #3)
- Page `app/pay/edit/[editId]/page.tsx` (public, tokenized link — unguessable editId + short-lived signed token; shared-route middleware check per the `isSharedTopLevelRoute` rule). Renders the edit summary (old→new, amount due) + the existing custom Square `PaymentForm` (`components/square/PaymentForm.tsx`).
- Flow: staff choose "Send payment link" in the modal when the saved card is absent/declined → edit event goes `pending_payment` (external capacity NOT yet grown, or grown-and-held — see step ordering: for payment-link edits, capacity growth is deferred until payment lands to avoid holding unpaid capacity; the dry-run re-validates availability at pay time) → SMS/email the link (existing resend/notify machinery) → guest pays on our page (`POST /api/edit-payments/[editId]` completes the cascade: verify plan freshness, charge, then run the remaining steps) → confirmation.
- Links expire (24h or event-time-minus-1h, whichever first); expiry voids the event (`failed`, reason `link_expired`). The payment made here also flows through `captureCardFromDeposit` (card gets vaulted for next time).

---

## 8. Admin UI (reservation admin board + popup modal)

### `EditReservationModal` (`src/components/features/reservations-admin/modals/EditReservationModal.tsx`)
Cloned structurally from `CancelModal.tsx` (ModalShell, phase machine `loading → edit → quoting → review → busy → success | blocked | error`). Single form + live quote panel (no stepper — staff speed, dry-run response IS the review surface):
- On mount: dry-run with empty spec → current editable state + gate check (409 → blocked view).
- Form sections (conditional on `productKind`): players/racers add–remove with names; lane count; shoes per player; combo party changes. Initial values from `useReservationDetail` lines/players.
- Debounced (~500ms) dry-run → old→new line diff table + delta chip:
  - **delta > 0:** "Will charge {BRAND} •{last4} on file: ${…} → added to the reservation deposit"; no card → offer "Send payment link" (self-hosted page) as the action.
  - **delta < 0:** CancelModal's `pickRow` pattern — "Refund to original card" vs "HeadPinz FastTrax Gift Card"; Execute disabled until chosen.
  - **delta = 0:** plain confirm.
- **Post-complete:** red banner + required "I understand" checkbox gating Execute ("Day-of order already closed — QAMF/BMI will NOT be updated. Handle center systems manually.").
- Execute: POST with planHash; success shows what happened (charged/refunded/GAN + copy, link-sent state); declined card → friendly error + "Send payment link" / retry; 409 → blocked/stale.
- Wire-in: extend `ManageReservationModal.tsx` `action` union with `"edit"`, amber "Edit…" button in the action bar; gating `status !== "cancelled"` (dry-run is the real authority). Done → existing `mutated()` → `refetch()` + board reload.
- Hook `useEditPlan.ts` colocated in `modals/` — plain fetch + useState with debounce + alive-ref discipline (matches `useReservationDetail.ts`; the admin board does NOT use React Query).

### Payments tab
Extend `getPaymentTimeline` (`reservations-admin/service.ts`) with `savedCard: {brand, last4, weAdded, permanentConsent, disabledAt} | null`; `PaymentsTab.tsx` renders "Card on file: VISA •4242 — temporary, auto-removes ~72h after visit / saved permanently / removed {date}". Optional v1.1: admin "mark permanent" toggle (`grantPermanentConsent`, `consent_source='admin'`).

---

## 9. Concurrency, idempotency, audit, notifications

- Redis NX lock `edit:lock:{anchorId}` (EX 120); cross-check no `reservation_cancel_events` row in `started` for the group (edit and cancel are mutually exclusive in flight).
- Lane-open cron race: planHash covers phase; inside the lock, re-fetch the day-of order immediately before money moves and re-derive phase — mismatch → `plan_stale` 409 before any money. Lane-open itself is safe in both interleavings (its Neon write is conditional; its payment caps at `net_amount_due`).
- Keys: ≤45 chars by construction; burned keys handled by attempt bump; 200-with-errors[] = failure.
- Audit: `reservation_edit_events` (money ledger) + `recordAdminAction` with new `AdminActionKind` `"edit"` (+ `"card_vault_disable"`); History tab merges via new `listEditEventsByAnchors` (same pattern as cancel events).
- Notifications: optional `notifyGuest` resend of an updated confirmation (reuse resend machinery); Square sends charge/refund receipts automatically; post-complete edits fire the Teams manager card.

---

## 10. Easy-win extra edit types (mostly existing machinery)

| Edit | Mechanism | Cost |
|---|---|---|
| Pizza toppings / soda | existing food PATCH route, surfaced in modal | trivial |
| Date/time reschedule | existing `/api/admin/bowling/reservations/reschedule` — link from Edit UI | none |
| Guest contact / notes | already exist | none |
| Player names / shoes sizes / bumpers (no count change) | `upsertReservationPlayer` + `syncQamfPlayers` + note PUT; $0, all phases | small (PR 3) |
| Attraction qty change | `attraction_bookings` JSONB already persists `bmiOrderId`/`bmiBillLineId` → line-level BMI edit + money engine | small (PR 9) |
| Duration change (1.5h ↔ 2h) | `bowling_experience_duration_options` reprice + QAMF rebook with new Time optionId | medium (PR 9) |

## 11. Gaps in the original ask (now covered by this plan)

1. **Cancel-after-edit correctness** — cancel plan must learn about edit top-up payments (§5) or later cancels under-refund.
2. **Waivers** — added bowlers/racers may need waivers; edit success message reminds staff; racer add reuses `registerProjectPerson` (waiver status surfaces via existing Pandora person read).
3. **Race heat capacity** — adding a racer can hit `freeSpots: 0`; the dry-run surfaces per-heat availability; v1 refuses (staff pick another heat via a follow-up edit) rather than auto-moving heats.
4. **Discounted/promo bookings** — repricing keeps stored below-catalog unit prices + warns; never silently reprices to full.
5. **KDS** — mid-session additions keep `Lane N |` note prefixes; post-complete rebuild carries NO fulfillment so nothing prints after the session.
6. **Loyalty** — never re-accrued on rebuilt orders; cancel-path reward deletion untouched.
7. **QBO noise** on post-complete rebuild (sale + refund + new sale) — net correct; flagged in the manager warning.
8. **Deposit ≠ 100% rows** — guard asserts the gc==total invariant shape before executing; partial-deposit rows → manual path until confirmed nonexistent.
9. **Compliance** — fine-print consent line (owner-approved).
10. **Edit-vs-cancel-vs-cron mutual exclusion** — locks + live-phase re-check.

## 12. PR breakdown (each independently shippable; engine flag-gated)

- **PR 0 — metadata prep (no behavior change):** `booking_metadata.bowling` stamp; `bmiLineId` in `raceHeatsMetadata`; `comboItemizedLinesForRacers` seam extraction (existing combo tests must pass unchanged); hoist `CENTER_CODE_TO_QAMF`.
- **PR 1 — card vault capture:** `card-vault/{data,service}` capture + provenance, `disableCard`, client `sourceKind`/opt-in plumbing across all three reserve paths + fine-print line, mocks + tests.
- **PR 2 — card-vault-sweep cron** + PaymentsTab card status.
- **PR 3 — edit engine pure core:** `types/guards/reprice/hash` + exhaustive unit tests (no routes, no side effects).
- **PR 4 — plan + dry-run API:** `plan.ts`, `reservation-edit-log.ts`, `POST /api/admin/reservations/edit` dryRun-only (execute 501 behind flag). Pins the UI contract.
- **PR 5 — EditReservationModal** (dry-run rendering, all delta states, post-complete gate) against the dry-run API.
- **PR 6 — PRE-phase execution, bowling/KBF increases:** top-up order + `chargeSavedCard`, GC load, order PUT, `syncQamfPlayers` + `rebookQamfForLaneChange`, Neon, audit, notify. Flag `RESERVATION_EDIT_V2`.
- **PR 7 — PRE-phase decreases + cancel-awareness** (ships atomically with `cancellation/plan.ts` extension): `refundTenderPartial`, exact `ADJUST_DECREMENT`, store-credit settlement.
- **PR 8 — self-hosted payment-difference page** + `pending_payment` lifecycle + link expiry.
- **PR 9 — race leg edits (BMI):** add path + line-level remove; cancel+rebook fallback behind sub-flag until live-verified.
- **PR 10 — combo edits** (dual-order, phase restriction).
- **PR 11 — MID phase in-place** ($0 + increases; decreases behind sub-flag until A1 verified).
- **PR 12 — POST-COMPLETE refund + rebuild** + manager gate + Teams alert.
- **PR 13 — easy wins** (duration, attraction qty, food surfacing).

Rollout per v2 cutover pattern: deploy flag-off → enable for one ops user → admins → on. (Admin-only feature — no public canary needed.)

## 13. Testing plan

**Unit (vitest, colocated):**
- `reprice.test.ts` — per-lane vs per-person resolution (stamped + legacy fallback + ambiguous rejection), duration multipliers, shoes, KBF paid adults, combo per-person with license reallocation + weekend pricing, discounted-line preservation.
- `guards.test.ts` — phase matrix (`sent_at` × tenders × `completed_at` × status), combo split-phase, mid-session lane-change refusal, phase_conflict.
- `hash.test.ts` — stability, key-order independence, drift detection.
- `plan.test.ts` — step ordering per phase/settlement, warning emission, chargeable-card resolution.
- `square-actions.test.ts` (edit) — partial-refund clamping, refund allocation order (top-ups before deposit tenders), $2k GC overflow, key-length assertions.
- `service.test.ts` — crash-resume replay at every step index; exactly-once via mocked idempotency; pending_payment resume.
- `card-vault/service.test.ts` — skip matrix (wallet/gift-card-only/$0/saved), fingerprint + fallback dedupe, CreateCard failure never throws, `chargeSavedCard` decline codes → `SquarePaymentError`.
- `card-vault/data.test.ts` — pure `isDueForDisable` predicate: mixed-terminal combo legs, <72h, >72h, cancelled-only, permanent consent, `we_added=false`, other live reservation deferral, attempts exhausted.

**Component (RTL, mocked fetch):** `EditReservationModal.test.tsx` — line diff render; delta>0 card notice / no-card payment-link CTA; delta<0 destination gating; post-complete banner + checkbox gate; 409 blocked; declined→fallback; success summary. `PaymentsTab` card-status states.

**Integration (mocked Square/QAMF/BMI; extend `src/test/mocks/square.ts` with payments/cards/calculate/gift-card-activity routes; `LOCAL_SQUARE_MOCK=1` + BMI fixtures):** full execute per phase (increase, decrease-card, decrease-store-credit, post-complete rebuild, combo dual-order); reserve-path tests asserting booking succeeds when CreateCard fails; cron test (`card-vault-sweep` dryRun counts, disable success/failure/already-disabled, limit).

**Route tests:** dry-run determinism (2× → same hash), planHash 409, phase-flip 409, auth.

**Live smoke checklist (Square sandbox + QAMF staging; every money path `?dryRun=1` first):**
1. **A1 first:** refund a gift-card-tendered payment → verify funds auto-return to the source internal-GAN card.
2. Card checkout → card on Square customer; check `fingerprint` population (A2); rebook same card → no duplicate.
3. Wallet checkout → no card saved, booking unaffected; gift-card-only → no card saved; opt-in → sweep excludes.
4. Sweep dry-run → correct due list; live → card disabled in dashboard, gone from `fetchSavedCards`, audit row.
5. PRE add player (per-person exp) → saved card charged once, GC == order total, QAMF lanes show player, double-submit no-ops.
6. Pizza-bowl (per-lane) lane increase → QAMF rebook same time verified in Conqueror.
7. PRE decrease → partial refund correct; then CANCEL same reservation → remaining refund correct (cancel-awareness).
8. Payment-link path: no-card edit → link → pay on self-hosted page → edit completes; expired link voids.
9. Combo add racer → both day-of orders updated, BMI bill +2 heats/racer, W-number stable, sweep doesn't revert within 10 min.
10. MID add item → order updated in place, KDS ticket prints with lane prefix, GC untouched.
11. POST-COMPLETE edit → old order refunded, new order completed, no KDS ticket, Teams alert fired, QBO import sane next day.
12. Build: `npx turbo run build --filter=fasttrax-web`.

## 14. Assumptions to verify (before the dependent PR merges)

- **A1:** Square refunds of gift-card tenders auto-credit the source card, including internal custom-GAN cards (gates PR 11 decreases + PR 12). Fallback: manual `ADJUST_INCREMENT` after refund.
- **A2:** `Card.fingerprint` populated at Square-Version 2024-12-18 (else brand+last4+exp dedupe; worst case = duplicate card the sweep deletes anyway).
- **A3:** `orders/calculate` tax math matches order-create exactly under our `LOCATION_TAX` scope.
- **A4:** QAMF `setLanePlayers` doesn't reset lane pricing/state in Conqueror when lists change (staging probe; if it does, player-count changes also take the rebook path).
- **A5:** BMI cancel+rebook old-bill-only sweep-gate approach (staging trial before enabling the legacy-row fallback).
- **A6:** No live bowling/KBF rows carry partial (`deposit_pct < 100`) deposits (else invariant becomes deposit-share and lane-open gap-comp interplay re-checked).

## 15. Kickoff notes

- Start at **PR 0** (§12) — pure metadata prep, zero behavior change, unblocks everything else.
- Before PR 11/12 merge, run smoke item #1 (Assumption A1: gift-card tender refund auto-credits the source internal-GAN card) in the Square sandbox — the post-complete and mid-decrease designs rest on it.
- Update `tasks/todo.md` (move this from future → in-flight) when implementation begins.

## 16. Implementation status (2026-07-11, branch claude/reservation-editing-plan-vvh9ee)

**Everything ships FLAG-OFF.** Dry-run (the modal's preview) works with no flags; execution
gates:

| Flag | Unlocks | Gate before enabling |
| --- | --- | --- |
| `RESERVATION_EDIT_V2` | master switch — PRE-phase bowling/KBF edits (increases via card-on-file / payment link; decreases to card or store credit) + MID increases | smoke items 5–8 (§13) |
| `RESERVATION_EDIT_V2_RACE` | BMI race-leg add/remove heats (line-level, existing bill) + combo racer edits | smoke item 9 + staging BMI trial |
| `RESERVATION_EDIT_V2_MID_DECREASE` | mid-session refunds | **Assumption A1 sandbox proof first** |
| `RESERVATION_EDIT_V2_POST` | post-complete refund→rebuild→repay→complete + Teams manager alert | **A1 proof** + smoke item 11 |

**Landed:** PR 0 metadata prep; card vault capture + `card-vault-sweep` cron + PaymentsTab
status + checkout opt-in + clickwrap fine print (policy v3-2026-07-11); engine pure core
(guards/reprice/hash, 53 tests); `reservation_edit_events` ledger; `buildEditPlan` dry-run with
Square `orders/calculate` diffs + planHash seal; executor with Redis lock, in-lock freshness
re-check, forward recovery, refund allocation (edit top-ups before deposit tenders);
QAMF `setLanePlayers` sync + availability-guarded lane-count rebook; BMI line-level heat
add/remove with $0 re-confirm + Pandora −3 + verify-after; cancel-awareness in
`cancellation/plan.ts`; self-hosted payment-difference page (`/pay/edit/{editId}`, HMAC token,
24h/1h-before-event expiry, resume-same-attempt semantics); post-complete Teams alert;
`EditReservationModal` + ManageReservationModal wire-in. ~150 new unit tests.

**Deferred (not built):** PR 13 easy wins (duration change, attraction qty); automatic guest
confirmation resend after an edit (modal surfaces a "resend manually" reminder); refined combo
removal matching (combo racer REMOVE falls back to guard refusal when order lines don't match
exactly); admin "mark permanent" card toggle (data fn `grantPermanentConsent` ships ready).

**Env additions:** `EDIT_PAY_LINK_SECRET` (payment-link HMAC; falls back to ADMIN_CAMERA_TOKEN),
`EDIT_ALERTS_CHAT_ID` (Teams; falls back to the refund-alerts channel),
`SQUARE_STORE_CREDIT_DISCOUNT_CATALOG_ID` (already a cancel-path env).

**Before ANY flag flips on:** run the §13 live smoke checklist top to bottom (Square sandbox +
QAMF staging). Item 1 (A1) gates MID_DECREASE and POST.
