# Game Zone card vouchers — redeem a BMI comp for a dispensed card

Branch `feat/kiosk-voucher-gamezone` (worktree `.claude/worktrees/gz-voucher`, off `origin/main` bc94cea5).

Owner ask 2026-07-29: five BMI vouchers minted at Office, setup
`Complimentary 100 Token Game Card`, memo `1 100 GZA`, activation fee credited,
"BONUS cash… we wouldn't need a Square order or anything. Just give out a $10
bonus cash card." Expire 2027-07-29, `Used=0`, unblocked.

Owner follow-ups: use the SHARED card-distribution components (not a parallel
rail); assume a guest may redeem **with nothing else in the cart**; flag ON by
default.

## 1. Why this voucher kind needs new code at all

Race / laser / gel comps ride `order/applyCode` and BMI nets the comp against
the matching line when the order is PROCESSED. A Game Zone comp has **no money
leg**: fulfillment is a physical card with Intercard value, which BMI cannot
see and cannot settle. Consequences, all probe-verified (2026-07-27):

- Comp-only bills **auto-cancel**, and codes are **not locked at apply** — so
  there is no order to process and BMI will never mark these `Used`. Left
  alone, one code redeems on every kiosk, every day, until 2027-07-29.
- `booking_voucher_redemptions` is `UNIQUE (bill_id, code)` — per-bill by
  design. It cannot stop this double-spend.

→ **BMI issues; we enforce single-use and fulfil.** Our claim ledger is the
authority of record. (Open question for BMI: is there a "mark consumed" call
for fulfilment-free comps? If yes, add it as a best-effort post-step later.)

## 2. Design decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Grant derivation | strict regex `Complimentary <N> Token Game Card` + denomination allowlist `[50,100,200,300,500,1000]` | BMI's comp "name" is free-form setup prose (the live gel comp is a full instruction sentence). Fails closed: unknown shape or off-allowlist `N` grants NOTHING. A typo'd "1000000 Token" cannot mint a fortune. |
| Bucket | **bonus tokens** (`<BonusTokens>`), `bonusCashDollars` wired but 0 | The proven rail — every production load goes through it, and BMI's own name says "100 Token". `<BonusCash>` has zero production callers, so it stays unexercised until probed. 100 bonus tokens = the $10 of play at our 10¢ rate. Switching is one line of data + a probe. |
| Single-use | new `game_card_voucher_claims`, one row per code, `UNIQUE (code)`, CAS re-claim | `INSERT … ON CONFLICT (code) DO UPDATE … WHERE status='released'` — one atomic statement, no transaction. Zero rows returned = already spent. |
| Ordering | **claim BEFORE the ledger row**; release the claim if the row insert fails | Reverse order leaves an orphan `state='charged', load_state='pending'` row that the reconcile cron would happily credit. |
| `$0` authorisation | `state='charged'` + `kind='voucher'` + `amount_cents=0` + `voucher_code` | Keeps `load-card`'s "no free loads" guard meaningful ("consideration settled → cleared to load") and keeps voucher rows inside the recover-forward set the cron already drives. Cheaper and safer than a new state that every cron/claim query would have to learn. |
| Second gate | `load-card` and the cron BOTH require a live claim row for a `kind='voucher'` txn | The invariant becomes "paid **or** voucher-claimed", never unchecked — in both directions, so neither an orphan row nor a replayed cron run can credit without authorisation. |
| Cart | voucher path never touches the booking session | Works identically with an empty or full cart. Explicitly bypasses `addToVisit` (a comp has nothing to add to a checkout). |

## 3. Shared components reused (no parallel rail)

`useGameCardDispenser` (CRT-591) · `dispenseAndRead` · `captureSafely` /
`KioskDispenserHold` / bin-full + bad-blank holds · `clearAccount`
clear-on-encode · `intercard_transactions` ledger · `/api/game-cards/load-card`
· on-prem bridge first, cloud SOAP fallback · `game-card-reconcile` cron
recover-forward · `peekVoucher` (already ships) for scan-time validation.

## 4. Work items

- [x] `game-cards/vouchers/grants.ts` — grant map, allowlist, both directions
- [x] `voucherTarget` gains `{kind:"gamecard", grant}`, checked first
- [ ] `planVoucherCoverage` — explicit "gamecard covers nothing" branch + comment
- [ ] `voucherDisplayName` — "100 Token Game Card comp"
- [ ] `game-cards/data/voucher-claims-db.ts` — claim / release / read, CAS
- [ ] `TxnKind` += `"voucher"`; `voucher_code` column; `startCompedTxn`
- [ ] `game-cards/service/credit-plan.ts` — ONE resolver for what a row credits (tokens/bonus/cash), shared by load + cron so they can never disagree
- [ ] `service/voucher-card.ts` — validate shape → `peekVoucher` → grant → claim → ledger row
- [ ] `POST /api/game-cards/voucher-redeem` (`claim` / `release`) + zod schema
- [ ] `load-card.ts` — accept `kind:'voucher'`, require the claim, credit via the plan
- [ ] `reconcile.ts` — grant-aware credit; skip voucher rows with no live claim
- [ ] `flags.ts` — `kioskVoucherGzEnabled()`, **defaults ON**, kill via `NEXT_PUBLIC_KIOSK_VOUCHER_GZ=false`
- [ ] `KioskGameZone` — new `voucher` mode: chooser tile → scan/type → claim → dispense → load → present; release the claim on any pre-dispense bail, NEVER after a card has physically left the stacker
- [ ] `KioskCodeEntry` — a scanned game-card comp routes to Game Zone with the code pre-seeded (this path stays behind `kioskPromoEnabled`; the chooser tile does not, so "on by default" actually means on)
- [ ] i18n EN + ES fragment keys
- [ ] Tests: grant allowlist/junk, target routing, claim race + re-claim after release, load authorisation refusal, cron skip
- [ ] `scripts/gz-voucher-bonuscash-probe.mts` — for the day bonus **cash** is wanted
- [ ] Gates: tsc · eslint (incl. react-hooks + jsx-a11y) · vitest · one final turbo build

## 5. What stays unproven until a live smoke

Flag is ON by default per owner instruction, so these are live on deploy:

1. **Dispense-on-comp has never run on hardware.** The rail is hardware-verified
   for paid new cards; this adds a $0 entry into it.
2. **BMI never records consumption.** Our ledger is the only spend record — a
   code also redeemed manually at Office would be invisible to us. Pick one
   channel per batch.
3. `<BonusCash>` is not used (grants are bonus tokens), so nothing unproven
   there — but if the owner wants literal cash, probe first.

Smoke plan: redeem ONE of the five live codes at a Fort Myers kiosk → card
dispenses → `/verify` shows +100 bonus tokens → re-scan the same code and
confirm it is refused → four codes left untouched.
