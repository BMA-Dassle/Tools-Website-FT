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

## 2026-04-10 — BMI race-pack credit-assignment bug

Separate BMI regression: credits don't post on race-pack sells via
the public booking API after a page config change. Exhaustively
tested every documented + undocumented parameter combination — all
fail. Write-up at `tasks/bmi-race-pack-credits-bug.md`.
