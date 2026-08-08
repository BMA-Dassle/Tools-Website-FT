# Lessons Learned

## A root layout does not re-render on navigation — anything it decides from `headers()` is frozen for the whole visit (2026-08-07)

**What happened:** clicking "Waiver" in the FastTrax nav landed on `/waiver` with the site
nav still pinned over the waiver's own header. A hard refresh cleared it. HeadPinz looked
fine, which made it read like a brand bug — it wasn't.

`app/layout.tsx` picks the chrome from request headers that `middleware.ts` sets
(`x-no-chrome`, `x-no-mobile-bar`, `x-brand`). That is correct exactly once, for the
document the browser loads. Next.js partial rendering means a client-side navigation
re-renders only the segments BELOW the shared layout — the root layout never runs again
(`node_modules/next/dist/docs/01-app/02-guides/authentication.md`: layouts "don't re-render
on navigation", which is also why an auth check there is a known footgun). So the chrome
decision made for `/pricing` rode along onto `/waiver` and stayed there until a full
document load. HeadPinz hid the symptom because its nav is rendered by the per-section
layouts under `app/hp/`, which DO unmount when you navigate off `/hp` — different
mechanism, same latent bug on its own shared top-level routes.

**The rule:** anything a root layout derives from `headers()`, `cookies()` or the URL is a
property of the ENTRY REQUEST, not of the current page. If it can change while the visitor
stays in the SPA, it needs a client-side re-evaluation:

- Put the path→decision rule in one pure, dependency-free module — here
  `src/lib/constants/chrome-routes.ts`.
- Middleware reads it for the entry render; a small client component reads it on every
  navigation (`src/components/layout/ChromeGate.tsx`, which seeds from the server's answer
  on first render so hydration still matches).
- Never write the same path test twice. Middleware had the mobile-bar list duplicated per
  host, and the drift had already shipped once (`/racer` bar on FastTrax only, 2026-08-06)
  and again silently (HeadPinz booking confirmations kept the bar FastTrax dropped).

**Smell test before shipping a layout-level decision:** click into the route from the site's
own menu, not just by pasting the URL. Pasting a URL is a document load and hides every bug
in this class.

## A feature that shipped dark stays dark — reservation-edit v2 sat unusable for 27 days behind `=== "true"` (2026-08-07)

**What happened:** owner: _"Reservation edit v2 needs to be enabled by default."_ The engine
was fully built and merged 2026-07-11/12 (~150 unit tests, live smoke 18/18 · 18/18 · 20/20)
and had been **completely unreachable in production ever since**, because all four rollout
vars were written as opt-in gates — `process.env.X === "true"` — and nobody ever set them.
The one env var the plan doc told the owner to set was never set either, so the "remaining
steps" list in three tracker files described a state that never happened.

The polarity was duplicated in **five** places (route, planner preview ×2, a local `flag()`
helper in the executor, and its own `refundFlagForPhase` lookup) across four files. Five
independent chances to drift; the planner's preview and the route's gate had already drifted
once before (recorded in the 2026-07-28 entry below).

**Fix:** one exported helper, `editFlagEnabled(name) => process.env[name] !== "false"` in
`guards.ts` — the module every layer already imported — with the route, the preview, and the
executor all reading through it. Guard copy flipped from "not switched on yet — ask Eric to
enable it" to "has been switched off (`X=false`)", because under kill-switch semantics a
blocked message means someone deliberately threw the switch.

**Rules:**

- **`=== "true"` is the bug, not the config.** CLAUDE.md has said "FLAGS ARE KILL SWITCHES
  ONLY" since 2026-07-31, and this engine predates that rule — but re-reading it is what
  makes a flip like this a two-line decision instead of a debate. When you write a rollout
  var, write `!== "false"` the first time. An opt-in gate converts "we shipped it" into "we
  shipped nothing" silently, and the only symptom is a feature nobody uses.
- **Flag polarity belongs in ONE helper, exported from the module the gates already share.**
  Not a `const flag =` copied into each consumer. The preview and the enforcement gate must
  be physically incapable of disagreeing — that is a code-structure property, not a
  code-review promise.
- **A test that asserts "blocked when the var is unset" stops testing anything the moment
  polarity flips — it just re-asserts the new default.** Every such test had to be rewritten
  to set the exact string `"false"`. When you flip a default, grep the tests for `delete
  process.env` and `= "true"` and check each one still fails for the reason it was written.
  Same for scripts: `post-dayof-refund-smoke.mts` "proved" the master switch was off by
  deleting the var, which after the flip proved the opposite.
- **A stale "DO NOT ENABLE" outlives the reason for it.** Both refund switches carried that
  banner from assumption A1, which was *overturned live on 2026-07-27* — the code comment in
  `service.ts` said so, three tracker docs and a memory file still said "DO NOT ENABLE."
  When you overturn an assumption, grep its name and retire every banner in the same commit.
- **Ship default-on when the failure mode is loud and money-safe.** The QAMF player-DELETE
  vendor bug is real and unfixed, but it fails with names/title still synced, no money
  touched, and an explicit "adjust bowler count in Conqueror manually" warning. Degraded and
  loud is a reason to ship with a kill switch, not a reason to ship dark.

## An idempotency key must contain every field that makes the operation distinct — a missing personId gave a party free races (2026-08-06)

**What happened:** W58352 — a kiosk party of 4 booked 3 heats each and bought four 3-race
Weekday packs. BMI granted all 12 credits. Only **3** came off, and all 3 came off ONE
racer (Brett Conlon); the other three raced 3 heats each on credits that were never drawn.

The cause is one line in `deductCreditRedemptions`:

```ts
// WRONG — no personId
const guardKey = `race-credit-redeemed:${opts.billId}:${r.ref}:${r.depositKindId}`;
```

`ref` is the **heat block id**, and `RaceItem.heats` documents that *"multiple racers on
the same heat share heatId but have distinct entries (one per racer)"*. So all four racers'
redemptions for the 20:24 heat produced the **same** Redis NX key. The first `SET NX` won;
the other three logged `already applied, skipping` and never called `addDeposit`. The
charge path is unaffected — it drops covered heats to $0 off the heat OBJECT set — so the
guest was correctly charged $0 for 12 races while only 3 credits were spent.

The production log is the whole bug in twelve lines:

```
[race-pack] granted 3 (kind 12744867) to person 63000000006517986 (Brett Conlon) → deposit 57971034
[race-pack] granted 3 … to person 57968585 (Frank Heisner)  … (×4 racers, 12 credits)
[race-credit-redeem] deducted 1 (kind 12744867) from person 63000000006517986 → deposit 57971044
[race-credit-redeem] already applied, skipping race-credit-redeemed:63000000007527876:2026-08-06T20:24:00:12744867
[race-credit-redeem] already applied, skipping race-credit-redeemed:63000000007527876:2026-08-06T20:24:00:12744867
[race-credit-redeem] already applied, skipping race-credit-redeemed:63000000007527876:2026-08-06T20:24:00:12744867
… same for 21:12 and 21:36
```

**The rule:** an idempotency key must be keyed on the full identity of the operation it
guards. Here the operation is "draw one credit from **this person** for **this heat** on
**this bill**" — three nouns, and the key held two. Before writing a guard key, name the
operation in a sentence and check that every noun in it appears in the key. A guard that is
too NARROW double-writes and is caught in testing; a guard that is too WIDE silently
*skips* work, succeeds, and logs a reassuring "already applied."

**Corollaries:**

- **A shared id is not a unique id.** `heatId`, `orderId`, `billId`, `sessionId` are all
  one-to-many. If N rows can carry the same value, that value alone can't key a per-row guard.
- **Compare the guard's cardinality against the collection you're iterating.** The walk
  produced 12 redemptions; the guard admitted 3. Any time `redemptions.length` and the
  number of writes diverge, that difference is the bug — log both, or assert them equal.
- **The "skip" branch of an idempotency guard needs a test.** There was no test file for
  `race-credit-redeem.ts` at all. And a mock that returns `"OK"` unconditionally makes the
  collision test **vacuous** — the guard never skips, so the bug can't reproduce. Mock
  `SET NX` with a real `Set` so the second write actually returns `null`.
- Note the neighbouring retry queue got this right: `bmi_deposit_failures` conflicts on
  `(source, source_ref, person_id, deposit_kind_id, amount)` — **person_id is in the key.**

**Blast radius:** the Redis TTL is 7 days, so only that window is measurable. A sweep of
the live guard keys (`scripts/race-credit-guard-collision-sweep.mts`) flagged **62
reservations** with the fingerprint — every deduction landing on one person while other
racers on the same reservation held undrawn credits — totalling ~151 credits. The bug is as
old as the guard, so the true total is larger. Any party of 2+ sharing a heat was exposed,
on **both** the kiosk pack rail and the web credit rail.

## "Non-fatal" must mean deferred, not discarded — a swallowed vendor write silently lost $2,113.95 (2026-08-03)

**What happened:** Pandora's BMI **Office auth** endpoint (`user=API2`) returned ASP.NET
`Runtime Error` 500s for roughly six hours. `confirmAndRecordBmiPayment` is deliberately
non-fatal — the guest's card is already charged when it runs, so a BMI hiccup must never
surface as a payment error (the guest would pay twice). But "non-fatal" was implemented as
a bare `catch` + `console.error`: no retry, no queue, no alert. Two events' payments were
collected on the card and never reached BMI — 3373 Fireservice $1,772.56 and 3437 FSW
$341.39, the latter three days before its event. Nothing surfaced them. They were found
only by diffing our `collected_cents` against BMI's live payment ledger after the fact.

Two aggravating details:

- **A single `try` wrapped three independent steps** (state → payment → note), so the
  narrowest failure had the widest blast radius: a failing state update skipped the payment
  AND the note. Isolate each vendor call in its own try.
- **State updates survived the outage and payments did not**, because `setProjectState` has
  a Pandora fallback and `recordProjectPayment` is Office-only. A partial fallback makes an
  outage *look* handled in the logs while money quietly goes missing.

**The rule:** if you swallow an error on a path where money already moved, you owe the
system a durable record of what still needs to happen. Non-fatal means **enqueue and
retry**, never "log and forget." Pattern to copy: `lib/bmi-deposit-retry.ts` +
`/api/cron/deposit-retry-sweep` (Neon table, UPSERT idempotency key, escalating backoff,
park after `MAX_RETRY_ATTEMPTS` and keep reporting parked rows on every run — including the
idle run, so "gave up" never looks like "all clear").

**The trap when you build the retry — a failed POST is not proof the write didn't land.**
A timeout can follow a payment BMI recorded fine; blind retry double-posts real money into
a center's books. The sweep must re-read the vendor's ledger and post
`min(collected - recorded, vendorBalance, thisRow'sAmount)`, resolving as `already-square`
when that is ≤ 0. Capping by the row's own amount is what lets two queued failures on one
event (deposit + balance) settle independently instead of cannibalising each other.

**Also — not every gap is a gap.** The first scan flagged 15 events short in BMI totalling
$16,646.25. Only 2 were real. The other 13 had `square_settled_order_id` or `dayof_paid_at`
set: that money settled on a POS check inside BMI's own POS, and `group-square-settled-close`
writes a *note* only, by design. Recording project payments for those would have
double-counted $14,532.30. Always classify a reconciliation diff by *how* the money was
taken before "fixing" it.

Fix: `lib/bmi-project-payment-retry.ts` + `/api/cron/bmi-payment-retry-sweep` (every 5 min),
`confirmAndRecordBmiPayment` steps isolated and the payment step enqueuing on failure, all
four GF call sites passing `source`/`quoteId`/`sourceRef`. Guard pinned in
`lib/__tests__/bmi-project-payment-retry.test.ts`. Forensics kept as
`scripts/bmi-outage-recon.mts` (log-independent ledger diff),
`scripts/bmi-outage-gap-classify.mts` (real vs POS-settled), `scripts/bmi-outage-remediate.mts`.

## A vendor can change product config under a hardcoded confirm — BMI's unpaid money deposit releases SCHEDULES, not products (2026-08-01)

**What happened:** Kiosk booking W57040 (5 races + gel-blaster ×4) confirmed fine, guest
paid $233.13 on Square — and ~10 minutes later every planning row vanished off the BMI
reservation; staff re-added products/schedule by hand. Same evening, W56953's laser leg
did the same. Investigation (bmi:api:log + Neon + live BMI overviews of all 30 mixed
carts in 60 days) showed: the gel line WAS booked and never removed; what died was every
line's `scheduledTime`, and the bill showed `totalToDeposit: $51.12 / totalPaid: 0`.

**Root cause — two layers:**
1. BMI flipped the Nexus gel/laser products to REQUIRE a money deposit ~2026-07-22
   (old bills' price rows carry `shortName: null`, new ones `"m"`). No code of ours
   changed; the vendor config moved under us.
2. `unifiedReserveInner`'s STRICT $0 gate (`useZeroModel`) inspects only RACE items, so
   a MIXED cart (zero-model races + real-priced attraction on ONE bill) confirmed the
   whole bill as a $0 CREDIT — leaving the attraction's money outstanding. BMI treats an
   outstanding money deposit as unpaid capacity and RELEASES the lines' schedules
   (products stay; the guest silently drops off the arena dayplanner). Attraction-only
   carts always confirmed with real money → never affected. Every damaged bill since 7/24
   is in the `toDeposit > 0` group; every healthy one is at 0.

**The rules:**
- A "confirm as $0" gate must prove the WHOLE BILL is $0-model, not just one item kind.
  Pay BMI exactly its own `totalToDeposit` (now surfaced by `getBmiBillStatus`) — never
  assume which deposit kind a product wants; the vendor can change it without notice.
- `totalToDeposit > 0` on a confirmed BMI bill is a time bomb, not cosmetics: BMI
  un-schedules unpaid lines hours-to-minutes later. Treat any confirmed bill with money
  due as an incident.
- A reconcile cron that "drives forward" pending rows MUST have an age floor — the same
  night, race-confirm-reconcile picked up W57040's anchor 4s after insert and
  double-confirmed against the live reserve (confirmBmiPayment is NOT idempotent).

Fix (owner directive: "use the 0 key for those products"): FM gel/laser now book their
$0-KEY TWIN products — 43370936 / 43370955, the "QAMF Booking" variants that sell into
the SAME Nexus sessions with a single $0 money key (verified by live book+cancel probe).
Square owns the money (race $0-model convention); guest price stays in
`attractions-data`. The money-due confirm (`unified-reserve.ts` + `race-confirm-reconcile`
pay BMI's own `totalToDeposit`) stays as the safety net for the still-real-priced BMI
attraction products (FT/HP shuffly, FT duckpin, both Naples Nexus products) and
in-flight pre-deploy sessions. Plus: 3-min age floor on `getPendingBmiConfirms`, and
`apps/web/scripts/backfill-mixed-bill-deposits.mjs` settles already-booked unpaid bills.

## A cache in front of deadline-bounded work must never cache the ABSENCE of the result (2026-07-31)

**What happened:** `/api/waiver/context` cached its summary for 120s and ran the Pandora
waiver sweep (signed count + roster) only on a summary-cache MISS, bounded by a 2.5s
deadline. One cold request missing the deadline meant: summary cached WITHOUT the sweep
result, and every request for the next 120s early-returned off that summary — the sweep
never re-ran. The organizer clicked their email link and saw "2 registered" over an empty
roster, forever (pid 63000000006846994). Every piece behaved as designed; the composition
guaranteed the feature's headline payload could permanently fail to ship.

**The rule:** when a response is `fast part + slow bounded part`, the cache key must
distinguish "have the slow part" from "don't". Early-return from cache ONLY when the
complete result is present; a hit that is missing the bounded part falls through and
retries the work (per-item caches make each retry cheaper until it lands). Never let the
fast part's TTL suppress recomputation of the slow part.

**Also:** the same route 502'd an entire request on ONE transient `getReservationDetail`
failure. Multi-call upstream fetches on guest-facing routes get one retry before erroring.

Fix: `fix/waiver-organizer-roster` — sweep re-runs on summary-hit-with-no-state, deadline
2.5s→5s, one detail retry, pinned in `app/api/waiver/context/route.test.ts` ("cache
interplay" describe).

## BMI membership names are category-scoped — a substring match on "pro" is a qualification bypass (2026-07-30)

**What happened:** A 13-year-old holding only `Qualified Junior Intermediate` + `Qualified Junior
Pro` booked an **adult Pro Race Red** (bill 63000000006631238, res W55920). Every tier gate in the
booking flow — v1 `getRacerTier`/`filterProducts`, v2's verbatim port, and the per-racer selector —
decided qualification with `m.includes("pro")`, and `"qualified junior pro"` contains `"pro"`. Age
13 puts a racer in the ADULT category (junior is 7–13, adult is 13+ — 13 overlaps), so her junior
quals were read as adult quals and the whole adult catalog unlocked. There was **no server-side
check at all**: `assertHeatBookable` guarded scheduling rules only, so the client filter was the
single (broken) gate.

**Fix (`fix/junior-pro-tier-gating`):** one gating primitive, `qualifiedTierForCategory(memberships,
category)` in `race-products.ts` — adult scope counts only non-"junior" membership names; junior
scope counts everything (adult skill ⊇ junior). `filterProducts` (v1 + v2), both racer selectors,
and a NEW per-racer guard in `assertHeatBookable` (catalog products above Starter; packages/combos
exempt — Ultimate Qualifier legitimately books above current tier) all route through it.
`tierFromMemberships` survives as DISPLAY-ONLY and its doc says so.

**Guardrails:**

- **Vendor name strings that encode scope must be parsed with the scope, never substring-matched.**
  "Junior Pro" ⊃ "Pro" is the exact shape of bug a bare `.includes()` invites. One exported
  primitive owns the interpretation; every gate calls it.
- **Any client-side eligibility filter needs a server-side mirror at the money/booking choke
  point.** The restriction rules had one (`assertHeatBookable`); personal qualification didn't —
  so a UI bug shipped bookings the business forbids.
- **"Ports v1 verbatim" copies v1's bugs.** A parity port is a bug-compat contract; when the ported
  logic gates safety or eligibility, audit it instead of trusting the port.
- **Boundary ages belong to both ranges — decide explicitly.** Published rules say junior 7–13,
  adult 13+; the code buckets 13 as adult (`age < 13`), which silently strips a 13-year-old junior
  pro of their junior-tier access. Owner decision still open (flagged 2026-07-30).

## The waiver gate that never gated: 32 racers booked heats with no waiver (2026-07-30)

Owner, hours before the Christmas in July FM open house (7/30, racing 4:30–5:30): "None of
the waivers for the christmas in july submitted." Reality on inspection was worse than a
clean zero and better than a total loss — of 63 RSVPs carrying a BMI personId, **27 had a
valid waiver and 33 had none**, and every one of the 33 had walked the racer funnel
(name → DOB → waiver) and, in 30 cases, come out the other side holding a booked heat.

**Root cause — the gate is decorative.** In `app/event/[slug]/page.tsx`, `waiverValid` is
*read* in exactly three places: the step router, a green/amber "Waiver Signed / Waiver
Pending" badge, and its own setter. **No booking path consults it.** Worse, the session
restore sets `setWaiverValid(true)` on the sole evidence of a personId in `sessionStorage`
("They already signed if they have a personId in session"). So the failure mode is a
one-liner: guest signs → Pandora cold-starts and 5xx's → guest closes the tab → guest comes
back → restored as `waiverValid: true` → straight to the dashboard → books a heat. The
badge says "Waiver Signed." BMI says nothing. Nobody finds out until race day.

**Remediation:** `apps/web/scripts/xmas-waiver-backfill.mts` — reuses
`signWaiverDigital()` + the `method: "backfill"` audit row built for the Health Net
incident (2026-06-18). 32 signed, **32/32 verified by BMI readback**, 32 audit rows in
`waiver_acceptances`, every one carrying a real `waiverID`.

**Rules:**
- **A boolean named `xValid` that no branch reads is not a gate, it's a label.** Before
  trusting any "required before participating" step, grep the flag and find the branch that
  *refuses*. If the only readers are a setter and a badge, there is no gate.
- **Never restore a compliance flag from client storage.** `sessionStorage` proves the guest
  was here before, never that an upstream write landed. Re-probe the system of record
  (`waiverExpiry` on the person) on restore — the cheap GET is the whole point.
- **Verify a backfill by readback, not by response.** Sign → re-GET the person → assert a
  future `waiverExpiry`. `logWaiverAcceptance()` swallows its own errors by design, so a
  clean run log proves nothing about the audit trail; query the table.
- **A waiver signature must carry the guest's FULL legal name.** The RSVP record stores an
  abbreviated display name ("Jacob E.") — signing that is signing nothing. Pull
  `firstName`/`lastName` off the BMI person record.
- **Refuse to guess on legal records.** The backfill skips minors, unknown birthdates, and
  any person it cannot read, and reports them by name for the desk. 3 guests (2 with a
  17-digit BMI id stored in `personId` instead of the short Pandora id, 1 persistent 500)
  were handed to check-in rather than signed blind.
- **Pandora waivers are center-wide, not location-scoped.** Verified live: a waiver written
  at HeadPinz FM (`TXBSQN0FEKQ11`) reads back identically at FastTrax (`LAB52GY480CJF`).
  `pandoraLocation: "headpinz"` on a racing event is correct, not a bug to "fix."

## A readiness gate that covers 3 of 4 item kinds is a hole, not a gate — and a $0 cart leg still calls a vendor (2026-07-28)

**What happened:** A FastTrax kiosk captured **$234.21** (race + 4 race packs, BMI bill
63000000006468566) and then threw. The guest got the "Payment received — do NOT pay again" screen;
the center set the reservation up by hand.

**Root cause chain — four things had to line up, and every one of them was ours:**

1. The guest tapped the **Duck Pin** tile, pressed **Back** on the first step, and booked racing
   instead. Back-at-step-0 deliberately keeps the draft in the cart (KioskFlow.tsx: "Main menu
   offers removing it"), so a completely untouched bowling item stayed behind — `bookedAt: null`,
   `webOfferId: null`, no hold, `playerCount: 2`/`laneCount: 1` still at `newItem()` defaults.
2. `allItemsReady()` in CartView gated `race` (needs a heat) and `attraction` (needs product AND
   slot) — then returned a hardcoded **`true`** for `bowling`/`kbf`. Bowling was the one kind that
   could reach the pay screen unconfigured.
3. Duckpin prices through QAMF/Square, not the BMI bill, so a leg with no offer contributed **$0**
   and was invisible in the cart total. Nobody — guest or code — could see it in the money.
4. `unified-reserve` still iterated it and called QAMF with `webOfferId: 0` and
   `BookedAt: new Date().toISOString()` → **400 `{"BookedAt":["Millisecond must be 0."],
   "Customer.Guest.PhoneNumber"…}`** AFTER capture, taking the PAID race booking down with it.

Then two things stopped anyone from recovering or even noticing:

- The client's 3-attempt retry could never work. Attempt 1 activated the deposit gift card and
  failed at QAMF; attempts 2-3 failed **earlier**, at `BAD_REQUEST: Gift card must not be
  activated.` Square does not replay that off the idempotency key — it rejects on card state.
- `qamf-bowling-auth.ts` truncated the vendor body to **200 chars**, cutting the PhoneNumber rule
  mid-field. The single most valuable line in the failure was destroyed by our own logging.

**Fix (`fix/phantom-bowling-leg`):** `service/bookable.ts` — one pure predicate, a leg is bookable
with a hold OR (`bookedAt` AND `webOfferId`); `allItemsReady` uses it (bowling gated at last) and an
unfinished item turns the pay button into "Finish setting up X →" instead of a dead greyed-out
button; Back-at-step-0 drops an untouched draft; `unified-reserve` partitions unbookable legs out
before pricing, charge and confirm, and records each drop; the `bookedAt` fallback is
`nowRounded5EtIso()`; `createReservation`/`setReservationCustomer` normalize `BookedAt` (seconds and
ms to zero) and `PhoneNumber` (digits) at the client choke point; already-activated gift cards
verify balance and replay as success; vendor bodies keep 1200 chars. Plus
`lib/reserve-attempt-log.ts` — a durable Neon `reserve_attempts` row per attempt.

**Guardrails:**

- **A readiness/validation switch over a union MUST justify every arm.** `return true` for a kind is
  a decision, not a default — write down why, or gate it. Three arms guarded and one waved through
  is worse than no gate, because everyone downstream trusts it.
- **$0 is not the same as absent.** A cart leg that prices to nothing can still make vendor calls and
  fail a paid transaction. Reason about legs by whether they can BE BOOKED, never by what they cost.
- **Drop, don't throw, after the money lands.** When a leg cannot possibly succeed and carries no
  money, skipping it (loudly, durably logged) beats failing a captured booking.
- **Never truncate a 4xx validation body.** 200 chars is shorter than one vendor error list.
- **"Already in the target state" is success, not failure** — activation, confirmation, cancellation.
  A retry that dies EARLIER than the original failure is the signature of a non-idempotent step.
- **A screen that says "our team has been notified" must actually notify someone.** Ours didn't; the
  guest at the counter was the alert. (Alerting deferred by owner 2026-07-28 — the durable log
  lands first.)
- **Our own log, or it didn't happen.** Vercel runtime-log queries time out past ~3 minutes of
  window, retention is short, and there is no "what happened to bill X". Every money fan-out gets a
  Neon audit row with the FULL error, written before the charge and closed either way.

## A status field IS a claim — revoke it with the same reach you granted it (2026-07-28)

Owner report (W54793, racing that night): the sweep caught "no valid waiver," wrote
`** NO VALID WAIVER ** … send to Guest Services / kiosk to sign before racing` into the
BMI memo, cleared `fastLane` on the Redis record — and left the reservation sitting in
**"Confirmation - Kiosk"**. That custom state is only ever reached, on the kiosk rail,
*after* everyone has signed; staff read it as "waivers are done, send them to the karts."
The row contradicted its own memo, and nothing on the operational screens sided with the memo.

**Root cause:** express lane is granted in TWO places — `fastLane` on the booking record
*and* the kiosk confirmation state stamped by
`app/api/notifications/booking-confirmation` (owner 2026-07-21, express skips Guest
Services so staff work it from the kiosk state). The demotion only knew about the first
one. A grant with two limbs and a revoke with one leaves the louder limb standing.

**Fix:** `~/features/booking/service/express-revoke.ts` owns the state half —
`revertExpressKioskState()` reads the project, and reverts to plain Confirmation (`-3`)
**only if** it is still in the kiosk state (so `-4` cancelled, `-5` arrived, a waiver
state, or an already-plain `-3` are never clobbered — a blind `-3` would revive a cancel
or un-check-in a guest standing at the counter). `scripts/express-raceday-reverify.mts`
now writes memo + flag + state together, is re-runnable (an `expressRevokedAt` marker
keeps half-done rows in scope; the memo rewrite strips its own prior headline instead of
stacking a second one), and reports the live state in dry-run.

**Rules:**
- **When a warning and a status field disagree, the status field wins in the room.** Staff
  work from the list column, not the memo body. A demotion that leaves the status asserting
  the opposite of the memo has not demoted anything.
- **Enumerate every surface a flag was written to before you write the revoke.** Grep the
  grant (`fastLane` → record, express-session index, BMI state, race-day email, kiosk
  badge) and handle each, or state which ones you deliberately left.
- **Revert a state only from the value you set.** Read-then-compare; never blind-write the
  "default" state. Cancelled/arrived rows are someone else's now.
- **A remediation sweep must be idempotent and self-healing.** Gate on "was ever express,"
  not "is express" — otherwise the rows a half-finished earlier pass created are exactly
  the rows the next run can no longer see.


## A deterministic Square idempotency key locks a customer out after a card DECLINE (2026-07-25)

**What happened:** A customer booking a 6pm VIP experience (3 adults + 1 junior) hit
"Transaction limit exceeded. Please try a different card." (card 1 declined by Square), changed
cards, and then got **"Different request parameters used for the same idempotency_key:
pay-card-19876b77dfd6e279"** on every subsequent attempt — permanently stuck on that bill.

**Root cause:** `authorizeCardPayment` derived its key as `pay-card-${baseKey}` where
`baseKey = reserveBaseKey(billId)` — deterministic per bill. Square records the idempotency key on a
**declined** payment too, bound to that request's `source_id`. Square Web-Payments nonces are
**single-use**, so ANY retry (different card, or the same card re-tokenized) carries a new
`source_id` under the unchanged key → Square rejects it as "different request parameters." The
deterministic key was originally added to stop double-charge on double-submit
(v2-rollout-readiness.md:153); it created the exact inverse trap. Same failure class as the lane-open
`comp-resettle` case below (§ Gift-card / deposit funding).

**Fix (commit pending, `apps/web/lib/square-gift-card.ts`):** fold a short `sha256(source_id)` hash
into the card key → `pay-card-${baseKey}-${suffix}`. Each distinct card attempt gets its own key
(decline→retry works); a true network-level double-POST (identical nonce) still dedups. Double-charge
stays prevented because `baseKey` is still stable → all attempts share ONE deposit order, and Square
rejects a second full authorization against an already-covered order. Vaulted-card retries
(card-vault-sweep) pass a stable reusable token, so replay-safety there is preserved.

**Guardrails:**

- A payment idempotency key must be unique **per attempt**, not per order/bill. Key it off the
  single-use payment token (nonce), never off a stable business id alone.
- Prevent double-charge with a **stable ORDER** (one deposit order per bill) + Square's order-balance
  check, NOT by freezing the payment key. Those are different jobs — don't conflate them.
- Immediate operational unblock when a customer is stuck on this error: **start a fresh booking**
  (new bill → new baseKey → new key). Verify no capture happened first (a decline captures nothing).

## A .NET SOAP array of int64 serializes as `<long>`, not `<string>` — the wrong item tag no-ops AND returns success (2026-07-23)

**What happened:** `clearAccount()` (Intercard `TPI_ClearAccount`, used by kiosk new-card
clear-on-encode) was shipped with its account-array items wrapped in `<string>`, copied from the
`MAC_ID` array pattern. A live dry-run on test card 1062056 showed the clear returning **code 0
(success) while the balance stayed untouched** — a silent no-op. Switching the item tag to `<long>`
cleared the card for real (verifyAccount then returned `exists:false`).

**Root cause:** the two arrays have different item types. `MAC_ID` items are genuinely `string`, so
`<string>` is right there. But `TPI_ClearAccount`'s `Account` items are `AccountNumber` =
`int64` (C# `long`). The ASP.NET SOAP serializer names primitive-array items by their XSD type
(`<long>`, `<int>`, `<string>`…); a `<string>` item does not deserialize into a `long[]`, so the
array arrives **empty** — the op clears zero accounts and returns 0. A green result code proved
nothing.

**Also learned (same dry-run):** `TPI_ClearAccount` _de-registers the account entirely_ ("so the
cards can be re-issued" — spec), it does NOT just zero the balance. A `creditTokens` on the same
number afterward RE-MATERIALIZES the account clean. So the clear→credit "clear-on-encode" sequence
is sound — but only once the item tag is correct.

**Rules:**

1. **Match the SOAP array item tag to the item's XSD type, not to a sibling array's convention.**
   `int64`/`long` → `<long>`; `int` → `<int>`; `string` → `<string>`. Check the spec's `items:` type
   (`docs/intercard-tpi-api.yaml`) for every array, per-array.
2. **A vendor `0`/success code is NOT proof of effect.** For any op that mutates value, verify the
   effect out-of-band (re-read the account) — especially before wiring it into a money path or
   flipping its feature flag. `GC_CLEAR_ON_ENCODE=1` on the buggy `<string>` version would have
   silently stacked residual value on recycled cards behind a green check.
3. Keep the account number a **string** in JS end-to-end (bigint precision) regardless of the XML tag
   — the `<long>` is the wire element name, not a JS `Number()` cast.

## Variably-priced Square catalog items REQUIRE base_price_money — and a failed quote is silent on the card path but fatal on the kiosk reader (2026-07-23)

**What happened:** FastTrax duckpin on the kiosk died at the card reader with "Bowling quote
missing — cannot start the reader payment," while the same duckpin booking via the "Bowl Now" QR
(customer's own card) worked fine. Root cause (proven in prod logs):
`POST /api/square/bowling-orders/quote 500 — BAD_REQUEST: The item variation EXW7E74IRPYJAQFA4YIIEW3G
is variably priced and requires a value for base_price_money.` The duckpin Square item (`SQ.DUCKPIN`)
is **variably priced**, but `buildBowlingQuoteLineItems` sent only `catalogObjectId` (no price) for a
catalog line with no promo (`factor === 1`). Square rejected the whole quote order → no
`quoteDayofOrderId`/`quoteDepositCents` on the item.

**Why the two paths diverged:** `bowlingReserve` (card/web/QR) treats the quote as optional — if
`item.quoteDayofOrderId` is absent it OMITS it and the reserve route rebuilds the day-of order
server-side (which DOES always send `basePriceMoney`). So a broken quote is invisible there.
`bowlingTerminalPrepare` (kiosk paired reader) HARD-REQUIRES the pre-created quote order — the reader
can only charge an exact existing order — so it throws. HeadPinz bowling never hit this because its
catalog items are fixed-price (catalog price rings fine without an override).

**Rules:**

1. **Always send `base_price_money` on a priced catalog-linked Square line.** Never rely on the
   catalog price. Square honors it as a price-key override on fixed-price items and REQUIRES it on
   variably-priced ones. Keep the quote builder byte-identical to the reserve day-of order build
   (`route.ts` `sqLineItems` already always sends `unitPriceCents`).
2. **A silently-caught quote failure is a real defect even when the UI still works** — the card path
   masks it via server-side fallback; only the stricter reader path surfaces it. Don't dismiss "but
   it works on web/QR." Grep Vercel logs for the actual Square `BAD_REQUEST` detail.
3. When a fix touches a shared line-item builder, confirm the amount stays **dynamic** (per-duration
   `priceCents`), never a static constant — displayed must still equal charged.

## Mockups must speak the product's own design language — kiosk mockups use the PODIUM system + real photos (2026-07-21)

**What happened:** Planning the kiosk Race Info hub, three mockup rounds got rejected ("looks like
shit", "take design of kiosk not website") before landing. The first used flat placeholder frames
with generic neon styling; the second borrowed the WEBSITE's attractions-card treatment (dashed
borders, arcade photo on a racing tile); only the third — built from the kiosk's actual PODIUM
tokens (kiosk.css `.kiosk-canvas`), the real `CategoryCard` full-bleed-photo pattern, `k-btn-primary`
for the CTA, Exo 2 italic + Barlow, and the venue's real photography — matched expectations.

**Rules:**

1. **Read the target surface's design system BEFORE mocking** — for kiosk work that's
   `app/kiosk/kiosk.css` (PODIUM tokens/classes) + `KioskCategories.tsx` (CategoryCard,
   ShelfBanner), not the marketing site's styles. Kiosk ≠ website even when they share a brand.
2. **Real photography, never placeholder art** — the site's Vercel-blob assets are downloadable;
   embed them (data URIs in artifacts) rather than drawing stand-in SVG shapes.
3. **Match the photo to the content** — an arcade photo on a "Race Types" tile reads as wrong
   instantly. KIOSK_PHOTOS is the curated manifest; pick per-subject.
4. **Owner mock sign-off ≠ visual sign-off** — "concept matches" still came with "make it look a
   lot better when building." Budget polish into the build, not just the mock.

## A vendor "success" with an aggregate count can hide a skipped item — demand per-item results (2026-07-19)

**What happened:** Kiosk booking W52504 (2 racers, same 5:36 Blue heat) confirmed cleanly, but only
1 of 2 racers was checked into the race session — staff caught it by eye. The Pandora
`POST /bmi/schedule` insert loops racers and `continue`s (log-warning, NOT error) any racer whose
project-person row hasn't cloud→local synced to the center's Firebird server yet, then returns
`success: true, inserted: 1`. Our kiosk post-reserve rail logged that as
`session assignment W52504: OK (1 racers)` — success. The racer that got skipped (Jace) had been
registered as a project person via the BMI cloud API only ~60s before the schedule POST; the other
(Derek) was attached at bill creation ~2 min earlier and had synced. Registration→local-sync lag is
variable (the reservation-sync flavor of this takes ~6 min); an 8s delay + "success" check was never
enough.

**The rules:**

1. **Never treat an aggregate-count vendor response as complete.** If you send N items and get back
   `inserted: M`, compare — and when the API can't tell you WHICH items failed, fix the API first
   (Pandora_API ≥2.4.57 returns per-racer `results` and is idempotent per racer).
2. **Only re-POST what the vendor names as missing.** Blind batch retries against a non-idempotent
   insert duplicate the items that DID land (`T_PRJ_PERSON_2_PRJ_SCHEDULE` had no existence check
   before 2.4.57).
3. **Every silent auto-action needs a staff-visible failure surface.** The rail now appends
   `AUTO CHECK-IN INCOMPLETE — please check into session: <names>` to the reservation memo when
   anyone stays unlinked after retries — the memo is the surface staff already work from, and it's
   what saved W52504 (manually).
4. **BMI cloud→local sync lag applies to PROJECT PERSONS too**, not just reservations and persons
   (the "Pandora Sync Before Booking" lesson). Anything that writes via the cloud API and then reads
   via the local Firebird server must tolerate minutes of lag.

## Square refuses partial refunds of gift-card-funded payments (2026-07-11)

**What happened:** Live testing of reservation-edit decreases surfaced a hard Square rule the
edit-engine designs had only assumed away (Assumption A1): payments funded by a GIFT CARD cannot
be partially refunded — and gift-card refunds are heavily restricted in general. The owner's
operational model is: refund the guest's money on the CARD payment with reason exactly
**"Reservation Deposit"**, then manually decrement the gift cards involved (`ADJUST_DECREMENT`).

**Rules:**

- NEVER design a money path that partially refunds a gift-card tender (e.g. the internal deposit
  GC's day-of payment). Refund the guest's card payment instead and keep the GC == order-total
  invariant with an exact `ADJUST_DECREMENT`. The reservation-edit MID-decrease and
  POST-COMPLETE paths were specced on GC-tender refunds and must be redesigned before
  `RESERVATION_EDIT_V2_MID_DECREASE` / `_POST` ever turn on.
- Deposits can be part-paid with a GUEST's own gift card (`authorizeMultiTender`) — any refund
  allocator walking deposit tenders must check `sourceType` (`fetchPaymentFacts` exposes it) and
  skip GIFT_CARD tenders, then fail loudly toward store-credit settlement if card tenders can't
  cover the owed amount.
- Refunds of reservation money carry the exact reason **"Reservation Deposit"** (owner
  convention — consistent dashboard/export reads).
- Any NEW ledger that records refunds (e.g. `reservation_edit_events`) must be added to the
  refund-alerts sanctioned set (`recordedCascadeRefundIds`), or the system yells at its own
  refunds as Dashboard violations. Refund-alerts whitelists by refund ID, not reason.

**UPDATE — OVERTURNED at the API level (2026-07-27, owner-authorized live probe
`apps/web/scripts/gc-refund-probe.mts` + `-followup.mts`):** `POST /v2/refunds` **ACCEPTED a $1
PARTIAL refund of a $2 gift-card-funded payment** (real chain: owner's VISA bought a $2 gift
card → gift card paid a $2 order → $1 partial refund of that GC payment → accepted, completed,
payment shows refunded_money=$2 after the remainder refund). The 7/11 "NO" was never an API
attempt — it was a dashboard/ops-flow limitation recorded as if it were an API rule.
Consequences:

- The `skipGiftCardTender` hop in `refundTenderPartial` and the GIFT_CARD skip in the edit
  allocator are OVER-conservative (safe, but partial GC refunds are in fact available).
- `RESERVATION_EDIT_V2_MID_DECREASE` / `_POST` "must be redesigned" (§14 A1) should be
  revisited — the original GC-tender-refund specs appear viable as written. Re-verify in the
  exact production shape before flipping anything on.
- Unlinked refunds: still **NOT enabled** as of 2026-07-27 — a validly-shaped request
  (`unlinked: true`, `destination_id` = card on file, `customer_id` present) returns
  `REFUND_ERROR/REFUND_DECLINED`. Note the request REQUIRES `customer_id` when destination is a
  card on file (first attempt without it fails validation, which masks the entitlement answer).
- Probe-sequencing lesson: NEVER `DEACTIVATE` a gift card while refunds to it are PENDING — the
  refund credit lands asynchronously (payment showed refunded before any REFUND activity
  appeared on the card). Verify the REFUND activity on the card before teardown.
- Reason-string lesson (owner correction, 2026-07-27): EVERY real Square refund — probes and
  one-off scripts included — carries the exact reason **"Refund: Reservation Deposit"**. The
  portal's journal-entry pickup keys off it; an ad-hoc reason ("probe: …") means the refund is
  invisible to the journal and needs manual accounting. The 7/27 probe created three such
  refunds (2×$1 on the GC spend payment, 1×$2 on the VISA purchase payment); Square refund
  reasons are immutable, so those three need manual journal entries.
- Refund-reason SCOPE (owner, 2026-07-27): `"Refund: Reservation Deposit"` belongs to the
  **deposit / cash-out leg only**. A refund of the DAY-OF Square payment (the GC-funded revenue
  order) must NOT carry it — that would double-count one economic event in the portal journal.
  The day-of leg carries its own **staff-supplied reason** entered in the admin portal at refund
  time. Per-domain reasons are the norm, not an exception (group functions already use
  `"Refund: Group Event Deposit"`).
- **NEVER issue an amount-only refund** (owner rule, 2026-07-27). A bare `POST /v2/refunds`
  (payment_id + amount) records a dollar figure and nothing else: the returned item never shows
  in Square's item-level sales reporting and QBO cannot categorize it, so the books keep revenue
  that was actually reversed. Refunds must be **ITEMIZED**: create a return order
  (`POST /v2/orders` with `returns[].source_order_id` +
  `return_line_items[].source_line_item_uid`, which does NOT mutate the immutable paid order),
  then refund with `order_id` = that return order. **Square computes the tax-inclusive
  `return_amounts.total_money` itself — use that figure, not local tax math.** Probed live
  2026-07-27 (`apps/web/scripts/dayof-itemized-return-probe.mts`): both the return order and the
  linked refund were accepted. If the returned lines cannot be identified, REFUSE the refund
  rather than falling back to an amount. (The deposit/cash leg is a single funding line with no
  item semantics and is the one exception.)
- **A PAID Square order's line items are IMMUTABLE — forever** (probed 2026-07-27,
  `apps/web/scripts/dayof-lines-after-refund-probe.mts`). `UpdateOrder` returns
  `BAD_REQUEST "LineItems cannot be modified for finalized tenders"` on an order with finalized
  tenders — before a refund, after a PARTIAL refund, and even after the tender is refunded in
  FULL. There is no sequence that unlocks it. Consequences: any post-payment money flow is
  **money-only** (the order keeps its original lines and the refund objects carry the story);
  never plan an `update_dayof_order` step for a lane-open or completed order — it would fail
  fatally _after_ money moved. Only PRE-phase (zero-tender) orders accept line edits.
- Related, same probe run: a partial refund does **NOT** reopen `net_amount_due_money` on the
  source order (it stays 0 and the order stays OPEN). So the feared "strand trap" — a refunded
  order stuck at balance-due and skipped forever by `bowling-order-complete` — does **not**
  exist. Don't design around it, and don't treat a refund as a guard against the complete-cron.
- Same run: `payment.refunded_money` **includes PENDING refunds**, so clamping against it during
  the async settlement window is safe (a retry cannot over-refund).
- Same run: refunding a payment on a **COMPLETED** order is accepted — the money-only
  post-complete path is valid.
- Same run, confirmed the hard way: the 7/27 card ending 1430 has **no REFUND activity at all**
  — the credit never posted because the card was DEACTIVATED while its refunds were PENDING.
  Deactivating a gift card with refunds in flight **destroys the money**. Always wait for the
  credit before drain/deactivate.
- Probe-location rule (owner, 2026-07-27): ALL live Square probes run against location
  **`6MZJFTGAYD7TC`** — it does NOT track accounting. NEVER probe against a revenue location
  (the 7/27 probes hit HeadPinz Fort Myers `TXBSQN0FEKQ11` and put probe sales/refunds into
  that day's books). Every probe script's `LOCATION` constant uses `6MZJFTGAYD7TC`.

## Pandora heatNumber is CREATION-order, not schedule-order — never order heats by it (2026-07-11)

**What happened:** Staff inserted an extra Blue session mid-day ("76 - Blue Junior Starter",
7:06 PM, between heats 51 and 52) and Pandora assigned it the day-max heat number. The moment
it went on track (7:41 PM), `resolveRaceLiveState`'s orphan guard (`laterHeatRan`: "a
later-numbered heat has actualStart ⇒ this heat finished") flipped EVERY unrun Blue heat to
"finished" — the VIP combo board showed 10:36/11:00 PM Intermediates as "✓ Done" at 7:44 PM,
and `raceSettleGate` (same resolver) would have counted those heats delivered and charged the
bills hours before the races ran.

**Rules:**

- `heatNumber` identifies a session and labels it for display; it says NOTHING about schedule
  position. Bulk-created days are coincidentally monotonic — a single staff insert breaks it.
- Any "earlier/later heat" reasoning must compare `scheduledStart` in the ET-wall frame
  (`etWallMs`). Fixed in `race-live-state.ts` for both `laterHeatRan` and `isCalled` (the
  watermark session is resolved by id and compared on scheduledStart; heatNumber only as a
  fallback when the watermark's session isn't in the list).
- Inserted sessions also come from a different id range (54604200 vs the day's 53945xxx bulk
  block) — a tell when eyeballing payloads, never a contract.
- Test fixtures that generate sessions must keep schedule order internally consistent with any
  overridden times, or they mask exactly this class of bug (the old generator did).

## A recovery sweep and a cancel cascade share the SAME state — every writer must close every gate (2026-07-07)

**What happened:** Res 11416/11417 (W48833) was cancelled + refunded through the cascade. The
cascade wrote the BMI project to -4 via Pandora, but the write became visible only after ~20-25s
(the cascade's 9s verify poll gave up → logged a FALSE "did not stick"). Five minutes later
`bmi-cancel-sweep` RECOVERED the -4 back to Confirmation (-3): Pandora's direct Firebird write
leaves `userUpdatedId=-1` — indistinguishable from BMI's auto-cancel bug the sweep exists to
undo — and the sweep's "intentional cancel" gate (the Redis booking record) still said
"confirmed" because the cascade never updated it. Staff saw a refunded booking still live in BMI.

**Rules:**

- When a watchdog/sweep auto-reverts state, EVERY code path that intentionally sets that state
  must close the sweep's gates BEFORE (or atomically with) the write — never assume the sweep
  will "recognize" the writer. Pandora Firebird writes carry NO user identity (`userUpdatedId`
  stays -1); do not gate on writer identity for anything written via Pandora.
- The cascade now marks the Redis booking record cancelled at COMMIT (step C, before BMI
  teardown), and the sweep has a durable Neon backstop (`bowling_reservations.status='cancelled'`
  by W-number) because Redis records expire (90d TTL) and evict (6/29 OOM).
- Pandora `/v2/bmi/reservation/state` returns 200 immediately but the Firebird write can take
  ~25s to become visible via the Office API. Verify polls must cover that (~22s now), and a
  verify "failure" should be worded as "not yet visible", not "did not stick" — the write
  usually lands after we stop watching.
- The confirmation page PATCHes the booking record `status:"confirmed"` on EVERY load — a
  cancelled/refunded record must refuse resurrection server-side (booking-record PATCH now
  drops the status flip). Staff clicking "View confirmation" on a cancelled booking was enough
  to re-open the sweep gate.

## Never tell a customer they're being grouped with another party (2026-07-06)

**What happened:** The VIP group-match feature shipped with a customer-facing banner
("Another VIP group is already booked at 2 PM — pick the matching time and both groups head
over to HeadPinz together") and a "JOINS THE 2 PM GROUP" tile badge. Owner: we should not be
telling the end user we're putting them with another group.

**Rules:**

- Steering nudges that exist for OPS reasons (grouping parties, staffing, walk-overs) must be
  ANONYMOUS in customer UI — express them as "Recommended" (or plain visual emphasis) without
  explaining why. The why goes to staff channels (alert emails, portal) only.
- More generally: customer-facing surfaces must never reveal the existence, timing, or size of
  another customer's booking. Availability counts are fine; "another group/party/booking"
  phrasing is not.

## Local build verification must run the WORKSPACE build script, not `next build` directly (2026-07-03)

**What happened:** The World Cup VIP branch passed a local `npx next build` clean, then the
Vercel deploy failed on the **a11y gate** (`scripts/a11y-gate.mjs`, a jsx-a11y sweep wired as
the package's `postbuild` hook). `next build` invoked directly never runs npm lifecycle hooks,
so the gate silently didn't execute locally — the "green build" claim was false.

**Rules:**

- Verify with `npx turbo run build --filter=fasttrax-web` (or `npm run build` in `apps/web`) —
  anything that skips the `postbuild` a11y gate is not a build verification.
- The gate's `control-has-associated-label` rule can't see button text nested ≥3 levels deep in
  conditional markup — rich card-style `<button>`s need an explicit `aria-label` (better for
  screen readers anyway).
- Wrinkle: untracked local scratch scripts under `apps/web/scripts/` (gitignored `.mts` probes)
  ARE type-checked by local builds and can fail them even though CI/Vercel never sees those
  files. Park them out of the tree for the verification run rather than concluding the branch
  is broken — and prefer writing scratch probes that type-check.

## BMI public bill-delete returns TRUE on confirmed bills — while the PROJECT lives on (2026-07-03)

First live cancels through the cascade (bills 63000000004148142/…180, W47613/W47615): the
public-booking `DELETE bill/{orderId}/cancel` returned `true` on CONFIRMED bills — a
"Cancellation" record even appears in the BMI reservations list, so it LOOKS like a full
cancel — but it only deletes the BILL record. The real Office PROJECT (id = billId+1, resolved
via `search?token={W} → kind===2 → localId`) stays Confirmation and keeps holding the heat
capacity. The old 2026-05-11 lesson ("delete only works pre-confirm") was half right: it
doesn't _fail_ post-confirm, it half-succeeds, which is worse.

Rules:

- **The Office project state (-4 via setProjectState) is the ONLY real cancel for a booked
  BMI reservation.** The public bill delete is bill-record cleanup afterwards, or the primary
  only when NO project resolves (never-confirmed bills). Never treat its `true` as done.
- **Verify with retries**: Pandora's state write lands asynchronously — an immediate re-read
  showed -3 for a few seconds before flipping to -4. Poll (~4 tries, backoff) before
  declaring a write failed.
- Pandora writes show `userUpdatedId = -17` (ONLINE_BOOKING) — an intentional-cancel writer
  for the bmi-cancel-sweep gate (never -1), on top of the Neon cancelled-record gate.
- `cancelBmiProject` (src/features/cancellation/bmi-cancel.ts) encodes all of this; the
  regression test pins the public-delete-true trap.

## Cancellations settle MONEY GROUPS, and store credit must be a fresh Square-GAN card (2026-07-03)

Built the all-kinds cancellation cascade (`src/features/cancellation/`, branch
`feat/cancel-refund-improvements`). Rules that must outlive the feature:

- **One deposit order = one money group.** VIP combo legs AND mixed race+attraction carts are
  multiple `bowling_reservations` rows funded by ONE deposit charge / ONE internal gift card.
  Any cancel/refund path that settles a single row of such a group is wrong by construction
  (the old combo bug: card refunded, sibling leg + gift card + second day-of order orphaned).
  Resolve the group by `square_deposit_order_id` (fallback `bmi_bill_id`), settle once, mark
  every leg. `listCancelGroupReservations` in bowling-db.ts is the canonical resolver.
- **Never hand a guest an internal deposit GAN.** `isInternalDepositGan` (lib/square-gift-card.ts)
  blocks every WEBHPFM…/GFFT…-style prefix as an online payment method, so "just give them the
  deposit card" can never work — store credit must be a NEW DIGITAL card created WITHOUT a
  custom GAN (Square generates the number). Persist the GAN to Neon BEFORE activation/delivery;
  email/SMS can fail, the row cannot.
- **Square may reject a gift card buying a gift card.** The "purchase" store-credit strategy
  (order with a GIFT_CARD line paid by the internal card) is gated behind a $1 live probe
  (`scripts/store-credit-probe.mts`); the default "comp" strategy (mintDigitalGiftCard +
  ADJUST_DECREMENT drain) is prod-proven. A comp mint without its drain is a DOUBLE LIABILITY —
  the drain is fatal, never best-effort.
- **Cancelled Neon rows are the cron gate.** Every settle cron filters `status='confirmed'` and
  bmi-cancel-sweep treats a cancelled record as an intentional cancel — so the cascade marks
  Neon between the money step and the external teardown. Ordering is load-bearing.
- **Amounts are stamped per leg for display but are GROUP-level** — never SUM
  `refund_cents`/`store_credit_cents` across legs of one deposit group; `reservation_cancel_events`
  is the authoritative money record (and the idempotency attempt counter: failed attempts burn
  their Square key namespace, crashed ones resume it).

## A re-sign must re-confirm BMI, and "deposit paid" must never read `deposit_due_cents` (2026-06-22)

Incident — **Suffolk** (FM, BMI project **49972983**, GAN HPFM49972983, quote #101, event 6/25). Two
distinct symptoms reported as one: "showing more deposit than they have" + "signed but BMI didn't move to
confirmation."

**Symptom 1 — inflated deposit display (NOT a money bug).** The portal showed `Deposit $2192.30 / Deposit
paid $2192.30` with a `$894.06` balance — internally contradictory. The money was healthy (gift card
$1298.24, day-of order $2192.30 correctly reconciled, balance $894.06 on a saved card). Root cause: the
event crossed the 96h line, so `group-quote-dispatch` (`fullPaymentRequired`) flipped `deposit_due_cents`
to the **full total**, and `lib/portal-format.ts` computed **"deposit paid" = `deposit_due_cents`**. A data
fix to `deposit_due_cents` does NOT stick — the dispatch cron rewrites it every pass (route.ts ~L441).

- **Fix:** `depositPaidCents(q) = q.deposit_paid_at ? Math.min(q.deposit_due_cents, q.collected_cents) : 0`
  — "deposit paid" / balance-payment amounts now derive from real collected money, capped so they can never
  exceed what was actually paid. `deposit_due_cents` is a mutable _due_ amount, never a _paid_ amount.

**Symptom 2 — re-sign didn't re-confirm BMI.** A price change after deposit sets the quote to
`resign_required` and resets the BMI project to "Pending Signed Contract" (FM stateId **48952154**). The
guest re-signed, but `app/api/group-function/resign-settle/route.ts` never called `updateProjectStatus(-3)`
— only the _deposit_ route confirmed BMI. So the project sat stuck at "Pending Signed Contract" with the
balance correctly recorded.

- **Fix:** `resign-settle` now calls a non-fatal `reconfirmBmi(quote)` (mirrors the deposit route's BMI
  block) on **every** settle branch — deposit-only, reprice-charged, refund-owed, no-change.

**How to apply / general rules:**

- "Paid" displays are derived from `collected_cents` (real money in), never from `deposit_due_cents`/
  `deposit_due` (a _due_ amount the dispatch cron mutates to full total within 96h). `amount_due = total -
collected` is the only safe identity.
- Any GF flow that lands a contract in a signed/settled state (deposit, re-sign, post-paid sign) MUST
  re-confirm the BMI project (`updateProjectStatus`, stateId -3). Adding a new signed-terminal path? Wire
  in the BMI confirm or the event stays at "Pending Signed Contract."
- Reusable diagnostic: `apps/web/scripts/gf-confirm-and-deposit-sweep.mts` (read-only) flags money-taken
  quotes whose BMI project isn't confirmed, and `deposit_paid` quotes whose displayed deposit > collected.
- FM BMI states seen: `-3` Confirmation, `48952154` Pending Signed Contract (`bmi-scan.ts`
  `pendingSignedContractStateId`). Naples Pending-Signed ≈ `8007473`.

## Persist guest input to our own DB at capture — never let an external API be the only store (2026-06-21)

Incident: online **Pizza Bowl** orders reached the kitchen with no pizza/soda. Root cause was a booking
path that pre-created the day-of Square order with package + shoes only and never re-attached the pizza/
soda selections — but the deeper failure was that those selections (toppings, drink) were **only ever sent
to the Square order, never persisted to Neon**. When they failed to attach, the data was **unrecoverable**:
we couldn't even tell the kitchen which toppings each guest wanted (had to flag "take order manually").
`bowling_reservation_lines` only held the package; `booking_metadata` had nothing; the toppings lived
solely in a transient request body. See `memory` + `project_fm_kds_routing_gap`.

**Rule (now a CLAUDE.md hard rule):** anything a guest gives us that we send to an external API (Square,
QAMF/Conqueror, BMI/Pandora) MUST be saved to our own DB (Neon) **at capture, independent of and before
relying on the API call**. Our DB is the source of truth; the API is a downstream sync. On API failure the
row stays recoverable + retryable.

**How to apply:**

- Persist guest selections (food/toppings/drinks, player names, shoe sizes, waiver answers, contact info,
  anything typed/chosen) to Neon as the first guaranteed step, then sync to the API.
- Do NOT write persistence as "best-effort after the API call" — that's exactly how this data was lost.
- Applies to new features AND edit flows (the pizza/soda edit endpoint persists the new selection regardless
  of the Square outcome).
- When auditing a flow, ask: "if every external API call here failed, could we still recover everything the
  guest told us?" If no, persist more.

## Square's payment/card idempotency_key max is 45 chars — never PREFIX an already-prefixed baseKey (2026-06-20)

Incident — party **3354** (group-function reprice, quote id **143**): `/api/group-function/resign-settle`
402'd on **every** re-sign click and could not be cleared. The real root cause (revealed only after we
added failure-audit logging — see below) was Square returning **`VALUE_TOO_LONG` — "Field must not be
greater than 45 length"** on the **payment idempotency_key**.

Square's idempotency_key limits differ per endpoint: **CreatePayment = 45**, **CreateCard = 45**,
gift-card activities = 128, **CreateOrder = 192**. The reprice path built its keys by prefixing a baseKey
that _itself_ began with `gf-reprice-`:

```js
const baseKey = `gf-reprice-${quote.id}-${hash16}`; // e.g. gf-reprice-143-26ad0266ecd84a73
// derived: `gf-reprice-pay-${baseKey}`  → "gf-reprice-pay-gf-reprice-143-…" = 46 chars  ✗ (>45)
//          `gf-reprice-card-${baseKey}` → 47 chars  ✗
```

The double `gf-reprice-` prefix + a **3-digit** quote id pushed the payment key to 46. It was **content-
dependent**: it fit for 1–2-digit ids (≤45), so it passed every low-id sandbox test and shipped broken —
quote 143 was the first 3-digit paid-in-full reprice to hit it. The CreateOrder key (limit 192) was fine,
so an OPEN order got created but the payment **always** failed before any Payment object existed (zero
payments, order stuck OPEN). The card was valid the whole time. (A first attempt to "encode the amount in
the key" made it _worse_ — longer — confirming the constraint is length, not collision.)

**Fix:** a FIXED-length hash, so the key can't grow with id/total magnitude, still keyed on the fields
that make the charge unique (quote + target total + card source):

```js
const baseKey = createHash("sha256")
  .update(`gf-reprice:${quote.id}:${quote.total_cents}:${sourceId}`)
  .digest("hex")
  .slice(0, 24); // pay=39, card=40, order=41 chars — all ≤45 forever
```

Keying on `total_cents` also keeps the re-price collision-safe (new total ⇒ fresh order/payment; a
double-submit at the same total dedupes; after a successful settle `collected_cents == total_cents` and
only ever rises, so a charge-succeeded-but-DB-failed retry replays the same payment, never double-charges).

**Guardrails:**

- Square payment/card idempotency keys are capped at **45 chars**. Don't build them by prefixing a
  baseKey that already carries a prefix — and don't let any key length depend on variable-width content
  (ids, amounts). Prefer a **fixed-length hash**; audit each derived key against its endpoint's limit.
- An idempotency key whose length grows with content fails silently for _large_ inputs only — it will
  pass every small-input test. Test with realistic production-scale ids/amounts.
- When a money endpoint returns a hard error, **write the provider error code + detail to the audit log**
  before returning. resign-settle logged nothing on failure, which forced live Square archaeology and a
  wrong first diagnosis; the best-effort `reprice_charge_failed` row pinned the real cause in one query.

## Saving a Square card on file: CreateCard directly with the Web Payments SDK token — don't $0-auth first (2026-06-18)

The customer account portal (`apps/web/src/features/account/data/cards.ts`) saves a card on file by
calling `POST /v2/cards` **directly** with the Web Payments SDK `source_id` (single-use token) +
`card.customer_id`, matching the proven subscription flow
(`app/api/square/subscription/route.ts` → `saveCardToCustomer`). It deliberately does **not** run a
$0 verification payment first.

Why this differs from `app/api/group-function/update-card/route.ts` (which does $0-auth →
cancel → CreateCard): the Web Payments SDK token is **single-use**. Consuming it on a `POST
/payments` first risks the subsequent `CreateCard` failing on a spent token. CreateCard validates
the card itself; `verification_token` carries 3DS/SCA when present. For a subscription payment
method, Square's own billing/dunning handles a later decline — the up-front $0 auth is not worth the
token-reuse fragility.

**Guardrail:** when saving a card on file from a fresh tokenize(), prefer a single `CreateCard`
call. If you genuinely need a pre-charge verification, tokenize with `intent: "CHARGE_AND_STORE"`
or capture the _payment id_ (not the nonce) and pass that as CreateCard `source_id` — never reuse
the raw nonce across two Square calls.

## Pandora-created person must finish syncing to the cloud before booking a race/activity (2026-06-17)

Owner flag (Health Net + Christmas in July): the group-event signup flow
(`app/event/[slug]/page.tsx`) creates a BMI person via Pandora (`POST /api/pandora` →
`pandoraCreatePerson`/`pandoraOnboardGuest`), which writes to BMI Firebird. That person then has to
**sync up to the SMS-Timing/BMI booking cloud** before the public booking API (`api.bmileisure.com`,
via `/api/bmi` book/sell/confirm) can see them. **If the guest selects and books a race/attraction
before that sync lands, the booking errors out** ("everything will error out") — the booking backend
doesn't know the person yet.

Current state (verified 2026-06-17): **UNHANDLED.** After `pandoraOnboardGuest` returns a personId,
the flow goes straight to `setStep("dashboard")` and lets the guest pick a heat immediately — no
wait, poll, or readiness check. The only mitigation is the user hitting the manual retry button.
This is the same shared code path for **both** `xmas-in-july` and `healthnet-2026`, and any new
"schedule your activities" CTA that funnels entry-only guests into booking inherits the bug.

**Guardrails:**

- After creating a person via Pandora, **gate race/activity selection on a readiness check** — poll
  until the person is visible to the booking backend (reuse the `getWithRetry` cold-start pattern in
  `lib/pandora.ts`), then enable booking. A blind fixed delay is a fallback, not the fix; prefer
  polling a "is this person bookable yet" signal.
- Show the guest a brief "getting your profile ready…" state during the wait instead of a bookable
  UI that will fail.
- This applies to ANY flow that creates a BMI person and immediately books against it.

## A design that relies on a manual operational step needs an automated fallback + monitoring (2026-06-16)

For 5½ weeks (since the v2 day-of order flow launched 2026-05-09), **1,498 bowling/KBF day-of
Square orders — $133,005.63 — sat in state OPEN despite being fully paid.** They never imported
into QuickBooks because the Square→QuickBooks sync (and item-level Sales reporting) only pull
_completed_ sales. No money was lost (payments captured on the right days; orders were visible in
Square the whole time) — purely a reporting/import gap. Full write-up:
`docs/postmortems/2026-06-16-bowling-day-of-orders-left-open.md`.

Root cause: `lib/bowling-lane-open.ts` **intentionally** leaves the order OPEN with its SHIPMENT
fulfillment so the kitchen/KDS keeps showing shoe sizes + food during the session — correct
trade-off — but it relied on **staff completing the order on the POS at session end**, with no
automated fallback. Staff didn't, and nothing else closed them. Group functions and racing were
unaffected because both **complete-on-payment** (GF balance flow; `race-dayof-pay` — races have no
KDS fulfillment to preserve).

**Fix shipped:** close the order on the real session-end signal — the QAMF `reservation.updated →
Completed` transition (lanes closed) — in a SEPARATE call from lane-open (the order is final after
lane-open). `completeReservationOrder` (`lib/bowling-order-complete.ts`) is fired from the QAMF
webhook + the `bowling-events-consumer` fallback, with `reservation-status-close` (every 30 min) as
a cron backstop for missed events. All paths share a `dayof_order_completed_at` idempotency guard;
no-shows stay on `bowling-no-show-close`.

**Guardrails:**

- If a flow offloads a finalizing step to humans (close on POS, bump a ticket), it is **not done**
  without an automated fallback that runs if the human step doesn't happen — plus an alert when the
  unfinished state piles up ("paid orders OPEN with $0 due > N hours").
- **Reconcile order _state_, not just payments.** Payment-based reports looked correct the entire
  time while the orders that feed item-sales/QBO were never closed.
- **Diff against the working sibling.** When one flow works (GF/racing complete-on-payment) and a
  parallel one doesn't (bowling), compare them first — the fix is usually "do what the sibling does."
- The reliable "session over" signal for bowling is the **QAMF Completed event**, NOT Square
  fulfillment state — the stuck orders' fulfillments sat in PREPARED/PROPOSED, never COMPLETED, so a
  kitchen-bump/fulfillment-based trigger would never have fired.

## No decorative emoji in UI/design — use @tabler/icons-react (2026-06-15)

Owner feedback on the Christmas in July landing page: emoji used as icons/decoration (🎄🏎️🍸⏱)
"look AI." Decorative emoji cheapen a designed page and read as AI-generated. **Rule: never use
emoji as icons or flourishes in the product UI.** Use the project's icon library
**`@tabler/icons-react`** (already a dependency) — e.g. `IconGlassCocktail`, `IconBowling`,
`IconCar`, `IconGift`, `IconClock`, `IconChristmasTree`. Render `<IconX className="h-8 w-8
text-(--accent)" stroke={1.5} />`. Plain text is fine when no icon fits; don't substitute an emoji.

## Express Lane eligibility must judge the WHOLE party, not the personId-bearing subset (2026-06-13)

Ops flagged four reservations (W40849, W40705, W40712, W40861) that got Express Lane with "not
enough returning racers." Every one was a 2-racer party: racer #1 a returning racer with a
`bmiPersonId` + valid waiver, racer #2 a name typed in by the guest (Ross / Jade / Gary / toddick)
with **`personId: null`** — no BMI person, no waiver on file. They still got express, so a person
who needs to sign at Guest Services was waved through.

Root cause — the eligibility check **filtered the party down to members that already had a
personId, then asked "are all of _those_ waivers valid?"** A personId-less second racer was
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
  id" as _disqualifying_ (or as "needs registration"), never as "skip this one."
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
combo + seed fresh activity … }` added by commit 4ddfcfc to stop a _stale_ combo from hijacking
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
   _fully tendered_ as paid (`tenders.length > 0 && net_amount_due === 0`, then verify the tender's
   payment is `COMPLETED`). Same trap exists anywhere else we poll an order for payment.
2. **Square's $2,000 gift-card cap applies to the card's BALANCE, not the load amount.**
   `loadBalanceOntoGiftCards` topped up existing cards with `min(remaining, $2k)` — but a card
   already holding the 50% deposit only has `$2k − balance` headroom, so EVERY event totaling
   > $2,000 threw at balance-load time. Fix: fetch current balance, load into headroom, overflow
   > onto new cards. Corollary: **callers must persist overflow card ids/gans onto the quote**
   > (`updateGfGiftCardList`) or day-of payout never sees the funds — all three callers ignored the
   > loader's return value.

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
A screenshot showed the user was on `/book/kbf/v2` — a _different_ implementation (the
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

The 2026-06-07 emergency guard (below) only stopped _past_ events. The same loop hit an _upcoming_
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
  Removing the _acting_ is more robust than chasing convergence on a value you can't control.

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
   on _every_ run, so step 2 repeated indefinitely. (Suspect: stored `line_items` carry the
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
- A change-detection loop that _acts_ on every detected change MUST converge: after writing the
  "corrected" value, the next read has to compare equal. If the source (Hermes) and the persisted
  store can never match (because we mutate before persisting), you have an infinite trigger. Verify
  convergence, not just "did it detect a change."
- `status !== "contract_sent"` is a fragile proxy for "signed." `resign_required` is unsigned but
  trips it — re-arming the very loop that set the status. Prefer an explicit signed marker
  (`contract_signed_at`) when gating destructive/customer-facing transitions.
- TODO follow-up: fix the non-converging product diff so an _upcoming_ event can't loop the same way
  before its date. The past-event guard only covers events that have already happened.

## Two crons sharing one trigger raced — `dayof-close` stranded `dayof-pay` (2026-06-05)

Quote #3286 (LSI Companies, $2,649.09) showed Deposit ✓ / Balance ✓ in admin but its Square
day-of order sat OPEN, unpaid. Gift cards were fully funded and untouched. Root cause: a
read-modify race between two crons that gate on the _identical_ trigger
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
  Don't just check they both _select_ the right rows (the 2026-06-03 lesson) — check their _relative
  ordering_ when they fire in the same tick. The dependent cron (close) must gate on the producer's
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
The real root cause was the _earlier_ bug (see the 2026-06-03 lesson below): #3286's order
was created **before** `base_price_money` was added to catalog lines (2026-06-03), so it
carried only `catalog_object_id` and Square used the catalog default. The 2026-06-03 fix
(always send `base_price_money`) was correct and complete.

The 2026-06-05 "fix" was an **overcorrection from a misdiagnosis**: it added
`fetchCatalogPriceInfo` and dropped the catalog link whenever quote price != catalog price.
That changed nothing about pricing correctness (base_price_money already guaranteed it) but
**destroyed Square item-sales attribution** for every override-priced line — race starters,
birthday packages, extra pizzas, well drinks. By 2026-06-08, 17 line items across live
day-of orders were ad-hoc purely because of this branch, plus 7 older orders that had gone
_fully_ ad-hoc via the all-or-nothing fallback.

Corrected fix (2026-06-08): `buildSquareLineItem` keeps the catalog link whenever a PLU is
present and always sends `base_price_money`. No catalog pre-fetch, no price comparison.
Square honors the override AND preserves reporting. `fetchCatalogPriceInfo` /
`CatalogPriceInfo` deleted. Audited/remediated via `apps/web/scripts/audit-dayof-adhoc-*.mjs`

- `remediate-dayof-relink.mjs` (5 OPEN orders relinked; 6 completed/paid orders left as-is).

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

### Addendum: the misdiagnosis had METASTASIZED (2026-07-03, USA250 incident)

The retracted 2026-06-05 belief ("Square rejects `base_price_money` on fixed-price catalog
items") had been **copied into three more routes before it was retracted** — and the 2026-06-08
correction only fixed `buildSquareLineItem` (group functions). The stale copies lived on in
`/api/square/bowling-orders`, its `/quote` sibling, and the `bowling/v2/reserve` fallback, each
with an `if (catalogObjectId) → drop basePriceMoney` branch (one even kept the wrong claim as a
comment). They were harmless for a year because no bowling caller sent a reduced price — until
USA250 (price-key promo, 2026-06-26) did. Result: bowling-only carts with the code applied were
charged FULL price while the review showed the discount and plugged the difference into the
displayed "Tax" line (the total-unchanged screenshot is the signature). Racing/mixed carts were
fine (unified-reserve passed the override through).

- **When a belief about an external API is corrected, grep for every copy of the belief** —
  `catalog_object_id` order-construction sites, comments quoting the old claim — not just the
  file where the bug was found. A wrong comment is executable documentation: the next author
  copies it. (Full sweep done 2026-07-03: all other order-creation sites verified safe.)
- **A dormant drop-the-override branch is a time bomb, not a no-op.** "No caller sends a
  reduced price today" lasts exactly until someone ships a promo.
- **Display seams that plug totals hide charge bugs.** The checkout review computed
  `tax = quotedTotal − discountedSubtotal`, so a full-price quote surfaced as an inflated tax
  line instead of a wrong total. Guard at the source instead: the quote route now FAILS (502)
  if Square's returned line prices don't echo every `base_price_money` sent (see
  `bowling-orders/quote/route.ts` invariant), and the reserve route re-derives price-key promos
  server-side from the code alone, so even the no-quote fallback charges what was displayed.
- **A client-side-only discount is unauditable.** The bowling-only path never sent the promo
  code to the server, so no redemption row existed and victims couldn't be identified from our
  data. Any price-affecting state the client holds MUST reach the server at charge time (the
  code, not the amounts). Audit tooling: `scripts/usa250-bowling-overcharge-scan.mts`.

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
catalog variations are _variably priced_, so Square hard-rejected every catalog attempt:
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
q`WHERE col >= ${date}::date AT TIME ZONE 'America/New_York'`;
```

Does NOT produce `$1::date AT TIME ZONE 'America/New_York'`. Instead the
driver strips `::date`, and Postgres sees `$1 AT TIME ZONE 'America/New_York'`
where `$1` is a text parameter. The result is silently wrong — no error,
just incorrect boundaries.

**Fix:** Apply `AT TIME ZONE` on the column side instead:

```typescript
q`WHERE (col AT TIME ZONE 'America/New_York')::date >= ${date}::date`;
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
first time, treat it as a deploy-tooling change _regardless_ of where the deploy
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
_consumes_ shared inventory (codes, lane-holds, vouchers) must dedup
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

| Path                                                                          | 17-digit `63…`?       | Wire form                            | How we read it                             | Verdict  |
| ----------------------------------------------------------------------------- | --------------------- | ------------------------------------ | ------------------------------------------ | -------- |
| Race/attraction booking `orderId`/`billId`/`orderItemId` (public-booking API) | **yes**               | unquoted number                      | `res.text()` + regex (`extractRawOrderId`) | **safe** |
| BMI **Office** project entity `id`/`personId`/`number` (`office-api22…`)      | no — 7–8 digit        | **quoted string** (`"id":"8031234"`) | `JSON.parse`                               | **safe** |
| **Pandora** person `personID` (`docs/pandora-api.md`)                         | no — 6-digit Firebird | quoted string (`"id":"713365"`)      | `res.json()`                               | **safe** |
| QAMF bowling reservation ids / both Node bridges                              | no                    | string / n/a                         | —                                          | **safe** |

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
  pathname === "/accessibility" ||
  pathname.startsWith("/accessibility/") ||
  pathname === "/cancellation-policy" ||
  pathname.startsWith("/cancellation-policy/") ||
  pathname === "/your-new-route" ||
  pathname.startsWith("/your-new-route/");
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
if (!actRes.ok || data.errors) {
  /* surface the error */
}
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
const walletUrl = `https://squareup.com/apass/gc/download/personalized/${giftCardIdShort}?source=egift`;
```

Verified by curl on a known-ACTIVE $5 card:

- `/apass/.../{stripped}` → `HTTP 200 application/vnd.apple.pkpass` ✅
- `/apass/.../gftc:{full}` → `HTTP 404` ❌
- `/gift/balance/{stripped}` → real balance page (SPA-rendered) ✅
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
  that _matches_ lines (credit redemption, reward redemption, tax) must match on the SAME composite
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
The `bmi-cancel-sweep` later flips the _project_ to `-3` (Confirmation) but cannot re-add stripped
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
- "NO BOOKING FOUND" from an email+date match is a _lead_, not a verdict — value can be delivered
  under a different email, a manual reservation in another system (Conqueror/QAMF), or a separate
  later payment.
- For `confirm_failed` bowling rows, join sibling rows for the same guest/day: a successful retry
  usually reuses the SAME `square_deposit_order_id`, so one capture can back two rows. Compare the
  order id before concluding double-charge.
- Read the incident memory IN FULL before proposing remediation — the body said "remediation
  COMPLETE except 5 held," but I acted on the stale one-line index hook. Fixed the hook.

## Synthetic/derived product ids bypass the Square catalog map → ad-hoc lines → QBO miscategorization (2026-06-15)

QBO journal-entry sync flagged 97 recent racing orders (June 9-14, all from our v2 site) as
"missing Square category": each race line imported as a loose item ("Starter Race", "Pro Race",
"Intermediate Race", "POV Race Video") instead of rolling up under "Racing 303". The user asked
whether it was old data or a live v2 bug — it was **live**.

Two causes, both producing Square line items with **no `catalog_object_id`** (and therefore no
`reporting_category`, which is what the QBO sync keys off):

1. **Combined-card synthetic ids.** Commit `1d059dfc` (Jun 9, on main) added `combineTrackVariants()`,
   which merges adult Red+Blue single races into one bare-named card carrying a **synthetic product
   id `m:<id>:<id>`**. The reserve route does `lookupCatalogId(bmiProductId) ?? lookupCatalogIdByName(name)`
   — the synthetic id isn't a `SQUARE_CATALOG_MAP` key and the bare name "Starter Race" isn't a
   `NAME_CATALOG_MAP` key, so **both lookups missed → ad-hoc line.**
2. **POV never mapped.** `POV_PRODUCT_ID "43746981"` (checkout.ts) was absent from `SQUARE_CATALOG_MAP`
   even though an `SQ.POV` catalog variation existed → every POV upsell sold ad-hoc.

Fix (categorization only — does NOT touch price): `lookupCatalogId` now resolves `m:` ids via any
component track id (all components of a tier map to the same item, so juniors stay JR\_\*, adults stay
KARTING — verified by a parametrized test over every real combined card). Added `"43746981": SQ.POV`
and a `"POV Race Video"` name fallback. Both day-of order builders (reserve/route.ts and
unified-reserve.ts) route through `lookupCatalogId`, so the single change fixes all future orders.

**Guardrails:**

- When you introduce a **synthetic, merged, or otherwise derived product/line id** (anything that
  isn't a raw upstream id), audit EVERY consumer that keys off the raw id — `SQUARE_CATALOG_MAP`,
  tax maps, build-key resolution, credit attribution. A new id format silently falls through
  `?? null` fallbacks to a degraded-but-not-erroring path (here: ad-hoc Square line).
- **Don't "fix" categorization with broad name substrings.** Adding "Starter Race" to
  `NAME_CATALOG_MAP` would mis-match "Junior Starter Race Blue" → adult Karting (lookup uses
  `includes()`). Resolve by id, not by fuzzy name.
- A missing Square category on a line item = missing `catalog_object_id`. The "Sales (Categories)"
  tab in the QBO sync lists the line **name** as the entity when it can't resolve a catalog category.
- "These could be old" is a hypothesis to TEST, not assume: pull `created_at` + per-line
  `catalog_object_id` on the actual flagged order ids. Here the dates (this week) + the bare-name
  product registry diff proved it live. UQ/Rookie ad-hoc were the opposite — all dated 6/9, fixed
  by `2623356f` on 6/10, so already self-resolved; only historical remediation needed.

## Fixed-duration open packages: never trust `slot.optionId` (2026-06-16)

**Symptom:** Pizza Bowl (should be 2hr) and Fun 4 All (should be 1.5hr) lanes booked at **1 hour**.
Staff called Fun 4 All "Have-A-Ball"; the actual Have-A-Ball _league_ is a Square-subscription
signup that books **no** QAMF lane (zero "have a ball" reservation labels in 60 days — confirmed
before touching anything).

**Root cause:** QAMF "Time" web offers expose a **60/90/120-min option triple** (e.g. FM Fri-Sun
1258/1259/1260) and return them with `Minutes` **undefined**, listing the **60-min option first**.
`parseAvailabilities`' "longest by Minutes" reduce degrades to `timeOpts[0]` = 60 min. `open`
packages (Pizza Bowl, Fun 4 All) have **no duration buttons**, so `selectSlot` fell back to that
`slot.optionId` and **ignored the known-correct offer option** stored on the experience
(`bowling_experience_offers.qamf_option_id`). Identical to the earlier Fun 4 All incident that
`/api/admin/bowling/fix-f4a-duration` only _remediated_ — the forward cause was never fixed, so it
re-broke (and Pizza Bowl inherited it once it was remapped onto the Fri-Sun offers 158/124).

**Fix (forward):** `BowlingOfferStep.selectSlot` option precedence is now
`durationOpt?.qamfOptionId ?? exp.qamfOptionId ?? slot.optionId`. The seeded offer option
(Pizza Bowl 1260/988/1268/996, Fun 4 All 1227/939/1235/947) is authoritative; `slot.optionId` is a
last resort only. Hold + reserve both build `WebOffer.Options.Time` from this id, so the lane is held
at the right length immediately.

**Fix (existing):** `/api/admin/bowling/fix-open-duration` (data-driven; supersedes fix-f4a-duration)
reads the correct option from the DB per experience+center and reschedules any future
non-cancelled/completed reservation whose live QAMF Time option is wrong. `?dryRun=true` first.

**Guardrails:**

- The DB `duration_minutes` / option metadata is **display + pricing** only. The lane length the guest
  actually gets is **whichever QAMF Time option Id we send** — its `Minutes` lives in QAMF/Conqueror.
- **Never trust the availability response's derived `optionId` for a fixed-duration package.** QAMF's
  option ordering and absent `Minutes` make "longest" unreliable. Use the seeded offer option.
- A renamed report ("Have-A-Ball") may not be the feature you think. Confirm with **data** (reservation
  labels) which booking path is actually involved before remediating production.

---

## QAMF reservation PATCH requires Title + Notes together (2026-06-27)

**Symptom:** `patchReservation(centerId, id, { Title })` (Title only) 400s with
`"JSON deserialization for type 'CenterReservationSvc.Controllers...'"`. Adding the
existing `Notes` back makes it succeed.

**Rule:** When PATCHing a QAMF reservation's `Title`, always include `Notes` in the
same body. Fetch the reservation first (`getReservation`) and resend its current
`Notes` unchanged so you don't blank it. The production booking path already does
this in `unified-reserve.ts` (final patch sends `{ Title, Notes }`); ad-hoc scripts
must too.

**Also corrected:** the old "QAMF creds Vercel-only" note is stale for the NEW REST
API — `QAMF_BOWLING_CLIENT_ID`/`_SECRET` ARE in local `.env.local`, so scripts hitting
`@/lib/qamf-bowling` (getReservation/patchReservation) run fine from a dev machine.

**Context:** owner asked to prefix every Ultimate VIP combo _bowling_ leg's QAMF
Title with `VIP Exp.` so HeadPinz staff spot the VIP package in the Conqueror list.
Forward fix: `unified-reserve.ts` finalTitle now prefixes `VIP Exp. ` when the leg has
a `comboSpecialId`. Existing today/future legs remediated via
`scripts/_vip-qamf-title-prefix.mts` (dry-run default, `--live`; idempotent — skips
titles already starting with `VIP Exp.`). 13 legs patched (today → 7/8).

## Porting a page ≠ redesigning its data layer (2026-07-12)

**Correction:** While planning the Daily Events port from the employee portal, I designed
"improvements" into the data layer — collapsing the portal's two dayPlanner calls into one,
replacing its 7 parallel per-day week fetches with a ranged endpoint, making AI extraction
server-authoritative. Owner corrected mid-build: "make sure we are not changing any API calls —
we should just be moving UI essentially."

**Why:** A port's value is that the moved page behaves EXACTLY like the original against the
same upstream systems. Every "smarter" call pattern is an unvalidated behavior change hiding
inside a supposedly mechanical move — if the new page disagrees with the old one, nobody can
tell whether the data changed or the port broke it. Optimizations belong in their own PR after
the port is verified live.

**How to apply:** When a task is "move/port/recreate X", treat upstream call patterns
(endpoints, params, sequencing, batching) as part of the spec, byte-faithful. Only deviate for
(a) hard repo rules that don't alter the wire requests (e.g. parseWithRawIds response parsing),
(b) dependencies that physically don't exist in the target (portal-DB reads → frozen constants),
and call out every such deviation explicitly in the plan. Ask "is this port allowed to change
behavior?" BEFORE designing, not after.

## Never take money before every fallible non-money step (2026-07-14, H3074 six-charge incident)

**Incident:** The GF deposit route charged the card FIRST, then created + activated the
eGift card. Gift-card creation failed on a custom-GAN collision ("The Gift Card has
already been created" - GANs derive deterministically from the BMI reservation id, and
attempt #1 had already claimed it), so EVERY retry captured $973.07 and then died. One
guest (Kelly Greens, contract 8caebedb) was charged 6x = $5,838.42 across 7/9-7/13 while
the quote showed unpaid. Separately, the legacy-deposit path minted the prior BMI deposit
onto ONE comp gift card - any prior over $2,000 blew Square's per-card cap
(PAYMENT_LIMIT_EXCEEDED, the guest-visible "gift card exceeded value" error, event #3098).

**Why:** Random per-request idempotency keys mean each retry is a brand-new Square
payment; work ordered charge-before-fulfillment means any post-charge failure strands
captured money with no DB record (violates persist-first); deterministic external ids
(custom GANs) collide across retries/re-signs and must have a recovery path.

**How to apply (now enforced in the GF payment routes - keep these invariants):**

1. Idempotency keys derive from (quote id, attempt counter), never randomBytes, so a
   double-click or replay dedups to the SAME payment.
2. Everything fallible that does not need the payment happens BEFORE the charge (gift
   cards are CREATED pre-charge; only ACTIVATE, which cannot take money, runs after).
3. The instant a charge captures, persist its order/payment ids
   (updateGf{Deposit,Balance}ChargeCaptured) - and every retry path checks that marker
   and RESUMES fulfillment (verify payment COMPLETED via Square, then finish) instead of
   re-charging. Resumed loads compute the remainder via sumGiftCardLoadsForPayment.
4. Custom-GAN creation goes through createDigitalGiftCard: a colliding PENDING card is
   reused; a colliding ACTIVE card is never merged - fall back to a Square-generated GAN.
5. Any amount destined for gift cards must be chunked/headroom-checked against the $2k
   cap (giftCardSaleChunks / loadBalanceOntoGiftCards) - including comp mints of prior
   deposits (legacy path now mints one comp card per chunk).
6. Every payment failure/decline is appended to contract_audit_log
   (deposit_declined/deposit_payment_failed/balance_declined/balance_payment_failed) so
   the admin Contract tab timeline shows what the guest experienced.

## QAMF v1.3 lane add/delete work — Game-lane duration is computed from players (2026-07-15)

**Re-probe** (`apps/web/scripts/_qamf-lane-add-delete-reprobe.mts`, live center 9172, throwaway
Confirmed reservations X158957/X158958, self-cleaned):

- **`POST /reservations/{id}/lanes` (add lane) WORKS** under `api-version: 1.3` on a Confirmed
  reservation — the 7/14 "zero-duration lane" was OUR body, not a vendor bug. On **Game-based
  offers the server IGNORES the EndTime you send and RECOMPUTES the lane's duration from its
  players × games** — `Players: []` legitimately computes to 0 minutes (that was the 7/14
  corruption, and its follow-on DELETE 409 `LaneNotAvailable`). Send explicit StartTime AND
  EndTime **plus named players inline** (`Players: [{ Name, ShoeSize, ActivateBumpers }]`,
  `GamesPerPlayer` set) → 201 with a real lane. Notably, inline players in the lane POST are
  accepted — no `PriceKeyNotFound`, unlike the dedicated `POST .../players` endpoint (still
  409s, center price-key config).
- **`DELETE /reservations/{id}/lanes/{laneId}` WORKS** — 200 first try, lane gone in a
  DELAYED re-read (immediate GETs echo requests; always verify delayed, same as the lanes
  PATCH).
- **Caveat before relying on in-place adds:** the added lane got 20 min for 2 players × 1 game
  while the original lane holds 40 min for the same 2 × 1 — the per-game duration applied on
  the add path may differ from the create path (different price option?). Verify in Conqueror.
- **Player-DELETE (`DELETE .../players/{id}`) is STILL a bare 500** under BOTH 1.2 and 1.3 on
  Confirmed with fresh version-matched ids (`_qamf-player-delete-reprobe.mts`, re-probed 7/15
  post-upgrade). Vendor bug, escalated to QubicaAMF 7/11 — the `qamf-sync.ts` graceful
  fallback (sync names/title + staff "adjust bowler count in Conqueror" warning) stays.

**Consequence:** reservation-edit's lane-count change no longer NEEDS the delete+create rebook
(`intent: "rebook"`) for API reasons — in-place lane add/remove is viable once the duration
caveat is verified. Player-count decreases remain blocked on the vendor fix (then also switch
`syncQamfPlayers`' GET from api-version 1.2 → 1.3; 1.2 serves stale player ids post-confirm).

## Player add/remove: exhaustive variants probe — it is NOT our request shape (2026-07-16)

After the lane lesson above, re-challenged the player-DELETE 500 the same way
(`_qamf-player-mutation-variants-probe.mts` + the version-sweep in
`_qamf-player-delete-reprobe.mts`; X158959–X158962, self-cleaned). Full matrix, all on
center 9172:

- **DELETE .../players/{id}: bare 500 everywhere it can exist.** api-versions 1.2 AND 1.3
  (1.0/1.1 GETs don't expose player `Id` at all, so the endpoint is unreachable pre-1.2);
  Temporary AND Confirmed (7/14); Game AND Time offers (kills the "Game duration recompute
  crashes" theory); id read fresh from the SAME version's GET seconds earlier; default-named
  (Player1…) and renamed players. Empty response body (the API's real guards return proper
  problem+json 409s) ⇒ unhandled server exception. **Vendor bug confirmed — keep the
  QubicaAMF escalation, keep the qamf-sync.ts manual fallback.**
- **PUT .../players count-change is DELIBERATELY blocked**, not broken: 3→2 and 3→4 both
  409 `"Requested updated players are 2, but actual players are 3"` (ReservationPlayers…
  code). Same-count rename remains the only PUT use. The lib comment "same-count-only" is
  now probe-verified.
- **PATCH /lanes with inline Players is a SILENT NO-OP for count** — 200 but the lane keeps
  its 3 players. Never use it to change player count and think it worked.
- **Player ids are UNSTABLE** — they regenerated across GETs even after a _409'd_ PUT
  (baseline [4050149-51] → [4050152-54] after a failed V1). Any future player-DELETE caller
  must GET-then-DELETE atomically; never persist QAMF player ids.

So: add/remove players on an existing QAMF reservation has NO working API path today.
Increase = works only via inline Players on an added lane (see lane lesson) or Conqueror;
decrease = Conqueror-manual until QubicaAMF fixes the DELETE.

## Run the FULL build (a11y-gate), not just `tsc`, before pushing kiosk/UI (2026-07-19)

Pushed `autoFocus` on the admin PIN input after only running `npx tsc --noEmit` — it
typechecked fine but the Vercel build failed at the **postbuild a11y-gate**
(`jsx-a11y/no-autofocus`, `scripts/a11y-gate.mjs`). tsc does NOT run jsx-a11y; the gate only
runs inside `npm run build`. **Rule: for any JSX/UI change, run `npm run build` locally
(it runs tsc + the a11y-gate) before pushing — never just `tsc`.** Common jsx-a11y trips on
this repo: `autoFocus`, click handlers on non-button elements without role/label, controls
without an accessible label. See `apps/web/lib/a11y.ts` for the helper props.

## Multi-writer checkout: stale files + wrong-cwd pathspec = phantom equality (2026-07-20)

Two traps that nearly deleted sibling work (dispenser-fault beacon, MSR chooser) from
`KioskGameZone.tsx` while pushing the game-card bridge-status chip:

- **`git diff origin/main -- <repo-relative-path>` run from `apps/web/` matches NOTHING and
  prints nothing** — indistinguishable from "file is identical". Always run pathspec'd
  diffs from the repo root (or use paths relative to the cwd), and treat "no output" as
  UNVERIFIED until the pathspec is proven to match (`git log -1 -- <path>`).
- **In this shared checkout a working-tree file can be OLDER than origin/main** (siblings
  push via worktrees; the checkout lags). Editing a hot multi-writer file in place and
  cherry-picking onto origin can silently revert their pushed features — the 3-way merge
  saw 227 deletions that were just staleness. **Rule: before editing any kiosk/multi-writer
  file, `git show origin/main:<path>` → overwrite the working file → re-apply your edit on
  that fresh base → verify `git diff origin/main -- <path>` (from root) shows ONLY your
  hunks.** Also expect local `tsc` to fail on OTHER stale files (e.g. card-reader) — verify
  the file-level diff instead, and lint the file directly.

## Case-normalizers must never run per keystroke; OSK decisions must read live DOM (2026-07-21)

Kiosk bowling names landed as "SaRA GoODFELLOW" / "SeBASTIAN" — two bugs compounding:

- **`OnScreenKeyboardHost` never re-renders while a guest types** (typing updates only the
  step's state; the host is a KioskShell sibling), so the render-time smart-caps decision
  (`letterCase`) froze at its focus-time value (`true` on an empty field) inside the `press`
  closure → every letter emitted UPPERCASE. **Rule: any per-keypress decision in the OSK
  must be computed inside `press()` from the field's live `value`/`selectionStart`, and the
  host needs an explicit re-render bump per keypress for its labels.**
- **`formatPersonName` on every `onChange` self-defeats.** Its mixed-case guard (preserve
  "McDonald") means an ALL-CAPS stream is only fixable at chars 1–2: "S"→"S", "SE"→"Se",
  but "SeB" now contains a lowercase letter, reads as deliberate mixed case, and every
  later capital is preserved → "SeBASTIAN". **Rule: store names AS TYPED, normalize on
  blur / at commit — never per keystroke.** (Racing names never showed the bug because
  KioskPeopleStep formats one-shot at commit.) A payload-time backstop also can't repair
  already-mangled mixed-case rows — the guard preserves them by design.

Fix: press-time caps in OnScreenKeyboard.tsx; blur-time formatting in the bowling
people/details steps; backstop `formatPersonName` in both reserve payload builders.
`name-format.ts` moved to `apps/web/src/lib/helpers/` (booking service needed it;
kiosk→booking would be backwards layering).

## Kiosk "Confirmation Kiosk" state reverted to plain Confirmation — cross-backend write race (2026-07-22)

Owner report: kiosk reservations turned from "Confirmation - Kiosk" back to "Confirmation".
Live probe: **63/80** recent kiosk rows sat in `-3`, only 17 in the kiosk state — BOTH racing
(W53xxx) and attraction (W385/W384). NOT the sweep (`bmi:sweep:log` had 0 kiosk hits), NOT
`race-confirm-reconcile`, NOT BMI auto-cancel: the revert happens AT BOOKING TIME
(`updated`≈`booked`), final state `-3` with `userUpdatedId=-1` (a Pandora write). Old
kiosk-state rows stay kiosk forever → no delayed reverter; winning the booking-time race is
permanent.

**Root cause:** cross-backend write race. The reserve flow confirms via a PANDORA
`reservation/state → -3` write (unified-reserve BMI_AUTOCANCEL_WORKAROUND). Pandora returns
200 immediately but propagates to Firebird ASYNCHRONOUSLY. The kiosk custom-state write goes
via the OFFICE API PUT seconds later. When the Pandora `-3` lands late it clobbers the Office
kiosk write → plain Confirmation (~80% of bookings). The arena-fix assumption "inline -3 then
custom-state overwrite ⇒ no regression" was WRONG — the two writes go to different backends
with async replication, so "earlier" ≠ "lands first".

**Fix:** (1) `setProjectState` gained opt-in `ensureAttempts`/`ensureGapMs` — for custom
(kiosk) states, re-read + re-assert across a window so a late `-3` is corrected. (2) The kiosk
state flip in `runKioskPostReserve` moved to run DEAD LAST (after the Pandora session
assignment) with the self-heal on. (3) The attraction block in unified-reserve uses the
self-heal (its reassert window IS the propagation guard — no rail delay ahead of it).
Remediation: `scripts/kiosk-state-remediate.mts` (dry-run default, `--commit` to write).

**Rule:** when two code paths write the SAME BMI project field via DIFFERENT backends
(Pandora/Firebird vs Office API), you CANNOT rely on issue-order — Pandora writes propagate
async and can land out of order. The authoritative write must be verified + re-asserted, or
both writes must go through the same backend.

## Combine cards shipped on a guessed transport — twice (2026-07-23)

Owner report (verbatim mood): combining "does not work at all, completely got stuck,"
the API error surfaced as a bare "see attendant," and the reader looped 30-second
"waiting for a card" resets. Two design failures, both mine:

1. **Guessed vendor contracts.** The first combine used a hand-guessed
   `TPI_ConsolidateAccounts` SOAP envelope (errored live: `<string>` array items
   instead of `<long>`, `LocationID` instead of `LocID` in the wrong sequence
   position, `UTC_DateTime` instead of `GMT_DateTime`). The "fix" then swung to a
   raw-TCP Enhanced-3PI client with a new `INTERCARD_EIS_HOST` env — a direct
   host/IP socket from Vercel, which is not how ANYTHING cloud works in this stack.
   The live WSDL was sitting on the host the whole time
   (`WS_ThirdPartyInterface.asmx?WSDL`) and settles every envelope question.

2. **Swallowed errors + unbounded retry loop.** Failures collapsed into a generic
   guest message with the real cause only in server logs; the auto-accept loop
   re-armed straight back into the same failure (30s gate timeout per cycle) while
   holding the guest's card during a 30s×2 socket timeout.

**Rules:**

- **Never invent a vendor envelope or transport.** Cloud Intercard = the ONE SOAP
  host (`intercard.swflpassport.com`) all verified calls use; fetch the live
  `?WSDL` for any new op (element names, ORDER, array item types — `<long>` vs
  `<string>` has now bitten twice: ClearAccount and ConsolidateAccounts). No raw
  sockets, no per-site hosts/IPs, no new env endpoints without the owner naming one.
- **Hardware flows must surface the REAL failure on-screen** (staff read the kiosk,
  not Vercel logs) and **halt the retry loop** after a service failure — resume is
  an explicit tap, never automatic re-entry into a known-dead backend.
- **A guest-facing entry point must not exist when its backend can't serve it** —
  probe availability before showing the button; a timeout with a guest's card held
  must be tight (seconds), and every failure path hands the card back.

## `approval_required` is overloaded AND goes stale on post-paid conversion (2026-07-24)

**Incident:** Owner asked why contract `c675998f` (H1091 "Welcome Boys and Girls
Club", Naples, $1,116) wasn't charging inside the 72h window. My first answer —
"it's a post-paid account, working as designed, invoice-only" — was **wrong**, and
the owner corrected me. It _had been_ post-paid, but the `"GF Post Paid Account"`
BMI line was later removed, converting it to a normal within-96h full-payment event.

**Root cause:** `isPostPaid` is derived LIVE from BMI products every dispatch pass,
and amounts (`deposit_due_cents`/`balance_cents`) are rewritten accordingly — but
`approval_required` is a sticky column written ONCE (at the post-paid hold) and
**never reconciled**. The approve route sets `approved_at` and deliberately leaves
`approval_required = TRUE` permanently. So a converted event kept the stale flag,
and `getQuotesNeedingBalanceCharge` excludes `approval_required = TRUE` → the 72h
auto-charge silently skipped a now-normal, card-on-file event. It also can't reach
`balance_charged`, so `group-dayof-pay` (whose `OR approved_at IS NOT NULL` escape
implies someone intended post-paid to settle) never fires either — dead zone.

**The flag means TWO things** (disambiguate ONLY by `approved_at`):

- post-paid marker: `approval_required=TRUE` + `approved_at` NOT NULL (went through /approve)
- manual auto-charge HOLD (h1174 pattern): `approval_required=TRUE` + `approved_at` NULL, on a NORMAL event

**Fix (fix/gf-stale-postpaid-flag-release):** reconcile the flag in group-quote-dispatch's
post-sign branch — when `!isPostPaid && approval_required && approved_at`, clear
`approval_required = FALSE` (idempotent, outside the change-gate so it self-heals).
Scoped by `approved_at` so manual holds are untouched. No payment-cron predicate
change needed: once the flag is FALSE the existing charge query matches it.
Blast radius verified = 1 row (#286); the other 24 approved rows are still genuinely
post-paid and untouched. Owner decision 2026-07-24: converted events auto-charge the
card on file (Path A), accepting that the card was saved under a post-paid
`autoCharge:false` contract.

**Rules:**

- **Any flag derived from BMI product state must be reconciled every pass, not written once.**
  If `isPostPaid` can flip, everything gated on it (amounts AND `approval_required`) must re-derive.
- **Don't declare "working as designed" on a payment gap until you've checked whether the
  event's type CHANGED.** A stale marker on a converted event looks identical to correct
  post-paid behavior; the line-item list is the tell.
- **Never blanket-add `OR approved_at IS NOT NULL` to the balance-charge query** — a converted
  row with a saved card would hit Path A and auto-charge a card banked under `autoCharge:false`.
  Fix the stale flag upstream instead.

## tsc "clean" is a lie while syntax errors exist anywhere (2026-07-26)

**Incident:** the Game Zone cancellation fix shipped a semantic type error
(`plan.ts` read `r.partial` off a variable whose explicit inline annotation
lacked the field) and broke the Vercel build. Local `tsc --noEmit` before
commit "passed" — its only output lines were `.next/dev/types/*` **syntax**
errors, which were being grep-filtered as known noise.

**Mechanism:** when the program contains parse/syntax errors (here: a corrupted
`.next/dev/types/routes.d.ts` left behind by a dev-server crash), TypeScript
skips/short-circuits semantic checking — so real type errors in source files
are silently NOT reported. Filtering the syntax errors out of the output makes
a fundamentally broken run look green. Vitest never catches these either
(esbuild strips types without checking).

**Rules:**

- **A tsc run with ANY syntax error reports nothing trustworthy.** Never filter
  known-noise errors out and treat the remainder as the verdict. Zero output
  must mean zero errors of every kind.
- **Fix the corruption first, then typecheck:** `rm -rf apps/web/.next/dev`
  (safe when no dev server is running) and re-run.
- **Before committing anything, gate on `npx next build`** (or a tsc run that
  is verifiably syntax-clean) — it's what Vercel runs, and it caught in one
  pass what the polluted tsc missed.
- Also fixed: `let x: Array<{...inline...}>` annotations silently narrow away
  fields added to the source type — annotate with the named type
  (`TenderRefund[]`) so the compiler tracks evolution.

## Pandora create is NOT an upsert + waiver template duration is YEARS (2026-07-25)

**What happened (Strachan family, live kiosk traffic):** a guardian signed waivers for two
kids; one kid worked, the other's waiver "never applied." Live Pandora reads showed the second
kid had **EIGHT person records** (three holding waivers from three separate sign attempts, five
orphans), the first kid two, the guardian two. Separately, every waiver signed through our
`WaiverSigning` flow carried `waiverExpiry` = the NEXT MORNING 9am ET, while desk-signed records
run ~1 year.

**Root causes:**

1. **`POST /v2/bmi/person` creates a duplicate whenever the field set differs from the original
   create** (and possibly whenever it feels like it). Every comment claiming "known person
   resolves to the same personId, never a duplicate" was wrong. The biggest minter was
   `linkMinorToGuardian` re-creating the minor with `guardianID` after every guardian sign
   (kid's own empty email vs `submitNew`'s session-contact email fallback → no match → new
   person). Re-taps of "Sign waiver" re-ran the short-id "upsert" too — one new person per tap.
   With duplicates in play, the waiver lands on one record while readiness checks read another
   (`bmiPersonId` vs `pandoraPersonId`) → sign-then-revert loop → guest re-signs → another dup.
2. **Pandora waiver template `duration: 1` means 1 YEAR** (BMI semantics; all three locations
   return 1; desk records confirm ~1yr) — `calculateWaiverExpiry` treated it as DAYS.

**Rules:**

- NEVER call the Pandora person create for someone who already has a short Pandora id this
  session. Resolve once, store `pandoraPersonId`, use it for BOTH signing and every later
  readiness read. The create is a last resort for identity resolution, not a lookup.
- Treat Pandora waiver template `duration` as YEARS (clamped 1–10 in `calculateWaiverExpiry`);
  any `?? 365`-style fallback on that field is a bug.
- When a "signed but shows unsigned" report comes in, suspect DUPLICATE PERSON RECORDS first:
  `GET /bmi/person/search?lastName&birthday&filter=false` enumerates them; the guardian's
  `related[]` reveals link-minted orphans.
- Cleanup for affected guests: waivers may exist on multiple records; the record that raced
  (has `lastVisit`) is the live one — merge/deactivate orphans at the desk.

## A hidden action is a missing feature: settled reservations had no refund door (2026-07-28)

**Report:** owner opened a completed race (res 16426, Fort Myers, "Debbie Collier",
$27.67) in the manage modal and asked why there was no refund button. There wasn't
one — and three independent things were each individually sufficient to hide it.

**1. The only money action was Cancel, and Cancel correctly refuses these rows.**
`cancelActionable()` returns false for `completed` / `arrived` / `no_show`, and also
whenever `dayofPaymentId` is set. Both refusals are RIGHT: Cancel voids a booking, and
a visit that already happened must not be voided; its cascade also won't touch a
tendered day-of order. But Cancel was the header's only money door, so the rows that
most need a refund had none. The fix is a SEPARATE gate (`refundActionable`) covering
exactly Cancel's complement — never a loosened Cancel.

**2. The only control that could actually price the refund was hidden by product kind.**
The day-of order-lines stepper lived inside the bowling-only branch of the edit modal,
even though the server computes `editable` per line and is completely kind-agnostic
(`isEngineOwnedLine`, shared by the planner and `applyOrderLineSpec` — the comment
already claimed "one rule, no drift"). It mattered exactly here: this race bills as a
single **"Rookie Pack"** line, so heat removal cannot price it, while returning the
pack line IS the refund. The client was hiding a capability the server had.

**3. The flag gate was keyed on step KIND, so each phase got the wrong flag.**
`refund_dayof_payment` is emitted by BOTH `mid` and `post_complete` (money-only is the
preferred shape in each). Kind-keyed gating therefore meant `_MID_DECREASE` silently
governed post-complete refunds while `_POST` governed only the rebuild path — enabling
`_POST` alone did nothing for the post-complete refund we actually shipped, and
enabling `_MID_DECREASE` alone opened a phase nobody had signed off.

**Rules:**

- **When a gate correctly refuses an action, ask what the row's remaining action IS.**
  A guard that's right about "not this" still leaves a hole if nothing else covers the
  case. Add the complement gate; don't widen the correct one.
- **Never gate a UI control on product kind when the server already decides per item.**
  If the server ships an `editable`/`allowed` flag, render exactly that. Kind checks on
  the client silently amputate whole flows (here: every race refund).
- **Gate flags on PHASE, not on step kind,** when one step kind spans phases. Keep the
  mapping in ONE pure helper (`refundFlagForPhase`) used by the planner for preview and
  re-checked by the executor as the real gate. Refuse the impossible combination
  (`pre` + a paid-order refund step) loudly instead of falling back to a default flag.
- **A flag-off environment must be visible in the PREVIEW, not at Execute.** The dry-run
  now returns `executionBlocked`, so the button disables with the reason as soon as the
  quote lands. Classify "flag off" as _blocked_, never as an ack prompt — no checkbox
  unlocks an env var, so re-offering the manager checkbox is a dead end.
- **Guard copy must never point at a button that isn't on the row.** Three separate
  messages said "use Cancel instead" — all on rows where Cancel is hidden by design.
  When you write remedial copy, check the affordance actually exists in that state.
- **`refund_cents` is CANCELLATION-only. Never write it from an edit refund.** It feeds
  guest-facing copy ("This booking has been cancelled — your $X refund is on its way")
  and `booking-status`'s outcome, so an edit refund writing it would tell a live guest
  their reservation was cancelled. Edit refunds live in the edit ledger, which already
  feeds the Payments refunds node and History. _(Checked before changing it — the
  obvious "make the row show the refund" fix would have been a guest-facing bug.)_
- **Verify against the reported row, read-only, before claiming a fix.** `buildEditPlan`
  only GETs and calls `orders/calculate`, so dry-running the real reservation proves the
  plan (phase, cents, itemized return uid, blocked reason) without moving a cent. Doing
  that is what surfaced the pack-line problem — the unit tests all passed without it.

## A "master switch" that couples an unrelated broken feature to the one you need (2026-07-28)

**Setup:** owner said "turn it all on." Refunds were proven, but
`RESERVATION_EDIT_V2` is the master switch the edit route checks — so enabling refunds
would ALSO have shipped PRE-phase bowling/KBF editing, whose QAMF player sync is blocked by
a vendor bug (player-DELETE returns a bare 500 on every valid input, escalated, no API path
exists) and whose own live-smoke items have never been run.

**Fix:** exempt the narrow, proven capability. `isRefundOnlyPlan()` lets a refund-shaped
plan execute on its own phase flag while everything else still needs the master switch.

**Rules:**

- **A capability flag should gate ONE capability.** When a master switch accumulates
  unrelated features, "turn on X" silently ships Y. Split the flag before shipping, not after
  someone reports Y broken.
- **Exemptions from a safety gate must be ALLOWLISTS, not blocklists.** `isRefundOnlyPlan`
  requires every step to be one of eight named kinds. A blocklist ("not a charge, not a
  sync") silently widens the moment anyone adds a step kind — and the thing being widened is
  "may move money without the master flag."
- **When you add a second gate, re-check the PREVIEW covers both.** Adding the refund
  exemption reintroduced the dishonest-preview bug for every non-refund plan: the planner
  reported "runnable" while the route would 501. If `executionBlocked` mirrors the route,
  it must mirror ALL of it.
- **Never flip a flag before the corrected code is on the deployed branch.** Main still had
  the pre-correction engine (no itemized returns, `update_dayof_order` still emitted on a
  paid order). Setting the flags first would have enabled amount-only refunds — explicitly
  banned — plus a step that fails fatally AFTER money moved. Verify with
  `git show origin/main:<path> | grep <symbol>`, not from memory of what you built.
- **Smoke the shape that PRODUCTION will run, not a convenient one.** The 11/11 run set
  `RESERVATION_EDIT_V2=true` and used MID + a bowling row. Production is master-OFF, and the
  reported reservation was POST + a collapsed race-pack line + full refund. Three different
  axes untested. Deleting the master flag from the smoke and adding `--post` / `--race`
  turned "probably fine" into 18/18, 18/18, 20/20.

**Square fact (verified 3× live):** an ITEMIZED refund does **not** populate the SALE
order's `refunds[]` — `refunded_money` and `net_amount_due_money` both read 0 there. The
linkage lives entirely on the RETURN order (`refund.order_id` → return order carrying
`return_line_items[].source_line_item_uid`). Debugging a refund by reading the sale order
will show nothing. Same shape the POS produces for in-store returns.

**Reconciliation trap (cost me a false alarm):** a gift-card-funded payment reports
`source_type: "CARD"`. Summing by `source_type` counted internal gift-card spend as the
owner's credit card and reported $59.20 outstanding when the real-card net was zero. The
ONLY reliable tell is `card_details.card.card_brand === "SQUARE_GIFT_CARD"`. This is the
same trap already recorded for refund routing — it bites reconciliation queries too.

## A status badge must be per-record truth, or the "informational" excuse leaks (2026-07-28)

Owner, on the live kiosk check-in list: _"Reservations showing everyone as express lane? … Tammy
reservation is not but is showing express lane?"_ — and, for at least the second time, _"I've said
several times express lane doesn't need to check in on kiosk and it shouldn't send an OTP."_

The badge rendered on `r.kind === "racing"` — **every** racing row. `CheckinBrowseRow` carried no
express field; the server never computed eligibility.
[kiosk-checkin-plan.md §11A](kiosk-checkin-plan.md) had explicitly decided this: "Deliberately NOT
gated on real express eligibility … computing `fastLane`-per-row would be leaky + slow. Purely
informational." On live FM data for 7/28, **8 of 25** racing reservations (32%) were mislabelled —
each one a guest told to skip a check-in they actually needed.

**Where the reasoning went wrong:**

- **"Informational" is not a licence to be wrong.** A green pill next to a specific guest's name
  and time is not a general explainer — it is a claim about THAT reservation. If a UI element sits
  on a row, it is per-row truth or it is a bug, no matter how the spec frames it. "It's just
  informational" was the tell that should have triggered a re-think, not the justification.
- **The cost objection was never priced.** "Leaky + slow" was true of the rejected design (a live
  Pandora waiver read per row). The flag was already sitting in Redis: `bookingrecord:{billId}`
  carries `fastLane` from checkout, and the browse loop was already awaiting a Redis `mintRef` per
  row — so real eligibility cost ONE extra GET, issued in the same `Promise.all`, i.e. zero extra
  round trips and nothing new disclosed. **Before accepting "too expensive to be correct", price
  the cheap version:** the truth is often already in a store the code path is opening anyway.
- **Repeated guidance means the RULE wasn't implemented, only the artifact.** "Express doesn't
  check in and shouldn't get an OTP" had been said before, and a modal had been built — but the
  express row still ran the last-4 gate → OTP → check-in like any other. Building the thing the
  owner described (a modal) while leaving the behaviour they asked for (no OTP, no check-in)
  unchanged is why they had to say it again. When guidance repeats, look for the behaviour that
  never changed, don't re-polish the artifact.

**Fix / guardrails:**

- `express: boolean` on both `CheckinBrowseRow` and `CheckinItinerary`; two pure, unit-tested
  predicates in `apps/web/src/features/kiosk/checkin/express.ts` (cheap booking-time flag for the
  list, live-waiver truth for the itinerary — the itinerary one is strictly stronger and catches a
  waiver that lapsed after booking). Both re-enforce the 2026-06-13 whole-party rule and hard-gate
  on racing-only (a combo still needs its lane opened).
- **An express row REPLACES check-in**: tapping it opens the message — no last-4, no OTP, no
  itinerary. Same for the itinerary when reached by phone lookup or a scanned QR.
- **Verify a badge change against live data before calling it done.** `cd apps/web && npx tsx
scripts/kiosk-express-badge-check.mts [date] [center]` prints the decision + reason per
  reservation, works at any hour (no ±3h window), and is read-only. It's what proved Tammy N.
  6:00 PM now drops the badge — a build + unit tests could not have.
- Copy fixed to "Race Check-In — 1st floor, left of the Red Track" (was "the pits"); one shared
  `ExpressLaneBody` so the modal and the itinerary panel cannot drift.

**A `TODO(i18n)` for "rich text can't be translated" is usually a splitting problem, not an engine
problem.** The express body was left English because inline `<strong>` spans made it rich text the
plain-string `formatMessage` can't render. The fix wasn't a new engine: split the paragraph at
SENTENCE boundaries (plus one standalone place name) so each key is a complete translatable unit
and the emphasis wraps a whole key. Splitting mid-sentence is what produces half-Spanish output —
splitting between sentences doesn't. Reach for that before deferring a translation.

**Process note that nearly shipped a regression:** this fix was written in a working tree ~100
commits behind `origin/main`, and main had since reworked the very file being edited
(`KioskCheckinFlow.tsx` +403/−143, the kiosk i18n conversion). `git fetch` + `git diff HEAD
origin/main -- <the files you touched>` BEFORE writing the patch is what caught it; applying the
original diff would have reverted main's i18n work on that file. Re-do the edit against
`origin/main` in a nested worktree, never force a stale patch through.

## A shared helper is not a fix — the fix is the CALL SITE, and there were three (2026-07-29)

Owner report from the HPFM shoe KDS: a kiosk booking ("Alpha Test", 1 bowler, 6:15 PM)
showed only `1 Shoe Rental Web` — the paid rental line — and no shoe SIZE ticket. Suspicion
was the 7/25 change that dropped the "how many pairs" step and derived the shoe count from
per-bowler sizes (`ceb4357a`).

**It wasn't that change.** Neon had the size (`Female 1`), QAMF had it, and the derived
rental line item was correct. What was missing was the `$0` shoe-KDS line item on the day-of
Square order. Live proof, 10 days of bookings that recorded sizes:
`web 32/32 have shoe-KDS lines · kiosk 0/8`.

**Root cause:** `fe7a1e7d` (7/24) added `syncShoeKdsLineItems()` to
`unified-reserve.ts` because "kiosk collects sizes UP FRONT." But **kiosk bowling does not
go through unified-reserve** — it reuses the web `BowlingWizard`, which POSTs
`/api/bowling/v2/reserve`. That route persisted `shoe_size` to Neon and never touched the
Square order. Web worked only because the guest later loads the confirmation page and
`BowlingPlayersEditor` PATCHes `/reservations/[id]/players`, which *does* sync. The kiosk has
no confirmation page, so nothing ever wrote the sizes. The fix had landed on a producer the
kiosk never executes — and `tsc`, eslint, and the full build were all green, because a call
site that is never reached is not a type error.

**Fix:** call `syncShoeKdsLineItems` in `app/api/bowling/v2/reserve/route.ts` right after
`insertReservationPlayers`, guarded on `players.some(p => p.shoeSize)` — a no-op for web
placeholder rosters, and a strict improvement for web KBF (sizes are pre-filled, so they now
land at reserve instead of waiting on a page visit).

**Rules:**
- **Before fixing "the kiosk path," prove which endpoint the kiosk calls.** Read the network
  call, or read the runtime log for one real booking. "Kiosk collects it up front" is a UI
  fact; it says nothing about which server route runs. Kiosk flows that reuse a web wizard
  hit the WEB route.
- **When a helper has N producers, enumerate all N and state the coverage in the commit.**
  `fe7a1e7d`'s own message named a third producer (`bowling-walkin-order.ts`) and left it
  alone — but never checked that the two it *did* wire were the two that actually run.
- **A per-guest side effect is verifiable in bulk — verify it in bulk.** One query joining
  `bowling_reservation_players` to the Square order, grouped by `booking_source`, turned a
  guess into `web 32/32, kiosk 0/8` in one run. Do that BEFORE writing the fix, not after.
- **"Best-effort, never throws" hides its own absence.** The helper swallows failures by
  design, so a missing call and a failing call look identical from the outside. When a
  side effect is silent, the only proof it ran is the artifact it produces.

## Design the whole guest flow before building the happy path (2026-07-29)

Built Game Zone voucher redemption single-shot: scan one code, dispense one
card. The owner immediately asked the two questions that should have been
designed for up front — "scan multiple vouchers before hitting get my cards"
and "what if a voucher has a game zone card AND a race on it" — and the second
one had already bitten once (BMI multi-item vouchers were silently
half-redeemed because `extractApplied` did `.find` on one comp line).

Retrofitting the basket meant reworking claim timing (claim moved from scan
time to dispense time so browsing can't burn a code), per-row failure handling,
and the whole entry screen. All of that was cheap to design and expensive to
add later.

**Rule:** before writing a guest-facing redemption/purchase flow, answer these
in the plan, not after the first version ships:
- Can the guest present MORE THAN ONE of these at once? (basket vs single)
- Can ONE of them contain more than one thing? (per-item identity + per-item
  single use, not per-code)
- Do the parts fulfil in DIFFERENT places? (dispense now vs cart at checkout)
- What does a PARTIAL success look like on screen? ("something went wrong"
  leaves a guest who is owed 3 cards and got 2 with no idea which)
- When exactly is the irreversible step taken, and can the guest walk away
  before it?

Corollary that saved us here: per-item claims meant a mixed voucher's unspent
legs survive an abandoned booking. Per-code single use would have destroyed
them. Model identity at the smallest redeemable unit from the start.

## Render a new guest-facing page IN its real chrome before shipping/sharing (2026-07-30)

Built the /v/{code} voucher page styled as a standalone white page — dark text,
light background. It's a top-level route, so middleware rewrites it under the
brand (/hp) layout: fixed nav + dark site background. Result on a real phone:
content slid UNDER the fixed nav and rendered dark-on-dark, unreadable. I
emailed guests a link to it without ever loading it in the actual chrome. Owner
(rightly): "why didn't you catch this, that should be a normal thing by now."

CLAUDE.md already says "NEVER guess a live site's CSS/layout — inspect the real
DOM first," and there's a seed+smoke rule. This is the same rule for pages I
author, not just ones I convert.

**Rule:** any NEW top-level page/route, before sharing a link or calling it
done:
1. Find a SIBLING page that already renders in the same chrome (here /reload)
   and copy its shell: nav-clearance top padding (`pt-32 sm:pt-36`), dark
   backdrop, white-on-dark colors. Don't invent a standalone light layout.
2. Actually LOAD it in the brand chrome (dev server or deploy preview) and look
   — a fixed nav + site background are invisible in a bare component render.
3. Only then share the link.

The tell you skipped this: your page uses `text-neutral-900` / `bg-white` while
every sibling uses `text-white` on a fixed dark `-z-10` backdrop.

## A module-level complaint is a scope statement, not a bug report (2026-07-30)

Owner opened with "this voucher plus game zone is a total mess … research and
fix." I fixed exactly what each of their test screenshots showed — and they had
to keep walking the kiosk finding the NEXT dead end (a different "Accepted!"
screen with no scan-more, a cart voucher chip whose tap never worked, a promo
chip with no way back in, a no-dispenser kiosk promising to print cards) until:
"Why am I still having to tell you this stuff … why haven't you reviewed,
tested and fixed it all?"

The symptoms all had ONE structural cause — value state scattered across
panel-local screens — and per-symptom patches kept shipping new inconsistencies
into the gaps (my own auto-print countdown among them; owner hated it: timers
that act without the guest asking are not a UX fix).

**Rule:** when the complaint names a MODULE, enumerate its full surface before
editing — every entry point, panel, state and exit, including chips/banners on
OTHER screens that open it. Walk each path on paper, list every dead end, design
one target state, implement once. Extract the decision logic into pure tested
functions (`code-entry/receipt-plan.ts`) and instrument every transition
(`[kiosk]` console + Clarity) so the next report arrives with data instead of a
screenshot.

The tell you're doing it wrong: the owner's screenshots are driving your commit
sequence.

## A verify-this-for-me finding needs the exact URL, or the owner tests the wrong surface (2026-07-30)

Reported "the /waiver sign-time guardian chain soft-locks completion" and asked the
owner to test with steps that assumed they knew WHICH page. Three rounds of "it works
fine" followed - they were testing /kiosk/flow (form-mode guardians, a Continue
button, genuinely fine) and an older branch's /waiver, while the defect lived only in
the head build's /waiver sign-time path. Both sides were right about what they saw;
the instructions never pinned the surface. (Owner, fairly: "your steps were not clear.")

**Rule:** when handing the owner a repro for a UI finding:
1. Give the FULL URL (host + path + params), not a route name - on preview, the
   literal vercel.app link.
2. Name the build fingerprint: what visibly differs in the version under test
   (here: the finish is a green "All waivers signed / I'm done" card; a "Continue"
   ending = wrong page or old build).
3. Say what a PASS and a FAIL each look like on screen, so "it worked" is
   unambiguous.
The tell you skipped this: the owner's report describes UI your finding's code path
cannot render.

## A cutover report's claim about behavior must match a call site, not an intention (2026-07-31)

The stage-2 waiver cutover report said the four booking confirmation pages "keep the
canonical long /waiver URL … the long link still attaches the waiver to the
reservation, it just has no remove button." The code never did that: both racing
confirmation pages built `buildWaiverUrl({ center })` — no `reservation`, so no
`loc`/`pid` — and the block's own comment admitted it was "center- not
reservation-scoped." The email route even documented the intended contract ("with
loc+pid when the reservation is known") while never receiving one. Net effect in
production: guests signed standalone waivers that never landed on the booking's
roster — the owner caught it from a live confirmation page (billId 63000000006696489).
The old pre-cutover `subscribe/event?id=projectReference` link HAD attached, so the
cutover silently regressed the attach while every waiver test stayed green.

Two compounding details found while fixing it:

1. **The pid was derivable all along, without any fetch.** Office projectId =
   billId + 1 (`officeProjectIdFromBillId`, last-10-digit math). The old block
   instead fetched the bill overview and read `ov.id` off `res.json()` — a 17-digit
   BMI id through JSON.parse, i.e. ALREADY precision-corrupted before use (both
   …489 and …490 round to …488). The "reservation exists" gate was probing a
   neighbor's id and still passing. A `string` annotation on the URL param was safe;
   the "convenience" read of the parsed overview was the violation.
2. **Pure id arithmetic must live in a pure module.** `officeProjectIdFromBillId`
   sat in `lib/bmi-office-actions.ts`, which imports node `https`/`crypto` at module
   top — unimportable from the "use client" confirmation pages. Extracted to
   `lib/bmi-office-ids.ts` (re-exported from the old path so server callers and the
   round-trip tests are untouched).

**Rules:**
- When a report asserts "surface X does Y," verify the assertion against the call
  site before relying on it — a report describes the author's model, the tree
  describes the product. Here one grep (`buildWaiverUrl\(` in the page) falsified it.
- A cutover that replaces a reservation-scoped link must prove the replacement is
  still reservation-scoped — "same banner renders" is not that proof. The tree-scan
  suite (`waiver-entry-points.test.ts`) now pins both racing confirmation banners to
  `officeProjectIdFromBillId` + a `reservation` passed to `buildWaiverUrl`.

## Flags are kill switches, not launch gates (2026-07-31)

Shipped the kiosk gift-card split behind TWO stacked opt-in flags (terminal +
split, both `=== "true"` NEXT_PUBLIC vars). The owner enabled one, redeployed,
and stared at the old UI through three rounds of "did you redeploy?" - the
second flag was never set, the values are build-baked, and an open kiosk tab
keeps the stale bundle anyway. Owner: "stop trying to make everything flags...
if we do flags, it's only to turn features off. I don't want to fight it 24/7."

**Rule (now in CLAUDE.md hard rules):** a merged feature is ON. A flag, when
one exists at all, defaults ON (`!== "false"`) as an emergency kill switch -
never an opt-in gate. Not ready to be on = not ready to merge: branch + preview
deployment is the exposure control, not an env var. And never stack two flags
in one feature's path - the second one is invisible until someone loses an
evening to it.

The tell you're doing it wrong: your rollout instructions contain the words
"set the env var in Vercel and redeploy" for a feature the owner asked for.

## A client-side slot gate is a display filter, not enforcement (2026-08-01)

Midnight Madness was sold hours before its 11:45 PM window on launch day.
When MM moved onto the shared all-day Fri-Sun Time offer (its dedicated QAMF
Unlimited offers reject every create), its late-night window became OUR rule -
and the only place it was enforced was the offer-card/slot filtering in the
clients (`slotAllowedForExperience` in the classic wizard + useBowlingOffers).
Nothing on the server knew MM had a window at all: the hold and reserve routes
saw only the shared `webOfferId`, which is exactly the field that can no longer
distinguish MM from the regular hourly rail. Any stale bundle, cached offer
step, or direct POST booked MM at noon and charged for it.

**Rule:** every experience-scoped sales restriction (time window, day, blackout)
must be enforced in the money path - the reserve route / unified-reserve -
fail-closed, BEFORE any QAMF confirm or Square write. Client gates are UX
sugar on top, never the mechanism. When the restricted experience shares its
offer id with an unrestricted one, the offer id is not a usable signal: detect
by `experienceSlug` when the client sends one AND by the experience's Square
product lines (every paid booking carries them) so clients that predate the
slug field are still covered. `midnightMadnessWindowError` /
`MM_CATALOG_OBJECT_IDS` in `features/booking/service/bowling-offer.ts` is the
pattern: one shared rule, asserted at hold (UX), reserve (money), and
unified-reserve (kiosk/mixed carts).

The tell you're doing it wrong: a restriction described with "the card is
hidden outside the window." Hidden is not blocked.

## Guest-facing UI on a money path needs an explicit owner decision BEFORE building (2026-08-01)

While fixing "scanning the VIP voucher pulls no names in at check-in," the fix
chosen was to ADD required per-racer name inputs to the web combo party step -
a whole new guest-facing form on a purchase flow, gating Next. The owner had
asked for name RECOGNITION (pull the name in when a signed-in / previously
raced guest scans), never for new typing at booking. The change was described
after the fact inside a long summary, the owner committed the batch trusting
the headline ("combo names"), it deployed, and they discovered a form they
never approved on their live checkout. Reverted same day (15d826e5).

**Rule:** anything a GUEST will see or type - a new field, step, gate, or
required input, especially on a booking/checkout path - is a product decision,
not an implementation detail. STOP and ask before building it, with a one-line
mock or description of exactly what the guest will see ("this adds two required
name inputs to step 3 of the combo flow - ok?"). "I mentioned it in the
summary" does not count: the decision has to be made BEFORE the code exists,
in its own question, not discovered inside a report of finished work. Root
causes can have multiple fixes - when one candidate fix changes guest UX and
another doesn't, present both and let the owner pick.

The tell you're doing it wrong: the words "and Next is blocked until..." about
a flow the owner never asked to change.

## "Everyone on a booking" means BMI projectPersons, not just heats (2026-08-02)

The voucher receipt's new "Who's here from your booking?" chips reused the
check-in party rail (`listBindableParty`) and offered ONE person for a 5-guest
VIP booking. The rail unioned record racers, Neon heats, waiver-link signers,
and the contact — but count-based bookings carry only "Adult N" slot labels in
heats, so everyone the guest had actually REGISTERED on the booking (web
waiver registration, staff adds) was invisible. The owner's correction: "check
out the code that pulls in people into waiver from a booking — it should pull
every person on it."

**Rule:** a "people on this reservation" feature must union **BMI
projectPersons** — `getReservationDetail(locationId, projectId).persons_list`,
`projectId = officeProjectIdFromBillId(billId)`, trying each of
`CENTER_TO_BMI_LOCATION_IDS[center]` (the FM server hosts two venues) — the
same source `/api/waiver/context` and the kiosk waiver roster read. And filter
placeholder slot labels ("Adult 1") even when they carry a personId: the
whitley incident put those labels INTO BMI's people list, so an id is not
proof of a real name.

## A derived flag written only at INSERT rots — and can hard-block a signature (2026-08-03)

Sales flipped three HPFM quotes to "Send Contract" and reported "not sending".
The pipeline was fine (cron every 60s, `0 in send-contract state(s)` all
morning — the state flip never persisted in BMI, upstream of us). But chasing it
surfaced a real bug: `is_tax_exempt` was written **only** by `insertGfQuote` and
never again, while `taxCents` is re-derived from `isTaxExempt(item.products)` on
every dispatch pass. Add or remove BMI's `GF Tax Exempt` line after the first
send and the money self-heals while the flag lies — permanently.

Both directions do damage, and the second is worse than cosmetic:

- **Flag FALSE, exempt in BMI** → contract charges $0 tax, but the page never
  asks for the DR-14 and the signed PDF records "Tax exemption document on file:
  No". Found 12 such rows, ~$25k signed with no certificate on file (Naples
  Airport Authority $12,224.34, FGCU, YMCA Collier, Boys & Girls Club, …).
- **Flag TRUE, no exempt line** → `taxValid` in `ContractClient` is
  `taxExempt === "no" || (taxExempt === "yes" && Boolean(taxFileUrl))`, and the
  radio DEFAULTS to "yes" off the flag. The guest is **hard-blocked from signing**
  until they upload a DR-14 they don't have and don't need. Three unsigned quotes
  were stuck this way, incl. JW Group 3447 — opened six times, never signed,
  read as "the contract isn't sending".

**Rule:** any column derived from BMI products must be re-derived and rewritten
on every sync pass, not just at insert. Concretely: add it to
`updateGfQuoteDetails`, pass it at **every** call site, and — the part that's
easy to miss — add it to the post-sign `changes[]` comparison set. `GF Tax
Exempt` is a $0 line, so toggling it on an already-tax-free event moves no money;
every other comparison matches, the pass returns "no changes", and the flag stays
stale forever behind a gate that looks like it's working.

The same class of bug is already documented one section over for
`approval_required` (2026-07-24, stale post-paid marker). That one got a
self-heal block; this one didn't. When you find the third, stop patching
per-field and re-derive the whole derived set.

**The third arrived same-day: the CENTER stamp (2026-08-03).** US Anesthesia
Partners (H3194, BMI 56000667, 8/8) is moving from FastTrax to HeadPinz Fort
Myers. FastTrax and HPFM share one BMI client (`headpinzftmyers`), so a move
keeps the same project, contract, deposit and gift card — and `lib/bmi-scan.ts`
already re-reads the Pandora **Location** selector on every scan. But
`center_code / center_name / square_location_id / brand / base_url / gan_prefix /
hermes_center` were written **only** by `insertGfQuote`, so a moved event kept its
old venue forever: the day-of Square order rings the whole event up at the venue
it left, the balance order books there too, and every guest-facing string (brand,
`base_url`, waiver / survey / Google-review links) names the wrong center. Fixed
by re-deriving them in `syncQuoteCenter` (group-quote-dispatch) — gated on
`center_code`/`square_location_id` only, because `gan_prefix` legitimately varies
across ~170 legacy rows and diffing it would report a phantom change on every one.

Two things the center case adds that the flag cases didn't:

- **A Square order's location is immutable.** Re-pointing the row is not enough —
  `reconcileDayofOrder` now rebuilds on a location mismatch, not just a total
  mismatch, because a move often changes no money at all. It also cancels the
  superseded order at **its own** location; passing the quote's freshly-updated
  location would fail the cancel and leave two live orders for one event.
- **The classifier that picks the venue must not be greedy.** The FastTrax
  backstop was `subject.includes("FT")`, which also matches GIFT, LEFT, SOFT,
  CRAFT, DRAFT, AFTER — and since the check can only ADD FastTrax and never
  remove it, one false positive pins a HeadPinz-bound event to FastTrax on every
  subsequent pass. Now anchored (`isFastTraxSubject`, tested).

With the center stamp covered, the BMI-derived set is closed: everything
`insertGfQuote` takes from BMI is now also writable by `updateGfQuoteDetails`. The
insert-only remainder is identity (`bmi_reservation_id`), vestigial Hermes queue
ids, and the dead PandaDoc template columns. A fourth instance means someone added
a derived column without adding it to the update path — check that first.

**Corollary for triage:** "it's not sending" from sales can mean sent-but-unsignable.
Check `contract_sent_at` and the audit log's `page_view` rows before believing the
dispatch path is at fault — JW Group had six page views and zero `signed` events,
which named the real problem immediately.

## A swallowed loop-breaker turns a vendor outage into guest spam (2026-08-03)

BMI Office started returning **403 on writes while reads stayed healthy**. Every
group-function contract send fell back to Pandora, which returns 200 and
**silently no-ops CUSTOM state ids** — a pathology already documented twice in
this file. So the project never left "Send Contract", the dispatch cron re-scanned
it on the next pass, and re-emailed the guest. Result over 45 minutes:

    Sanibel Harbour   25 emails      Happy Birthday Danny!  24 emails
    Garland           25 emails      RG Architects          14 emails

~88 duplicate contract emails to four guests. It self-resolved only when the
vendor's writes recovered.

Two independent faults had to line up, and both were ours:

1. **`setProjectState` reported success it could not prove.** For a custom state
   id it returned normally as soon as *either* path claimed success — and the
   Pandora path's claim is known-worthless for exactly these ids. A function whose
   whole job is "make the state be X" must READ BACK that the state is X. It now
   re-reads (retried, because Pandora propagates to Firebird asynchronously) and
   THROWS otherwise. Read failures are judged per path: an unreadable verify after
   an Office PUT is assumed good (proven path), after a Pandora write it is treated
   as failure.

2. **All four send paths emailed FIRST and moved the state afterwards, inside
   `try {} catch { /* non-fatal */ }`.** The one path that got it right —
   `exitSendContractWithResend` — even carried a comment explaining why state must
   precede the email ("a BMI hiccup can never turn the cron into a repeating email
   to the guest"). The invariant was written down and three siblings ignored it.

**Rule:** when a state change is what stops a loop, it is not a side effect — it
is the gate. Perform it BEFORE the irreversible action (email/SMS/charge), verify
it landed, and abort the action if it did not. "Non-fatal" is the wrong label for
the only thing preventing repetition. All five paths now share one
`leaveSendContract()` helper that returns a boolean, and the run summary logs
`stateMoveFailed=N` so a write outage reads as "contracts queued", not silence.

**Corollary:** `catch { /* non-fatal */ }` deserves suspicion in review. Ask what
repeats if that call fails. If the answer is "a guest-facing message", it is fatal.

## Refunding a deposit while its gift card stays funded pays twice (2026-08-03)

A group-function deposit is charged to a card and then **loaded onto an internal
Square gift card** (GAN prefix `GFFT`/`GFHPFM`/`GFHPN` — see `lib/gan.ts`), which
the day-of payout cron redeems against the event's Square order. The card is an
accounting instrument for money the guest has already paid.

`group-quote-sync` refunds both Square payments when BMI flips a project to
Cancellation (stateId `-4`) — and never touched the gift cards. So every
cancellation of a deposited event refunded the card **and** left a fully funded
gift card behind: the same dollars, twice. Nothing had spent one yet only because
a cancelled quote is excluded from the day-of payout query — one status change away
from paying out.

Found while making an FT → HPFM center move safe: if sales had executed the move
as cancel-and-rebook instead of re-pointing the existing project, US Anesthesia
Partners' $1,073.18 would have been refunded to the guest's card while
`GFFT56000667` still held $1,073.18.

**Rule:** decrement first, then credit. `drainInternalDepositGiftCards`
(`ADJUST_DECREMENT`, reason `PURCHASE_WAS_REFUNDED`) now runs BEFORE the refunds.
A failed drain does **not** block the refund — the guest's money has to come back,
and `isInternalDepositGan` means they cannot spend the card themselves — so staff
get paged (`notifyGiftCardDrainFailed`) to zero it by hand instead. The choice to
make is which failure you can live with, and it is never "guest waits for money".

**Corollary:** any code path that refunds a group-function or booking payment must
answer "what happened to the gift card that payment funded?" A refund path written
without that question is a double-pay waiting for a status change.

## Wallet passes mirror claim state INLINE, never on a cron (2026-08-03)

Voucher wallet passes (PassKit) are a **downstream projection of `voucher_claims`**, and the
mirror runs **in the same request that moved the claim** — kiosk redemption, web credit, cart
claim, release, spend, void. Not a cron, not a queue, not "the next sweep will catch it".

**Why inline is the requirement, not an optimisation.** A guest who just handed over a leg at a
kiosk is still standing there holding the phone. If the pass still shows the pre-redemption value
when they look down, the reasonable conclusion is that they were charged twice. Latency here is a
support call and a refund request, not a cosmetic lag. (Owner rule 2026-08-03: "if a voucher is
used on kiosk or web we should be able to update that pass live not wait for a cron or anything".)

**The rules, enforced in `features/game-cards/wallet/voucher-pass.ts`:**

1. **Inline, same request.** `syncVoucherPass(code)` is awaited from the redemption paths
   themselves. The only cron that calls it is the stale-cart-claim sweep — and only because a
   sweep release IS a claim movement, so it syncs inline within that iteration.
2. **Every writer of claim state syncs** — take, release, spend, void. All four. A new claim
   writer that forgets leaves the pass permanently wrong, and **under-reporting is the dangerous
   direction**: to the guest it looks like value vanished. Releases (abandoned checkout) must push
   the remaining value back UP.
3. **A sync failure is never a redemption failure.** Every export swallows its own errors. Neon
   already holds the truth. A stale pass self-heals on the guest's next Add-to-Wallet tap, which
   re-pushes current state.
4. **Never read the pass to decide anything.** Write-only from our side. `voucher_claims` is the
   single authority — its one atomic CAS per item is what makes redemption race-safe, and a second
   opinion living on someone's phone would be a second writer.
5. **No pass, no call.** Skip on `passkit_coupon_id IS NULL`. Most guests never add one, and this
   runs on the redemption hot path.

**Corollary — issue lazily.** PassKit bills single-use passes AT ISSUANCE, not at install, so a
pass is created only when a guest taps Add to Wallet (`GET /v/[code]/wallet`). Pre-creating one per
minted voucher would bill us for every voucher whose email is never opened. Idempotency is free:
`externalId` is our own `HPW…` code and PassKit 409s a duplicate, so create-then-recover-on-409 is
race-safe without a lock.

**Guest-facing wording lives in ONE place.** The pass reuses `vouchers/display.ts`
(`groupVoucherItems`, `voucherItemDisplayLabel`) rather than re-deriving labels. First attempt
wrote a parallel summariser and the pass said "200 Tokens" where the product says "$20 Game Card" —
the exact shape of [extracted component misses later fixes]. Two surfaces showing one voucher must
not word it two ways.

## Platform badges are ASSETS you download, not buttons you build (2026-08-03)

Both `/v/[code]` and the voucher email shipped a hand-rolled pill reading **"Add to Apple or
Google Wallet"** — our font, our border radius, our copy. Owner caught it: *"shouldn't we be using
the actual real logos for those?"* Yes, and the same is true of every platform badge we will ever
add (App Store, Google Play, Apple/Google Pay).

**Two separate mistakes were in that one pill.**

1. **The wordmark was re-set in our own type.** Both vendors publish downloadable artwork
   specifically so nobody does this. Google's guidelines are explicit: *"Do not create your own Add
   to Google Wallet buttons or alter the font, color, button radius, or padding within the button in
   any way."*
2. **Two brands were merged into one control.** Neither vendor ships a combined badge — every file
   in both packs is single-platform — so a single "Apple **or** Google" button could not have been
   legitimate artwork at any size. Each badge gets its own link, stating its own platform.

**Where the files actually are** (both are a click-through-terms download, so this is worth
writing down):

- **Google** — direct, no session needed:
  `https://developers.google.com/static/wallet/download-assets/add-to-wallet-{svg,png,axml}.zip`.
  ~45 locales including **`esUS`**. Two shapes per locale: `wallet-button` (one-line, 283x50) and
  `add-wallet-badge` (two-line, 199x55). Only one colour, `#1F1F1F` — there is **no light variant**.
- **Apple** — the download link on
  `developer.apple.com/wallet/add-to-apple-wallet-guidelines/` is `href=""` with the real target
  hidden in **`rel="/file/?file=wallet&agree=Yes"`**, which is why it looks like the page has no
  asset. Fetch `https://developer.apple.com/file/?file=wallet&agree=Yes` (56 MB). 45 locales
  (English is **`US_UK`**, Latin-American Spanish is **`ESMX`**), each as RGB SVG + RGB EPS + CMYK
  EPS. **No PNG at all**, and only one variant — the black fill already carries a `#A6A6A6`
  hairline, which is what makes it work on dark.

**Three things that will bite the next time:**

- **Email needs PNG, not SVG.** Gmail and Outlook do not render SVG in mail. Rasterise the vendor's
  own SVG at 2x and serve it at half size via explicit `width`/`height`. Converting format is fine;
  redrawing is not. Apple forces this anyway by shipping no PNG.
- **Pick the shapes that pair.** Apple ships only a two-line badge, so use Google's two-line
  `add-wallet-badge` (181x50 at our height) rather than its one-line button (283x50). Mismatched
  widths read as a bug. Never stretch one to match the other — the wordmarks are different lengths.
- **A light host surface is the legal way to fix contrast.** Apple's badge is drawn for light
  backgrounds and Google's only variant is near-black, so both sit muddily on our `#00041b` pages.
  The clear-space rules (Google 8 dp, Apple .1X) govern the space *around* a badge, so wrapping the
  pair in a white panel is allowed where restyling either badge is not. Render at ≥50px tall to
  clear Google's 48 dp minimum.

**Also: check what main already has before editing a stale tree.** The working tree this was first
written in was 47 commits behind `origin/main`, where the page had *already* been split into two
per-platform buttons using `?platform=`. Committing the stale file would have reverted that. Build
the change in a worktree off `origin/main`, not on top of whatever the shared tree happens to hold.

## A filter parameter is not a state field — Pandora removals (2026-08-06)

Pandora's session-participants endpoint takes `excludeRemoved`, documented as
"omit participants with `F_PAR_STATE = 5`". It is easy to read that and assume
the state comes back on the record. **It does not.** A removed racer's payload is
byte-identical in shape to an active one — no state, no flag, no timestamp:

```json
{"participantId":"57909002","personId":"11588634","firstName":"Ethan",...,"paid":true,"checkedIn":null,"guardian":null}
```

So there is no such thing as "check whether this racer was removed" in one call.
The only available signal is a **set-diff of two calls**:

```
removed = (excludeRemoved=false) \ (excludeRemoved=true)
```

Two consequences worth carrying forward:

1. **Diff-derived facts are positive; absence is not.** `in allStates && !in
   active` means Pandora affirmatively has that person at state 5. A racer simply
   missing from a payload means nothing — could be a timeout, a partial page, a
   cache fallback. Anything that acts on removal (retraction SMS, cancelling a
   booking, clearing a pass) must key off the positive form and fail closed on
   the other, or it will fire hardest exactly when the upstream is sick.

2. **A fail-open guard inverts under load.** `fetchPandoraPidsAnyState` in
   `checkin-alerts` returned `new Set()` on a non-200. Its entire documented job
   was stopping a scratched racer being SMS'd via the express lane — and an empty
   set makes `!pids.has(id)` true for everyone, so the check disabled itself
   precisely when Pandora was unhealthy and staff were most likely shuffling
   heats. Guards that answer "is it safe to send?" must return null/throw on
   doubt, never a permissive empty value.

Related: a MOVE is a removal from the old heat. Anything reacting to removals has
to exclude moves or it double-texts on an event another cron already owns — see
`features/racing/eticket/removal-sweep.ts` for the four-guard version, and note
that the guard built from "sessions we already touched" was NOT enough (a racer
moved to a not-yet-ticketed heat slipped through; caught only by replaying a real
day against live rosters, never by unit tests).

---

## Slot length is not play time (2026-08-08)

Owner correction: Nexus gel blaster / laser tag were described everywhere as a
**"15 minute session"**. Fifteen minutes is the *slot* — it covers the briefing
and gearing up. Actual arena time is **7 minutes**. The correct guest-facing
phrasing is **"7 min session · 15 min experience"**, and it must never collapse
back to one number.

Two traps this exposed:

1. **A single `durationMin` field silently becomes marketing copy.** `durationMin`
   on `AttractionProductDef` is load-bearing for scheduling — BMI's reservation
   grid, `combo-board` end times, `attraction-session-assign`. But
   `AttractionProductStep` and `/book/[attraction]` were *also* rendering it
   straight to the guest as "15 min session". One number was answering two
   different questions. Fixed by adding an optional `playMin` alongside it:
   scheduling keeps reading `durationMin`, guest-facing labels render both when
   `playMin` is set. Do NOT "fix" a wrong duration label by editing the number
   the scheduler reads.

2. **The same claim was duplicated in six places with three different wordings.**
   `attractions-data.ts`, `activities-catalog.ts`, the bowling attractions step,
   two `/hp/*/attractions` pages, `/hp/pricing`, `/hp/book` JSON-LD, and
   `group-events.ts` each restated the duration in their own prose ("15 min
   sessions", "15-minute missions", "15-min battles"). A grep for the exact
   string finds a third of them. When a fact about a product changes, sweep for
   the *number near the product noun*, not the phrase you happen to remember —
   and check JSON-LD/SEO descriptions, which are guest-facing to search engines
   and are routinely missed.

Reminder that held: guest-facing kiosk copy ships EN + ES in the same commit, and
data-borne copy counts. The new `attraction.playExperience` key landed in both
catalogs, and the `es` duration labels in `activities-catalog.ts` moved with the
English ones.
