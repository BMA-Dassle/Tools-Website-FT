# Kiosk Coupon Codes + Scannable Vouchers — Research & Design

**Status:** RESEARCH / PLAN ONLY — no code built. Owner request 2026-07-26.
**Scope:** (1) bring coupon codes to the kiosk the way the web booking attractions selector
has them; (2) scan **race** and **laser tag vouchers** at the kiosk; (3) **game zone
vouchers** that immediately dispense an arcade card from the kiosk's CRT-591.

**REVISED 2026-07-27 — vouchers originate from BMI (first), redemption layer stays
issuer-agnostic.** Owner confirmed vouchers are BMI's, and BMI's latest Public Booking API
spec (updated 2026-06-25) ships **released** voucher endpoints: `voucher/sell`,
`order/applyCode`, `order/removeCode`. Full spec extract saved to
[docs/bmi-public-booking-vouchers.md](../../docs/bmi-public-booking-vouchers.md).
**BMI is the system of record for BMI-issued vouchers** and is the required v1 target; our
side is scan UX + a per-issuer redemption adapter + a Neon audit ledger. Owner follow-up
(2026-07-27): *"we could eventually have our own vouchers as well — just needs to support
BMI"* — so the scan/redeem layer is designed **dual-source from day one** (resolve a
scanned code to an issuer: `bmi` now, `native` later), and the v1 homegrown Neon voucher
design is retained in §2 Part D as the future `native` issuer, not discarded.
(Earlier owner note — "guests could put a voucher on their account" — is revisited in §3;
BMI vouchers are order-level codes, so on-account conversion is an explicit design option,
not the default.)

---

## 1. What exists today (evidence map)

### 1a. Coupon codes — everything but the kiosk UI already works

The discount-code system is live, Neon-backed, and — critically — **its pricing seam already
runs under the kiosk** because the kiosk reuses the web booking session, reducer, cart math,
and reserve rails.

| Piece | Where | Notes |
| --- | --- | --- |
| Tables | `apps/web/src/features/discount-codes/data.ts` | `discount_codes` (mechanic percent/fixed, purchase window, visit-date window, `allowed_weekdays`, `allowed_locations`, `scopes` JSONB per domain, `max_uses`) + `discount_redemptions` ledger (`UNIQUE (code_id, external_ref)` idempotency; `recordRedemption` at L300–364 does insert-then-guarded-bump). |
| Pure validation | `evaluate.ts` — `evaluateCode()` L51–138 | Checks active → purchase window → mechanic → uses → location → domain scope → product slug → weekday (ET) → visit-date window. Weekday/visit-date checks are **skipped when `bookingDate` is absent** (deliberately loose for the web landing). |
| Server resolver | `service.ts` — `resolveAppliedPromo()` L46–79 | Multi-domain, anti-enumeration (returns `null` for any unusable reason). |
| Public endpoints | `POST /api/booking/v2/promo` (multi-domain, never leaks *why* invalid) · `POST /api/discount-codes/validate` (single-domain, per-reason errors) | Both Redis rate-limited 20/5min **per IP**. |
| Web attractions selector | `apps/web/app/book/v2/PromoLanding.tsx` | Promo form L280–347; `submitCode()` L155–187; gold "✨ Code applies" tile badge via `isOfferingInPromoScope` (L693, badge L719–747); `?code=` carried into the activity flow and preserved on back-nav (`CartView.tsx` L77–80, `MiniCartV2.tsx` L32–36); server-side seed in `app/book/v2/page.tsx` L78–83. |
| Checkout input | `steps/checkout/PromoCodeInput.tsx`, rendered by `CheckoutStep.tsx` L977–984 | Self-contained; dispatches `{type:"applyPromo"}`. A richer per-reason variant exists unused at `steps/bowling/DiscountCodeInput.tsx`. |
| Pricing seam | `src/features/booking/service/promo-pricing.ts` | Pure (`isPromoEligibleLine`, `promoFactor`, `applyPromoToBillLines` — idempotent via `originalAmount` guard). Per-line eligibility on that line's own visit date; mixed carts discount only eligible legs. **Fixed-amount codes are a no-op on this path** (factor 1, L128) — only percent codes work in v2. |
| Charge side | `unified-reserve.ts` `buildCombinedLineItems()` (bowling L318–350, race L406–414, attractions L430–443) | `base_price_money` price-key overrides, no Square DISCOUNT object. Redemption recorded post-capture at L1395–1409, soft-fail, keyed on `squareDayofOrderId`, stamped `bookingSource:"kiosk"` for kiosk carts. |
| State plumbing | `machine.ts` L98/349 (`applyPromo`), `state/types.ts` L629 (`session.appliedPromo`) | Same `BookingSession` the kiosk persists (`kiosk_booking_session`, schema v11). |
| Admin | `/admin/{token}/discount-codes` (`DiscountCodesClient.tsx`, 833 ln) | Create/edit, mechanic picker, per-domain slug scoping, Square DISCOUNT auto-provision for bowling. |

**Kiosk today:** deliberately no promo input on the merged checkout — owner decision
2026-07-21, recorded at `KioskCheckoutScreen.tsx:17–19`: *"No promo code input by owner
decision — web checkout keeps it; the pricing seams stay so it can return as a drop-in."*
This request re-introduces it at the **selection screen** (mirroring the web attractions
selector), not checkout. Note the legacy (flag-off) kiosk checkout path still renders
`PromoCodeInput` as an artifact of `CheckoutStep` reuse — unguarded, zoomed.

**Known gaps to fix while building this** (found during research):

1. **Trust model split:** `POST /api/bowling/v2/reserve` re-resolves the code from Neon at
   charge time ("client-sent amounts are never trusted"), but the mixed-cart
   `reserve-all` → `unifiedReserve` path **trusts the client's `appliedPromo.amountPct`
   snapshot**. The kiosk is an unattended public surface — the unified path must re-resolve
   server-side before this ships on kiosks.
2. `/api/booking/v2/promo` never passes `locationId`, so `allowed_locations` codes resolve
   at the landing and are only caught later (usually never). The kiosk knows its center —
   pass it.
3. Per-IP rate limiting can bucket every kiosk behind one NAT (and `getClientIp` failure
   buckets everything under `"unknown"`). Key kiosk requests by `kioskDeviceKey()` instead.
4. Admin-UI foot-gun: `booking_date_start/end` are not settable from the admin UI and any
   PUT silently NULLs them (`api/admin/discount-codes/validation.ts` never reads them).
5. `max_uses_per_customer` is stored but never enforced anywhere.

### 1b. Kiosk scanning — three working input paths, zero voucher consumers

| Path | Where | Used for today |
| --- | --- | --- |
| Serial QR scanner (Web Serial) | `src/features/kiosk/qr-scanner/` — `useQrScanner`, `models.ts` (Honeywell 3320g confirmed, Opticon 2D seeded), `line-accumulator.ts`, `port-matching.ts`, `aamva.ts` (license → name+DOB only), `member-qr.ts` | License sign-in, SMS-Timing member QR. Docs: `docs/qr-scanner/README.md`. |
| Keyboard-wedge burst | `checkin/wedge-scan.ts` (armed-only capture) + server classifier `checkin/scan.ts` (`shortcode | signed-url | wnumber | code | unknown`) | Check-in reservation codes. |
| Camera (zxing) | `components/features/game-cards/CardScanner.tsx`, `ReloadFlow.tsx` | Game-card barcode/QR on the public `/reload` page. |

`KioskConfig.scannerEnabled` (`config.ts:58`) is literally documented as for "login codes +
**vouchers**" — the hook was left for this feature; nothing consumes it yet.

QR **generation** exists (`qrcode@^1.5.4`; payload pattern in `lib/qr-checkin.ts`). There is
**no 1D barcode generator** in the repo — voucher QR is the scan target.

**Real scan payloads — owner capture on a live kiosk scanner, 2026-07-27** (identities
confirmed by owner). This is the ground truth the classifier must dispatch on:

| Raw payload | Confirmed identity | Classifier routing |
| --- | --- | --- |
| `https://icardinc.net/063PFZHQEAKEQ0A6M5` | Game Zone card **QR** (Intercard shortlink) | Existing `resolve-scan.ts` redirect-chase (SSRF-allowlisted) → reload/balance flows |
| `0000000001063464` | Game Zone card **1D barcode** — bare Intercard account, zero-padded to 16 digits | Strip leading zeros → account number (string!) → game-card flows |
| `C2D8M8D6M6C9M9U9U5K7Q6R9` | **BMI voucher number** — 24 chars, uppercase, strictly alternating letter/digit | → `bmi` voucher adapter (applyCode). **Answers Q1's format half.** |
| `sqgc://7783324218120014` | Square **gift card** QR (scheme + 16-digit GAN) | Recognize + route gracefully: "Gift cards are accepted at the card reader" (future: balance lookup / tender) |
| `https://squareup.com/gift/balance/359d3e06…` (32-hex token) | Square gift card **balance URL** (also printed on the cards) | Same routing as `sqgc://` |
| (4s after the icardinc scan: `HeadPinz — Where Fun Comes Together`) | Not a payload — the resolved page title echoed by the test panel | Ignore non-payload lines |

Design consequences:

1. **Scan-first UX is confirmed** — a 24-char voucher code is not typeable on a kiosk OSK
   in practice. Keep the keyboard as fallback only; expect mistypes (consider echoing the
   parsed code back big before applying).
2. **The BMI code shape is regex-detectable — CONFIRMED across 32 production codes**
   (owner shared a BMI Office voucher table, 2026-07-27, numbers 548–579): every code is
   24 chars, strictly alternating letter/digit. The generator's alphabet is deliberately
   lookalike-free — letters only from `A B C D G H K M P Q R S T U X Z` (no I/O/L/E etc.,
   no vowel words possible), digits only `2–9` (no 0/1). Classifier regex:
   `^([A-Z][2-9]){12}$` (don't over-fit to the 16-letter set; the loose letter class is
   safe since alternation + digit-2-9 already excludes everything else we scan). Our
   future native codes (Part D) just need a different shape — e.g. 10-char Crockford with
   a letter prefix — so issuer resolution is a cheap local regex, not a BMI round-trip.
3. **Gift cards WILL be scanned at this surface** whether we plan for it or not — the
   classifier must catch `sqgc://` and `squareup.com/gift/balance/` and respond helpfully
   instead of "unrecognized code." (Ties into the shelved gift-card multi-tender research.)
4. Game-card payloads arriving at the voucher/coupon prompt should bounce the guest to the
   Game Zone reload/balance flow — the guest scanned the thing they were holding; honor it.
5. **Comp vouchers already exist in BMI production** — the shared Office table is a batch
   of 32 "Complimentary 1 Hour Shuffly" vouchers (sequential numbers, one shared Setup
   text: "Redeem at guest services or attendant"). Three takeaways: (a) BMI Office batch-
   mints vouchers and **displays the codes in its voucher table**, so staff-sold/comp
   delivery (print/hand-out) needs nothing from us — the open Q1 half is only the online
   `voucher/sell` path; (b) the kiosk becomes the self-serve redemption point for voucher
   stock that exists TODAY; (c) voucher kinds must be **BMI-product-driven, not hardcoded**
   to race/laser/game-zone — Shuffly is already a fourth, and it books through the same
   BMI `booking/book` as laser tag, so the applyCode rail covers it with zero extra work.

### 1c. Vouchers — BMI-native, now released (the v1 assumption is obsolete)

- **BMI Public Booking API ships vouchers** (spec updated 2026-06-25; extract at
  [docs/bmi-public-booking-vouchers.md](../../docs/bmi-public-booking-vouchers.md)):
  - `POST /public-booking/{clientKey}/voucher/sell` — vouchers are BMI **products**
    (`ProductKind 4`, `IsVoucher: true`, `VoucherMetaId`) sold with gift metadata
    (sender/recipient/memo/picture), optional bundled `ActivationProducts`, optional
    delayed `ActivationDate`.
  - `POST …/order/applyCode` — `{OrderId, Code}` applies a **voucher number or discount
    promo code** to an existing order; returns the updated `PublicOrderOverview` with
    `AppliedPromoCodes[] {Name, VoucherOrderItemId?, DiscountId?, Discount}` and per-line
    `VoucherCode` / `Discount` fields.
  - `POST …/order/removeCode` — backs one out by `VoucherOrderItemId` (voucher) or
    `DiscountId` (promo).
  - Sections 20–22 carry **no** "not yet released" banner (the payment-options and
    pay-on-site sections do) → released.
- **Our proxy is half-ready**: `order/applyCode` + `order/removeCode` were allowlisted
  speculatively on 2026-04-21 (`apps/web/app/api/bmi/route.ts:78–84` — comment says "not
  yet released", now stale). `voucher/sell` is NOT allowlisted yet.
- **Precision hard rule applies everywhere here**: `OrderId` / `OrderItemId` /
  `VoucherOrderItemId` / `ProductId` / `PersonId` are Longs that exceed
  `Number.MAX_SAFE_INTEGER` — `stringifyWithRawIds` / `parseWithRawIds` mandatory.
- Adjacent rails still relevant:
  - **Race credits** (`race-credit-redeem.ts`, comp deposit kind in
    `data/race-credits.ts`) — the on-account alternative if the owner wants voucher→account
    conversion (§3, decision 2).
  - **Game zone / Intercard** (`features/game-cards/`, `features/kiosk/card-reader/`,
    `game-card-bridge/`) — dispense→read→credit→present is hardware-verified; the missing
    piece is a voucher-triggered load with **no money leg**.
  - **POV codes lesson** (`tasks/lessons.md` §shared-inventory): idempotent claim deduped
    by owning resource id — applies to our audit ledger and to how we call applyCode.
  - **Laser tag** books through the same BMI `booking/book` as races
    (`service/attractions.ts:1–8`) — with applyCode, race and laser tag redemption are
    **the same integration** (the v1 asymmetry disappears).

---

## 2. Recommended design (revised for BMI-native vouchers)

### Part A — Coupon codes on the kiosk (unchanged; smallest lift, ships first)

Mirror the web attractions selector on `KioskCategories` (the kiosk's selector screen):

1. **Entry UI:** a "Have a coupon?" affordance on `KioskCategories` opening a kiosk-native
   modal — `OnScreenKeyboard` text entry **and** "scan your coupon" via the attached QR
   scanner. Printed/emailed coupons encode `https://headpinz.com/book/v2?code=XYZ` (also
   works on any phone camera); the scan handler extracts `code=` or accepts a bare code.
2. **Validation:** same `POST /api/booking/v2/promo`, but the kiosk passes `locationId`
   (its center's Square location) and `bookingDate = todayYmd()` — walk-up semantics let the
   kiosk be *strict* on weekday/visit-date windows where the web landing is deliberately
   loose. Surface per-reason error copy (the `DiscountCodeInput` message table).
3. **Apply:** dispatch the existing `{type:"applyPromo", promo}`; badge eligible tiles via
   `isOfferingInPromoScope`, restyled to the kiosk PODIUM design system (mockup lesson
   2026-07-21: never copy website card styling onto the kiosk).
4. **Checkout display:** add a promo-savings line to `KioskCheckoutScreen`.
5. **Hardening (required before kiosk exposure):** unified reserve re-resolves the promo
   code from Neon at charge time (match the bowling route's trust model); per-kiosk
   rate-limit key.
6. **Flag:** `NEXT_PUBLIC_KIOSK_PROMO_ENABLED`, default OFF until owner smoke.

Pricing needs **zero** work: the kiosk cart already runs `promoFactor` /
`applyPromoToBillLines` transitively, and `unifiedReserve` already records redemptions for
kiosk carts.

**Boundary decision — two coupon systems now exist.** BMI `applyCode` also accepts
"discount promo codes" (BMI-configured, `DiscountId`). Our Neon/Square system stays the
coupon system for kiosk/web PR1 (live, admin'd, prices via Square price-keys, records
redemptions). Do NOT run the same code through both systems — a code is either ours
(Neon/Square price-key) or BMI's (applyCode). Convergence on BMI promo codes is a possible
later phase once voucher integration proves the applyCode rail.

### Part B — Voucher redemption layer: issuer-agnostic core, BMI adapter first

**Architecture rule (owner 2026-07-27):** one scan/redeem pipeline, multiple issuers. A
scanned code resolves to an issuer — `bmi` (v1, below) or `native` (later, Part D) — and
each issuer implements the same small adapter contract: `resolve(code) → kind + grant
preview`, `redeem(code, target) → applied result`, `release(code, target)`. The kiosk UX,
scan classification, audit ledger, and confirmation surfaces are shared; only the adapter
differs. Nothing about the BMI integration below is allowed to assume it's the only issuer
(no "voucher == BMI order code" leaks into UI or ledger shapes — the ledger stores
`issuer` + issuer-scoped refs).

**BMI adapter (v1 target).** BMI is the system of record for BMI-issued vouchers. Voucher
products (race / laser tag / game zone) are
configured in BMI per kind (`VoucherMetaId` governs the voucher metadata — exact semantics
to confirm, §4). Sale channels:

- **BMI Office / POS** — staff sell vouchers directly; BMI issues the voucher number.
- **Online / kiosk (later phase)** — `voucher/sell` via our proxy (needs allowlisting +
  raw-id handling + Square charge choreography like any other BMI sale). Gift metadata
  (sender/recipient/memo) comes free from the API.

**Our layer** (thin by design):

1. **Scan UX** — voucher QR/barcode → code string. Extend the kiosk scan classifier;
   "Redeem a voucher" chip on `AttractScreen`; accept scans on the categories screen.
   (Confirm what BMI prints on a voucher — code format, QR presence — §4. If BMI vouchers
   are code-only on paper, the kiosk on-screen keyboard is the fallback entry.)
2. **Redemption = `order/applyCode` against the booking's BMI order.** Both race and laser
   tag flows already create BMI bills before payment. Sequence: build bill (heats /
   sessions booked) → `applyCode {OrderId, Code}` → re-read overview (`parseWithRawIds`) →
   our displayed total re-derives from the overview's reduced `Total` → Square charges the
   **remainder** (possibly $0 → skip charge, straight to confirm). `removeCode` on guest
   back-out or idle reset, and in the abandon/cancel teardown path.
3. **Neon audit ledger (persist-first rule)** — `voucher_redemptions` row at scan-accept:
   **`issuer` (`'bmi'` now, `'native'` later)**, code (raw string), issuer-scoped refs
   (BMI: OrderId/VoucherOrderItemId as raw strings), kiosk device, amounts before/after,
   state (`applied → charged → confirmed | removed | orphaned`). This is an audit +
   reconcile surface — for BMI vouchers it is NOT the source of truth (for future native
   vouchers it will be). An `applied` row whose booking never
   confirmed feeds a sweep that calls `removeCode`/cancel so codes aren't burned by
   abandoned sessions (verify BMI's behavior: is a code consumed at applyCode, or only at
   payment confirm? §4 Q3).
4. **Displayed == charged**: the post-applyCode overview is the single pricing truth for
   voucher orders — our Square charge amount must derive from re-reading it server-side,
   never from client math. Hard-fail on drift (existing tripwire pattern,
   `KioskTerminalCheckoutGate`).

### Part C — Per-kind flows

**Race + laser tag voucher (same integration — and every other BMI-booked attraction):**
scan → (race only) identify/register racers as usual → pick heat / session → bill built →
`applyCode` → pay remainder on the reader (or $0 skip) → confirm. No arena-deposit ask
needed; no price-key fallback needed — the v1 asymmetry is gone. Because all four BMI
attractions share `booking/book`, the same rail redeems **gel blaster, duckpin, and
Shuffly** vouchers for free — and comp Shuffly vouchers already exist in BMI production
(§1b consequence 5). Kind support should follow BMI product config, not a hardcoded list.

**Game zone voucher → card spits out immediately:** game cards are Intercard-side and
invisible to BMI, so redemption must marry the two systems:

- Kiosk scan → create/locate a BMI order carrying the game-zone voucher-eligible product →
  `applyCode` → overview shows $0 (or remainder) → confirm BMI payment ($0) → **then** the
  existing dispense rail: `$0` `intercard_transactions` row (new `kind:'voucher'`, linked
  to the BMI OrderId + voucher code) → `dispenseAndRead` → `creditTokens` bridge-first →
  present card. Failure paths reuse capture-to-bin, `KioskDispenserHold`, and the
  recover-forward reconcile cron (row already persisted → recovery credits, never
  re-dispenses).
- Requires a BMI product mapping "game zone card / N tokens" (may already exist for group
  events — "200 Token Game Zone Cards" appears in GF contracts). Confirm §4 Q6.
- If BMI's product/voucher modeling proves awkward for a non-BMI fulfillment, game zone is
  the natural first user of the `native` issuer (Part D) — same kiosk flow, our Neon
  voucher instead of a BMI order. Default remains BMI-native so all three kinds share one
  issuer at launch.

**"Put it on my account" (owner note from v1 review):** BMI vouchers are order-level codes
— the guest "holds" value by holding the code, and can redeem any visit until expiry, which
may be enough. If true on-account conversion is still wanted for race vouchers, the v1
mechanism stands as an optional add-on: scan → `applyCode` on a race-credit-style grant, or
directly grant a Comp race credit (`addDeposit(+1)`) and mark the code consumed via a $0
redemption order. Decide after BMI semantics are confirmed (§4) — don't build both paths
speculatively.

### Part D — Future `native` issuer (our own vouchers; retained v1 design)

Owner 2026-07-27: we may eventually issue **our own** vouchers alongside BMI's (e.g.
instant marketing batches, donations, party favors, kinds BMI can't model, or fulfillment
BMI can't see like game cards). When that day comes, it plugs into the Part B adapter
contract — no kiosk UX or ledger changes. The v1 schema is kept here as the blueprint:

```
vouchers            -- ONLY for issuer='native'; BMI-issued vouchers never get a row here
  id BIGSERIAL PK · code TEXT UNIQUE (generated ~10-char Crockford; UNIQUE on UPPER(code))
  kind TEXT            -- 'race' | 'laser_tag' | 'gamezone' | ...
  grant_config JSONB   -- e.g. gamezone: {tokens, bonusTokens, waiveActivationFee}
  batch_id / batch_label · issued_source · issued_to JSONB · expires_at
  status 'issued' → 'redeeming' → 'redeemed' | 'void'   (atomic claim: UPDATE … WHERE status='issued')
  redeemed_at · redeemed_ref (raw string) · redeemed_center · redeemed_kiosk · created_by

voucher_events      -- append-only audit: issue / scan / redeem / release / void
```

Plus an admin mint/void/report page and printable QR sheets (`headpinz.com/v/{code}`).
Issuer resolution is a **local regex, no round-trip** now that the BMI format is observed
(§1b): `^([A-Z][0-9]){12}$` → `bmi`; our native codes pick a deliberately different shape
(e.g. 10-char Crockford, letter-prefixed) → `native`; anything else → per-payload routing
from the §1b registry (game card, gift card, check-in code).

### Hard-rule compliance (all parts)

Raw-string ids end-to-end (never `Number()` / `JSON.parse` a BMI/Intercard id — every
applyCode/removeCode/voucher-sell call and overview re-read) · persist to Neon at capture,
external APIs downstream · displayed==charged via server-side overview re-read · every
money/fulfillment path flag-gated and live-smoked before default-on · vendor success codes
verified out-of-band (re-read the order overview after applyCode; re-read the Intercard
balance after credit) · idempotent claims deduped by owning resource id.

---

## 3. Phasing (one PR, one purpose)

| PR | Scope | Flag |
| --- | --- | --- |
| 0 | **BMI probe script** (`scripts/` mts): sell a test voucher in BMI Office, then applyCode/removeCode against a throwaway order — answer §4 Q1–Q5 empirically before building UI | — |
| 1 | Kiosk coupon codes (our Neon/Square system) + server re-validation hardening | `NEXT_PUBLIC_KIOSK_PROMO_ENABLED` |
| 2 | Redemption core (issuer-agnostic adapter contract + `voucher_redemptions` ledger w/ `issuer` column + scan classification) with the **BMI adapter**: proxy plumbing (+`voucher/sell` allowlist), raw-id client helpers, removeCode teardown hooks | — (inert without PR3) |
| 3 | Race + laser tag voucher redemption at kiosk (scan → applyCode → pay remainder) | `NEXT_PUBLIC_KIOSK_VOUCHER_REDEEM` |
| 4 | Game zone voucher → applyCode + dispense | `NEXT_PUBLIC_KIOSK_VOUCHER_GZ` |
| 5 | (Optional) sell vouchers on kiosk/web via `voucher/sell`; on-account conversion if owner still wants it | per feature |
| 6 | (Future, when needed) `native` issuer per Part D: Neon `vouchers` tables + admin mint/print + adapter — zero kiosk UX change | per kind |

## 4. Open questions — BMI · **PR0 PROBE RAN 2026-07-27** (live, prod `headpinzftmyers`)

`scripts/bmi-voucher-probe.mts` (on `feat/kiosk-coupon-voucher`) applied a real voucher —
`K5B7C3S7Q4Z9Q9Z3M9A9T7Z2`, which turned out to be a **"Race Comp"** voucher — to a
throwaway license-fee order (id `63000000006397110`, 17-digit → raw-id handling proven).
Both throwaway orders cancelled clean. Findings:

- **⚡ REDEMPTION MODEL (changes the design): `applyCode` ADDS the voucher's bundled comp
  product as a $0 LINE — it does NOT discount existing lines.** Overview after apply:
  `AppliedPromoCodes: [{name: "Race Comp - K5B7…", voucherOrderItemId, discountId: null,
  discount: ""}]` plus a new line `Race Comp ×1` stamped `voucherCode=K5B7…`; the existing
  license line and the order **total were unchanged**. A BMI voucher = "this item, free,"
  not "% off your cart." So the kiosk redemption flow is NOT "pay the remainder of what
  you picked" — it's **the voucher's product lands on the bill free**, and the open design
  question becomes how a comp line pairs with a scheduled heat/slot (does booking/book
  schedule onto the comp line, or does the comp line's presence zero a matching product's
  price at confirm?). **NEXT PROBE: apply a race voucher to a bill that has a real booked
  heat** — or confirm with staff how POS redeems these today.
- **Q3 ANSWERED: codes are NOT locked at apply.** The same code applied to a second
  un-paid order was accepted. Consumption presumably happens at payment confirm (verify at
  the next probe). An abandoned Pending order should therefore not burn a code — but the
  kiosk teardown still calls `removeCode` as hygiene.
- **removeCode works and fully restores**: after remove, `AppliedPromoCodes` emptied, the
  comp line vanished, and re-apply succeeded.
- **Q5 ANSWERED: errors are HTTP 200 + `{success:false, errorMessage:"Voucher (code: …)
  is not found"}`** — body strings, not status codes. Kiosk copy maps off `errorMessage`.
- Public `/products` returns an **empty catalog** on this deployment — voucher products
  are not publicly listed (Office-side config); `IsVoucher` discovery isn't available to
  us, so voucher kinds resolve at applyCode time from the applied line, not up front.
- `booking/sell` needs the license-fee idiom (bare ProductId, no PageId) for standalone
  lines; slot products (Shuffly 23345625) reject a bare sell ("Product not found or
  wrong") — throwaway orders for probes should use the license product `43473520`.

**PROBE 2/3 (same day, real booked heat):** applyCode on a bill with a booked $22.35
Starter Race Red line adds the $0 Race Comp line but the race line **and total are
UNCHANGED at apply** — no auto-zero on the public API. And availability re-queried WITH
the OrderId after applyCode offers **no productLineId binding** — heats cannot be
scheduled "onto" the comp line; booking always adds a priced race line. Owner
(2026-07-27): **the zero-out happens when the order is PROCESSED** — BMI nets a Race
Comp line against a race line at settle (POS behavior). Owner also re-confirmed the
on-account direction: race/laser/gel comps should ALSO be loadable onto guest accounts
(Part C / decision 2 stands as a follow-on phase).

**PR3 integration design (locked by the probes):** book the heat/session normally +
`applyCode` on the same bill → OUR Square charge zeroes the race line matched by the
comp (deterministic: one comp line = one matching race entry) → BMI carries both lines
and nets them at processing. The netting-at-settle behavior is owner-asserted, not yet
API-verified, so PR3's flag stays dark until ONE paid live smoke confirms: reduced charge
→ BMI settles clean → the code shows consumed in Office.

Still open:

1. **Voucher number delivery on the ONLINE `voucher/sell` path** (staff-sold is answered —
   Office displays codes; format confirmed: `^([A-Z][2-9]){12}$`).
2. **VoucherMeta semantics** — expiry, multi-item vouchers, which product a comp nets
   against when several could match.
3. **Consumption + netting at payment confirm** — the PR3 paid live smoke (codes are NOT
   locked at apply, so only a processed order can prove it).
4. **Public bill-overview path** — `bill/{id}/overview` 404s on public-booking (it's a
   proxy-era path); the applyCode/removeCode responses carry the overview inline, which
   is what the kiosk should read.

## 5. Open decisions — owner

1. **Sale channels for v1**: BMI Office/POS only, or also sell vouchers on web/kiosk
   (`voucher/sell` — PR5)?
2. **On-account conversion** still wanted for race vouchers, or is "hold the code, redeem
   any visit" enough? (§2 Part C last block.)
3. **Game zone denominations** — which token amounts get voucher products, and is the $2
   activation fee waived on a voucher-dispensed card?
4. **Coupon entry placement** — categories screen confirmed (this doc's assumption,
   mirroring web)?
5. **Web voucher redemption** (apply a voucher in the web booking flow, not just kiosk) —
   now or later? The applyCode rail is surface-agnostic once PR2 lands.

## 6. Verification plan (when built)

- **PR0:** probe transcript answering §4 Q1–Q5 checked into the script header.
- **PR1:** on a dev kiosk, enter + scan a percent code scoped to attractions → tiles badge,
  cart shows savings, reader charges the discounted total, `discount_redemptions` row lands;
  expired/wrong-day codes show the specific reason; other-center code refused.
- **PR3:** staff-sold BMI voucher → scan at kiosk → race bill shows reduced total from the
  re-read overview → reader charges exactly the remainder → BMI order confirms with the
  voucher attached (`AppliedPromoCodes` verified) → re-scan shows "already used" (or per Q3
  behavior); abandoned session → sweep calls removeCode and the code works again.
- **PR4:** live hardware session — voucher scan → $0 BMI confirm → card dispenses →
  Intercard balance verified via `/verify`; forced load-failure captures the card and the
  reconcile cron recovers forward; stacker-empty hold + staff resume; no double-dispense on
  re-scan after crash (audit ledger blocks).
