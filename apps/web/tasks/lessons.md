# Lessons (Claude self-correction log)

## 2026-05-02 — Always run an E2E round-trip on write-path code before pushing

**Mistake:** Built the POV-credit voucher claim feature end-to-end —
Pandora participants pass-through, claim endpoint, deposit retry queue,
admin UI, sweep cron — and pushed without ever running a single live
add/remove against the real `/bmi/deposit` endpoint. The first real
customer to hit it (Eric Osborn, 11:33 PM 2026-05-03) issued a POV
code with `VIEWPOINT_DEPOSIT_KIND_ID` env unset: code went out, no
deduct happened, AND no row landed in the failure queue (because the
enqueue gate also required the env var). Silently lost the failure.

**Two compounding bugs found during recovery:**
1. `VIEWPOINT_DEPOSIT_KIND_ID` was env-only with no fallback. Production
   env was unset on first deploy — every claim hit a no-op deduct.
2. The enqueue gate was `if (!deducted && VIEWPOINT_DEPOSIT_KIND_ID)`.
   When the env was missing, BOTH halves of the AND failed, so the
   exact case where we needed durability the most was the one that
   silently dropped failures.

**What I should have done before pushing:**
- Run a 4-step round-trip with curl against the real upstream:
  1. `GET /v2/bmi/deposits/{loc}/{personId}` — record current balance
  2. `POST /v2/bmi/deposit` add `+N` of TEST kind (39228454)
  3. `GET` again — verify balance moved by +N
  4. `POST` remove `-N` — verify balance returned to baseline
- Plus exercise the actual claim endpoint locally with `?action=claim-from-credit`
  hitting a real personId+sessionId, watching for the Redis record AND
  the `bmi_deposit_failures` row to materialize.
- Discovered post-hoc that BMA's `/bmi/deposit` itself was throwing
  `"Unexpected Error Occured"` on every call (add AND remove, even
  with the TEST kind). Would have caught this immediately with an
  E2E test before push.

**Rule for myself:**
- Before pushing any code that calls a 3rd-party write endpoint, run
  the round-trip against a TEST account / TEST kind. Document the
  curl commands in the commit body so it's reproducible.
- Defaults > env-only for IDs that are knowable. Env vars SHOULD
  override for rotations; the in-code default keeps the system from
  silently failing when env config drifts.
- Enqueue-on-failure gates must NEVER short-circuit on the very
  conditions that caused the failure. If the deduct failed because
  the kind ID is missing, that IS the failure — record it.

**Fix landed:**
- Hardcoded `46322806` (verified against live `/bmi/deposits` overview)
  with env override.
- Dropped the env-gate on the enqueue path.
- Manually backfilled Eric's Redis claim record + inserted his retry
  row in `bmi_deposit_failures` for the sweep cron to drain once BMA
  fixes the upstream.
- Confirmed BMA's `/bmi/deposit` is currently 500'ing on every call —
  reported separately.

## 2026-04-24 — Never poll diag endpoints as deploy-health probes

**Mistake:** Used shell patterns like
```
until curl -s ".../api/test/race-pack-diag?..." -o /tmp/p.json && grep -q "fieldX" /tmp/p.json; do
  sleep 15
done
```
to wait for a Vercel deploy to expose a new field in a diag response.

**Why it went wrong:** Every iteration of that loop called the full diag
flow against LIVE BMI. Each call created a real bill in BMI Office.
Over a day of testing (race-pack-diag, race-book-diag, probe-for-deploy
patterns) this piled up ~5,000 test bills that took 25+ minutes to bulk-
cancel via parallel DELETE. `race-book-diag` specifically never auto-
cancels (intentional for a physical-check-in test), so every accidental
invocation left a permanent Open bill.

**Fix landed:**
1. Both `/api/test/race-pack-diag` and `/api/test/race-book-diag` now
   short-circuit when called with `?probe=1`, returning `{ok, probe,
   inputShape}` without making a single BMI call. Use this for any
   "is the deploy live?" polling.
2. `race-book-diag` logs `[race-book-diag] CREATING BILL …` at
   `console.log` BEFORE firing — so accidental spam is visible in
   Vercel logs fast.

**Rule for future:**
- Any endpoint that creates persistent state upstream (BMI bill,
  Pandora person, Redis record with cost implications) MUST have a
  `?probe=1` equivalent for liveness checks, AND MUST be called only
  with explicit intent.
- To poll for a deploy, hit the probe mode, or just `sleep 90 && curl`
  once — don't re-enter the full side-effecting flow.
- If you need the Monitor tool to wait for a condition, use it against
  a read-only endpoint (deposits, overview, cron-log) — never a
  creating one.

## 2026-04-24 — Check-in double-credit bug (BMI)

Staff reported and confirmed: every online race booking paid with a
race credit is getting a SECOND credit deducted when the customer
physically checks in at the track. Reproduced with both
`depositKind: 2` (Credit) and `depositKind: 0` (Money) on
`payment/confirm` — same failure either way. Bug is inside BMI
Office's check-in handler; our code does not fire any `payment/confirm`
or `booking/sell` at check-in time.

Write-up preserved at `tasks/bmi-checkin-double-credit-bug.md`.
Test artifacts: reservations **W28792** (orderId 63000000003256749)
and **W28881** (orderId 63000000003257765), both on personId 409523.

## 2026-05-11 — BMI cancel: Office API can't find orders from new REST API

**Context:** Group event cancel route uses Office API (`office-api22.sms-timing.com`)
to cancel confirmed orders by setting `stateId: "-4"`. This is required because
`DELETE bill/{orderId}/cancel` on the Public API only works on open/held orders —
once `payment/confirm` closes the bill, only the Office API can cancel the project.

**Problem:** Orders created via the **new Public REST API** (`api.bmileisure.com /
public-booking/{clientKey}/booking/book`) return orderIds (e.g. `63000000003453231`)
that the Office API's `GET /api/{clientKey}/project/{orderId}` endpoint returns 404
for. All 4 group event products (Blue Starter, Red Starter, Gel Blaster, Laser Tag)
exhibited this — book + confirm succeed, but Office API project lookup fails.

**What works vs. what doesn't:**
- `DELETE bill/{orderId}/cancel` via Public API: works ONLY on open/held orders (before `payment/confirm`)
- Office API `GET project/{orderId}`: works for orders created via Office API or old SMS-Timing API — FAILS for orders created via new REST API
- The orderId format is the same (`63000000003xxxxxx`) in both systems

**Current status:** Not resolved. Group event cancel buttons on the confirmation
page call `/api/group-event/cancel` which hits Office API and gets "Project not found".
The `removeFromCart` function (which cancels held orders) could potentially use
`DELETE bill/{orderId}/cancel` instead since held orders aren't confirmed yet — but
this hasn't been implemented.

**Possible investigation paths:**
1. Check if there's a delay/sync before new REST API orders appear in Office API
2. Check if Office API uses a different identifier (projectNumber, billNumber) vs orderId
3. Ask BMI support if there's a cancel endpoint on the new REST API for confirmed orders
4. Use `booking/removeItem` to remove line items before cancelling (may release the slot)

**Rule for future:**
- Two BMI cancel mechanisms exist and are NOT interchangeable:
  - `DELETE bill/{orderId}/cancel` — Public API, open orders only
  - Office API `PUT project` with `stateId: "-4"` — confirmed orders, but only finds projects from older APIs
- When building cancel flows, verify the cancel mechanism matches the API used to create the order
- Test cancel end-to-end with a real booked+confirmed order, not just held orders

## 2026-04-10 — BMI race-pack credit-assignment bug

Separate BMI regression: credits don't post on race-pack sells via
the public booking API after a page config change. Exhaustively
tested every documented + undocumented parameter combination — all
fail. Write-up at `tasks/bmi-race-pack-credits-bug.md`.

## 2026-05-18 — Cold-start probe failure presents as false "no availability", not 5xx

**Mistake:** User reported the bowling wizard showing "No more
availability today" for Naples Wed 1pm, despite the network response
in DevTools showing slots. I jumped to a webOfferId string-vs-number
type mismatch (the spec types it `string | number`), normalized to
number in the v2 availability route, and shipped. Didn't fix it.

The actual signature the user surfaced two messages later: **first
request after deploy shows nothing, second request shows "Next
available."** That's a cold-start retry pattern, not a data filter
pattern.

**Root cause:** [v2/availability/route.ts](../apps/web/app/api/bowling/v2/availability/route.ts)
does `.catch((err) => ({ Availabilities: [] }))` per probe and returns
`{ Availabilities: [] }` with HTTP 200 regardless of how many probes
errored. On a cold Lambda + cold QAMF auth (right after deploy), a
batch of probes can all silently fail → the route returns empty →
the wizard treats it as "this day is sold out." The Lambda warms up
within a few seconds and the next request succeeds — which is exactly
what the user saw.

**What I should have done before guessing:**
- Listened harder to "first time doesn't load, second time works."
  That phrase IS the diagnosis. Retry semantics, not data semantics.
- Asked one question: "Does the network response show
  `Availabilities: []` on the failing request, or a populated array?"
  If `[]`, it's an upstream/probe failure; if populated, it's a
  client filter bug. I conflated these and built the wrong fix first.
- Checked the Vercel function logs for `[avail] all N probes failed`
  / `probe error at …` warnings BEFORE proposing a data-shape fix.

**Rule for myself:**
- When a route silently coalesces upstream errors into an empty
  success response, that's a bug shaped exactly like "the data is
  there but the UI hides it" — and it's the FIRST hypothesis to
  check, not the last. Look for `.catch(() => empty)` / `try {…}
  catch {…}` patterns that swallow signals before doing type
  forensics on the payload.
- "Show me the response on the failing request" is the cheap
  diagnostic. Type mismatches require seeing the data to confirm;
  cold-start failures require seeing the absence of data.

**Fix landed:**
- Server: per-probe single retry + `502` when every probe failed,
  so the client can distinguish "QAMF unreachable" from "genuinely
  zero availability."
- Client: `fetchSlots` retries once on 502/504 with a 750ms backoff
  before surfacing the error.

## 2026-06-02 — BMI orderId ≠ projectId: payment/confirm doesn't prevent auto-cancel

**Context:** Customer race reservations with recorded payment were being
auto-cancelled by BMI system cron (userUpdatedId=-1) hours after booking.

**Root cause:** BMI's `booking/book` returns an `orderId` that is no longer
the same as the internal `projectId` (now offset by +1). `payment/confirm`
records the payment against the orderId, but the project at orderId+1 is
not marked as confirmed. BMI's auto-cancel cron sees an unconfirmed project
and cancels it.

**Evidence:** 3 test bookings on 2026-06-02 all showed consistent +1 offset:
  - W38433: orderId=63000000003675359, projectId=63000000003675360
  - W38445: orderId=63000000003675520, projectId=63000000003675521
  - W38446: orderId=63000000003675533, projectId=63000000003675534

Older bookings had orderId == projectId (offset 0). This is a recent BMI-side change.

**Temp workaround (REMOVE when BMI fixes):** After `payment/confirm` succeeds in
`/api/booking/v2/reserve`, call Pandora `POST /v2/bmi/reservation/state` with
`projectId = orderId+1` and `stateID = "-3"` (Confirmation). This is idempotent —
if BMI fixes payment/confirm, setting -3 on an already-confirmed project is a no-op.

A cron at `/api/cron/bmi-cancel-sweep` runs every 5 min as a safety net,
scanning the dayplanner for cancelled-with-online-payment reservations and
recovering them via Pandora.

**Rule:** Both the v2/reserve Pandora call and the sweep cron must be removed
once BMI confirms the fix. Search for `BMI_AUTOCANCEL_WORKAROUND` to find all
workaround code.
