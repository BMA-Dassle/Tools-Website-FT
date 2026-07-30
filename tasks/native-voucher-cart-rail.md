# Native vouchers that cover race / attractions (mixed with game-zone)

Owner 2026-07-30: our own vouchers may bundle laser + game-zone card etc., must
be scannable together, and will EVENTUALLY be sellable on the website.

## What already ships (main 7f71cc31)

- Multi-scan basket — scan several, one "Get my cards".
- A native voucher is a LIST of items with per-item single use (`voucher_claims`,
  atomic CAS on `(code, item_index)`).
- **Game-zone items redeem fully** — kiosk dispenses / web credits.
- Mixed vouchers are ACCEPTED and mint fine; the game-zone leg works.
- Attraction/race items currently return `not_redeemable` — the piece below.

## The remaining piece is a MONEY-PATH change, so it gets its own careful step

A race/laser item can't dispense; it has to reduce a BOOKING charge. That means
`unified-reserve.ts`, which today verifies vouchers BMI-only:

- `unified-reserve.ts §0b` keeps only vouchers with `billId + voucherOrderItemId`
  and verifies them against the BMI `booking_voucher_redemptions` ledger.
- `planVoucherCoverage` (issuer-agnostic already — keys off `voucherTarget(name)`
  + the cart) does the actual heat-exclude / attraction-qty-reduction. **This we
  reuse as-is** — a native race voucher just needs `name:"Race"` and to survive
  the `voucherIsApplied` filter.

### Design (to build behind the existing `NEXT_PUBLIC_VOUCHER_REDEEM` flag)

1. `AppliedVoucherState` gains `issuer?: 'bmi' | 'native'` + (native) `itemIndex`.
   Native is "applied" without a BMI bill, so `voucherIsApplied` learns the
   native shape (claim marker instead of `voucherOrderItemId`).
2. Kiosk/web voucher entry accepts an `HPW` code whose item targets race/laser,
   adds it to `session.appliedVouchers` as native — pending, no BMI call.
3. **Claim at CHARGE time, last moment, inside reserve §0b** — not at scan.
   Rationale (displayed==charged + single use): scanning must not burn a code a
   guest then abandons, and the charge must reflect exactly what they saw. So
   reserve does: atomic per-item `claimVoucher(issuer:'native')` → on success the
   coverage plan already excludes the heat / drops the qty → mark charged. A
   code that's already spent when they reach checkout HARD-FAILS the reserve
   (same rule BMI uses), never a silent full charge.
4. **Idempotent reserve retries:** `voucher_claims` is CAS-on-released, so a
   retry of the SAME reserve must re-recognise its own claim. Add
   `claimed_by_txn` reuse: a claim already held BY THIS reserve's txn is a
   success, not a conflict. (This is the one net-new correctness bit — needs a
   test.)
5. On reserve failure AFTER a native claim, the claim must release (the booking
   didn't happen) — reuse `releaseVoucherClaim`, guarded by the reserve txn.

### Why this is a separate PR, not a bolt-on

It edits the charge path, the repo's most sensitive code; the rule is
displayed-price ↔ charge-time re-eval, verified with tests. It wants the owner's
eyes on the charge diff and a booking-reserve test around claim/verify/retry/
release. Doing it carefully is cheap; doing it wrong double-charges or burns a
guest's voucher.

## Sellable online (future, non-blocking)

The model already fits: a website purchase MINTS a voucher at purchase time
(same `vouchers` row, `issued_source:'web-sale'`), and redemption is the exact
rail above. No redemption rework — only a purchase/checkout front-end when we
get there.

## One decision needed from owner before coding the reserve change

Claim timing — confirm **at charge (last moment)**, not at scan. Recommended,
and everything above assumes it. The alternative (claim at scan) is simpler but
burns codes on abandoned carts.
