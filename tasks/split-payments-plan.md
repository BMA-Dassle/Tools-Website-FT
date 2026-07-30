# Split Payments — eGift (scan) + physical gift cards (swipe) + multiple credit cards

> **HANDOFF STATUS (2026-07-26, owner-approved plan).** PR-1 is DONE: the five probe scripts
> live on branch `feat/split-tender-probes` with the run guide
> [tasks/split-tender-probes.md](split-tender-probes.md). What a session can build NEXT without
> the owner (all headless, flag-dark, unit-tested):
>
> - **PR-2 — server engine** (§Architecture 1–2): `tenders.ts`, `authorizeTenders`,
>   `createDepositAndChargeTenders`. Note `SQUARE_MAX_TENDERS_PER_ORDER` stays a
>   PROBE-GATED constant (default 10) until probe #3 runs.
> - **PR-3 — ledger + sweep cron** (§Architecture 5).
> - **PR-5 — web client, component-only** (§Architecture 6): tender-math + TenderChips +
>   PaymentForm `onTenders`/`splitTenders`; zero consumer changes.
>
> What needs a HUMAN at the venue before the remaining PRs: run the probes per the run guide —
> `probe-terminal-split` (a card reader + 2 taps) is the **GO/NO-GO for kiosk multi-card**
> (fail ⇒ kiosk scope becomes N gift cards + 1 tap; web unaffected). Do NOT flip any flag or
> start PR-6/PR-9 before its verdict is recorded in the run guide.
> Reminder: dev Square is PRODUCTION — probes are dry-run by default, `--live` moves real money.

## Context

Kiosk and web checkouts are effectively single-tender today. The foundation exists —
`authorizeMultiTender()` in [square-gift-card.ts](apps/web/lib/square-gift-card.ts)
authorizes one gift card + one card (`autocomplete:false`) and captures atomically via
`POST /v2/orders/{id}/pay` — but it's capped at 1 GC + 1 card, the kiosk reader path bypasses it
entirely (`giftCardNonce: null` hardcoded), and the only kiosk gift-card story is "swipe it on the
Square Terminal as the sole tender." This project generalizes the rail to N gift cards + M cards
on both surfaces, with kiosk hardware ingestion (QR scan for eGift, MSR swipe for plastic, manual
GAN entry fallback).

## Owner decisions (2026-07-29 — v1 scope + caps)

- **v1 ships "kiosk matches web": ONE gift card + ONE card per checkout.** Web already does
  1 GC + 1 card, so v1 is kiosk-only work: scan/swipe/type a gift card at the reader kiosk,
  balance applies, remainder is one tap. Multi-GC and multi-card become later flag flips on
  the same rail (the PR-2 engine already models N). The kiosk deposit-tenders route enforces
  max 1 GC in v1.
- **Tender caps (post-v1): 5 total / 3 gift cards / 3 cards** — the kiosk hold runs ~5 min;
  a GC scan+apply ≈15-20s, a card tap with payer handoff ≈40-60s, so 3+3 ≈4½ min is the outer
  edge. Constants + rationale live in `tenders.ts` (`MAX_TOTAL_TENDERS` etc.);
  `SQUARE_MAX_TENDERS_PER_ORDER` stays the probe-gated hard bound.
- **Probe status:** #1 terminal-split = **GO** (2026-07-29, see split-tender-probes.md — order
  state is authoritative, post-capture cancel impossible). v1's only remaining gate is #2
  (gc-id-as-source, headless). #3 (cap) stops mattering at 2 tenders. PR-2 (server engine)
  shipped on `feat/split-tender-engine` with attempt-salted keys + smuggled-GC rejection +
  failedTender attribution (adversarial review, 5 confirmed findings fixed).

## Owner decisions (2026-07-26)

- Scope: **kiosk + web booking**. Split model: **gift cards first (drained), cards cover the rest**.
- **Multiple credit cards allowed**; per-card amounts guest-entered, last card auto-fills remainder.
- **Simplicity rule**: single-card path stays exactly as easy as today; split is strictly opt-in.
- Tender cap: Square's real per-order max (**probe-confirmed; believed 10**; sub-caps 5 GC / 4 cards for UX).
- Kiosk GC input: eGift = QR scan, physical = MSR swipe, manual GAN via on-screen keyboard as fallback.
- Synthesis decisions (simplicity rule): a gift card always applies `min(balance, remaining)` — no
  custom GC amounts (cards are the adjustable knob); card-vault consent applies to the final typed
  card only (kiosk never vaults).

## Verified foundation (key exploration facts)

- **Square cannot partially pay an order** — all tenders must sum exactly to amount due, authorized
  `autocomplete:false`, then captured atomically by PayOrder (proven live twice; `accept_partial_authorization`
  deliberately unused). N-payment reference: `payDayofOrder` in
  [group-dayof-pay/route.ts](apps/web/app/api/cron/group-dayof-pay/route.ts).
  Note: `payOrder()` omits `order_version` and is proven that way — keep omitting.
- Charging by **gift-card ID (`gftc:…`) as `source_id` is live-proven** (store-credit purchase
  strategy, probed 2026-07-13). Raw GAN as source_id fails. `getGiftCardFromGan()` exists but has no route.
- Kiosk credit-card device = **Square Terminal** (cloud REST, polled); `card-reader/` = CRT-591
  game-card dispenser (unrelated). `createTerminalCheckout` already parameterizes
  `payment_options.autocomplete` (admin reader-test uses `autocomplete:false` today).
- Forward-recovery model: no post-capture rollback; pre-capture failures cancel all auths;
  durable anchors + reconcile drive post-capture failures forward. **The "terminal-orphan reconcile"
  cron referenced in comments does NOT exist yet** — the new sweep cron absorbs that role.
- Refunds: Square refuses partial refunds of GIFT_CARD-funded payments (lesson 2026-07-11); the
  reservation-edit and cancellation allocators already walk N tenders safely; only
  `refundSquarePayment`'s un-salted key needs fixing.
- Web UI: `PaymentForm.tsx` (717 lines) has single-GC split math; `GiftCardCapture` has a fixed
  container id (one instance at a time — re-mount by `key`). PaymentForm consumers: 8 files; 4 in
  tokenize mode, 4 legacy mode (never see split UI); contract-pay/BalancePayClient is NOT a consumer.
- Kiosk seams: `CheckoutStep.tsx:~1567` `if (readerDeviceId)` → `KioskTerminalCheckoutGate`
  ("ready" phase renders `KioskReaderCheckout`) → `handleTokenize({externalPayment})` → reserve-all.
  Drift tripwire (warn >0¢, abort >2500¢) runs at prepare — preserved unchanged.
- Config coupling to fix: `msrEnabled ⇒ gameZoneCapability("reload")` — needs `msrUse` field so a
  podium kiosk MSR can serve gift cards without lighting up Game Zone reload.

## GO/NO-GO probe (do first)

**`probe-terminal-split.mts`** — can a Terminal checkout carry `order_id` + `amount_money` *less than*
the order's net due with `autocomplete:false`, then a second partial checkout, then PayOrder both?
- **Pass** → full design ships (M reader taps as tenders).
- **Fail** → kiosk scope reduces to *N gift cards + exactly 1 reader tap for the remainder*
  (web multi-card unaffected — card nonces don't use Terminal). Everything else in this plan stands.

Other probes (all `apps/web/scripts/*.mts`, house pattern; dev Square is PRODUCTION — small amounts,
refund after): `probe-gc-id-tender-payorder.mts` (gftc: id as source with autocomplete:false + PayOrder mix),
`probe-payorder-cap.mts` (real tender cap → sets `SQUARE_MAX_TENDERS_PER_ORDER`),
`probe-from-gan.mts` (physical + eGift GAN lookup; what MSR/scanner actually emit),
`probe-approved-cancel.mts` (canceling terminal-created APPROVED auths → feeds sweep/abandon).
eGift QR payload + physical GC track format are captured live via the kiosk admin scanner/MSR tabs
before the parsers' allowlists are finalized.

## Architecture

### 1. Tender model (new `apps/web/src/features/booking/service/tenders.ts`)

Zod discriminated union — `{kind:"gift_card", nonce? | lookupToken?}` (exactly one) and
`{kind:"card", sourceId, amountCents?, sourceKind?}` (only the LAST card may omit `amountCents` =
auto-fill). Array-level rules: GCs before cards, caps (10 total / 5 GC / 4 card), no dup GANs.
Constants: `SQUARE_MAX_TENDERS_PER_ORDER = 10` (probe-set), `MAX_GIFT_CARD_TENDERS = 5`,
`MAX_CARD_TENDERS = 4`.

`/api/booking/v2/reserve-all` + `/api/bowling/v2/reserve` gain optional `tenders?: TenderInput[]`
(400 if combined with legacy flat fields or with `externalPayment`; 400 fail-closed when flag off;
**absent → byte-identical legacy path**).

### 2. Authorize engine (`authorizeTenders` in lib/square-gift-card.ts — NEW code; `authorizeMultiTender` stays frozen)

Resolve + re-validate ALL GCs first (internal-GAN block, ACTIVE, balance>0, dup check) → plan all
amounts (GC = min(balance, remaining) in order; cards as entered; last card = remainder; sum must
equal total EXACTLY) → authorize sequentially `autocomplete:false` → `payOrder` (no order_version).
Any failure → cancel every prior auth, rethrow. Indexed idempotency keys (all ≤ 45 chars,
disjoint from legacy namespaces):

| Op | Key |
|---|---|
| GC auth i | `pay-gc-${baseKey}-${i}-${h8(sourceId)}` |
| Card auth j | `pay-card-${baseKey}-${j}-${h8(sourceId)}` |
| Terminal tap k, attempt a | `term-${baseKey}-${k}-a${a}` (attempt salt = burned-key lesson) |
| PayOrder (split) | `payord2-${baseKey}-${h8(ids.join(","))}` |
| Cancel | `cxl-${baseKey}-${h8(paymentId)}` |

`deposit.ts` gains `createDepositAndChargeTenders(...)` (clone of the 4-step skeleton →
`authorizeTenders` → `activateGiftCardForDeposit` with ALL paymentIds). `createDepositAndCharge`
untouched; `unified-reserve.ts` else-branch forks on `input.tenders?.length` (flag-gated).

### 3. Kiosk terminal split sequence

```
PREPARE (unchanged) → anchor v2 {split:true, tenders:[]}
per GC:   POST /api/kiosk/gift-card-lookup {seed, gan} → {lookupToken, balanceCents, last4}
          POST /api/kiosk/deposit-tenders {seed, lookupToken} → GC auth (autocomplete:false) → ledger
per card: POST /api/kiosk/terminal-checkout {…, seed, splitAmountCents} → reader tap (autocomplete:false)
          GET poll → stamp paymentId (union-append; legacy single-stamp preserved)
CAPTURE:  POST /api/kiosk/deposit-tenders/capture {seed} → verify sum + APPROVED → payOrder
RESERVE:  reserve-all with externalPayment {paymentId: last, paymentIds: all, amountCents: sum}
          → finalizeDepositFromExternalPayment (sum-of-payments verification; single-id degenerates
            to today's exact match) → activate deposit GC with all ids
```

Zero-regression fork: no `splitAmountCents`/`seed` in the terminal-checkout POST → today's code path
verbatim (`autocomplete` defaults true). `TerminalAnchor` v2 adds `split`, `paymentIds[]`,
`tenders[] {index, kind, paymentId?, amountCents, ganLast4?, checkoutId?, attempt?, status}`,
`capturedAt` — all optional, legacy readers null-safe. Also: `DELETE {seed,index}` (remove a GC
pre-capture), `POST /abandon {seed}` (idle-reset → cancel all auths immediately), and a GET/resume
that returns the ledger so a crashed kiosk resumes mid-split (extends the existing prepare-resume).

### 4. GAN lookup route (`POST /api/kiosk/gift-card-lookup`)

Guards in order: flag → per-IP rate limit (reuse checkin limiter) → **anchor binding** (seed must
resolve a live split anchor — the real anti-enumeration; plus ~10 failed lookups per seed locks the
session) → local `isInternalDepositGan` pre-check → `getGiftCardFromGan` → re-check prefix/ACTIVE/balance.
Response: `{lookupToken, balanceCents, last4, state}` — **never** the raw gftc: id or full GAN.
Token = single-use Redis entry `{giftCardId, gan, balanceCents, seed}`, TTL 15 min, seed-bound.
Web needs no new route (nonce path exists; engine re-validates server-side regardless).

### 5. Durable ledger + sweep cron

New Neon table `split_tender_attempts` (raw SQL; seed/base_key/surface/deposit_order_id/total_cents/
tenders jsonb/state open|captured|canceled|capture_pending|needs_review) — persist-first on every
tender add and paymentId stamp. New cron `/api/cron/split-auth-sweep` (15 min): cancels APPROVED
auths on abandoned rows (kiosk >45 min, web >2 h), retries-or-escalates `capture_pending`
(order COMPLETED → mark captured; OPEN+all APPROVED → one capture retry; else cancel-all + page),
alerts on `captured` rows >2 h with no booking (finally realizing the "terminal-orphan reconcile").

Failure matrix highlights: mid-list GC/card failure → cancel-all, friendly 400, retry gets fresh
keys where the source changed; terminal timeout/cancel → attempt-salted re-arm; browser crash
mid-split → resume from ledger, nothing settles if abandoned (sweep cancels); post-capture failures →
forward recovery only (existing model).

### 6. Web client (PaymentForm generalization)

New pure module `components/square/tender-math.ts` (+ tests): `AppliedGiftCard[]`, `ChippedCard[]`,
`computeTenderPlan()` (greedy GC application, chip validation ≥ $1, last-card auto-fill, cap, dup-GAN),
reducer; `useTenderPlan.ts` hook; `TenderChips.tsx` (GC + card chips, add-GC link, remainder line —
renders today's exact single-GC markup in the 1-GC case). PaymentForm adds `onTenders?(payload)` +
`splitTenders?: {multiGiftCard, multiCard}` — **legacy `onTokenize` consumers are byte-identical**
(split affordances require both). `TenderPayload.legacy` carries the old flat shape whenever
expressible so CheckoutStep keeps proven flat-field reserve calls until the rail flag flips.

Multi-card mechanics: chip = tokenize the live iframe NOW (nonces single-use), destroy → fresh
`payments.card()` → re-attach (riskiest mechanic — live-verified in stage tests; fallback:
alternating container ids). Wallets stay whole-total single tenders (hidden when any split tender
exists); saved card allowed only as the final tender. Decline recovery: server returns
`{code:"TENDER_DECLINED", failedTender:{index,kind,last4}}` → GC chips resubmit by GAN (no re-scan),
card chips become "re-enter" ghosts. GiftCardCapture gains `appliedGans` dup check; re-mount by `key`.

### 7. Kiosk client (split UX + hardware)

`KioskTenderScreen` (new, thin): mode "single" renders `KioskReaderCheckout` exactly as today with
the reader pre-armed — the ONLY visual change is the amber GC banner becoming a
**"Use a gift card / split payment"** button (flag off → banner, byte-identical). Tapping it DELETEs
the pending full-amount checkout → `KioskSplitTenderScreen` (tender board: applied tenders,
huge "LEFT TO PAY", + Add gift card / Pay rest by card; per-tender cancel; "Cancel everything"
confirm — refund copy if a card tap already captured). Pure math in `split/split-core.ts` (+tests).
State machine: overview ⇄ gc-capture (scan/swipe/manual → lookup → confirm-apply) ⇄ card-amount →
card-awaiting-tap (N of M) → finalizing → onCaptured. IdleWatcher paused during awaiting-tap/finalizing;
unmount cleanup DELETEs pending checkout (keepalive) + fires `/abandon`.

Hardware ingestion:
- **QR (eGift):** `GiftCardScanListener` (clone of CheckinScanListener) mounted only during
  gc-capture; 350 ms burst grouping; `extractGanCandidate()` in `qr-scanner/gift-card-qr.ts`
  (bare 8–20 alnum GAN, or Square URL forms; license-shaped bursts → friendly error). Never log
  raw payloads; server lookup is the arbiter. Final rule order locked by a live eGift capture.
- **MSR (physical):** `parseSquareGiftSwipe()` added to `wedge.ts`, invoked ONLY inside
  `useSerialMsr` via new `mode: "intercard" | "square-gift"` (raw tracks never leave the hook).
  Hard discards first: bank-shaped (Luhn + payment IINs) → discard, log shape only; `;6283=` →
  "that's a Game Zone card"; surviving 8–20 digit run → candidate → server lookup. Tighten to a
  Square IIN allowlist after hardware capture. New config `msrUse?: "gamezone"|"giftcard"|"both"`
  (default gamezone) fixes the `gameZoneCapability` coupling; add to `resolveKioskConfig` literal
  (strip-guard test).
- **Manual:** OSK numeric input (`data-osk-layout="numeric"`), 8–20 chars.
- **Admin test surface:** "Gift cards" card in KioskAdmin (scan/swipe/manual → classification +
  masked lookup) — doubles as the live-capture probe and per-kiosk smoke.

Policy cleanup (same flag): `guardAdd` early-return kills the "One payment covers everyone" modal;
`splitPaymentAvailable` widens to boolean fed by flag (+ reader presence for mobile-join copy);
JoinPhoneFlow copy becomes positive when available; update the two join tests.

## Flags

| Flag | Side | Default | Gates |
|---|---|---|---|
| `SPLIT_TENDERS_ENABLED` | server | off | `tenders[]` on reserve routes + engine fork |
| `NEXT_PUBLIC_TENDERS_PAYLOAD_WEB` | client | off | CheckoutStep sends tenders even single (transport parity stage) |
| `NEXT_PUBLIC_MULTI_GC_WEB` / `NEXT_PUBLIC_MULTI_CARD_WEB` | client | off | web split affordances |
| `NEXT_PUBLIC_KIOSK_SPLIT_TENDER` | client+server kiosk routes | off | kiosk split screen + GC lookup/tender routes (inert without `kioskTerminalEnabled`) |

## PR sequence (one PR, one purpose)

1. **Probes** — 5 scripts; record findings in `tasks/`; owner go/no-go on terminal partial + cap.
2. **Server engine** — `tenders.ts`, `authorizeTenders`, `createDepositAndChargeTenders`, key helpers, unit tests. Dead until flagged.
3. **Ledger + sweep** — `split_tender_attempts` table module, `/api/cron/split-auth-sweep` (+vercel.json), captured-orphan alerting.
4. **Web rail** (`SPLIT_TENDERS_ENABLED`) — reserve-all + bowling reserve `tenders[]` parsing/guards, unified-reserve fork, `DepositResult.tenders`.
5. **Web client, component-only** — tender-math + hook + TenderChips + PaymentForm `onTenders`/`splitTenders` + GiftCardCapture dup-check + tests. Zero consumer changes.
6. **Web CheckoutStep wiring** — `handleTenders` adapter (legacy passthrough), then stage flags: transport parity → multi-GC → multi-card. Bowling step + game-cards follow as separate small PRs.
7. **Kiosk GC rail** — gift-card-lookup + deposit-tenders routes (add/remove/abandon/resume), anchor v2, Neon writes. Testable GC-only.
8. **Kiosk client** — KioskTenderScreen/KioskSplitTenderScreen/useSplitTender/split-core, scanner + MSR parsers (`msrUse` config), admin Gift-cards surface, policy/copy cleanup.
9. **Kiosk terminal split** — terminal-checkout `splitAmountCents` fork + multi-stamp, `/capture`, `finalizeDepositFromExternalPayment` sum-generalization, `ExternalTerminalPayment.paymentIds`, resume. **Gated on probe #1 + live card-present smoke** (H3074 six-charge rule).
10. **Refund hardening** — `refundSquarePayment` key salt, N-tender fixtures for reservation-edit + cancellation suites, tender-count guard check.

## Verification

- **Unit (vitest):** tender-math (greedy/auto-fill/caps/dup-GAN/replan), split-core kiosk math,
  authorizeTenders key derivation + cancel-all, zod tender rules, payload adapter `legacy` correctness,
  extend deposit.test.ts + join tests + wedge tests (bank-discard, gamezone, candidate).
- **Live (owner-run; production Square, small amounts, refund each step; `scripts/inspect-order.mts` after each):**
  1. Parity: single-card booking with flags on — order indistinguishable from before.
  2. Two eGift cards + card remainder (web): 3 payments on one order.
  3. Two cards split (web): iframe re-mount clean, brand/last4 chips correct.
  4. Decline recovery: dead final card → ZERO captured payments, GC chips survive, re-enter succeeds.
  5. Kiosk: GC scan → balance shown → apply → remainder tap; then 1 GC + 2 taps; cancel-mid; idle-mid
     (auths released — check Square dashboard shows no lingering holds); crash-resume.
  6. Regression: wallet + saved-card checkouts unchanged; kiosk flag-off screen byte-identical.
- **Tripwires per stage:** inspect-order shape diffs, Square per-order payment counts vs tender counts,
  orphan-payment audit stays clean, sweep-cron logs quiet.

## Open items (non-blocking, resolve during implementation)

- Square Web SDK: confirm `tokenize().details.card.{brand,last4}` availability; destroy/re-attach cleanliness (fallback: alternating containers).
- eGift QR payload + physical GC IIN — locked by live captures on the admin surface before parser allowlists finalize.
- Mobile-join `splitPaymentAvailable`: pass reader presence into join-session creation (preferred) vs flag-only.
- `deposit_payment_ids` reporting column on Neon reservations: optional, allocators don't need it.
