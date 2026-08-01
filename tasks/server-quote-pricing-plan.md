# Server-Quote Pricing + Per-Line Coverage Display — Plan

Owner direction (2026-07-31, after the voucher/pack drift night):
1. "Why are we just not getting pricing from server?" — no reason; do it.
2. "I'd rather handle it by changing the line to credit like the Intermediate
   race does from account" — covered units render as their own $0
   Credit-style lines, never negative aggregates.

## Why

Every checkout bug tonight (the $0 voucher crash, the phantom "couldn't
apply", the $1.56 tax on a $0 order, Jacob's pack+credit $27 drift) was ONE
disease: the client rebuilds a parallel pricing estimate for display while the
server prices the charge, and the two disagree. Bowling already solved this
(`/api/square/bowling-orders/quote` → `quotedTotal`); racing/attraction carts
never got the same treatment. The server pricing core (buildCombinedLineItems)
is proven correct (unified-pricing-repro.test.ts).

## Target model

ONE pricing function, two consumers:

```ts
// server-only core (extracted from buildCombinedLineItems)
pricedSession(session): {
  lines: PricedLine[];   // charged AND covered
  subtotalCents; taxCents; totalCents; depositCents; depositPct;
  perEntity?: …          // combo split totals
}

interface PricedLine {
  key: string; name: string; quantity: number; unitCents: number; // 0 when covered
  /** Why this line is $0 / reduced — drives the display tag. */
  coverage?: {
    kind: "race-credit" | "race-pack" | "voucher" | "combo-inclusion";
    label: string;        // "Credit" · "Race Pack" · "Voucher …Z4SX"
  };
}
```

- `buildCombinedLineItems` (reserve/prepare) derives its Square lines FROM
  `pricedSession` output → quote ≡ charge by construction, forever.
- Display: a covered unit is its own line at $0 with a right-aligned tag,
  exactly like today's account-credit row ("Intermediate Race · Credit"):
  - `Intermediate Race ×2 · Race Pack` (replaces "Today's races — covered by
    race pack −$80.97")
  - `Gel Blaster · Voucher …Z4SX` (replaces the green −$12.00 row)
- Tax on the charged subtotal only (per entity for combos) — the $0-order
  fake-tax class dies structurally.

## PRs

**PR A — extract the core (no behavior change).**
- Pull the pricing math out of buildCombinedLineItems into `pricedSession`
  (same module or `pricing.ts`), reserve consumes it.
- GOLDEN PARITY TESTS: every existing pricing fixture (combo v1/v2, credits,
  packs, vouchers partial/full, duckpin/bowling mixed, promos) asserts old
  totals == new totals. This PR ships only when parity is exact.

**PR B — quote endpoint + display rendered from it.**
- `POST /api/booking/v2/quote {session}` → pricedSession result. NO side
  effects (no Square order, no claims, no Redis writes), no external calls
  (prices come from the session's own items — same inputs reserve uses),
  lightly rate-limited.
- CheckoutStep review (web + kiosk) renders the quote lines verbatim:
  coverage tags per line, negative aggregates deleted (voucher rows, pack
  row; combo flat-collapse stays, driven by quote lines).
- Fetch on review entry + on any coverage change (credit toggle / voucher
  add-remove / pack pick), debounced; last-known totals while loading; on
  quote failure fall back to the current client math labeled "estimated".
- The "N vouchers cover $X" banner counts quote coverage lines → the
  "3 vouchers / only 1 used" copy bug is fixed here for free.
- Kill switch only (house rule): `NEXT_PUBLIC_SERVER_QUOTE !== "false"`.

**PR C — the gate trusts the quote + kiosk voucher UX.**
- Kiosk terminal gate's `depositCentsExpected` = the quote's depositCents →
  drift ≈ 0 by construction; the $25 backstop stays as a tripwire and the new
  telemetry keeps logging shown/computed per prepare.
- "Your codes" per-LEG ✕ (today removing one leg removes the whole code).

## Explicitly unchanged

Charge rails (unified/bowling/legacy-credit), §0b claims, BMI/QAMF booking,
deposit/gift-card mechanics, receipts/emails, bowling-only quote path.

## Verification

- Golden parity suite (PR A) is the backbone.
- Endpoint tests: coverage tagging per source; $0 full-coverage; Jacob's
  exact shape (pack + credit in one cart — must price ONE consistent answer).
- Live smoke checklist: credit-only, pack+credit, voucher partial, voucher
  full $0, duckpin+gel mixed, combo v2 — on preview, each showing
  review == reader == Square order.

## Estimate

PR A ~half day · PR B ~a day (UI included) · PR C ~half day. Do on fresh
eyes, not fatigue hours; the drift telemetry (bb816e99) covers prod meanwhile.

## Open inputs

- The $0-voucher wire-log result (owner test #2) may add one more parity
  fixture to PR A.
- Copy call: tag wording — "Credit" for all sources vs distinct "Race Pack" /
  "Voucher" labels (plan assumes distinct labels; the account credit keeps
  "Credit").
