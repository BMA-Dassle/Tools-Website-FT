# Lessons Learned

## Express Lane eligibility must judge the WHOLE party, not the personId-bearing subset (2026-06-13)

Ops flagged four reservations (W40849, W40705, W40712, W40861) that got Express Lane with "not
enough returning racers." Every one was a 2-racer party: racer #1 a returning racer with a
`bmiPersonId` + valid waiver, racer #2 a name typed in by the guest (Ross / Jade / Gary / toddick)
with **`personId: null`** — no BMI person, no waiver on file. They still got express, so a person
who needs to sign at Guest Services was waved through.

Root cause — the eligibility check **filtered the party down to members that already had a
personId, then asked "are all of *those* waivers valid?"** A personId-less second racer was
silently dropped from the decision instead of disqualifying the party. "1 returning + 1
unregistered" → express.

This existed in **three** places, all with the same shape:
- `apps/web/src/features/booking/service/checkout.ts` — `party.filter(m => m.bmiPersonId)` then
  `.every(waiverValid)` → wrote the `fastLane` flag to the booking record.
- `apps/web/app/book/confirmation/v2/page.tsx` — `racers.map(r => r.personId).filter(Boolean)`
  then trusted `fastLane` or re-checked waivers on that filtered set. This also writes the BMI
  **`** EXPRESS LANE **` reservation memo** the front desk reads (via `buildReservationMemo`'s
  `expressLaneResNumber`), so the bug reached staff, not just the green confirmation UI.
- `apps/web/app/book/confirmation/page.tsx` (v1) — same filter. v1 is NOT redirected to v2 — it's
  the shared/legacy post-payment landing (see middleware ~line 615 + checkout.ts:1213) — so it had
  to be fixed too.

**Fix:** express requires that EVERY racer is a resolved returning racer with a valid waiver.
- checkout: `party.length > 0 && party.every(m => !!m.bmiPersonId && !m.isNewRacer && m.waiverValid === true)`.
- both confirmation pages: gate on `allRacersResolved = racers.length > 0 && racers.every(r => !!r.personId)`
  BEFORE trusting `fastLane` or running the per-personId waiver check. Any null personId → express dropped.

**Guardrails:**
- An eligibility/all-clear check over a party must iterate the FULL roster. `.filter(hasId)` before
  `.every(valid)` is a silent bug: the members you dropped are exactly the ones that should block.
- A racer with no `bmiPersonId` / `personId` has no waiver on record by definition — treat "missing
  id" as *disqualifying* (or as "needs registration"), never as "skip this one."
- Separate concern, not yet built: when a second racer genuinely signed in / is a real returning
  racer, the flow should resolve them to a personId and link them to the reservation
  (`/api/pandora/schedule` also filters on `r.personId`, so unresolved racers aren't even scheduled).
  That registration path is a follow-up — this fix only makes the unresolved case correctly DROP express.

## Splitting one paid Square order into two (cross-center revenue) — tax rounds twice, fees & promos have a home (2026-06-13)

Context: the Ultimate VIP combo was booked as ONE day-of order at HeadPinz FM, but racing
revenue belongs at FastTrax FM. Remediation = split each untendered combo order into a FastTrax
racing order + a HeadPinz bowling order, both settling off the SAME shared gift card. Four
untendered orders remediated live (script `apps/web/scripts/combo-split-remediate.mts`, dry-run
first); 3 already-charged ones left for finance per owner.

The hard part was NOT the split — it was making the two new orders reconcile to the cent against
the gift card, which holds exactly the original (post-discount, fee-inclusive, taxed) total.

Guardrails (these WILL recur on any future cross-center split — attractions, etc.):
- **The gift card holds the ACTUAL net, not your idealized price.** Before splitting, fetch the
  real order: it may carry a flat **Booking Fee** line (catalog `7VKAFU3HDPRSKY7ZB6CKXTRW`, $2.99,
  taxed) and/or a **promo discount** (one combo had `$25.00 off`). An idealized "$65/$75 × ppl"
  split silently diverges from the card balance.
- **Tax rounds ONCE on the original order but TWICE when you split.** Two separately-taxed orders
  can sum 1¢ OVER the single original → the second settlement charge fails for 1¢. NEVER assume
  `splitA + splitB == original`. Make one order the **balancer**: fix the other to its exact
  revenue, then size the balancer (via a small discount line) to the LARGEST tax-incl total ≤
  (gift_card_balance − fixedOrder), so the pair is ALWAYS ≤ the card (≤2¢ stranded is harmless;
  over is fatal).
- **Square order-scope tax uses round-HALF-TO-EVEN (banker's rounding), not round-half-up.**
  6.5% on a $65.00 subtotal = 422.5¢ → Square charges **422¢ ($69.22)**, not 423¢. A round-half-up
  predictor will mismatch Square by 1¢ on exact-half cases. Use banker's rounding when predicting
  Square totals locally.
- **Guard on the real constraint, not on prediction equality.** Abort the cancel/repoint only if
  live `FT_net + HP_net > gift_card_balance` (or the gap is implausibly large, e.g. >3¢ → tax
  didn't apply). A strict `liveTotal === predictedTotal` check falsely aborts on the 1¢ banker's-
  rounding case (it did, on the first run — caught safely, no rows touched).
- **Order of operations is safety.** Create both new orders (idempotency keys) → assert ≤ card →
  repoint the Neon rows → THEN best-effort cancel the old order. If the assert fails, nothing is
  repointed/canceled and the new orders are orphaned (harmless: no Neon row references them, so no
  cron settles them). Re-running is safe — repointed rows no longer match the old id, so done
  orders skip.
- **You cannot change a Square order's `location_id` after creation** — that's why revenue
  relocation requires create-new + cancel-old, not an update.

## A "stale combo" teardown that can't tell a cart RETURN from a fresh entry destroyed a booked Ultimate VIP at checkout (2026-06-12)

Symptom (owner repro): book the Ultimate VIP combo end-to-end → land back on `/book/v2` →
click **Checkout** → instead of the checkout page, the customer is dropped at **step 1 of a
race**, with the fully-booked combo gone. Impossible to pay.

Root cause: `BookingFlow`'s seeding effect had a guard `if (session.comboSpecialId) { … release
combo + seed fresh activity … }` added by commit 4ddfcfc to stop a *stale* combo from hijacking
a normal race-tile click with the Ultimate VIP wizard steps. But the landing cart bar's
**Checkout** (`?checkout=1`) and **View Cart** links both route through the combo's first item
(always a race) → `/book/race/v2`, which is byte-identical to the Karting tile's URL. So a CART
RETURN tripped the stale-combo teardown: it released the live BMI heats + QAMF lane and seeded a
fresh race — exactly the symptom.

Fix: a cart return is not a fresh entry. Thread two intent signals from the landing —
`initialCheckout` (already existed, `?checkout=1`) and a new `initialCartView` (`?cart=1` on the
"View Cart" link) — and skip the teardown when either is set. The combo stays intact and the
effect falls through harmlessly (the requested race is already in the cart, so nothing re-seeds);
`activeItem` is null → Checkout renders `CheckoutStep`, View Cart renders `CartView`.

Guardrails:
- **A destructive "this session is stale" heuristic MUST key off explicit intent, never a URL
  shape that two different intents share.** Checkout/View-Cart and a fresh tile click all hit
  `/book/<cartSlug>/v2`; only an explicit query flag distinguishes them.
- **Never release live vendor holds (BMI heats, QAMF lanes) on a mount/seed effect unless the
  user has unambiguously asked to start over.** Auto-teardown on entry is a charge-blocking,
  hold-orphaning hazard.
- When you add a cart-bar link that re-enters an activity route, decide whether it's a "resume"
  or a "fresh start" and carry that intent in the URL — don't let `BookingFlow` guess.
- Files: `apps/web/src/components/features/booking/BookingFlow.tsx` (the guard),
  `apps/web/app/book/v2/PromoLanding.tsx` (`?cart=1` on View Cart),
  `apps/web/app/book/[attraction]/v2/page.tsx` + `apps/web/app/book/kbf/v2/page.tsx` (read `sp.cart`).

## "Identical to X" means identical — a helpful fallback gate checked a guest into the wrong arena session (2026-06-11)

HP Arena scanner launch: owner's directive was "operates identically to races" — racing checks a
guest in ONLY when their scanned session is the one currently being called. I added a
"helpful" fallback to the arena green gate (also pass if within −60/+30 min of scheduled start,
to cover early walk-ups / degraded Pandora). Live incident within hours: session 48 was called, a
guest with a session-50 ticket scanned, and session 50's start time fell inside the window — the
scanner checked them into 50. Fixed in `cd3ca6f9` (called-only gate, race parity).

Rules:

- **When the owner specifies parity with an existing flow, widen NOTHING.** Every gate, guard,
  and failure mode should match the reference implementation unless the owner explicitly asks for
  a difference. A fallback that makes the gate more permissive is a behavior change, not a
  robustness improvement.
- **Time windows are not identity checks.** "Near the scheduled time" can match SEVERAL sessions
  when slots are 15 min apart — any gate deciding "is THIS the right session?" must key on the
  session's identity (called list membership), never on time proximity.
- **Degraded-dependency fallbacks should fail CLOSED on state-mutating actions.** If the
  called-list fetch fails, the right answer is the yellow card (staff decides), not "assume green
  if the clock looks right" — same as racing behaves when races-current is down.

Same day as the H2821 dig: #H2884 showed "Balance Paid $0.00" inline but a "BALANCE LINK SENT"
corner badge. Two `group-balance-charge` runs fired at the same tick and both read the quote in
`deposit_paid`. Runner A charged the card (COMPLETED $213.72, gift card loaded, `balance_charged`).
Runner B's duplicate charge **1.1s later** declined — only the card's duplicate-decline prevented a
real double charge — then fell to the link fallback, **overwrote the paid record back to
`balance_link_sent`, and emailed the guest a LIVE payment link for a balance she had just paid.**

Rules (shipped in `95bc9f20`):

- **Any cron that moves money must atomically claim the row before the first external write.**
  `claimGfBalanceCharge` does a compare-and-swap on `balance_charge_attempts`; the CAS loser skips.
  Reading `status='deposit_paid'` at scan time is NOT a guard — both runners pass it.
- **State writers must be self-guarding, not caller-trusting.** `updateGfBalanceLinkSent` now
  refuses rows with `balance_paid_at` set (returns rowcount; caller suppresses the guest
  notification on 0). A "send payment link" write that can land on a paid record is a
  double-charge invitation, whatever the caller checked earlier.
- **Remediation pattern:** verify the real payment + gift card in Square first, flip the status
  back, and **DELETE the stale Square payment link** (`DELETE /v2/online-checkout/payment-links/{id}`)
  — a live link to an already-paid balance is an armed double-charge.

## Square truths from the H2821 stuck balance: link orders stay OPEN, the $2k gift-card cap is on BALANCE (2026-06-11)

#H2821 (ASCE, $2,231 event, event-day discovery) showed "Balance Pending" + "BALANCE LINK SENT"
while the customer had **already paid the link two days earlier**. Two independent bugs stacked:

1. **A paid Square quick-pay payment link does NOT complete its backing order.** Quick-pay orders
   have no fulfillment, so Square leaves them `state=OPEN` forever — fully tendered, `$0` due,
   payment `COMPLETED/CAPTURED`. The reconcile cron's paid test was `order.state === "COMPLETED"`,
   so it polled a fully-paid order every 15 minutes and called it unpaid. Paid-detection must treat
   *fully tendered* as paid (`tenders.length > 0 && net_amount_due === 0`, then verify the tender's
   payment is `COMPLETED`). Same trap exists anywhere else we poll an order for payment.
2. **Square's $2,000 gift-card cap applies to the card's BALANCE, not the load amount.**
   `loadBalanceOntoGiftCards` topped up existing cards with `min(remaining, $2k)` — but a card
   already holding the 50% deposit only has `$2k − balance` headroom, so EVERY event totaling
   > $2,000 threw at balance-load time. Fix: fetch current balance, load into headroom, overflow
   onto new cards. Corollary: **callers must persist overflow card ids/gans onto the quote**
   (`updateGfGiftCardList`) or day-of payout never sees the funds — all three callers ignored the
   loader's return value.

Also fixed: `Promise.allSettled` summaries that count `errors++` without logging `r.reason` hide
the only copy of the failure — the $2k bug was invisible until a log line was added.

Remediated live (quote 119 #H2821 + quote 65 #H2981 — both customers had paid; gift cards loaded,
status `balance_charged`, receipts sent). Replaced Square payment links with the self-hosted
`/contract/{shortId}/pay` page (`/api/group-function/balance-pay` charges + loads + flips status
synchronously) so a paid-but-unreconciled state can't recur; the reconcile cron remains for legacy
square.link URLs only.

## Every payment entry point must ride the same rail — "effectively dead" fallbacks charge real cards (2026-06-10)

35 customers (~$1,127) were charged with NO booking created over ~48h after the June 7 v1→v2
redirect. Two missing HeadPinz Naples reservations (Barton $61.47, Mueller $37.07) surfaced it.
Root cause: v2 `CheckoutStep` wires `PaymentForm`'s `onTokenize` so the reserve routes charge AND
book atomically — and the card/saved-card/gift-card paths all honored it — but **`handleApplePay`
called `processPayment()` directly**, charging via `/api/square/pay` and skipping the reserve
entirely. `handlePaymentSuccess` then cleared the cart and redirected to a broken confirmation,
which read as failure → customers retried → double/triple charges (one customer ×3 = $218).
Google Pay was a quieter twin: `attach()` rendered the button, nothing ever called `tokenize()`.
Bonus wound: the fallback's `locationId` came from hostname (headpinz → HP **Fort Myers**), so all
35 charges also landed in the wrong Square location. Fixed in `2728e57d`.

**Rules:**

- **When adding a payment method to a component, audit EVERY submit path** (card, saved card, gift
  card, each wallet) against every caller mode. A new entry point that skips the orchestration
  callback is a charge-without-fulfillment bug, not a UX bug.
- **A comment saying a fallback is "effectively dead" is a claim, not a property.** If a code path
  would charge a customer without fulfilling, it must fail LOUDLY (server-side alert log + a
  "payment received, do NOT pay again" screen, never a Retry button) — silence + a broken
  confirmation is what converts one orphan charge into three.
- **Detection signature:** Square payments with note `FastTrax - … | Ref: cart-…` are always
  orphans (reserve-route charges write different notes). Worksheet:
  `node apps/web/scripts/audit-orphan-cart-payments.mjs 2026-06-08` (cross-matches
  `bowling_reservations` by buyer email; contact info for outreach lives in
  `clickwrap_acceptances` by cart `bill_id`).
- **Wallet payments look like `CVV_NOT_CHECKED` + `AVS_ACCEPTED`** in Square card_details — that
  plus iPhone user agents in clickwrap is how the Apple Pay path was pinned without repro.

## Before fixing a "v2" component, confirm which route is actually LIVE — the middleware redirects v1 → step-machine (2026-06-08)

KBF login wasn't populating kids/adults. I traced `/hp/book/kids-bowl-free/page.tsx` → it renders
`<BowlingWizard kind="kbf" />`, found the multi-pass bug there (`data.passes[0]` only — dropped a
parent's second pass), fixed it, proved it against real data, and reported done. **Wrong file.**
A screenshot showed the user was on `/book/kbf/v2` — a *different* implementation (the
`src/features/booking` step machine: `KbfIdentityStep` → `KbfBowlersStep`), and `middleware.ts`
`bookingV2Target()` **unconditionally 307-redirects** `/book/kids-bowl-free` AND (after stripping
`/hp`) `/hp/book/kids-bowl-free` → `/book/kbf/v2`. So `BowlingWizard kind="kbf"` is dead code that
never renders. I'd patched a redirected route.

The real bug was in the step machine: `KbfIdentityStep` got the full roster from `/api/kbf/verify`
but dispatched only `passId` (discarding members), then `KbfBowlersStep` fetched
`/api/kbf/pass/${passId}/members` — **an endpoint that doesn't exist** → empty list. Fix: carry the
flattened roster (all passes) through `session.kbfIdentity.members` at verify time; the bowlers step
reads it from session. No new endpoint, multi-pass handled.

**Rule: a `page.tsx` importing a component does NOT prove that route is live.** Before touching any
booking component, run the path through `bookingV2Target()` in `middleware.ts` — if it returns a
target, the page you're looking at is redirected away. Confirm the live route from the actual URL
(ask for it / check the screenshot) before editing. Two parallel implementations of the same feature
(`components/bowling/BowlingWizard.tsx` vs `src/components/features/booking/steps/`) is a trap — the
old one looks load-bearing but isn't.

- [apps/web/middleware.ts](apps/web/middleware.ts) `bookingV2Target()` (~line 621) — the v1→v2 redirect map
- [apps/web/app/book/kbf/v2/page.tsx](apps/web/app/book/kbf/v2/page.tsx) → `BookingFlow activity="kbf"` (the LIVE flow)
- [apps/web/src/components/features/booking/steps/bowling/KbfIdentityStep.tsx](apps/web/src/components/features/booking/steps/bowling/KbfIdentityStep.tsx) / [KbfBowlersStep.tsx](apps/web/src/components/features/booking/steps/bowling/KbfBowlersStep.tsx)

## "Send Contract" is the only contract trigger — retired `group-quote-sync`'s auto-resign (2026-06-08)

The 2026-06-07 emergency guard (below) only stopped *past* events. The same loop hit an *upcoming*
event: **Emmanuel Lutheran Church** (HeadPinz Naples, event #1355, Jun 17 7 PM) — signed + deposit
paid at 16:32, then blasted "Contract Updated" every 5 minutes from 16:40 onward. The planner sent
nothing; the cron did.

**Actual root cause of the non-convergence (it was NOT the product diff suspected on 06-07): a
timezone round-trip on `event_date`.** BMI returns a tz-less ET string (`2026-06-17T19:00:00` = 7 PM
ET). `syncQuote` wrote that bare string into the `timestamptz` column via `updates.event_date =
bmiDate`. The Neon session `TimeZone` is **GMT**, so Postgres persisted it as `19:00Z` = **3 PM ET**.
Next run, `normDate()` read the stored value back as 3 PM ET but normalized BMI's string as 7 PM ET →
a permanent 4-hour mismatch. The write-back re-introduced the same error every run, so it could never
converge. (The `event_date_display` column was computed correctly with a `-04:00` offset, masking the
bad raw instant — display looked right while the stored instant drove the loop.)

**Permanent fix — the gate.** Ripped ALL contract mutation out of `group-quote-sync`: no more
change-detection, no `resign_required` flip, no `notifyContractUpdated`, no silent `event_date` /
`line_items` rewrite. That cron now does ONLY: cancel+refund on BMI state −4, waiver reminders, and
day-of order backfill. **Every contract send / resend / update / resign now flows exclusively through
`group-quote-dispatch`, which fires only when the planner sets the BMI project to "Send Contract."**
One gate, planner-controlled. (`isEventOver`, the product/customer/date diff, the AI name writeback,
and the Hermes planner backfill all went with it — those updates happen on the next "Send Contract".)

**Data remediation (quote 99):** restored `status=deposit_paid`, `contract_status=signed`, re-attached
the signed PDF + `contract_signed_at` from `signed_pdf_history`, wiped the churn history, and set
`event_date` to the correct ET instant (`2026-06-17T19:00:00-04:00` = `23:00Z`). `signature_data` /
`document_seal` were nulled by the churn and unrecoverable, but the signed PDF + audit "signed" event
remain. The contract page keys its re-sign prompt off `status === "resign_required"`, so a restored
`deposit_paid` row renders the confirmed view — the guest is NOT asked to sign again.

**Guardrails:**
- **One customer-facing trigger per action.** A background poller and a planner-action handler must
  not both be able to send/resign the same contract. If the planner's "Send Contract" is the intended
  gate, the poller must never emit the same customer-facing effect — at most it does silent, internal
  self-healing (cancel/refund, reminders, backfill).
- **Never write a tz-less wall-clock string into a `timestamptz`.** The Neon session is GMT, so
  `'2026-06-17T19:00:00'::timestamptz` stores 19:00**Z**, not 19:00 ET. Always attach the correct
  ET offset (DST-aware) before persisting a BMI/Hermes date, or the raw instant drifts 4–5h even when
  the display column looks fine. (Latent elsewhere — dispatch ingests dates that already carry tz, so
  it stored correctly; sync's `project.date` did not.)
- A "corrected value" write that doesn't round-trip equal on the next read is an infinite trigger.
  Removing the *acting* is more robust than chasing convergence on a value you can't control.

## `group-quote-sync` re-emailed "Contract Updated" every 5 min for a past, signed event (2026-06-07)

Annalisa Birthday Party (HeadPinz Naples, Jun 6 4:15 PM) blasted the guest a "Contract Updated —
please re-sign" email every 5 minutes — continuing well past midnight, after the event was already
over. Three things compounded:

1. **Past events stay in scope.** The sync query selects `event_date > NOW() - INTERVAL '7 days'`
   AND status includes `resign_required` — so a finished event keeps getting picked up for a week.
2. **A signed/paid event gets force-re-signed.** `isSigned = quote.status !== "contract_sent"` is
   true for `deposit_paid`/`balance_charged`/`resign_required`. When any change is detected, the
   cron archives the PDF, flips status → `resign_required`, and fires `notifyContractUpdated`.
3. **The diff never converges.** The Hermes product comparison reported a "products changed" delta
   on *every* run, so step 2 repeated indefinitely. (Suspect: stored `line_items` carry the
   service-charge-corrected total while Hermes returns the raw amount, or a float `total` / ordering
   mismatch — each run re-detects the same "change.")

Result: an infinite re-sign/email loop at the `*/5` cron cadence, matching the inbox exactly.

**Fix (emergency):** added an `isEventOver()` guard in `syncQuote` — once the event's start time has
passed, return early (`skipped_past_event`) before any change detection, re-sign, or email. A
finished event must NEVER be flipped to `resign_required` or re-emailed. Cancellation handling is
left intact (it runs before the guard). Uses the live BMI `project.date` so a reschedule into the
future resumes sync.

**Guardrails:**
- Any cron that emails/charges/re-signs a customer must gate on "is this event still in the future?"
  A past-dated row is almost never a valid target for a customer-facing, pre-event action.
- A change-detection loop that *acts* on every detected change MUST converge: after writing the
  "corrected" value, the next read has to compare equal. If the source (Hermes) and the persisted
  store can never match (because we mutate before persisting), you have an infinite trigger. Verify
  convergence, not just "did it detect a change."
- `status !== "contract_sent"` is a fragile proxy for "signed." `resign_required` is unsigned but
  trips it — re-arming the very loop that set the status. Prefer an explicit signed marker
  (`contract_signed_at`) when gating destructive/customer-facing transitions.
- TODO follow-up: fix the non-converging product diff so an *upcoming* event can't loop the same way
  before its date. The past-event guard only covers events that have already happened.

## Two crons sharing one trigger raced — `dayof-close` stranded `dayof-pay` (2026-06-05)

Quote #3286 (LSI Companies, $2,649.09) showed Deposit ✓ / Balance ✓ in admin but its Square
day-of order sat OPEN, unpaid. Gift cards were fully funded and untouched. Root cause: a
read-modify race between two crons that gate on the *identical* trigger
`status = 'balance_charged' AND event_date <= NOW()`:

- `group-dayof-pay` (`*/5`) applies the gift card to the day-of order, sets `dayof_paid_at`. Does
  NOT change status.
- `group-dayof-close` (`*/15`) flips status → `completed`, with NO check that the day-of order was
  paid first.

Both fire together at minute `:00` — the first tick where a just-arrived event qualifies. Close
won the race (`updated_at` 16:00:37Z for a 16:00:00Z event), flipped status to `completed`, and
from then on pay's `WHERE status = 'balance_charged'` never matched again. Tell-tale: BOTH
`dayof_paid_at` AND `dayof_payment_error` were NULL — a real pay failure sets the error, so null/null
means the row was never even selected. Blast radius was 3 events (#3286, #1354, #H2986), all OPEN in
Square. Fix: gate close on `(square_dayof_order_id IS NULL OR dayof_paid_at IS NOT NULL)` to enforce
pay-before-close.

**Guardrails:**
- Two crons gating on the same status is a latent race whenever one is a precondition of the other.
  Don't just check they both *select* the right rows (the 2026-06-03 lesson) — check their *relative
  ordering* when they fire in the same tick. The dependent cron (close) must gate on the producer's
  completion marker (`dayof_paid_at`), not on the shared upstream status alone.
- A transition cron that has nothing to do must STILL be ordered behind the work it depends on.
  "Mark it done" must verify "is it actually done," never just "did the upstream status flip."
- Diagnosing null/null vs null/error distinguishes "never attempted" from "attempted and failed" —
  always pull both the success timestamp and the error column together.
- Remediate stranded orders by replaying the producer's logic with ITS idempotency keys
  (`gf-dayof-pay-{id}-{i}`), not by flipping status back upstream — flipping back re-arms the same
  race against the still-deployed buggy cron.

See also the 2026-06-03 lesson below — same pipeline, complementary failure mode (missed transition
vs. raced transition).

## ~~Square ignores `base_price_money` on FIXED_PRICING catalog items~~ — RETRACTED, was a misdiagnosis (2026-06-05, corrected 2026-06-08)

> **This lesson was WRONG and has been reverted in code.** Square DOES honor
> `base_price_money` on a catalog-linked line item for BOTH FIXED and VARIABLE
> pricing. Verified 2026-06-08 against `/orders/calculate`:
> a FIXED $26.99 "GF Race Blue Starter" linked **with** `base_price_money: $399.99`
> rings **$399.99** and keeps `catalog_object_id`; the same line with no
> `base_price_money` rings $26.99. The catalog price is only a default.

What actually happened: #3286's day-of order rang three "GF Race Blue Starter Fri-Sun"
lines at **$26.99** instead of the quoted **$399.99**, under-charging by **$1,464.53**.
The real root cause was the *earlier* bug (see the 2026-06-03 lesson below): #3286's order
was created **before** `base_price_money` was added to catalog lines (2026-06-03), so it
carried only `catalog_object_id` and Square used the catalog default. The 2026-06-03 fix
(always send `base_price_money`) was correct and complete.

The 2026-06-05 "fix" was an **overcorrection from a misdiagnosis**: it added
`fetchCatalogPriceInfo` and dropped the catalog link whenever quote price != catalog price.
That changed nothing about pricing correctness (base_price_money already guaranteed it) but
**destroyed Square item-sales attribution** for every override-priced line — race starters,
birthday packages, extra pizzas, well drinks. By 2026-06-08, 17 line items across live
day-of orders were ad-hoc purely because of this branch, plus 7 older orders that had gone
*fully* ad-hoc via the all-or-nothing fallback.

Corrected fix (2026-06-08): `buildSquareLineItem` keeps the catalog link whenever a PLU is
present and always sends `base_price_money`. No catalog pre-fetch, no price comparison.
Square honors the override AND preserves reporting. `fetchCatalogPriceInfo` /
`CatalogPriceInfo` deleted. Audited/remediated via `apps/web/scripts/audit-dayof-adhoc-*.mjs`
+ `remediate-dayof-relink.mjs` (5 OPEN orders relinked; 6 completed/paid orders left as-is).

**Lesson about the lesson:** before "fixing" a pricing bug by removing a code path, prove the
hypothesis against `/orders/calculate` (a free, side-effect-free validator). The original
diagnosis was never tested in isolation — link+override was assumed broken, never measured.

**Guardrails:**
- A `: string`-typed price field that "looks sent" can still be ignored by the upstream API.
  When an external system has its own source of truth (catalog price), verify it actually USED
  your value — diff the created resource against what you sent, don't assume the POST honored it.
- The reliable mispricing detector is **order total vs. quote total**, not the code path. Sweep
  all day-of orders (`order.total_money` vs `total_cents`) to find every drifted event; gap≈0
  with catalog links just means no override existed, not that the path is safe.
- Remediating a completed, mispriced Square order = refund the gift-card payment, rebuild the
  order ad-hoc with override prices, then **multi-tender capture via PayOrder** (`POST
  /orders/{id}/pay` with all `payment_ids`). `autocomplete:true` on a partial gift-card payment
  fails "payment total does not match order total"; create each payment `autocomplete:false`
  then PayOrder them together. A failed payment STILL burns its idempotency key.
- Separate "never attempted" (null/null) from "attempted, ignored" (price present but order
  shows catalog price) — they point at different bugs.

## Full-prepay group events never paid out day-of — two coupled bugs (2026-06-03)

"Hayes Birthday Party" should have auto-paid on the event day, but `/api/cron/group-dayof-pay`
reported `checked=0`. Real-DB inspection found two independent root causes in the group-function
payment pipeline:

**1. The status machine didn't model "fully funded at deposit."** Events booked within 96h
require full payment upfront (`fullPaymentRequired` in `group-quote-dispatch`:
`deposit_due_cents = total_cents` ⇒ `balance_cents = 0`). The ONLY code that advances
`deposit_paid → balance_charged` is the balance-charge cron's `processBalanceCharge`, which
opened with `if (quote.balance_cents <= 0) return "auto_charged";` — returning WITHOUT setting
status. So prepaid events stayed `deposit_paid` forever, and BOTH `group-dayof-pay` and
`group-dayof-close` (which gate on `status='balance_charged'`) silently skipped them. Once the
event time passed, balance-charge stopped selecting them too (its `event_date > NOW()` guard) ⇒
permanently orphaned: gift card fully funded, day-of order OPEN and never paid. Fix:
`updateGfBalancePrepaid()` advances $0-balance deposits to `balance_charged`.

**2. Day-of order catalog creation always failed; the lone ad-hoc fallback had no retry.**
`buildSquareLineItem` sent `catalog_object_id` + `quantity` but no `base_price_money`. Group
catalog variations are *variably priced*, so Square hard-rejected every catalog attempt:
`"variably priced and requires a value for base_price_money"`. The system limped on the ad-hoc
fallback, but a single transient failure of that one attempt at deposit time orphaned the
day-of order with no retry (10 events had accumulated a NULL `square_dayof_order_id`). Fixes:
(a) include `base_price_money` on catalog line items; (b) self-heal — `group-quote-sync` now
backfills any deposit-paid event missing its day-of order, via a shared `createDayofOrder` in
`lib/group-function-dayof.ts` (single source of truth; was previously duplicated 3×).

**Guardrails:**
- A payment state machine MUST handle the $0 / already-funded edge explicitly. A short-circuit
  `return` that skips the state transition is a silent trap — the "nothing to do" branch still
  has to advance state.
- Best-effort creation of an external resource on a hot path must be retried/self-healed, never
  fire-once-or-orphan. Sweep or surface the failures.
- When two crons gate on the same status, one missed transition breaks BOTH — trace every
  consumer of a status before assuming a quote will progress.
- Verify against real data: `node --env-file=apps/web/.env.local -e "<neon SELECT>"` pinpointed
  the exact failing column far faster than reasoning from code alone.

## Google ignores schema.org `eventSchedule` — Events need an explicit `startDate` (2026-06-02)

Google Search Console flagged our recurring-event JSON-LD (Mega Track Tuesday,
HeadPinz Trivia Tuesday, Midnight Madness) as ineligible. Root cause: the shared
`recurringEventSchema` (`apps/web/components/seo/JsonLd.tsx`) described recurrence
**only** via `eventSchedule` → `Schedule` (`byDay`/`repeatFrequency`/`scheduleTimezone`)
and had **no `startDate`**.

**Google's Event rich results do NOT read `eventSchedule`/`Schedule` at all.** It's
valid schema.org (fine for other consumers) but Google-blind. Google requires an
explicit ISO-8601 **`startDate` on the Event itself** — one of only three required
fields (`name`, `startDate`, `location`). No `startDate` ⇒ "Missing field 'startDate'"
⇒ ineligible. (`performer`/`offers`/`endDate` are recommended-only — yellow warnings,
never the hard error.)

Fix pattern for recurring events: compute the **next occurrence at render time** and
emit a concrete `startDate`/`endDate` (ISO-8601 **with the DST-aware ET offset** —
derive it via `Intl.DateTimeFormat(..., { timeZone, timeZoneName: "longOffset" })`,
never hardcode `-05:00`). Emit **one Event per recurring day**. Anchor day math at
**noon UTC** so adding days never trips the 2 AM DST boundary.

Coupled gotcha: a computed "next occurrence" **freezes at build time** on statically
rendered pages. Pages that render these schemas must set `export const revalidate`
(we use daily) so the dates roll forward. Don't assume deploy cadence will refresh them.

## Pandora product `tax` is a RATE, not a dollar amount (2026-05-30)

Each product in the Pandora `/v2/bmi/reservation` response carries `tax` as a
**per-line tax RATE** (e.g. `0.065` = 6.5%), NOT a dollar amount. Verified live on
reservation `49220090`: every product had `tax: 0.065`.

**Line tax = `rate × line-total`.** The old formula was:

```ts
taxTotal = products.reduce((s, p) => s + ((p.tax || 0) * p.total) / (p.price || 1), 0);
```

`(tax * total) / price` reduces to `rate × qty`, which under-counted tax by the unit
price. On 49220090 it produced **$0.65** instead of **$63.76** (`0.065 × 980.95`). The
bug was duplicated in two places, so it was extracted into one helper:
[apps/web/lib/group-function-pricing.ts](apps/web/lib/group-function-pricing.ts)
(`subtotalCents`, `taxCents`) — used by `bmi-scan`, both group-quote crons, and the backfill.

Two coupled gotchas the tax bug had masked (tax was ≈$0, so nobody noticed):
- **`total_cents` is the tax-INCLUSIVE grand total** everywhere (contract page, signed PDF,
  Square deposit/day-of orders: deposit = total/2, balance = total − deposit). The dispatch
  cron's normal path stored a tax-EXCLUSIVE total; now `+ taxCents`.
- The sync cron recomputed tax **without** honoring `isTaxExempt(...)` (dispatch did) — fixed.

Existing rows don't self-heal (dispatch only re-scans "Send Contract"; sync only recomputes
tax on product change). One-time fix:
[apps/web/app/api/cron/group-quote-tax-backfill/route.ts](apps/web/app/api/cron/group-quote-tax-backfill/route.ts)
— recomputes unpaid quotes, reports (read-only) on already-paid quotes that under-collected.
Run dry-run first: `curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/group-quote-tax-backfill?dryRun=1`,
then `?dryRun=0`.

## Post-paid approval requests must LEAVE "Send Contract" or they loop forever (2026-06-01)

The group-quote-dispatch cron (`* * * * *`, every minute) scans BMI for projects in
**"Send Contract"** state and processes each one. The normal (deposit) path transitions
BMI **"Send Contract" → "Pending Signed Contract"** after sending, so the next scan skips it.
The post-paid hold-for-approval branch did **not** — it set `status='pending_approval'`,
fired `notifyApprovalNeeded()`, and returned, leaving the project in "Send Contract." Result:
**an approval email to management every minute, forever — even after a decline.**

Two coupled bugs:

1. **The trigger is the BMI state, not the DB status.** Nothing can "wait for another Send
   Contract" if the item never leaves Send Contract. Fix: the moment we hold for approval,
   move BMI out of "Send Contract" (→ Pending Signed Contract), mirroring the sent path.
   Then a decline sits dormant, and sales re-flipping to "Send Contract" is the deliberate
   signal to re-request approval.

2. **The reset block re-inserted and would hit the unique index.** When a `cancelled`/`denied`/
   `expired` quote reappears, the reset block set `existing = null` then the create path called
   `insertGfQuote` — which has **no `ON CONFLICT`** against the UNIQUE index on
   `bmi_reservation_id` (`group-function-db.ts`). So "clear the denial and ask again" would have
   thrown on the duplicate insert. Fix: reset the row **in place** (`UPDATE ... RETURNING *`),
   keep `existing` pointing at it, and clear the approval/denial columns too
   (`approved_at`, `denied_at`, `denial_reason`, `approval_memo`, …). Don't stamp
   `hermes_last_processed_at` in the reset, or the 60s debounce skips the same-run reprocess.

Lesson: any cron that consumes a BMI workflow state must transition the project OUT of that
state on **every** terminal branch (sent, held-for-approval, error-park) — not just the happy
path — or the scan re-triggers it indefinitely.
[apps/web/app/api/cron/group-quote-dispatch/route.ts](apps/web/app/api/cron/group-quote-dispatch/route.ts)

## Neon sql template tag consumes `::type` as parameter type hints (2026-05-09)

The `@neondatabase/serverless` `sql` tagged template treats `${value}::type`
specially — it consumes `::type` as a parameter type hint (setting the OID)
and strips it from the SQL text sent to Postgres. This means:

```typescript
q`WHERE col >= ${date}::date AT TIME ZONE 'America/New_York'`
```

Does NOT produce `$1::date AT TIME ZONE 'America/New_York'`. Instead the
driver strips `::date`, and Postgres sees `$1 AT TIME ZONE 'America/New_York'`
where `$1` is a text parameter. The result is silently wrong — no error,
just incorrect boundaries.

**Fix:** Apply `AT TIME ZONE` on the column side instead:
```typescript
q`WHERE (col AT TIME ZONE 'America/New_York')::date >= ${date}::date`
```

This is unambiguous: Postgres casts the column to ET, extracts the date,
and compares against the parameter's date value. The `::date` on the
parameter still works fine as a type hint (date vs text doesn't matter
for a simple `>=` comparison).

**Rule:** Never put `AT TIME ZONE` after a template-tag parameter cast.
Always apply timezone conversion on the column or a literal expression.

## QAMF probe times MUST be multiples of 5 minutes (2026-05-09)

QAMF's `searchAvailability` API rejects any `BookedAtRange` where minutes
aren't divisible by 5. Error: `400 "The minutes must be multiples of 5."`

**What happened:** We added a "don't probe the past" guard that computes
`earliestMin = currentETTime + 15`. When the current time was e.g. 6:36 PM,
`earliestMin = 1131` (18h 51m). Every 15-min probe from there — 18:51, 19:06,
19:21 — had non-5-divisible minutes. QAMF rejected ALL of them, `.catch()`
swallowed the 400s, and the API returned `{Availabilities: []}`. This looked
like "sold out" to customers on a busy Saturday night.

**Why it was intermittent:** Only fails when `currentMinute + 15` isn't already
on a 5-min boundary. Test at 6:00 PM → fine. Test at 6:36 PM → total failure.
Future dates never hit this because `openHour * 60` is always clean.

**Why it was hard to find:** Three compounding issues:
1. `.catch(() => ({ Availabilities: [] }))` silently swallowed every 400 error
2. Vercel was serving stale serverless functions — console.log statements from
   new deployments weren't appearing in runtime logs
3. The experiences API worked fine (different code path), so DB filtering was
   ruled out as the cause

**Fix:** `earliestMin = Math.ceil(earliestMin / 15) * 15` snaps to the next
clean quarter-hour.

### Rules for future QAMF integration:
- **ALWAYS snap probe times to 15-min boundaries** (or at minimum 5-min)
- **NEVER silently swallow QAMF errors** — log the first few, include error
  count in the summary line
- **When Vercel logs don't show your console.log, suspect stale functions** —
  force a new deployment or check the build logs for cache hits
- **When debugging "no availability," check probe error count FIRST** — if
  `errors === probes`, the issue is probe construction, not QAMF capacity

## pnpm + Vercel = quagmire — switched to npm workspaces (2026-05-06)

The monorepo restructure (PR1) originally chose pnpm + Turborepo. After three
failed Vercel deploys and ~6 hours of debugging, we abandoned pnpm in favor of
npm workspaces + Turborepo. The architecture (workspaces, `apps/`, `packages/`,
Turbo orchestration) is unchanged — only the package manager flipped.

### What went wrong, in sequence

1. **PR1 added a workspace-root `pnpm-lock.yaml`** while leaving Vercel's
   project root at `apps/web/`. The plan said "Vercel impact: none." Wrong.
   **Vercel walks UP from the configured project root looking for any lockfile.**
   Finding `pnpm-lock.yaml` at the repo root caused Vercel to switch from
   `npm install` to `pnpm install` in `apps/web/` even though nothing inside
   that directory changed. Build failed with `ERR_PNPM_META_FETCH_FAIL` and a
   cascade of `ERR_INVALID_THIS` registry errors on every package fetch.

2. **First fix (pnpm@9.15.4 → 10.4.1):** thinking the URLSearchParams bug was
   pnpm 9-specific. Wrong — early pnpm 10.x patches (10.0–10.5) still had the bug.

3. **Second fix (pnpm@10.4.1 → 10.33.4 + Node 22.11.0 pin):** thinking Node 22.13+
   was the trigger. Vercel ignored the Node pin and ran Node 24 anyway.

4. **Third fix (Vercel Install Command override: `npm install -g pnpm@10.33.4 && pnpm install`):**
   `npm install -g` succeeded but Vercel's bundled pnpm at a higher PATH priority
   kept being invoked. Build log still showed "Ignoring not compatible lockfile"
   — proof the new pnpm wasn't actually running.

5. **Fourth attempt (corepack):** still same error pattern. Time burned vs
   value gained had crossed the line. Pulled the plug.

### Resolution

Switched to **npm workspaces + Turborepo** on 2026-05-06:

- Deleted `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `apps/web/package-lock.json`.
- Root `package.json` now has `"workspaces": [...]`, `"packageManager": "npm@11.6.4"`,
  no pnpm-specific fields.
- Vercel install command override turned OFF (Vercel auto-detects npm from
  the root `package-lock.json`).
- Local + Vercel build green in one push.

### What we lost vs what we kept

**Lost:** pnpm's strict isolated `node_modules`. Transitive deps now hoist —
`apps/web/eslint.config.mjs` can import `eslint-plugin-jsx-a11y` without
declaring it in `apps/web/package.json` (it's pulled transitively via
`eslint-config-next`). We're not catching that class of bug at install time
anymore. Acceptable trade-off; we can add `depcheck` or `knip` to CI later if
it becomes a real problem.

**Kept:** the entire monorepo architecture, Turbo orchestration, all v2
conventions, deploy targets — everything in `tasks/restructure-plan.md` is
package-manager-agnostic.

### Lessons that survive

**Rule 1:** When a workspace-level lockfile appears at the repo root for the
first time, treat it as a deploy-tooling change *regardless* of where the deploy
provider's project root points. Vercel walks up; so does most CI. Verify with a
preview deploy BEFORE asserting "no deploy impact" in any PR description or plan.

**Rule 2:** When debugging "works locally, fails on Vercel" issues, the FIRST
thing to confirm is the build log header: actual Node version, actual package
manager version, actual install command. Vercel's defaults shift over time and
silently override file-based pins (`engines.node`, `.nvmrc`) more often than the
docs suggest. Don't propose fixes until you've seen the log header.

**Rule 3:** Boring tooling for production deploys. pnpm has real benefits but
its tighter coupling to specific Node/undici versions makes it fragile on managed
build platforms whose runtime drifts. npm is slow and inelegant but it's what
Vercel/Netlify/Render/etc. test against, so it's what works. **For a small team
on a managed platform, pick the package manager the platform considers default,
not the one with the best ergonomics.**

**Rule 4:** Time-box exotic fixes. We pushed three commits (`51194bf`,
`f0e3e5b`, `ea3704a`) chasing pnpm before pulling the ripcord. The signal "I've
made three commits and the same error class is still firing" is a strong cue to
abandon the current approach and try something fundamentally different.

**Rule 5:** If you ever consider switching back to pnpm, read this lesson first.
Do not assume the URLSearchParams + Vercel-bundled-pnpm + Node-default-LTS issues
are resolved — verify on a preview deploy with no install command override
before any merge. The ergonomic upside is real but the deploy risk is too.

## Multi-source data — read BOTH live AND cached, cascade (2026-05-02)

**The confirmation page kept biting us when one source was stale or
missing.** Twice in the same week:

1. POV claim only checked `parsedOverviews` (the OrderSummary
   pre-payment snapshot) — never the live `overview` from BMI.
   Fast-confirming bookings sometimes had an empty snapshot at
   page-load time but a fully-populated live overview. Claim path
   silently found no POV line → no codes claimed → empty SMS, empty
   email, empty BMI memo. Customer paid for video, got nothing.
   Reported by ops on W33861 / W33835 after a customer noticed.

2. Earlier same day: line names were rendering "Intermediate Race
   Mega" on confirmation pages because BMI's `bill/overview` returned
   that as the public name on a package-only Blue Track SKU. The
   single-source code trusted BMI; the fix cascaded through our own
   PACKAGES + RACE_PRODUCTS registries.

**Rule:** Whenever a feature reads a piece of state from one source
on the confirmation page, ask "what's the OTHER source for this same
data, and what happens when they disagree?" The pattern across the
file is `liveSource?.field || cachedSource?.field || fallback` —
follow it consistently. Specifically:

- Bill lines → `overview?.lines || parsedOverviews.flatMap(...)`
- Race names → cascade through `productDisplayNameFromPackages` →
  `getRaceProductById` → BMI `line.name`
- Booking record → `bookingRecord?.field` (from /api/booking-record
  Redis) is the post-checkout authoritative source; falls back to
  `details?.field` (booking-store) for in-flight values.

**Test rule:** Any customer-impacting confirmation flow needs at
least one test that simulates an empty `parsedOverviews` (fast
checkout where the snapshot wasn't written yet) and confirms the
feature still works via the live overview path.

## Idempotency on resource-consuming endpoints (2026-05-02)

`/api/pov-codes?action=claim` was popping new codes from the pool on
every call, no billId-level dedup. When staff backfilled codes for an
affected booking, a customer revisit would have popped a SECOND set
of codes — different from what's in the BMI memo — and silently
consumed pool inventory. Made the claim path scan `pov:used` for
existing billId entries and return them when found, with
`cached: true` in the response. Cost: one HSCAN per call (1-2 round
trips for the current pool size). **Rule:** any endpoint that
*consumes* shared inventory (codes, lane-holds, vouchers) must dedup
by the request's owning resource id (billId, sessionId, personId)
before allocating new resources from the pool.

## CRITICAL: BMI ID Precision Loss (2026-04-04)

**NEVER use `Number()` or `JSON.stringify()` on BMI person IDs or order/bill IDs.**

BMI IDs like `63000000000021716` exceed JavaScript's `Number.MAX_SAFE_INTEGER` (9007199254740991).
`Number("63000000000021716")` silently becomes `63000000000021720` — losing precision and causing
FK constraint violations or wrong person lookups in BMI.

**Rule:** Always inject BMI IDs as raw text in JSON payloads using string concatenation:
```ts
// BAD — precision loss
const body = JSON.stringify({ personId: Number(pid), orderId: Number(billId) });

// GOOD — raw injection
const body = `{"personId":${pid},"orderId":${billId},` + JSON.stringify(otherFields).slice(1);
// or append:
body = body.slice(0, -1) + `,"personId":${pid}}`;
```

**Affected endpoints:**
- `booking/book` — orderId and personId
- `person/registerContactPerson` — orderId and personId
- `person/registerProjectPerson` — orderId and personId
- `payment/confirm` — orderId
- `bill/cancel` — orderId in URL path (string, safe)
- `bill/overview` — billId as query param (string, safe)

**Pattern to follow:** See `bookRaceHeat()` in `data.ts` for the canonical example of raw JSON injection.

### INBOUND is the other half — `res.json()` corrupts ids BEFORE outbound protection runs (2026-06-03)

`stringifyWithRawIds` only protects the OUTBOUND direction. The dual bug bit us in production
(v1 booking off-by-one): the instant a BMI/Pandora **response** is read with `res.json()` or
`JSON.parse`, any 17-digit id that comes back as a bare JSON **number** is rounded to the nearest
multiple of 8 — `63000000003675359` → `63000000003675360` (+1). In the 2⁵⁵–2⁵⁶ band, **7 of 8**
ids corrupt, so this silently worsens as BMI's id counters climb / volume grows. A later raw
outbound injection can't help — the value was already destroyed on the way in.

**The TypeScript trap:** a field typed `personId: string` does NOT make it a string at runtime.
`JSON.parse` returns a `number` for `"personID": 633…`; the `as string` cast is a compile-time
lie. Don't trust the type — control the parse.

**What the 2026-06-03 audit actually found — MAGNITUDE matters, check it before "fixing":**
The instinct was to point at the obvious id sites, but live prod probing refuted every one. Don't
repeat these dead ends — each id space has a different width:

| Path | 17-digit `63…`? | Wire form | How we read it | Verdict |
| --- | --- | --- | --- | --- |
| Race/attraction booking `orderId`/`billId`/`orderItemId` (public-booking API) | **yes** | unquoted number | `res.text()` + regex (`extractRawOrderId`) | **safe** |
| BMI **Office** project entity `id`/`personId`/`number` (`office-api22…`) | no — 7–8 digit | **quoted string** (`"id":"8031234"`) | `JSON.parse` | **safe** |
| **Pandora** person `personID` (`docs/pandora-api.md`) | no — 6-digit Firebird | quoted string (`"id":"713365"`) | `res.json()` | **safe** |
| QAMF bowling reservation ids / both Node bridges | no | string / n/a | — | **safe** |

So in OUR code, the 17-digit numbers exist only in the **public-booking** API, and that path
already reads them as raw text + regex. **A `: string` TS annotation doesn't guarantee runtime
safety — but neither does a 17-digit-looking field guarantee danger. Probe the real bytes before
assuming a precision bug.**

**ROOT CAUSE OF THE 2026-06-03 INCIDENT = BMI's `payment/confirm`, server-side (NOT our code).**
Confirmed by repro on W38433/W38445/W38446: we send the booking's correct raw `orderId`
(e.g. `…675359`) at `payment/confirm` ([OrderSummary.tsx](apps/web/app/book/race/components/OrderSummary.tsx)
injects `"orderId":${bill.billId}` as a raw token, `bill.billId` = the regex `rawOrderId`), yet
BMI creates/links the **project at `…675360` = `Number(orderId)`** (GET `project/…359`→404,
`project/…360`→200). Since we never send `…360`, BMI is rounding the orderId through `JSON.parse`
on **their** end. It "started recently" because older orderIds were coincidentally multiples of 8
(e.g. `…670152`, offset 0); as the counter climbed, `Number()` now lands `+1`. Compounded by a
**known BMI bug** — `payment/confirm` auto-cancels paid online reservations (`stateId -4`,
`userUpdatedId -1`) — which we already document and work around in
[`bmi-cancel-sweep`](apps/web/app/api/cron/bmi-cancel-sweep/route.ts) ("remove when BMI fixes
payment/confirm"). **Fix belongs to BMI; our mitigation is the recovery cron.** `parseWithRawIds`
does NOT fix this — our parse was never the problem.

**Our durable mitigation = the recovery cron, hardened** (BMI must still fix the parse at source).
Since we can't stop BMI's auto-cancel, [`bmi-cancel-sweep`](apps/web/app/api/cron/bmi-cancel-sweep/route.ts)
resets BMI-auto-cancelled paid reservations `-4 → -3`. A prod audit found it was leaving paid
reservations dead: hardcoded to **ftmyers only** (Naples never recovered), gated on **stale payment
markers** (`payMethodId=42603617` matched 0/73), and **hard-skipping** name="Online"/`personId=-6`.
Reworked to: run **both centers**; recover on a **hybrid gate** — match to a confirmed
booking-record (`bookingrecord:res:{number}`, [booking-record/route.ts](apps/web/app/api/booking-record/route.ts))
OR (`userUpdatedId === "-1"` [BMI's auto-cancel signature] + has-payment + not intentionally
cancelled); parse responses with `parseWithRawIds`; `?dryRun=1` for safe inspection.
**Key discriminator:** BMI's auto-cancel stamps `userUpdatedId = -1`; our intentional cancels go via
the Office API as user `API2`, so they carry a different id — that's how recovery avoids re-activating
refunds. `parseWithRawIds`/`serializeWithRawIds` remain in `@ft/db` as the documented inbound tools
(the cron uses `parseWithRawIds`); the speculative `bmi-office-actions`/`bmi-attraction-cancel` edits
were reverted (those Office ids are small quoted strings — no precision loss there).

**Rule:** never `res.json()` / `JSON.parse` a BMI or Pandora response that carries ids. Use one of:
- `parseWithRawIds(await res.text())` (`@ft/db`) — quotes id fields before parsing so they come
  back as full-precision strings. The inbound counterpart to `stringifyWithRawIds`.
- For GET→mutate→PUT round-trips, pair it with `serializeWithRawIds(obj)` — re-emits ids as the
  raw numeric tokens BMI expects (handles nested ids like `persons[].id`, which
  `stringifyWithRawIds`'s top-level injection can't).
- Or the original `res.text()` + regex extraction (`extractRawOrderId` in `data.ts`).

**Don't `JSON.stringify` an id ARRAY either** (e.g. `personsByIds`): a `string[]` quotes the ids,
a `number[]` rounds them. Build the body as raw tokens: `'[' + ids.join(',') + ']'` (digit-validated).

## CRITICAL: Shared top-level routes need middleware update for HeadPinz (2026-04-30)

**ALWAYS add new shared routes to `isSharedTopLevelRoute` in `apps/web/middleware.ts`.**

The middleware rewrites every HeadPinz request to `/hp{pathname}`, so `headpinz.com/foo` becomes
`/hp/foo` internally. If `app/hp/foo/page.tsx` doesn't exist, HeadPinz visitors get a 404 even
though `app/foo/page.tsx` exists and renders correctly on fasttraxent.com.

The fix is to add the route to the `isSharedTopLevelRoute` allow-list so it bypasses the `/hp`
rewrite and serves the brand-aware page directly on both domains.

**Whenever you create a new top-level page that must work on BOTH domains, do this in the SAME
commit:**

```ts
// apps/web/middleware.ts
const isSharedTopLevelRoute =
  pathname === "/accessibility" || pathname.startsWith("/accessibility/") ||
  pathname === "/cancellation-policy" || pathname.startsWith("/cancellation-policy/") ||
  pathname === "/your-new-route" || pathname.startsWith("/your-new-route/");
```

**Required pairing for any new shared page:**
1. `app/<route>/page.tsx` — uses `headers()` to detect `host` and renders the brand-aware version
2. `middleware.ts` — add `<route>` to `isSharedTopLevelRoute`
3. Test on BOTH domains before committing — fasttraxent.com AND headpinz.com

**Smell test:** if a new page uses `headers()` to switch on `host.includes("headpinz")`, the
middleware update is mandatory. There is no scenario where one without the other is correct.

## Square gift card mint pitfalls — read these before touching the survey/comp gift card path (2026-05-20)

Spent the better part of a day chasing "card invalid or not activated" + 502s before
getting an end-to-end merchant-comp gift card flow working. Four traps, none of them
in Square's docs as a single page.

### 1. ACTIVATE-by-order is the ONLY path that works for a merchant-comp card

For a customer-purchase card you can `POST /gift-cards/activities` with
`amount_money` + `buyer_payment_instrument_ids`. For a merchant-comp (no buyer),
you MUST go through an Order:

```
1. POST /v2/orders                — eGiftCard line + catalog discount → $0 total
2. POST /v2/orders/{id}/pay       — empty payment_ids (discount covered it)
3. POST /v2/gift-cards            — { type: "DIGITAL" }
4. POST /v2/gift-cards/activities — ACTIVATE with order_id + line_item_uid
```

Trying to pass `amount_money` alongside `order_id + line_item_uid` returns
`"Provide either order_id and line_item_uid OR provide amount and
buyer_payment_instrument_id"`. The two pairs are mutually exclusive.

Square reads the load amount from the line item's `gross_sales_money`
(base_price × qty), NOT `total_money`. So a $5 line with a 100% discount still
activates the card with $5.

### 2. FIXED_PERCENTAGE catalog discounts: omit `amount_money`

Our `"Gift Card - Guest Survey (500.088)"` (`37C3SN4245TUCN3RF7XMNKPU`) is
configured as FIXED_PERCENTAGE 100%. Including `amount_money` on the discount
object is a 400: `"Do not provide a value for amount_money if you provide a
catalog_object_id that references a fixed-percentage discount."`

```ts
discounts: [{ catalog_object_id: discountCatalogObjectId }]  // ✅
discounts: [{ catalog_object_id: ..., amount_money: { ... } }]  // ❌ for FIXED_PERCENTAGE
```

Pandora_API passes `amountMoney` because its discount is FIXED_AMOUNT — don't
copy-paste their pattern without checking the discount's `discount_type` first.

### 3. `actRes.ok` is not enough — Square returns 200 with `errors[]` on idempotency replay

The bowling-orders flow already accounts for this:

```ts
const data = await actRes.json();
if (!actRes.ok || data.errors) { /* surface the error */ }
```

Our reward path was only checking `!actRes.ok` and silently passing through
200-with-errors. Result: code returned a "success" with a GAN, but Square
never recorded the ACTIVATE activity. The card stayed PENDING $0. Every
survey-reward gift card minted today before `bda710b` ended up unusable.

**Belt-and-suspenders:** after activate, GET `/gift-cards/{id}` and assert
`state === "ACTIVE"` and `balance_money.amount > 0`. The extra round-trip is
cheap insurance against any future silent-failure mode.

### 4. Customer-facing URLs need the `gftc:` prefix STRIPPED

Square's API returns the gift card id as `gftc:<hex>`. But the customer-facing
balance and Apple Wallet URLs expect the hex only:

```ts
const giftCardIdShort = giftCardId.replace(/^gftc:/, "");
const balanceUrl = `https://squareup.com/gift/balance/${giftCardIdShort}`;
const walletUrl  = `https://squareup.com/apass/gc/download/personalized/${giftCardIdShort}?source=egift`;
```

Verified by curl on a known-ACTIVE $5 card:
- `/apass/.../{stripped}`     → `HTTP 200 application/vnd.apple.pkpass` ✅
- `/apass/.../gftc:{full}`    → `HTTP 404` ❌
- `/gift/balance/{stripped}`  → real balance page (SPA-rendered) ✅
- `/gift/balance/gftc:{full}` → Square's generic eGift landing page (looks like "invalid") ❌

Same convention Pandora_API uses (`cardID.split(":")[1]` before building URLs).
Both `app.squareup.com` and `squareup.com` work for `/gift/balance/`; Apple
Wallet uses `squareup.com` only.

### 5. The `state=ACTIVE` gift-cards LIST filter lags

`GET /gift-cards?state=ACTIVE` is indexed and can lag minutes behind. A card
that just activated may not appear in the list filter even though
`GET /gift-cards/{id}` returns `state: "ACTIVE"` immediately. Always verify
state by direct retrieve, never by absence from the LIST filter.

### Where to look
- [apps/web/lib/square-gift-card.ts](apps/web/lib/square-gift-card.ts) `mintDigitalGiftCard()` — canonical mint flow with defensive checks
- [apps/web/app/api/square/bowling-orders/route.ts](apps/web/app/api/square/bowling-orders/route.ts) — pre-existing working flow that already had the `data.errors` check
- `Pandora_API/src/utils/square.utils.ts` / `controllers/squareV2.controllers.ts.ts` — reference implementation for both mint and URL construction

## Booking v2: the persisted session is a VERSIONED ENVELOPE — never read raw `sessionStorage` (2026-06-07)

`usePersistedReducer` writes the booking session wrapped in `{ v: SCHEMA_VERSION, session }`
(the envelope was added when the up-front ContactStep shifted step indices — bump `v`
on any shape/step-order change so stale sessions are discarded, not resumed mid-flow).

The bug: two components read `sessionStorage` directly and assumed the OLD flat shape —
`PromoLanding` (`session.items`) and `MiniCartV2` (`session.items ?? []`). After the envelope
landed, `parsed.items` was `undefined` on both, so the landing's "Add to your visit" checkout
bar and the floating mini-cart silently vanished — the cart still existed, it just looked empty.
A `: string`/array type didn't help; the raw `JSON.parse` is `any`.

Fix + guardrail: added `peekBookingSession()` to the hook (unwraps the envelope + version-checks,
exactly like in-flow hydration) and routed BOTH readers through it. **Rule: any code that needs
the cart outside `<BookingFlow>` calls `peekBookingSession()` — never `JSON.parse(sessionStorage…)`.**
When you change a persisted shape, grep every reader; better, give the shape ONE reader and import it.
SSR note: read browser storage via `useSyncExternalStore` (server snapshot `0`), not a `setState`
in `useEffect` — the React-Compiler lint rule `react-hooks/set-state-in-effect` flags the latter and
it risks a hydration mismatch.

Related: back-out now offers "New booking" (not "Cancel") in `LeaveConfirmModal`, calling
`abandonBooking(session)` (checkout.ts) → cancels the BMI bill (heats + slots + attached contact)
AND releases any QAMF bowling/KBF hold. Needed because contact-first creates the BMI reservation
early (on first heat/slot advance), so an abandoned session would otherwise orphan a live reservation.

- [apps/web/src/features/booking/hooks/usePersistedReducer.ts](apps/web/src/features/booking/hooks/usePersistedReducer.ts) — envelope + `peekBookingSession`
- [apps/web/src/features/booking/service/checkout.ts](apps/web/src/features/booking/service/checkout.ts) `abandonBooking()` — full session teardown

## Loyalty reward verification: query Square directly, not logs or BMI math (2026-06-09)

Wrong call I made: told the user "no loyalty reward was applied" to a booking, based on a
multi-agent workflow whose log-reader + adjudicator concluded "no reward" from (a) no
`CreateLoyaltyReward` line in the Vercel log index, (b) a 200 (not 422) response, and (c) BMI
bill-overview totals. The user pushed back ("I think it did take my points") — and was right. A
read-only Square query proved a `$10.00 off` reward (tier `0f5c8c00`, ORDER scope) was ISSUED
against the Square day-of order at the exact reserve second; the order carried
`total_discount_money $10.00` + `discounts[].reward_ids` + `rewards[]`.

Why the workflow was wrong — three traps, all pointing the same way:

- **Vercel's runtime-log INDEX is not the full log.** It surfaces one summary line per request +
  `console.error`/`console.warn`; it does NOT contain every `console.log`. Absence of the reward
  log line is NOT evidence that no reward was created.
- **A Square reward adjusts the SQUARE day-of order, never the BMI bill-overview.** Reasoning
  about BMI `subTotal`/`total` gaps says nothing about whether a Square reward exists. (The
  adjudicator confidently dismissed the one investigator who happened to be right, with a
  plausible-but-wrong argument — adversarial verification can be unanimously wrong when every
  agent shares the same blind spot: nobody read Square.)
- **ISSUED ≠ no effect.** An order-attached reward sits `ISSUED` (points locked) until the order
  is PAID, then auto-redeems. An `OPEN` order with `tenders: []` is the normal pending state
  (day-of order settles at check-in), not a failure.

**Rule:** to confirm a loyalty reward's state, hit the source of truth, not inference —
`GET /v2/orders/{dayofOrderId}` (check `discounts[].reward_ids`, `rewards[]`,
`total_discount_money`) and `POST /v2/loyalty/rewards/search` for the account. Read-only Square
scripts use the prod token in `apps/web/.env.local` (see `apps/web/scripts/loyalty-diag.mjs`,
`order-check.mjs`). For a factual "did X happen in an external system" question, ONE authoritative
source query beats any amount of log/heuristic inference — go there first, not last.

Also confirmed: the earlier "reward couldn't be applied" failures were the rewards list offering
`ITEM_VARIATION`-scoped tiers (pizza/nachos) that can't apply to a bowling/attraction ORDER —
fixed by the ORDER-scope-only filter in `LoyaltySection.tsx`. Today's two bookings each created a
clean ORDER-scope `$10 off` (ISSUED), proving the fix works.

## Group-function resend dropped date/time changes + EST offset bug (2026-06-09)

Two distinct bugs, both surfaced when a planner moved an already-sent (pre-deposit) event and
re-flipped BMI to "Send Contract." Symptom: the contract page kept the OLD date/time while the
notes updated correctly. (Notes render live from BMI via `/api/group-function/event-details`;
date/time renders from the stored `event_date_display` column — so a stale column shows while
notes look fresh.)

**Bug 1 — resend's "pricing unchanged" path never wrote the date.** In
`group-quote-dispatch/route.ts`, the `pricingUnchanged` branch (status `contract_sent`, no
deposit yet) updated contacts + notes but omitted `event_date` / `event_date_display`. A
date-only move (same products/total) takes this path, so the new date never landed. The
post-deposit branch already wrote the date — this only bit pre-deposit. Fix: the branch now writes
`event_date`, `event_date_display`, `event_number`, and `line_items` from BMI on every resend, and
logs the date diff into the contract version. **Rule: a resend must pull through anything that
changed, not just contacts/notes — totals being equal does not mean the event is unchanged.**

**Bug 2 — hardcoded `-04:00` (EDT) on tz-less BMI dates.** BMI returns ET wall-clock with no tz
(`"2026-12-19T18:00:00"`). The code appended a literal `-04:00` in three places
(`bmi-scan.ts`, the dispatch `formatEventDate`, `ingest-legacy`), so every EST-season (Nov–Mar)
event displayed and stored **one hour early** (Dec-19 6 PM → 5 PM). Fix: new `lib/et-time.ts`
(`normalizeEtDate` / `formatEtDateTime`) derives the correct EDT/EST offset from the IANA tz db via
`Intl` (no month approximation); all three call sites now use it. **Rule: never hardcode a US-ET
offset — Eastern flips between -04:00 and -05:00. Use `lib/et-time.ts`.** This is the same tz
round-trip class the sync-cron header warns about.

Remediated live: quote 135 (#1359 Valerie's House) Jun 26 1:30 PM → Jun 28 2:30 PM; quote 139
(#3356 Gulf Coast Brain & Spine) Dec 19 5:00 PM → 6:00 PM. Both via
`apps/web/scripts/remediate-stale-dates.mjs` (re-runnable, audit-logged as
`manual_date_remediation`).

## Gift-card / deposit funding must ALWAYS equal the day-of Square order total (2026-06-09)

**Rule (user, verbatim intent): "Never tax inclusive. We take deposit based on day of square."**
The deposit charged at booking — and therefore the eGift card balance that pays the day-of order
at lane-open — must equal the **day-of Square order `total_money`** (which already includes county
sales tax). Do NOT compute a deposit from a pre-tax subtotal and hope it matches; derive it from the
order.

**The bug.** Regular bowling never created a Square quote (only KBF did), so the reserve route funded
the deposit/gift card from the **pre-tax** subtotal while the day-of order total was tax-inclusive.
At lane-open, `bowling-lane-open.ts` pays `min(giftCardBalance, orderNetDue)` from the gift card
against the order; the gift card was short by exactly the county tax (FM 6.5% / NAP 6%), so Square
rejected the payment: **"The payment total does not match the order total."** 15 upcoming
reservations were affected; the admin board showed `ERR WEBHOOK` with `$paid / $orderTotal` where
paid = orderTotal ÷ 1.0(6/65).

**Two compounding traps found during remediation:**
1. A **non-transient** lane-open error sets `dayof_order_sent_at = NOW()` (bowling-db.ts
   `updateBowlingReservationLaneOpen`), which trips the guard in `processLaneOpen` — so the
   lane-poll cron will NEVER retry it. Remediation must clear `dayof_order_sent_at` (+ the error)
   for unpaid rows, or the poll won't re-attempt.
2. `processLaneOpen` uses a **stable** idempotency key (`lane-open-{id}-pay`). The first failed
   attempt burns that key with the OLD amount; after topping up the gift card, the retry with the
   NEW amount fails with "Different request parameters used for the same idempotency_key." Those
   rows need a one-time settle with a **fresh** key (`comp-resettle-{id}-pay`).

**Square gift-card comp:** add complimentary balance via `POST /v2/gift-cards/activities`
`type: ADJUST_INCREMENT`, `adjust_increment_activity_details.reason` is an **enum** —
use `"COMPLIMENTARY"` (free text is rejected). Drives gift card → order total with no customer charge.

**Forward fix (deployed, commit 1196a8c4):** CheckoutStep now quotes every bowling/KBF item at
`depositPct=100` so the charge == the quoted day-of order total (tax-inclusive). Remediation scripts:
`apps/web/scripts/{audit-giftcard-gap,comp-giftcard-gap,settle-stuck}.mjs` (re-runnable, dry-run
default). Comped 15 gift cards, $89.50 total, on 2026-06-09.

---

## Credit redemption must be RACER-aware, not product-aware (2026-06-10)

**Symptom:** A racer with both a racing membership discount (League Racer −20%) and a race
credit saw "Credits Applied −1 credit" on the checkout review, but **Due Now never dropped**
($17.88, full discounted price). The credit was counted but applied no dollars.

**Root cause (a guard I added during the per-racer membership-discount work).**
`raceItemChargeLines` splits one logical race line into a full-price line + a discounted line per
distinct racing-discount % (both share the same `bmiProductId`). To avoid double-redeeming when a
product split into two lines, `applyCreditRedemptionsToOverview` keyed redemptions by `bmiProductId`
only and then **skipped any line with `membershipDiscountPct`**. That guard is wrong whenever the
**redeemer IS the discount-holder**: there's no separate full-price line for their heat, so the
credit landed nowhere — shown but never subtracted.

**Fix (commit c1359090):** make redemption racer-aware. Attribute each redeemed heat to the EXACT
split line it belongs to by matching **(productId + discount%)**, where the % is computed by a
single shared `racingDiscountForMember(member)` helper used by BOTH the line build and the credit
attribution — so they can't disagree on which line a racer is on. Also dropped the `m.redeemCredits`
short-circuit in `racingDiscountFor`: a redeeming member now KEEPS their discount on heats they pay
cash for, and the cash path (`unifiedReserve` → `buildRaceChargeLines` + `redeemedHeatSet`) rebuilds
with the same helper, so displayed == charged on every path (full redeem, partial, none).

**Guardrails for next time:**
- When you split a charge line by an attribute (discount %, racer, category), any downstream logic
  that *matches* lines (credit redemption, reward redemption, tax) must match on the SAME composite
  key — never on a sub-key (productId alone) that two split lines now share.
- A blunt "skip lines with property X" guard is a smell. If you're skipping a line to avoid
  double-counting, the real fix is usually a more precise key, not exclusion.
- Share the discriminator (here: the per-racer discount %) through ONE helper so the builder and the
  matcher can't drift. Two copies of the rule = a latent display/charge mismatch.
- For any race money change, prove display == charge on all three credit cases: redeem-all (credit
  order → /reserve), partial (cash path keeps discount on leftover heats), none.

---

## Race "charged but empty in BMI" — auto-cancel-pending before payment (2026-06-10)

**Symptom:** A FastTrax race booking is charged on Square (deposit COMPLETED) and shows "confirmed,"
but the BMI bill/reservation is EMPTY — no products, no schedule, `payments:[]`. A 14-day audit found
**13 such bookings (~$2,455 collected), ~1/day.** Detect: Square payment note
`FastTrax - Deposit | Ref: <billId>` COMPLETED, but `order/<billId>/overview` has `lines:[]` AND
`scheduleDays:[]`; the BMI Office project shows `schedule.stateId = -4`, `products:[]`.

**Root cause (confirmed by BMI support):** the reservation sits in **Pending Online** longer than
BMI's **auto-cancel-pending** setting (was 10 min). BMI auto-cancels the reservation AND strips the
bill's products/schedule. When the Square payment is then initiated, BMI returns **status 4
"BillNotFound"** — the BMI payment is never recorded — **but our Square card charge still completes.**
The `bmi-cancel-sweep` later flips the *project* to `-3` (Confirmation) but cannot re-add stripped
products → confirmed-on-paper, empty-in-reality.

**The defect on our side:** we charge the card on Square and only THEN tell BMI, without verifying
BMI can still accept the payment, and we don't void the Square charge when BMI returns BillNotFound.

**Guardrails:**
- **Never charge a card before confirming the downstream booking is still live.** Re-fetch the BMI
  reservation/bill overview IMMEDIATELY before initiating the Square charge; if it has no
  products/schedules/settle-total (auto-cancelled), abort and restart the booking — do not charge.
- Track per-order time-since-last-modified vs the auto-cancel-pending window; if exceeded, re-create
  the reservation via API (if data is retained) or time the user out and restart.
- Operational stopgap: raise the BMI auto-cancel-pending setting (FM was bumped to 20 min; 60 min
  avoids it). Setting lives in BMI, owner-controlled — fastest mitigation while the code guard ships.
- A COMPLETED Square charge does NOT imply the BMI booking exists. Verify both sides when auditing
  "did the customer actually get what they paid for."
- Latest BMI API specs (2026-06): https://bmileisure.atlassian.net/wiki/external/YTYwMTA3YjAyNWVkNDAzMmJhNDkxZWE5OWZiYTc5YmM


## Square: paying an ORDER with gift cards — the four rules (2026-06-12)

H2821 ($2,231 day-of check, two gift cards: $2,000 + $231) was stranded for a day by four
separate Square constraints, each discovered the hard way. H3011 (YMCA) was stranded 3 days
by the first one alone. The group-dayof-pay cron now encodes all four.

1. **Payment location MUST equal the order's location.** HeadPinz-brand events store the
   FastTrax FM location on the quote while the day-of order is created at the HeadPinz FM
   location — always pay at `order.location_id`, never `quote.square_location_id`.
2. **A payment attached to an order must cover the FULL amount due.** Partial CreatePayment
   (autocomplete:true) is rejected; a multi-card check can never be paid card-by-card that way.
   Multi-tender = CreatePayment per card **with `order_id` AND `autocomplete:false`**, then
   `POST /orders/{id}/pay` with all payment_ids. Creating WITHOUT order_id silently attaches
   each payment to its own auto-generated order — PayOrder then can't adopt it.
3. **Creating payments on an order bumps its version.** PayOrder must use the version
   refetched AFTER the creates or it fails VERSION_MISMATCH.
4. **Idempotency keys burn forever on a canceled payment.** Square replays the canceled
   payment on every retry of that key — a retry loop with stable keys can never self-heal
   after one failure+void cycle. Bump the key namespace when changing the payment shape
   (hence gf-dayof-mt3/payorder3), and record the REAL Square error detail in the DB
   (`dayof_payment_error`), not a generic message — the generic one cost an evening of log
   archaeology because Vercel's log viewer truncates messages.

Also: gift cards cap at $2,000 balance, so any event over $2k is ALWAYS multi-card — the
multi-tender path is the norm for big events, not the exception.


## Group contracts: balance_cents must derive from collected_cents, never deposit_due_cents (2026-06-12)

H2925 (Tracie Thomas, HPFM 6/14): guest paid the original $746.56 in full (deposit 5/28 +
72h auto-charge 6/11, collected_cents = 74656). Party was then repriced 2 lanes -> 4 lanes
($1,589.73). The dispatch cron's POST-SIGNING update path recomputed
`balance_cents = totalCents - existing.deposit_due_cents`, which erased every payment beyond
the deposit: the contract showed "$381.61 paid / $1,208.12 due". Resending can't fix it - the
resend re-enters the same cron. A sweep found one more victim (H1136, completed, paid in full,
showed $449.51 due). Both rows repaired in place.

**Guardrails:**
- The schema's universal rule (`collected_cents` comment in group-function-db.ts) is the ONLY
  valid derivation: `amount_due = total_cents - collected_cents`. `deposit_due_cents` is a
  point-in-time quote of the FIRST payment, not a record of money received - it is even
  rewritten on reprice (full-total within 96h of the event), so it can't reconstruct payments.
- Display must read the same source the charge path reads. resign-settle charges
  `total - collected`; the contract page now displays paid = `collected_cents` and
  due = `total - collected` for re-signs, so displayed amount == charged amount even if
  balance_cents is ever stale again (same principle as the Statsig displayed-vs-charged rule).
- Data-repair sweep for this corruption class:
  `SELECT id FROM group_function_quotes WHERE deposit_paid_at IS NOT NULL AND collected_cents > 0
   AND balance_cents <> GREATEST(0, total_cents - collected_cents)
   AND status IN ('deposit_paid','resign_required','balance_charged','balance_link_sent','completed')`
- Money was never at risk here: resign-settle, the 72h cron (status-gated), and /pay
  (balance_paid_at-gated) all guard correctly. The blast radius was display + stored balance only.

## "NO BOOKING FOUND" in the orphan audit ≠ "refund owed" (2026-06-13)

Reviewing reservations, I re-ran `audit-orphan-cart-payments.mjs`, saw 25 "NO BOOKING FOUND"
Apple Pay orphans + 2 `confirm_failed` bowling charges, and reported them as open remediation.
Wrong on every count:
- The audit reports **whether a booking exists**, NOT **whether the charge was refunded**. Checking
  Square refund status showed 23 of 25 were already refunded on 6-10.
- The 2 that remained (Barton $61.47, Courtney.e.brake $13.83) are on the owner's explicit
  **"value-received, do NOT refund"** list (5 held, $128.52) documented in the applepay-orphan-charges
  memory. They flag as "NO BOOKING" because they received value OUTSIDE our DB (manual Conqueror
  rebook / a separate later payment) — the email/±1-day match can't see that.
- The 2 `confirm_failed` bowling rows were both resolved: Loretta already refunded; Reinaldo paid
  ONCE (both his rows share one Square order/payment) and got his lane on the retry — a stale
  retry artifact, not a double-charge.

I nearly fired 2 refunds to customers the owner had decided to keep charged; the harness's
real-money block stopped it.

**Guardrails:**
- Before flagging ANY charge as "refund owed," check THREE things, not one: (1) does a booking
  exist, (2) `GetPayment.refunded_money` / status REFUNDED, (3) the owner-held list in the relevant
  incident memory. A charge is only open if all three say so.
- "NO BOOKING FOUND" from an email+date match is a *lead*, not a verdict — value can be delivered
  under a different email, a manual reservation in another system (Conqueror/QAMF), or a separate
  later payment.
- For `confirm_failed` bowling rows, join sibling rows for the same guest/day: a successful retry
  usually reuses the SAME `square_deposit_order_id`, so one capture can back two rows. Compare the
  order id before concluding double-charge.
- Read the incident memory IN FULL before proposing remediation — the body said "remediation
  COMPLETE except 5 held," but I acted on the stale one-line index hook. Fixed the hook.
