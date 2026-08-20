# Vouchers: attraction items + Groupon redemption

Grounding: `groupon.har` (owner-captured 2026-07-30, merchant.groupon.com console,
HeadPinz Entertainment Center merchant `7e6e5a3d-590d-8bfa-1919-904b7fe123eb`).
Everything below about Groupon's API is READ OFF THAT CAPTURE, not inferred.

The deal in the capture is exactly the mixed case the owner is describing:
**"$25 Worth of Arcade Game Play and Four Laser Tag Entries"** — game card value
AND attraction entries on one voucher.

## 1. Groupon's flow, from the capture

It already splits validate/redeem the way the owner asked for.

**Validate — non-destructive, by the code the guest presents:**
```
GET /umapi/v2/merchant_vouchers?locale=en_US&page=1&per_page=10&redemption_code=1908737
```
Returns everything needed to decide:
| field | captured value | use |
| --- | --- | --- |
| `uuid` | `20e96d03-…efe0` | required to redeem later |
| `details.publicRedemptionCode` | `{code:"1908737", format:"ean-13"}` | the barcode the guest shows |
| `details.grouponCode` | `VS-S1LB-XKSV-6N94-B4ZN` | the printed/emailed code |
| `details.merchantRedeemable` | `{redeemed:false, refunded:false, paymentCancelled:false, reserved:false, unfulfilled:false, isRedeemable:true}` | **the validity gate** |
| `details.redemption.status` | `redeemable` | ditto |
| `details.expiresAt` | `2026-11-27T04:59:59Z` | expiry |
| `deal.id` | `32c081cd-…f890` | **maps to what we grant** |
| `deal.inventoryProduct.priceSummary` | value `$65.00`, price `$30.60` | reporting |
| `features` | `{supportsRedemption:true, supportsOverspend:true}` | capability |

**Redeem — destructive, at the END of the order:**
```
POST /umapi/v2/merchant_vouchers/vouchers/{uuid}/redemption?locale=en_US
{"totalBill":0,"totalTip":0,"currencyCode":"USD","sourceType":"merchant-web"}
→ 201, empty body
```

`POST /merchants/{id}/vouchers/search {"query":"1908737"}` also exists but
returned `{"vouchers":[]}` for the same code — the `merchant_vouchers` GET is
the one that works. Don't use search.

## 2. ~~BLOCKER: the captured auth is not usable server-to-server~~ — RETIRED 2026-08-18

> **RETIRED.** Approach **A** landed: Groupon issued real partner credentials and
> the POS redemption rail is PROVEN end-to-end in staging (two vouchers redeemed
> 2026-08-18). The console API described below is no longer the path — see
> [groupon-qr-redemption-plan.md](groupon-qr-redemption-plan.md) and memory
> `reference_groupon_partner_offer_api` for the real contract. Everything after
> this banner is kept only as the historical record of the console capture.

```
POST /umapi/v2/merchant_oauth/mobile/recaptcha/access_token
{"email":…, "password":…, "reCaptchaToken":"0cAFcWeA4tMGf71bi8JOqVaG…"}
→ {"action":"","token":"…","user":{"id":…}}
```

It is **reCAPTCHA-gated**, and the subsequent API calls carry no
`Authorization` header — they ride the console's browser session
(`x-skip-encore-auth`, `x-domain`, session cookie). This is Groupon's internal
merchant-console API, not a partner integration surface.

A server cannot mint a reCAPTCHA token. So we cannot legitimately automate this
as captured. Three ways forward:

| | Approach | Verdict |
| --- | --- | --- |
| A | Groupon **partner/POS Redemption API** credentials (how POS vendors redeem Groupons) | **Right answer.** Business ask to Groupon, not a code change. Concepts map 1:1 to the capture, so the adapter below is built either way. |
| B | Store a console session token and refresh it by hand | Fragile (expires), and scripting a partner's console API against its captcha is a ToS question. Not for a money path. |
| C | **Staff-assisted redeem**: we validate/track, a human does the final POST in the console | Deliverable now, honest, nothing silently lost. |

**Recommendation: build the adapter now, back it with C, swap to A when Groupon
issues credentials.** The adapter boundary means that swap is configuration, not
a rewrite.

## 3. Design

Groupon slots into the voucher model already on main — a voucher is a LIST of
independently-claimed items — by adding a third issuer.

- `voucher_claims.issuer` becomes `'bmi' | 'native' | 'groupon'`. Per-item single
  use already works, which is what a mixed Groupon needs: the arcade leg is
  spent at the kiosk, the laser legs ride the cart, and an abandoned booking
  leaves the laser legs live.
- **`deal.id` → items[], mapped explicitly in our own table.** NEVER parse
  `merchandisingProduct.title`. "$25 Worth of Arcade Game Play and Four Laser
  Tag Entries" is marketing copy, and inferring value from vendor prose is the
  exact mistake the BMI comp-name path already taught us. One row per deal:
  `{dealId, items:[{kind:'gamezone', bonusTokens:N}, {kind:'attraction', slug:'laser-tag', qty:4}]}`.
- Redemption timing, per the owner: validate at scan, **POST redemption only
  after the order completes**. That ordering is correct (redeeming first would
  burn a guest's Groupon if the order then failed), but it means the external
  call can fail AFTER we've handed over value → a durable
  `groupon_redemptions` queue with retry, never a silent loss. Same
  recover-forward doctrine as the Intercard load.

## 4. Attraction items (the other half — unblocked, independent of Groupon)

Attraction/race items are mintable today but refuse redemption: the existing
cart voucher path applies via BMI `order/applyCode`, which by construction
cannot see a self-issued or Groupon-issued code. Needs a **native cart-coverage
rail**: the booking cart discounts from our own voucher rows, the reserve
verifies coverage against a server-written claim (never the client session), and
the claim is taken at charge time.

This is the piece that makes "game card + attraction" work on one screen:
gamezone items dispense immediately, attraction items ride the cart to
checkout, and the basket CTA splits ("Get my cards & continue").

## 5. Unknowns to settle before coding the Groupon half

1. **Auth** — decision A / B / C above. Blocks everything external.
2. **What does the kiosk scanner actually emit for a Groupon barcode?**
   `format: "ean-13"` means the printed barcode likely scans as 13 digits, which
   would collide with our game-card rule (`^\d{8,}$` → `game-card`). The `VS-…`
   text form is unambiguous; the barcode is not. Needs one live scan at a kiosk,
   same as the 2026-07-27 capture that pinned every other format.
3. **`$25 worth of arcade game play` → how many tokens?** Our packages are
   10¢/token, so 250 — confirm, because this is the grant amount.
4. **`Four Laser Tag Entries`** → which attraction slug/product, and does
   redemption need a booked session or is it walk-up?
5. `supportsOverspend: true` — Groupon expects `totalBill`/`totalTip` on
   redemption (the capture sent 0/0). Do we report the real bill?

## 6. Order of work

1. Native cart-coverage rail (unblocked; makes attraction items real)
2. Groupon adapter + `deal.id → items` map + validate at scan
3. Owed-redemption queue + retry, wired to whichever auth path is chosen
4. Classifier: `VS-…` now, barcode form after the live scan
