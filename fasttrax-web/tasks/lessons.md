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
