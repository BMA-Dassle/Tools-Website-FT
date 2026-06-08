# Group-Function: Re-price after Paid-in-Full

**Status:** IMPLEMENTED (PR-1 + PR-2) on branch `feat/gf-balance-link-reconcile` — build/typecheck/lint clean,
NOT yet committed or live-smoke-tested.
**Created:** 2026-06-06
**Owner:** Eric

## Scope & decisions (from Eric)

- Only handle events **already paid in full** that get re-priced in BMI.
- **A re-sign is required regardless** — every contract change clears the signature and forces
  re-confirmation. The delta is charged **after** the guest re-signs.
- Price **increase** → charge the **difference** + load the gift cards.
- Price **decrease** → **flag staff, no auto-refund** (same handling even if the new total drops below
  the deposit — one refund path for all decreases).
- **No card on file + increase → capture a card during the re-sign**, charge the delta, and save it on
  file for the future. (Not a payment link.)
- **Track link payments**: link-paid balances must count as paid-in-full. ⚠️ This surfaced a
  pre-existing gap — see §3f — there is currently **no reconcile** for paid links at all.
- **Skip deltas under $1** — update the books, don't charge/refund (configurable threshold).
- Deposit-phase / partial-balance flows are otherwise **out of scope**.

---

## 1. The problem

When a signed contract changes in BMI, [`group-quote-sync`](../apps/web/app/api/cron/group-quote-sync/route.ts)
archives the signed PDF, clears the signature, sets `resign_required`, and **recomputes the balance**
at [route.ts:561](../apps/web/app/api/cron/group-quote-sync/route.ts#L561):

```js
// Post-signing: deposit_due_cents is the amount actually paid — don't overwrite it.
updates.balance_cents = Math.max(0, totalCents - quote.deposit_due_cents);
```

Correct while only the **deposit** is paid. **Wrong once the balance is also collected** — the schema
tracks no "amount actually collected" ([db.ts:60-63](../apps/web/lib/group-function-db.ts#L60-L63)),
and `updateGfBalanceCharged` zeroes `balance_cents` ([db.ts:571](../apps/web/lib/group-function-db.ts#L571)).

### The overcharge

```
total=1000, deposit_due=500 → deposit paid (500). balance_cents=500.
72hr cron charges 500 → status=balance_charged, balance_cents=0.   Collected: 1000 ✓
BMI edit raises total → 1200.
sync recomputes balance_cents = max(0, 1200 - 500) = 700 → resign_required.
guest re-signs → balance settles at 700.
Collected: 500 + 500 + 700 = 1700, owed 1200 → OVERCHARGE 500. Gift cards over-loaded too.
```

Root cause is purely the formula (`total − deposit_due` instead of `total − amount_collected`).

### "Paid in full" detection

Converges on **`status='balance_charged'`, `balance_cents=0`, `balance_paid_at` set**:
- [`updateGfBalanceCharged`](../apps/web/lib/group-function-db.ts#L554) (`balance_payment_method='auto_card'`)
- [`updateGfBalancePrepaid`](../apps/web/lib/group-function-db.ts#L585) (`'prepaid'`)
- **(after §3f)** link-paid (`'link'`)

`balance_paid_at` is **not** cleared by resign, so it's a reliable "balance already collected" marker.

---

## 2. Goal

Resign flow unchanged. After re-sign of a paid-in-full event, settle only the **difference**:

- **total ↑, card on file** → charge `total − collected` to the saved card (server-side, no UI),
  load the difference onto the gift cards, update books, notify guest + planner.
- **total ↑, no card on file** → the re-sign flow shows a **card-capture step**; the guest enters a
  card, we charge the delta and **save the card on file** for next time.
- **total ↓** → persist new total; **no refund**; staff alert with overage + Square payment ID.
- **|delta| < $1** → update books only, no charge/refund.
- **total unchanged** → no money movement.

The re-sign UI today omits the payment step ([ContractClient.tsx:156](../apps/web/app/contract/[shortId]/ContractClient.tsx#L156));
we re-introduce it **conditionally** (delta>0 AND no card on file). Otherwise the card on file the guest
authorized at original signing (`agreements.autoCharge`) is charged server-side.

---

## 3. Design

### 3a. Schema — `collected_cents`

Additive column in `ensureGfSchema`:

```sql
collected_cents INTEGER NOT NULL DEFAULT 0   -- money actually taken from the customer to date
```

Universal rule: **`amount_due = total_cents − collected_cents`** (positive = charge, negative = refund-owed).
Maintain at every real collection point:
- `updateGfDepositPaid` → `collected_cents = total_cents − balance_cents` (the deposit just taken).
- `updateGfBalanceCharged` / `updateGfBalancePrepaid` → `collected_cents = total_cents`.
- Link reconcile (§3f) → `collected_cents = total_cents`.
- Reprice settlement (§3c) → `collected_cents += delta`.

Backfill before go-live:
```sql
UPDATE group_function_quotes SET collected_cents = total_cents
  WHERE status = 'balance_charged' AND collected_cents = 0;
UPDATE group_function_quotes SET collected_cents = (total_cents - balance_cents)
  WHERE status = 'deposit_paid' AND collected_cents = 0;
```

### 3b. Fix the recompute (one line)

[`group-quote-sync`](../apps/web/app/api/cron/group-quote-sync/route.ts#L558-L562) post-signed branch:

```diff
- updates.balance_cents = Math.max(0, totalCents - quote.deposit_due_cents);
+ updates.balance_cents = Math.max(0, totalCents - quote.collected_cents);
```

This alone kills the overcharge. Resign behavior otherwise unchanged.

### 3c. Settle the delta on re-sign completion

New server endpoint **`/api/group-function/resign-settle`**, called by ContractClient after a
successful re-sign in place of the audit "re-signed" status flip
([ContractClient.tsx:414-419](../apps/web/app/contract/[shortId]/ContractClient.tsx#L414-L419)). Body
optionally carries a Square `nonce` (only when a card was captured in the re-sign — see §3e).

1. Load quote; guard `status='resign_required'` + fresh signature (idempotent: 2nd call is a no-op).
2. `delta = total_cents − collected_cents`.
3. **Was paid in full** (`balance_paid_at IS NOT NULL`):
   - **delta ≥ $1, card on file** → charge `delta` to `saved_card_id`, load onto gift cards (§3d),
     `collected_cents += delta`, `balance_cents=0`, `status='balance_charged'`. Audit `reprice_charged`,
     BMI note, portal webhook, `notifyRepriceCharged()`.
   - **delta ≥ $1, no card on file** → `nonce` required (re-sign captured one): charge `delta` via
     nonce, **save the card** (`findOrCreateSquareCustomer` + create card-on-file, mirroring the
     deposit route), load gift cards, then as above.
   - **delta < $1 (incl. ≤ 0)** → see decrease/tiny handling below.
   - **delta ≤ −$1 (overpaid)** → persist `total_cents`/`tax_cents`/`line_items`; `status='balance_charged'`;
     **no refund**; `notifyRepriceRefundOwed()` to staff (overage + `square_balance_payment_id`).
     Audit `reprice_refund_owed`.
   - **|delta| < $1** → persist new total; no money movement; `status='balance_charged'`.
4. **Was NOT paid in full** (deposit-only — out of scope): `status='deposit_paid'`, let the 72hr
   [balance cron](../apps/web/app/api/cron/group-balance-charge/route.ts) collect as today.

Charging on re-sign completion (not the 72hr cron) is the "instant" collection and avoids the 72–96h
prepaid gap where the cron's `event_date − 72h ≤ NOW()` guard wouldn't fire.

### 3d. Share the Square charge+load logic

Extract the balance cron's inline order→charge→load/overflow
([group-balance-charge:118-303](../apps/web/app/api/cron/group-balance-charge/route.ts#L118-L303))
into **`apps/web/lib/group-function-reprice.ts`** → `chargeAndLoad({ quote, amountCents, sourceId, baseKey })`.
Both the balance cron and `resign-settle` call it. `sourceId` is the saved card id or the nonce.

### 3e. Conditional card capture in the re-sign UI

[`ContractClient.tsx`](../apps/web/app/contract/[shortId]/ContractClient.tsx#L155-L157) currently builds
resign steps as `buildSteps(true,false).filter(s => s.key !== "pay")`. Change: **keep the pay step when
`balanceCents > 0 && !hasCardOnFile`** (new `quote.hasCardOnFile` flag from the server, derived from
`saved_card_id`). In that case the pay step collects a card (Square Web Payments → nonce), passed to
`resign-settle`. When a card is on file, keep stripping the pay step (server charges silently). The
re-sign review already shows the new total with the delta as amount due
([ContractClient.tsx:145-148](../apps/web/app/contract/[shortId]/ContractClient.tsx#L145-L148)).

### 3f. ⚠️ NEW: reconcile paid balance links (pre-existing gap)

There is currently **no** code that marks a balance payment link as paid — `getQuotesWithPendingBalanceLinks()`
([db.ts:452](../apps/web/lib/group-function-db.ts#L452)) is **unused**, there is no Square webhook, and
nothing transitions `balance_link_sent → balance_charged`. Required for "track link payments" and a real
revenue-tracking gap on its own.

Add a poller (new cron `apps/web/app/api/cron/group-balance-link-reconcile/route.ts`, ~every 15 min):
for each `getQuotesWithPendingBalanceLinks()`, look up the payment link's order in Square; if the order
is paid/completed, call `updateGfBalanceCharged({ ..., balance_payment_method: 'link' })` (which now also
sets `collected_cents = total_cents`), send the receipt, fire the portal webhook. This makes link-paid
events first-class paid-in-full and eligible for reprice. *(May ship as its own small PR ahead of the
reprice work — flag for Eric.)*

### 3g. Race / idempotency

- Settlement runs on `resign_required`; balance cron selects only `deposit_paid`
  ([db.ts:443](../apps/web/lib/group-function-db.ts#L443)) — disjoint, no double-charge.
- Final update guarded `WHERE status='resign_required' AND collected_cents=<expected>`.
- Square idempotency keys from fresh `randomBytes`, as the balance cron does.

---

## 4. Files touched

| File | Change |
|------|--------|
| [lib/group-function-db.ts](../apps/web/lib/group-function-db.ts) | `collected_cents` column + backfill; set it in deposit/balance/prepaid + link reconcile; `updateGfResignSettled(...)` |
| **NEW** `lib/group-function-reprice.ts` | `chargeAndLoad()` extracted from balance cron |
| [cron/group-balance-charge/route.ts](../apps/web/app/api/cron/group-balance-charge/route.ts) | Refactor inline charge+load → shared module (no behavior change) |
| [cron/group-quote-sync/route.ts](../apps/web/app/api/cron/group-quote-sync/route.ts) | One-line recompute fix: `total − collected_cents` |
| **NEW** `app/api/group-function/resign-settle/route.ts` | Server-side delta settlement on re-sign (§3c) |
| [contract/[shortId]/ContractClient.tsx](../apps/web/app/contract/[shortId]/ContractClient.tsx) | Conditional card-capture step (§3e); call `resign-settle` instead of audit flip |
| [api/group-function/audit/route.ts](../apps/web/app/api/group-function/audit/route.ts#L39) | Remove `re-signed → deposit_paid` flip (moves into resign-settle) |
| [lib/group-function-notify.ts](../apps/web/lib/group-function-notify.ts) | `notifyRepriceCharged()` (guest+planner), `notifyRepriceRefundOwed()` (staff) |
| **NEW** `app/api/cron/group-balance-link-reconcile/route.ts` (§3f) | Poll + reconcile paid balance links → `balance_charged`/`collected_cents` |
| `vercel.json` (cron schedule) | Register the new reconcile cron |

---

## 5. All-possibilities matrix

| # | Scenario | Plan |
|---|----------|------|
| C1 | Paid in full (auto/prepaid/link), total ↑, card on file | resign → charge `delta` server-side + load gift cards |
| C1b | Paid in full, total ↑, **no card** | resign **with card-capture step** → charge delta + save card |
| D  | Paid in full, total ↓ (incl. below deposit) | resign → staff alert, no auto-refund |
| — | Paid in full, only date/name change / |delta|<$1 | resign; settle with no money movement |
| C2 | `deposit_paid`, edit before balance charged | **unchanged** — resign → deposit_paid → 72hr cron |
| — | deposit-only increase | **unchanged** (out of scope) |

---

## 6. Verification plan (seed + smoke per CLAUDE.md)

1. Seed `balance_charged` quote, `collected_cents=total`, raise total, sync `dryRun=1` → `balance_cents = delta`.
2. **Sandbox E2E, card on file:** raise total → re-sign → `resign-settle` charges exactly `delta`,
   gift card loaded by `delta`, `collected_cents` updated, receipt sent, status `balance_charged`. Run twice → no double charge.
3. **Sandbox E2E, no card:** raise total → re-sign shows card step → enter sandbox card → delta charged + card saved on file.
4. **Decrease:** lower total (and a case below deposit) → staff alert, no charge/refund.
5. **Tiny delta:** $0.40 change → books update, no charge.
6. **Link reconcile (§3f):** pay a sandbox balance link → poller marks `balance_charged`, `balance_payment_method='link'`, `collected_cents=total`; then a reprice on it works like C1.
7. **Backfill:** existing `balance_charged`/`deposit_paid` rows get correct `collected_cents`.

## 7. Open decisions — RESOLVED

1. No-card paid-in-full increase → **capture card during re-sign + save on file** (§3c/§3e). ✅
2. Track link payments → **yes; build the reconcile poller** (§3f — pre-existing gap). ✅
3. Tiny deltas → **skip under $1**, update books only. ✅
4. Decrease below deposit → **same as any decrease, flag staff**. ✅

## 8. Suggested PR sequencing

- **PR-1 (independent, ships first):** §3f balance-link reconcile poller + `collected_cents` column &
  backfill. Closes the standing revenue-tracking gap and lays the data foundation. Low risk.
- **PR-2:** recompute fix (§3b) + `resign-settle` + shared `chargeAndLoad` (§3d) + card-capture UI
  (§3e) + notifications. The actual reprice feature.

## 9. Implementation log (2026-06-06)

Both PRs implemented on branch `feat/gf-balance-link-reconcile` (currently one working tree; split at
commit time if two PRs are still wanted).

**PR-1 — foundation + link reconcile**
- `collected_cents` column + idempotent backfill (keyed on balance_paid_at/deposit_paid_at);
  maintained in `updateGfDepositPaid` / `updateGfBalanceCharged` / `updateGfBalancePrepaid`.
- `square_balance_link_id` column; balance cron + `updateGfBalanceLinkSent` capture the link's
  id + order id at creation.
- `loadBalanceOntoGiftCards()` extracted into `square-gift-card.ts`; auto-charge cron refactored to it.
- NEW cron `group-balance-link-reconcile` (registered in vercel.json, */15) — marks paid links
  `balance_charged` (method `link`), loads day-of gift cards, sends receipt. 14-day post-event grace.

**PR-2 — reprice feature**
- Recompute fix: `group-quote-sync` post-signed branch now uses `total − collected_cents`
  (was `total − deposit_due`); `ensureGfSchema()` called before the SELECT to guarantee backfill.
- NEW `lib/group-function-reprice.ts` `chargeDeltaAndLoad()` — order → charge saved card or captured
  nonce → load gift cards → save new card. Shares `findOrCreateSquareCustomer` (moved to
  square-gift-card.ts) + `loadBalanceOntoGiftCards`.
- DB: `updateGfRepriceCharged` (resign_required→balance_charged, collected+=delta, saves card),
  `updateGfResignNoCharge` (deposit-only → deposit_paid; decrease/no-change → balance_charged).
  Both guarded on resign_required for idempotency.
- NEW `app/api/group-function/resign-settle` — orchestrates: deposit-only → deposit_paid; paid-in-full
  delta ≥ $1 → charge delta; ≤ −$1 → flag staff refund; |delta| < $1 → no-op. Stable idempotency key
  per (quote, source).
- Notifications: `notifyRepriceCharged` (guest+planner), `notifyRepriceRefundOwed` (staff).
- ContractClient: `hasCardOnFile` prop; re-sign keeps the pay step ONLY when delta>0 & no card on
  file (card capture); otherwise settles the delta server-side on sign completion via `settleResign`.
  Pay-step copy/button branch for the resign case.
- audit route: removed the `re-signed → deposit_paid` flip (now owned by resign-settle).

**Known follow-ups / residual risk**
- No live smoke yet (needs Square sandbox + seeded quotes). Verify §6 before going live.
- Saved-card decline during a no-card-needed resign: error shown, no fallback to capture (rare).
- Concurrent capture double-submit with two distinct nonces is mitigated by the disabled button +
  Square single-use nonce, not a hard server lock.
- Lint: ContractClient still trips pre-existing React-Compiler `preserve-manual-memoization` rules
  (whole file already does; pre-commit runs prettier only, build tolerates them).
