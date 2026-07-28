# Post-Day-Of Refund Flow — Plan

**Status:** Research complete (2026-07-27), no implementation started. Not yet owner-approved.
**Research basis:** 10-agent workflow — 4 subsystem readers (cancellation, reservation-edit,
day-of charging, refund surfaces), 5 scenario lenses (68 scenarios), 1 adversarial completeness
critic. Plus three owner-authorized live Square probes the same night.

**Goal:** refund money AFTER the day-of order has been charged — the shape today's cancellation
cascade explicitly refuses. Money walks back up the chain it came down:
day-of order → internal gift card → guest's credit card.

---

## 1. Ground truth (live-probed 2026-07-27, treat as fact)

Probes: `apps/web/scripts/gc-refund-probe.mts`, `-followup.mts`, `gc-halfitems-probe.mts`.
Real chain each time: owner's VISA bought a gift card → gift card paid an order → refunds walked
back.

| # | Finding | Consequence |
| - | ------- | ----------- |
| G1 | `POST /v2/refunds` **accepts partial refunds of gift-card-funded payments** (reproduced twice) | The 2026-07-11 "Square refuses partial GC refunds" lesson was a dashboard observation, not an API result. Overturned in `tasks/lessons.md`; Assumption A1 in `reservation-editing-plan.md` §14 amended. |
| G2 | Refunding part of the day-of GC payment **credits the internal gift card automatically** | No manual gift-card surgery on the way back. This is the leg the owner wanted. |
| G3 | The credit lands **asynchronously** — the payment showed `refunded_money` before any REFUND activity appeared on the card | A wait step is mandatory before any decrement. Never deactivate/drain a card with refunds pending. |
| G4 | Refunding the deposit payment does **NOT** auto-remove value from the gift card | The surplus must die by explicit `ADJUST_DECREMENT` or it is double value. This is the one non-automatic step. |
| G5 | Unlinked refunds are **NOT enabled** (`REFUND_ERROR/REFUND_DECLINED` with a fully valid request incl. required `customer_id`) | No refunds to arbitrary cards. Every refund stays payment-linked and capped at what that tender was charged. Square rep Kaitlin Kendall (kkendall@squareup.com) still working it as of 7/24. |

**Not yet probed** (load-bearing, see §9 probe matrix): whether a partial refund raises the source
order's `net_amount_due_money`; whether `UpdateOrder` works on a tendered OPEN order; whether
refunds behave the same on a COMPLETED order (the probe's order stayed OPEN — quick-pay orders
never auto-complete).

---

## 2. Current state

**Works today (pre-payment only):** the PRE-phase decrease path — partial refunds to the guest's
card, or store credit — is live and unflagged.

**Explicitly refused today (not a gap — a deliberate wall):** once the day-of order carries any
tender, cancellation is *triply* blocked:

1. `guardRefundTotal` — internal GC is $0 after paying the day-of order, so it no longer equals the
   unrefunded deposit total → `amount_mismatch` 409 (`cancellation/guards.ts:153-165`).
2. `nothing_to_credit` — store-credit outcome needs a funded GC (`cancellation/plan.ts:193-200`).
3. `guardDayofOrder` — any `tenderCount > 0` → refuse, in both plan-time and execute-time checks
   (`cancellation/guards.ts:104-113`, `plan.ts:214-229`).

**Built but flag-dark:** `RESERVATION_EDIT_V2_MID_DECREASE` (order OPEN mid-session) and
`RESERVATION_EDIT_V2_POST` (order COMPLETED) were specced for exactly this flow and shelved on the
now-overturned A1. Their plan steps and most executors exist. **Finish these; do not build a third
system.** The stale "GC tenders can't be partially refunded" comments at
`reservation-edit/service.ts:155-171`, `reservation-edit/square-actions.ts:78-101`, and
`cancellation/square-actions.ts:115-117` must be corrected in whichever PR relaxes the behavior.

---

## 3. Canonical money flow

Amounts come from `POST /orders/calculate` replayed on the *survivor* lines with the snapshot's
catalog tax + discount refs (`reservation-edit/plan.ts:247-273`) — `refundCents = oldTotal −
newTotal`. **Never** client-side proportional tax math.

```
P0  lock + plan  — Redis edit:lock:{anchorId}, no open cancel event, planHash freshness,
                   startEditEvent ledger row (FATAL: no money moves without the row)
R1  refund the day-of GC payment by refundCents      → auto-credits internal GC (async)
W   WAIT for that refund to reach COMPLETED / the REFUND activity to post   ← NEW STEP
R2  refund the deposit tender(s) by the guest-owed amount   → guest's card
D   ADJUST_DECREMENT the internal GC by the credited amount → kills the surplus
O   update day-of order lines (OPEN only; sparse PUT + fields_to_clear, hard-verify total)
C   Neon commit + recordAdminAction + notification
```

`W` is the single genuinely missing executor. Without it, `adjustGiftCardDown` reads a stale $0
balance, returns 0 without posting, the executor logs the step green, the credit lands 30–90s
later, and the guest keeps both the card refund and the gift-card value —
**silent double value, every time** (`square-actions.ts:141-164`, `service.ts:374-383`).

**Two amounts, not one.** Gap-comped rows (lane-open auto-comps a ≤$2.00 shortfall via
`ADJUST_INCREMENT`, `bowling-lane-open.ts:310-348`) make these diverge legitimately:

- `gcDecrementCents` = the full amount credited back to the internal card (step D)
- `guestOwedCents` = `min(refund share, Σ deposit-tender un-refunded remainders)` (step R2)

Both are first-class plan fields persisted in the ledger, not an error path. Asymmetry beyond
200¢ means unknown manual activity → refuse loudly, move nothing.

---

## 4. Blind spots — prerequisites before any of this ships

The critic verified each against code. These are not polish items; each one bites in week one.

### 4.1 The feature has no input surface (largest unbuilt piece)

`EditSpec` (`reservation-edit/types.ts:54-88`) carries playerCount / laneCount / durationOptionId /
shoes / players / kbf / racers / attractions. **There is no line-item field**, and
`EditReservationModal` has no item picker. Every flagship scenario ("staff removes a $16.05 pizza
line") assumes a capability that does not exist — no spec, no reprice path, no UI. This must be
built: a line-item spec field + modal item picker, or a standalone item-share refund route.

### 4.2 Event identity collides on the second refund

`nextEditAttempt` counts only `state='failed'` rows (`reservation-edit-log.ts:120-128`), so a
*second, unrelated* refund on the same reservation computes attempt = 1 again and reuses
`edit-{id}-a1`. The upsert overwrites plan/spec while keeping old `refund_ids`
(`:150-157`); `-r90` replays with a different amount → Square rejects idempotency reuse; `-dec`
replays the first decrement's stored response; the netting pass then absorbs the *first* refund's
amount against the *second* refund's ask and moves no money while still editing order lines.
**Fix before shipping:** mint ids from a monotonic sequence over all terminal rows, or suffix an
event id.

### 4.3 Concurrency controls don't survive an async-settlement pause

The Redis lock is `EX 180` with no extension (`service.ts:110-117`) — shorter than a settlement
wait can run. `hasOpenEditEvent` is **advisory only** (a warning, `plan.ts:399-405`), filters
`('started','pending_payment')` and a 48h horizon (`reservation-edit-log.ts:327-343`), so a new
`pending_settlement` state would be invisible to it. And `refundAcrossTenders` netting absorbs any
non-completed event's deposit refunds cross-operation (`service.ts:684-701`), so a parked refund's
money gets eaten by an unrelated later decrease. Needs: lock extension/re-acquire, a **hard**
open-event guard including the new state, and per-operation netting scope.

### 4.4 Cross-system hazards

- **QAMF webhook double-refund.** `handleCancellation` (`webhooks/qamf-bowling/route.ts:202-249`)
  marks `status='cancelled'` at :246 **even when the refund throws**, and in the window after the
  step-1 credit lands (GC balance > 0 again) a transient deposit-order fetch failure makes
  `processSquareBowlingRefund` fall back to refunding the **full GC balance**
  (`lib/square-bowling-refund.ts:102,141-146`). A genuine double-refund path. Needs an
  open-refund-event guard in the same PR.
- **Un-charged sibling legs.** Non-combo multi-leg groups have no mixed-phase guard —
  `assertEditable` checks leg phases only when `isCombo` (`guards.ts:104-117`) and `buildEditPlan`
  silently takes `phases[0]` (`plan.ts:430-431`). A decrement can transiently eat a sibling's GC
  share; if a sibling charge cron fires in that window it **burns its deterministic idempotency
  key** and the leg becomes permanently unchargeable. Refuse any group with an un-tendered leg.
- **Store-credit column collision.** `issueEditStoreCredit` writes the same `store_credit_*`
  columns the cancel planner treats as "already issued, reuse, never re-mint"
  (`cancellation/plan.ts:172-183`) — an item refund settled as store credit would later be
  reported as the *cancel's* store credit and strand the rest. Needs distinguishable records.
- **Refund-alerts blind spot.** The watchdog matches rows by `square_deposit_payment_id` OR
  `dayof_payment_id` only (`run.server.ts:85-92`) and **drops** unmatched refunds
  (`detect.ts:67-68` — nothing pages; the defect is *zero monitoring*, not false alarms). Refunds
  against edit top-ups and second-tender payments are invisible. This feature multiplies exactly
  those shapes — extend matching to `reservation_edit_events.payment_ids` in the same PR.

---

## 5. Owner decisions — ANSWERED 2026-07-27

1. **Double-reason journal question → RESOLVED.** The day-of Square refund does **NOT** carry
   `"Refund: Reservation Deposit"` — that string belongs to the deposit/cash leg only, so the
   portal journals exactly one refund per economic event. The day-of leg carries **its own reason,
   supplied by staff in the admin portal** at refund time (free text, required, persisted to the
   ledger with the refund id). No double-count, and the day-of reversal reads in the Square
   dashboard as what it actually is. Precedent for per-domain reasons already exists
   (`"Refund: Group Event Deposit"`, `cron/group-quote-sync/route.ts:230,261`).
2. **Allocation policy across deposit tenders → ACCEPTED as recommended:** edit top-ups
   newest-first → card tenders → guest gift-card tenders. Explicit in the planner, never emergent
   from Square's tender order.
3. **Arbitrary goodwill refunds → OUT of v1.** Deferred; the engine reprices a desired end-state
   and cannot express them. Revisit as its own project.

---

## 6. Scenario matrix

68 scenarios across five lenses. Grouped by disposition.

### 6.1 v1 supported

| Shape | Notes |
| ----- | ----- |
| Single card deposit, mid-session item removal (order OPEN) | The canonical path; already coded in MID-decrease. |
| Multi-tender deposit, card tender covers the owed amount | Works with today's allocator unchanged. |
| Multi-tender where card alone can't cover | Relax `skipGiftCardTender` (legal per G1): card first, then partial refund of the guest's own GC. |
| Guest's own gift card ONLY deposit | Cleanest proof case for G1; refund returns to their gift card. Needs its own notification copy. |
| Wallet (Apple/Google Pay) deposit | Identical to card. Write allocator predicates as `sourceType !== 'GIFT_CARD'`, not `=== 'CARD'`. |
| Vaulted card expired/removed since booking | Payment-linked refunds don't need the vault entry. Encode a `card_refund → store_credit` fallback if the issuing account is closed. |
| Edit top-up on a different card via payment link | Newest-first allocation already coded and correct. |
| COMPLETED order (race, no-show, next-day dispute) | Prefer **money-only** (R1/W/R2/D, no rebuild) over the coded rebuild trio — less QBO noise, refund visible on the payment, no loyalty/discount orphaning. |
| Full-value refund (100% of the order) | Emit R1/W/R2/D and conditionally **omit** rebuild + line update. No code path exists for this today (`plan.ts:1344-1348` rebuilds unconditionally) — must be built. Must NOT set `status='cancelled'`. |
| Store-credit settlement instead of card | Reuse `issueEditStoreCredit`; teach the cancel planner about partially-refunded groups. |
| Gap-comped rows (≤$2 overhang) | Two-amount plan per §3. |
| Kiosk terminal deposit carrying Game Zone extras | Per-tender cap = `min(tender remainder, deposit share)` — never let cumulative refunds exceed the GC-activated amount. |

### 6.2 v1 refuses (typed 409, names the manual path)

Zero-money rows · broken shape (deposit captured, GC never minted — note `plan.ts:1283-1290`
currently only *warns* and silently drops the decrement step; must become fatal here) · VIP combos
and any shared-GC group · `square_dayof_order_id` stored as a JSON array · groups whose value spans
multiple gift cards (>$2k) · groups with an un-charged sibling leg · post-complete rebuilds on
orders with more than one tender · **full refund where `refundCents == remaining order total` on an
OPEN order** → route to the cancel cascade, which this project should extend with a post-payment
plan shape rather than stranding an OPEN order at balance-due.

### 6.3 Known hazards the design must handle

Crash after R1 before O (order stranded OPEN at balance due — `bowling-order-complete.ts:81` skips
it forever, never reaches QBO; needs a resumable "money moved, lines pending" state plus a
watchdog) · crash between R2 and D (the classic double-value window) · FAILED-attempt retry
double-refunding the day-of payment (netting exists only for deposit tenders, not day-of) · refund
credit that never posts (PENDING → FAILED after the flow moved on) · prior manual staff refund
already netted on the payment · OPEN→COMPLETED flip mid-flow (`square-actions.ts:193-195` throws
after money moved; resume must degrade MID → rebuild for the line step) · two admin tabs running
different specs (see §4.2) · race legs (`service.ts:903-904` never rewrites their lines; BMI is
never updated post) and standalone attractions, which are **always** post-complete and need their
own chapter or an explicit refusal.

---

## 7. Payments + History must reflect everything (owner requirement)

Every operation on a reservation surfaces in both tabs, or the work isn't done. Concretely:

- Each refund appears in **PaymentsTab** with destination, amount, and status (including PENDING
  during the settlement window) — the guest-visible truth of where money went.
- Each step appears in **HistoryTab** via `recordAdminAction` — who did it, when, what changed.
- Non-cancelled rows need an admin-visible **refund summary** so a second staffer can't
  double-issue.
- `commitNeon` must stop skipping `dayof_payment_id` / `dayof_order_completed_at`
  (`service.ts:942-954`) — a stale payment id after a rebuild breaks every later refund.
- This flow must **never** write the cancel-shaped columns (`status`, `refund_cents`,
  `square_refund_id`).

---

## 8. Testing (owner requirement: full testing is part of the plan)

**Tier 1 — unit.** Every money step, allocator, guard, and the new wait/resume states. Match the
~150-test bar the edit engine already set. Explicit tests for: crash-after-R1-then-retry (must not
double-refund), second-refund event identity, two-amount gap-comp math, per-tender caps,
allocation order, and every §6.2 refusal.

**Tier 2 — live API probes** at `6MZJFTGAYD7TC` only (§9). Nothing about Square behavior ships
asserted-but-unproven.

**Tier 3 — end-to-end seed + smoke.** A real reservation walked the whole life: book → deposit →
check in → day-of charged → partial refund chain → verify Square, Neon, **and** the Payments and
History tabs all agree. Run the mixed-tender and COMPLETED-order variants too. **No flag flips
until this passes.**

---

## 9. Probe matrix (extend `gc-halfitems-probe.mts`)

At `6MZJFTGAYD7TC`, in the true production shape — internal custom-GAN card, **taxed** order with
catalog lines:

1. Order `state` and `net_amount_due_money` after a partial refund of an attached payment. *(The
   whole "strand trap" rationale and the refund-as-guard argument rest on this; never observed.)*
2. `UpdateOrder` with `fields_to_clear` on an OPEN order **with tenders**, including dropping the
   total below the tendered amount. *(Every MID money flow treats this PUT as given.)*
3. Refunding a payment on a **COMPLETED** order. *(Our probe's order stayed OPEN.)*
4. Refund-credit behavior when the target GC is deactivated while the refund is PENDING. *(First
   probe run stranded $2 this way — card `…1430`, still unreconciled.)*
5. Whether `payment.refunded_money` includes PENDING refunds — the clamp math in
   `refundTenderPartial:92-93` depends on it during the async window.
6. Guest-GC deposit tender (not internal GC) taking a partial refund — the exact production shape
   of §6.1 row 3.

Also: audit every new idempotency key against its endpoint's limit at production-scale ids
(CreatePayment/CreateCard cap at 45 chars; the failure is content-dependent and passes small-id
tests).

---

## 10. Proposed PR sequence

| PR | Contents | Gate |
| -- | -------- | ---- |
| 0 | Probe matrix §9 + owner decisions §5 recorded in `lessons.md` | Owner sign-off on the reason-string convention |
| 1 | Prerequisites: event identity (§4.2), hard open-event guard + lock extension (§4.3), day-of refund netting, refund-alerts matching extension | Unit tests |
| 2 | Cross-system guards: QAMF webhook open-refund guard, un-charged sibling refusal, store-credit record separation, `/api/square/bowling-refund` auth | Unit tests |
| 3 | The `W` wait-for-credit executor + two-amount plan fields + fatal-on-missing-GC; correct the stale A1 comments | Unit tests |
| 4 | Item-removal spec field + modal picker (§4.1) | Unit tests |
| 5 | MID-decrease enable path: money-only COMPLETED variant, 100%-refund conditional omission, Payments/History surfacing (§7) | Tier-3 smoke |
| 6 | Flag flip per the v2 cutover safety pattern — deploy alongside, ops sign-off, then default-on | Full §8 checklist |

Combos, multi-GC groups, group functions, and BMI race-line updates are **explicitly out of scope**
— listed here so nobody "quick-fixes" a guard into allowing them.

---

## 11. Open items carried in

- Three refunds from the 7/27 run 1 carry ad-hoc reasons and need **manual journal entries**
  (immutable in Square).
- First probe card `…1430`: $2 of refund credits never posted before deactivation — reconcile or
  raise with Square.
- Parked, unrelated: PRE-phase race edit "no order line matches removed heat" (see `tasks/todo.md`).
