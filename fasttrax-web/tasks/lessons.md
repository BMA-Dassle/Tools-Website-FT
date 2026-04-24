# Lessons (Claude self-correction log)

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
