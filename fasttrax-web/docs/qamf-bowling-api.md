# QAMF Bowler API — Categories & Modifiers

Derived from `Pizza Bowl.har` (Apr 19 2026, center 9172 / HeadPinz Fort Myers, offer 103 "Pizza Bowl Sunday — VIP").

All endpoints are under `https://{tenant}/bowler/centers/{centerId}` and go through our `/api/qamf` proxy.

## 1. Pick a package

```
GET /offers-availability?systemId={centerId}&datetime=YYYY-MM-DDTHH:MM&players=N-M&page=1&itemsPerPage=50
```
Returns `[{ OfferId, Name, Description, ImageUrl, Items: [{ ItemId, Quantity, QuantityType, Lanes, Total, Remaining, Time }] }]`.

Example offers seen: `103 Pizza Bowl Sunday - VIP`, `124 Pizza Bowl Sunday - Old Time`, `11 Pizza Bowl Sunday - Regular`, `93 Time Bowling Night & Weekends`.

## 2. Confirm the package supports F&B

```
GET /weboffers/{offerId}/options
```
Returns `{ ShowFoodAndBeveragePage, ShowGamesAndExtraPage, CanSetShoes, CanSetBumpers, IsShoesEnabled, ... }`. Use `ShowFoodAndBeveragePage` to decide whether to render the F&B tab.

## 3. F&B opening hours at selected time

```
GET /opening-times/foodandbeverage/at?dateTime=YYYY-MM-DDTHH:MM
```
`{ FoodAndBeverageAllowedAtSelectedTime: true, TodayOpeningTime: { StartFoodAndBeverageTime, EndFoodAndBeverageTime } }`. Gate the tab on the boolean.

## 4. Non-F&B extras (Gel Blaster, Laser Tag, Tokens, Shuffly)

```
GET /offers/extras?systemId=X&datetime=Y&offerId=Z&page=1&itemsPerPage=50
```
Items have `ItemType: "FoodAndBeverage"` (misleading — they're attractions priced out of the QAMF cart) with fields `{ Id, Name, Description, Price, ImageUrl }`. Already used by `BMI_ADDONS_BY_CENTER` in `app/hp/book/bowling/page.tsx`.

## 5. F&B items by category

```
GET /offers/food-beverage?systemId=X&datetime=Y&categoryId=N&page=1&itemsPerPage=50
```
Items have `{ ItemId, Name, Description, Price?, ItemType, ImageUrl }`. Price is omitted for complimentary / package-included items.

Categories observed at FM (9172):

| categoryId | Contents | Notes |
|---|---|---|
| **3** | VIP Chips & Salsa (Id 13186) | Complimentary for VIP packages |
| **36** | Pizza Bowl Pizza (13036), Pizza Bowl Soda Pitcher (13037) | Included in any Pizza Bowl package |
| 10 | Drinks — Soda Pitcher, Bottle Water, Pitcher of Water | Paid extras |
| 12 | Appetizers (Nachos, Pretzels, Quesadilla, Tenders, Pot Stickers…) | Paid |
| 13 | Sandwiches / wraps | Paid |
| 15 | Pizzas (Personal Cheese, Meat Lovers, Supreme, Veggie, Regular, Gluten-Free) | Paid |
| 16 | Salads | Paid |
| 17 | Wings | Paid |
| 21 | Desserts | Paid |
| 20, 22 | (empty for this date) | — |

The "complimentary / included" categories (3, 36) are conceptually distinct from the paid menu (10–22) but come from the same endpoint — the client splits them.

## 6. Modifier groups for an item

```
GET /Items/{itemId}/Modifiers
```
Returns:
```json
{
  "Name": "Pizza Bowl Pizza",
  "ModifiersGroups": [
    {
      "Name": "Pizza Toppings Extra",
      "IdModifierGroup": 699,
      "Rules": { "MinQuantity": 0, "MaxQuantity": null },
      "Modifiers": [
        { "Name": "Extra Cheese", "IdOriginal": 5065, "Price": 2.00 },
        { "Name": "Pepperoni",     "IdOriginal": 5066, "Price": 2.00 },
        …
      ]
    },
    {
      "Name": "One included Topping",
      "IdModifierGroup": 768,
      "Rules": { "MinQuantity": 0, "MaxQuantity": 1 },
      "Modifiers": [
        { "Name": "No Topping",     "IdOriginal": 5487, "Price": 0.00 },
        { "Name": "Extra Cheese",   "IdOriginal": 5488, "Price": 0.00 },
        …
      ]
    }
  ]
}
```
- `Rules.MaxQuantity === 1` → radio / single-select
- `Rules.MaxQuantity === null` → multi-select with per-modifier quantity (or free-count checkboxes)
- `MinQuantity` drives "required" validation

Pizza Bowl Soda Pitcher (13037) has a single group "Soda Choice" with `MaxQuantity: 1` — a flavor radio (Pepsi / Diet / Mt. Dew / Dr. Pepper / Starry / Root Beer / Lemonade / Sweet Iced Tea / Unsweet Iced Tea / Ginger Ale / No beverage).

## 7. Cart summary (what we send back)

```
POST /Cart/CreateSummary
{
  "Time": "2026-04-19T22:00",
  "Items": {
    "Extra": [],
    "FoodAndBeverage": [
      {
        "PriceKeyId": 13036,            // Pizza Bowl Pizza
        "Quantity": 1,
        "UnitPrice": 2,                 // sum of chargeable modifier prices (Pepperoni +$2)
        "Note": "",
        "Modifiers": [
          { "OriginalId": 5066 },       // ⚠ field is OriginalId, NOT IdOriginal
          { "OriginalId": 5494 }
        ]
      },
      {
        "PriceKeyId": 13037,            // Pizza Bowl Soda Pitcher
        "Quantity": 1,
        "UnitPrice": 0,
        "Note": "",
        "Modifiers": [{ "OriginalId": 5084 }]
      }
    ],
    "ShoesSocks": [],
    "WebOffer": { "Id": 11, "UnitPrice": 64.95, "WebOfferTariffId": 64 }
  },
  "Players": [{ "TypeId": 1, "Number": 1 }]
}
```

**Quirk**: the Items/Modifiers GET returns `IdOriginal`, but CreateSummary + guest/confirm POST expect **`OriginalId`** (reversed). The F&B line item's `UnitPrice` is the sum of all chargeable modifier prices for that item (not the item's own base price — Pizza Bowl items themselves are free).

### 7b. Guest confirm (finalize)

```
POST /reservations/{ReservationKey}/guest/confirm
{
  "GuestDetails": { "Email", "PhoneNumber", "ReferentName" },
  "Cart": {
    "ReturnUrl": "...",
    "Items": [
      { "Name": "Pizza Bowl Sunday - Regular", "Type": "WebOffer", "PriceKeyId": 11, "Quantity": 1, "UnitPrice": 64.95 },
      {
        "Name": "Pizza Bowl Pizza",
        "Type": "FoodBeverage",             // ⚠ "FoodBeverage" (no "And"), unlike CreateSummary's "FoodAndBeverage" key
        "PriceKeyId": 13036,
        "Quantity": 1,
        "UnitPrice": 2,
        "Modifiers": [
          { "OriginalId": 5066, "Name": "Pepperoni" },  // guest/confirm modifiers have Name too
          { "OriginalId": 5494, "Name": "Peppers" }
        ]
      }
    ],
    "Summary": { "AddedTaxes", "Deposit", "Fee", "Total", "TotalItems", "AutoGratuity", "TotalWithoutTaxes" }
  }
}
```

## 8. Reservation lifecycle

- `GET /ReservationOptions` — fetches allowed reservation types
- `POST /reservations/temporary-request/book-for-later` — creates 10-min temp hold, returns `ReservationKey` (e.g. `W146090`)
- `PATCH /reservations/{key}/lifetime` — extends the 10-min TTL on activity

## 9. Relevance to FastTrax / HeadPinz code

Current `app/hp/book/bowling/page.tsx` already uses endpoints 1, 2, 4, and 7. It auto-injects VIP Chips & Salsa in `goToReview()` but does not hit categories 36 (Pizza Bowl items) or `/Items/{id}/Modifiers`. The refactor to surface Pizza Bowl pizza + soda pitcher with modifier pickers and move the Chips & Salsa into a visible F&B tab will add endpoints 3, 5, 6 to our flow.
