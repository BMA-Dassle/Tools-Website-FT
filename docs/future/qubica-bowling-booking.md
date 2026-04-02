# QubicaAMF Bowling Reservation — Custom Frontend Integration Plan

## Overview

Replace mybowlingpassport.com (QubicaAMF's generic booking frontend) with a custom-branded booking experience on headpinz.com. The portal codebase serves as both employee portal AND public website, with URL-based routing per location.

## Architecture

### Current System
- **Frontend**: Vue.js SPA at `www.mybowlingpassport.com` (QubicaAMF hosted)
- **Backend API**: `https://qcloud.qubicaamf.com/bowler/` (QubicaAMF cloud REST API)
- **Payments**: Square Checkout (API returns `square.link` redirect URL)
- **Customer Auth**: Azure AD B2C at `bowlingpassport.b2clogin.com` (optional — guest checkout works without)

### Proposed System
- **Frontend**: React (Vite + Tailwind + shadcn) — full-page booking wizard
- **Backend Proxy**: Vercel serverless endpoints at `/api/booking/*`
- **Payments**: Same Square Checkout flow (redirect + poll)
- **Multi-location**: URL-based routing, center ID parameterized

## API Authentication

- **Required header**: `Ocp-Apim-Subscription-Key: 93108f56-0825-4030-b85f-bc6a69fa502c`
- Without key → 401 Unauthorized
- With key → works from any origin (server-side)
- Key source: `https://www.mybowlingpassport.com/context.json`
- Must be kept server-side (proxy pattern)

## Center IDs

| Location | Center ID | Company ID |
|----------|-----------|------------|
| HeadPinz Fort Myers | 9172 | 2 |
| _(others TBD — check QubicaAMF admin)_ | | |

## Complete API Reference

All endpoints are under `https://qcloud.qubicaamf.com/bowler/`

### 1. Configuration (cacheable, rarely changes)

#### GET /centers/{centerId}/summary
```json
{"Id":9172,"Name":"HeadPinz Fort Myers","Channel":"Stable","DayChangeTime":"06:00:00","CompanyId":2}
```

#### GET /centers/{centerId}/functionalities
Feature flags. Key ones:
- `WebReservations.Enabled: true`
- `GuestReservations.Enabled: true`
- `ManageFoodAndBeverageModifiers.Enabled: true`

#### GET /centers/{centerId}/ReservationOptions
```json
{"BufferTime":10,"MaxPlayersNumberForLane":6,"MaxLanesNumberForReservation":4,"AvailabilityCheckInterval":5}
```

#### GET /centers/{centerId}/player-types
```json
{"MaxPlayers":24,"Types":[{"Id":1,"Name":"Bowlers","Description":"","Active":true}]}
```
Note: Type ID 1 ("Bowlers") is the only active type for guest bookings.

#### GET /centers/{centerId}/main-currency
```json
{"CurrencyID":"USD","Symbol":"$","DecDigits":2,"ThousandSep":",","DecimalSep":".","SymbolBeforeValue":true}
```

#### GET /centers/{centerId}/commonparts
```json
{"LogoUrl":"https://resourcespubqamfuse.blob.core.windows.net/company-2/FileSystem/Files/000138c5-....png","FooterCopy":"<p>© HeadPinz Fort Myers</p>"}
```

#### GET /companies/{companyId}/themes/{centerId}/website/font-colors/current
Theme colors and font. Returns header/footer/button color scheme.

#### GET /centers/{centerId}/Terms
Terms & Conditions, Cancellation Policy URLs.

#### GET /centers/{centerId}/MaintenanceMode
Returns `false` (boolean) when operational.

### 2. Availability

#### GET /centers/{centerId}/opening-times/bookforlater/range?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD
Returns 3-month window of open dates with booking hours.
```json
{"TimeZone":null,"Dates":[
  {"Date":"2026-04-02","IsOpen":true,"StartBookingTime":"2026-04-02T13:15:00","EndBookingTime":"2026-04-03T00:00:00"},
  {"Date":"2026-04-03","IsOpen":true,"StartBookingTime":"2026-04-03T11:00:00","EndBookingTime":"2026-04-04T02:00:00"}
]}
```

#### GET /centers/{centerId}/offers-availability?systemId={centerId}&datetime=YYYY-MM-DDTHH:mm&players=MIN-MAX&page=1&itemsPerPage=50
Returns available offers with pricing and lane availability.
```json
[{
  "OfferId": 90,
  "Name": "Open Bowling - Regular Day",
  "Description": "<p>Monday through Friday before 6pm...</p>",
  "ImageUrl": "https://resourcespubqamfuse.blob.core.windows.net/...",
  "Items": [{
    "ItemId": 715,
    "Quantity": 90,        // minutes
    "QuantityType": "Minutes",
    "Lanes": 1,
    "Total": 36,           // price in dollars
    "Remaining": 0,        // lanes available (0 = sold out at this time)
    "Time": "21:00",
    "Alternatives": [{"DateTime":"2026-04-03T17:45","Time":"17:45","Total":36,"Remaining":15}],
    "Reason": "TimeTooLate"
  }]
}]
```
**Offers seen for HPFM:**
- OfferId 90: "Open Bowling - Regular Day" (Mon-Fri before 6pm)
- OfferId 93: "Time Bowling Night & Weekends - Regular"
- OfferId 95: "Time Bowling Night & Weekends - VIP"
- OfferId 100: "Old Time Lanes - Nights & Weekends" (18+ only)

**Item duration options**: 90 min, 120 min, 150 min per offer.

### 3. Reservation Lifecycle

#### POST /centers/{centerId}/reservations/temporary-request/book-for-later
Creates a temporary reservation (10-minute lifetime).
**Request:**
```json
{"DateFrom":"2026-04-03T17:45","WebOfferId":90,"WebOfferTariffId":715,"PlayersList":[{"TypeId":1,"Number":3}]}
```
**Response:**
```json
{
  "ReservationKey": "W144333",
  "Status": "New",
  "LifetimeMinutes": 10,
  "BowlingQty": 90,
  "ReservationItems": [{
    "ItemGuid": "5db84298-...",
    "ResourceClass": "Bowling",
    "ResourceId": 14,
    "StartTime": "2026-04-03T17:45:00-04:00",
    "EndTime": "2026-04-03T19:15:00-04:00",
    "TotalPlayers": 3
  }]
}
```
**CRITICAL**: Reservation expires in 10 minutes. Must send keepalive heartbeats.

#### PATCH /centers/{centerId}/reservations/{reservationKey}/lifetime
Keepalive heartbeat — call every ~30 seconds.
**Response:**
```json
{"ReservationKey":"W144333","LifetimeMinutes":10,"ApprovePayment":null}
```

### 4. Add-ons

#### GET /centers/{centerId}/weboffers/{offerId}/options
```json
{"CanSetShoes":true,"CanSetBumpers":true,"IsShoesEnabled":true,"ShowGamesAndExtraPage":true,"ShowFoodAndBeveragePage":true}
```

#### GET /centers/{centerId}/offers/{offerId}/shoes-socks-offer?systemId={centerId}&datetime=YYYY-MM-DDTHH:mm&offerId={offerId}&page=1&itemsPerPage=50
```json
{"Shoes":[{"Name":"Bowling Shoes","Description":"Required if you don't have your own.","Price":4.75,"PriceKeyId":12787,"PlayerTypeId":1}],"Socks":[]}
```

#### GET /centers/{centerId}/offers/extras?systemId={centerId}&datetime=YYYY-MM-DDTHH:mm&offerId={offerId}&page=1&itemsPerPage=50
Returns add-on activities and tokens. Example items:
- Nexus Laser Tag ($10/person, ID 13678)
- Nexus Gel Blaster ($12/person, ID 13751)
- 300 Tokens + 30 Bonus ($30, ID 13173)
- 500 Tokens + 100 Bonus ($50, ID 13174)
- 1000 Tokens + 250 Bonus ($100, ID 13175)

#### GET /centers/{centerId}/opening-times/foodandbeverage/at?dateTime=YYYY-MM-DDTHH:mm
```json
{"FoodAndBeverageAllowedAtSelectedTime":true,"TodayOpeningTime":{"Date":"2026-04-03","IsOpen":true,"StartFoodAndBeverageTime":"2026-04-03T11:00:00","EndFoodAndBeverageTime":"2026-04-04T00:30:00"}}
```

#### GET /centers/{centerId}/offers/{offerId}/food-beverage-categories?systemId={centerId}&datetime=YYYY-MM-DDTHH:mm&offerId={offerId}&page=1&itemsPerPage=50
```json
[{"CategoryId":10,"CategoryName":"Beverages"},{"CategoryId":12,"CategoryName":"Shareables"},{"CategoryId":13,"CategoryName":"Handhelds"},{"CategoryId":15,"CategoryName":"Pizza"},{"CategoryId":16,"CategoryName":"Salads"},{"CategoryId":17,"CategoryName":"Wings"},{"CategoryId":20,"CategoryName":"Kid's Menu"},{"CategoryId":21,"CategoryName":"Desserts"},{"CategoryId":22,"CategoryName":"Sides and Fries"}]
```

#### GET /centers/{centerId}/offers/food-beverage?systemId={centerId}&datetime=YYYY-MM-DDTHH:mm&categoryId={categoryId}&page=1&itemsPerPage=50
Returns food items for a category with images, prices, descriptions.

#### GET /centers/{centerId}/Items/{itemId}/Modifiers
Returns modifier groups (sides, customizations) for a food item.
```json
{
  "Name": "BBQ Pulled Pork Sandwich",
  "ModifiersGroups": [{
    "Name": "~Sides",
    "IdModifierGroup": 725,
    "Rules": {"MinQuantity":1,"MaxQuantity":1},
    "Modifiers": [
      {"Name":"Cut Fries","IdOriginal":5191,"Price":0.00},
      {"Name":"Waffle Fries","IdOriginal":5192,"Price":0.00},
      {"Name":"Onion Rings","IdOriginal":5657,"Price":2.00}
    ]
  }]
}
```

### 5. Checkout & Payment

#### POST /centers/{centerId}/reservations/{reservationKey}/guest/confirm
Submit the full order with guest details and cart.
**Request:**
```json
{
  "GuestDetails": {
    "Email": "customer@email.com",
    "PhoneNumber": "2395551234",
    "ReferentName": "John"
  },
  "Cart": {
    "ReturnUrl": "https://payments.mybowlingpassport.com",
    "Items": [
      {"Name":"Open Bowling - Regular Day","Type":"WebOffer","PriceKeyId":90,"Quantity":1,"UnitPrice":36},
      {"Name":"Bowling Shoes","Type":"ShoesSocks","PriceKeyId":12787,"Quantity":2,"UnitPrice":4.75},
      {"Name":"Nexus Gel Blaster - Per Person","Type":"Extras","PriceKeyId":13751,"Quantity":2,"UnitPrice":12},
      {"Name":"BBQ Pulled Pork Sandwich","Type":"FoodBeverage","PriceKeyId":12486,"Quantity":1,"UnitPrice":13,"Modifiers":[{"OriginalId":5193,"Name":"Chips & Salsa"}]}
    ],
    "Summary": {
      "AddedTaxes": 5.36,
      "Deposit": 90.85,
      "Fee": 2.99,
      "Total": 90.85,
      "TotalItems": 82.5,
      "AutoGratuity": 0,
      "TotalWithoutTaxes": 85.49
    }
  }
}
```
**Response:**
```json
{
  "NeedPayment": true,
  "ApprovePayment": {
    "Url": "https://square.link/u/TVinbHOq",
    "MobileUrl": null,
    "Method": "GET",
    "Data": {"OperationId": "WP59743-9172"}
  },
  "OperationId": "WP59743-9172"
}
```
**Payment flow**: Redirect customer to `ApprovePayment.Url` (Square Checkout). After payment, Square redirects back to `ReturnUrl` with `transactionId` and `orderId` query params.

**Cart Item Types**: `WebOffer`, `ShoesSocks`, `Extras`, `FoodBeverage`

#### GET /centers/{centerId}/reservations/{reservationKey}/status/{operationId}
Poll payment status (call every 2-3 seconds after redirect back).
```json
{"OperationId":"WP59743-9172","PaymentStatus":"COMPLETED","ReservationId":"W144333","ReservationStatus":"CONFIRMED"}
```
Payment statuses: `ONGOING` → `COMPLETED` or `FAILED`

#### PUT /centers/{centerId}/reservations/{reservationKey}/payment-confirm
Confirm payment with Square transaction details.
**Request:**
```json
{"QueryParams":{"transactionId":"jZ8fq28KTfFoKDsAuVDVbxvigTfZY","orderId":"jZ8fq28KTfFoKDsAuVDVbxvigTfZY"}}
```

### 6. Post-Payment

#### PATCH /centers/{centerId}/reservations/{reservationKey}/players
Update player names, shoe sizes, bumper preferences.
**Request:**
```json
{
  "Players": [
    {"Name":"John","ShoeSize":"M- 9.5","WantBumpers":true,"Size":{"Id":4,"Name":"M- 9.5","CategoryId":1,"Position":4}},
    {"Name":null,"ShoeSize":null,"WantBumpers":false,"Size":null},
    {"Name":null,"ShoeSize":null,"WantBumpers":false,"Size":null}
  ]
}
```

#### PATCH /centers/{centerId}/reservations/{reservationKey}/SetEndFlow
Mark the booking flow as complete. Call after player details are submitted.

## Booking Flow (Step by Step)

1. **Load config** → `/centers/9172/summary`, `ReservationOptions`, `player-types`, `main-currency`
2. **Pick date** → `/opening-times/bookforlater/range` (3-month calendar)
3. **Pick time + players** → `/offers-availability` (shows offers, prices, lane counts)
4. **Select offer** → `POST /reservations/temporary-request/book-for-later` (creates temp reservation)
5. **Start heartbeat** → `PATCH /reservations/{key}/lifetime` every 30s
6. **Shoes** → `/offers/{offerId}/shoes-socks-offer`
7. **Extras** → `/offers/extras` (laser tag, tokens, etc.)
8. **Food & Beverage** → `/food-beverage-categories` → `/food-beverage` → `/Items/{id}/Modifiers`
9. **Review** → Show order summary, collect guest email/phone/name
10. **Confirm** → `POST /reservations/{key}/guest/confirm` → get Square payment URL
11. **Pay** → Redirect to `square.link` → customer pays → redirect back
12. **Poll** → `GET /reservations/{key}/status/{operationId}` until COMPLETED
13. **Confirm payment** → `PUT /reservations/{key}/payment-confirm`
14. **Player details** → `PATCH /reservations/{key}/players` (names, shoe sizes, bumpers)
15. **End** → `PATCH /reservations/{key}/SetEndFlow`

## Risks & Notes

1. **ReturnUrl** — The confirm request sends `ReturnUrl` field. QubicaAMF may validate this server-side. Need to test with a custom domain.
2. **Subscription key** — Currently using the one from mybowlingpassport.com's context.json. Should request own key from QubicaAMF.
3. **Vendor TOS** — Confirm QubicaAMF allows third-party frontends.
4. **Reservation TTL** — 10-minute lifetime. Frontend must heartbeat every ~30s or reservation dies.
5. **Returning customers** — B2C auth flow uses QubicaAMF's Azure AD B2C tenant. Guest-only flow is simpler.
6. **context.json config**: `cloudBackendUrl: "https://qcloud.qubicaamf.com/bowler"`, `apiSubscriptionKey: "93108f56-0825-4030-b85f-bc6a69fa502c"`
