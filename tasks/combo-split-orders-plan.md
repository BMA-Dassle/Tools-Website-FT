# Combo split day-of orders — revenue to the right entity

**Owner ask (2026-06-13):** the Ultimate VIP combo's revenue belongs to TWO
Square locations (FastTrax FM racing + HeadPinz FM bowling), but today it books
ONE day-of order at HeadPinz FM. Split it into **two day-of orders, one deposit,
one shared gift card.** Build VIP now; design it generic so cross-center
attractions can reuse it.

## Enabling fact (verified)
ONE Square seller account, ONE `SQUARE_ACCESS_TOKEN`, three LOCATIONS
(`FASTTRAX_FM` LAB52…, `HEADPINZ_FM` TXBS…, `HEADPINZ_NAP`). A Square gift card
belongs to the SELLER, so one card can fund orders at both locations. ✓

## Locked revenue split — Model A, itemized (owner-approved)
Flat combo price per person: **$65 Mon–Thu / $75 Fri–Sun**. Every component is
its own day-of line on the correct location's order, using the REAL Square
catalog variation + a `base_price_money` override.

**FastTrax FM order — racing** (flat across day tiers):
| Line | $/person | Catalog variation |
|---|---|---|
| Starter Race | 17.00 | `X4RZPTPJEJ45OG3S3HMDMCHZ` (Ultimate Qualifier) |
| Intermediate Race | 17.00 | `X4RZPTPJEJ45OG3S3HMDMCHZ` |
| POV Video | 5.00 | `6BJ7HF2VGITYIA3FRS4RK2AV` (ViewPoint Cameras) |
| FastTrax License | 4.99 | `7GUST7MZ25TOBOB4UXPDYPV4` (new racers only) |

**HeadPinz FM order — VIP bowling** (weekend uplift rides here):
| Line | Mon–Thu | Fri–Sun | Catalog variation |
|---|---|---|---|
| VIP Bowling | 16.01 | 26.01 | `R66TY2VTICYUH4NM3F4UQVLF` |
| Shoes | 5.00 | 5.00 | `BVJ2ZSW6N4FPSPSPSB4IN7LA` |

Per-person sum: **65.00 / 75.00** ✓. Tax 6.5% per order (Lee County, both).

**Returning racer (no license):** the $4.99 rolls onto the racing-side (Starter
Race line) so FastTrax keeps all racing revenue and the sum still hits 65/75.

**VIP Bowling is allocated PER PERSON** (not per lane) — that's what lets a flat
per-person price balance; it books under the per-lane VIP catalog item. At a real
group (4 ppl / 1 lane) HeadPinz books within ~$3.46 of the true lane+shoes value
on weekday; weekend runs ~$21 over (the full $10/person uplift on bowling vs a
$15/lane real premium) — owner accepted.

## Money rail
- **Two day-of orders:** racing → FASTTRAX_FM, bowling → HEADPINZ_FM, each with
  its own location-sales-tax (ORDER scope) and the itemized catalog lines above.
- **ONE deposit** = sum of BOTH orders' tax-inclusive totals (100% upfront), one
  `createDepositAndCharge`.
- **ONE gift card** loaded with that full sum (shared).
- **Settlement:** FastTrax race-dayof-pay charges the GC for the RACING order;
  HeadPinz lane-open charges the GC for the BOWLING order. Sum of the two
  settlements = GC balance → $0. (The race-dayof NOT EXISTS bowling guard now
  passes for the combo because the two orders have DIFFERENT ids — the racing
  order has no bowling row sharing it, so race-dayof settles it; lane-open owns
  the bowling order.)

## Persistence
A combo writes TWO Neon `bowling_reservations` rows that SHARE the gift card:
- `product_kind='race'` → FastTrax racing `square_dayof_order_id`
- `product_kind='open'` → HeadPinz bowling `square_dayof_order_id` + qamf id
Both carry the same `square_gift_card_id` / `square_gift_card_gan`.

## Generic design
`ComboSpecial.revenueSplit: ComboRevenueLine[]` — each line declares
`{ key, label, entity, catalogObjectId, weekdayCents, weekendCents, appliesTo,
reallocateTo? }`. `comboOrderGroups(session)` groups lines by entity → one Square
order per entity. A future cross-center attraction combo is a data change.

## Build status
- [x] Catalog ids (POV / VIP bowling / shoe) in square-catalog-map
- [ ] revenueSplit registry config + race-bowl entry
- [ ] comboOrderGroups builder + unit tests (sums, routing, new/returning, tiers)
- [ ] comboChargeLines → itemized; CheckoutStep review itemization (display==charge)
- [ ] unified-reserve: two orders, one deposit, one shared GC, dual persistence
- [ ] Preview + owner sign-off → then main (live revenue change; NOT direct)

## Open / deferred
- Confirmation-page receipt currently resolves ONE order per bill; with two
  orders it shows the racing order's receipt. Acceptable for the preview; revisit
  if ops wants both receipts on the confirmation page.
- Weekend uplift currently 100% on bowling (owner may later split it).
