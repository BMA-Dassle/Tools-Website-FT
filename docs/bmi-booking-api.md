# BMI Leisure Public Booking API

Documentation compiled from three BMI Confluence pages and live testing (2026-04-01).

## Sources
1. **João Casanova (Aug 2025)** — "Booking API Subscriptions flow" — original endpoints
2. **Angelina Obolonina (Mar 2026)** — "Full Public Booking API Documentation" — extended endpoints (some not deployed)
3. **Updated João doc (Apr 2026)** — latest confirmed working endpoints with `Bmi-Subscription-Key` header

## Authentication

**Auth Endpoint:** `POST https://api.bmileisure.com/auth/{clientKey}/publicbooking`

**Required Headers (ALL requests including auth):**
```
Bmi-Subscription-Key: d0119e685b6d4ba5b7559a13d148c7ec
Content-Type: application/json
Accept-Language: en
```

**Auth Request Body:**
```json
{
  "Username": "headpinzftmyers",
  "Password": "01c87c35-64c1-4de0-ab37-29429b9752ae"
}
```

**Auth Response:**
```json
{
  "TokenType": "bearer",
  "AccessToken": "eyJhbG...",
  "ExpiresIn": "86400",
  "IncludedClientKeys": ["headpinzftmyers", "headpinznaples", "bowlandb", "bowlandpc"]
}
```

After auth, include on all subsequent requests:
```
Authorization: Bearer {AccessToken}
Bmi-Subscription-Key: d0119e685b6d4ba5b7559a13d148c7ec
```

## Path Prefix

> **IMPORTANT:** Angelina's doc says `/api/{clientKey}/...` — this does NOT work (all 404).
> The working prefix is `/public-booking/{clientKey}/...`

**Base URL:** `https://api.bmileisure.com/public-booking/{clientKey}`

## Endpoint Status (tested 2026-04-01)

| # | Endpoint | Method | Path | Source | Status |
|---|----------|--------|------|--------|--------|
| 1 | Locations | GET | `/locations` | All 3 docs | LIVE |
| 2 | Pages by date | GET | `/page?date={iso}` | All 3 docs | LIVE |
| 3 | All products | GET | `/products` | All 3 docs | LIVE (cached 1hr) |
| 4 | Product image | GET | `/image/product?productId={id}` | João + Angelina | LIVE |
| 5 | Available days | GET | `/availability?productId={id}&dateFrom=&dateTill=` | All 3 docs | LIVE |
| 6 | Time slot proposals | POST | `/availability?date={date}` | All 3 docs | LIVE |
| 7 | Book time slot | POST | `/booking/book` | All 3 docs | LIVE |
| 8 | Sell (add to cart) | POST | `/booking/sell` | Angelina + latest João | LIVE |
| 9 | Confirm payment | POST | `/payment/confirm` | All 3 docs | LIVE |
| 10 | Cancel order | DELETE | `/bill/{orderId}/cancel` | Latest João | LIVE |
| 11 | Register contact | POST | `/person/registerContactPerson` | Angelina | LIVE |
| 12 | Page by XRef | GET | `/page/{pageXRef}` | Angelina | untested |
| 13 | Register participant | POST | `/person/registerProjectPerson` | Angelina | untested |
| 14 | Subscriptions | GET | `/subscription/{loginCode}/{pageXRef}` | João original | untested |
| 15 | Save memo | POST | `/booking/memo` | Angelina only | NOT DEPLOYED |
| 16 | Remove item | POST | `/booking/removeItem` | Angelina only | NOT DEPLOYED |
| 17 | Order overview | GET | `/order/{orderId}/overview` | Angelina only | NOT DEPLOYED |
| 18 | Cancel (old path) | DELETE | `/order/{orderId}/cancel` | Angelina only | NOT DEPLOYED |
| 19 | Person lookup | GET | `/person?email={email}` | Angelina only | NOT DEPLOYED |

## Endpoint Details

### 1. Retrieve all locations
`GET /public-booking/{clientKey}/locations`

```json
{
  "locations": [
    { "clientKey": "headpinzftmyers", "name": "Headpinz Ft. Myers" }
  ]
}
```

### 2. Retrieve all pages available on a date
`GET /public-booking/{clientKey}/page?date={date}`

- `date` — ISO 8601, e.g. `2026-04-07T00:00:00.000Z`

Returns array of page objects, each containing products grouped by category.

**Product fields:**
| Field | Type | Description |
|-------|------|-------------|
| id | Long | Product ID |
| name | String | Display name |
| info | String | HTML description |
| hasPicture | Boolean | Has image |
| bookingMode | Int | 0=Individual, 1=PerSlot |
| productGroup | String | Group name (e.g. "Karting") |
| minAmount/maxAmount | Int | Quantity limits (-1=no limit) |
| minAge/maxAge | Short? | Age restrictions |
| resourceKind | String | Resource type |
| kind | Int | ProductKind enum |
| isCombo | Boolean | Package product |
| isMembersOnly | Boolean | Members only |
| prices | Price[] | Pricing info |
| resources | Resource[] | Available resources |
| dynamicGroups | AgeGroup[] | Age group config (null if N/A) |
| xRef | String | External reference |

### 3. Retrieve all bookable products
`GET /public-booking/{clientKey}/products`

Cached for 1 hour. Returns flat array of all products.

### 4. Return image of a product
`GET /public-booking/{clientKey}/image/product?productId={productId}`

Returns binary image data.

### 5. Return available days in a period
`GET /public-booking/{clientKey}/availability?productId={id}&dateFrom={date}&dateTill={date}`

```json
{
  "activities": [
    { "date": "2026-04-07T00:00:00", "status": 0 },
    { "date": "2026-04-08T00:00:00", "status": 1 }
  ]
}
```
- `status` — 0=Available, 1=FullyBooked

### 6. Retrieve time slot proposals
`POST /public-booking/{clientKey}/availability?date={date}`

Request:
```json
{
  "productId": "33415132",
  "pageId": "123",
  "quantity": 1
}
```

Response:
```json
{
  "proposals": [
    {
      "productLineId": null,
      "blocks": [
        {
          "productLineIds": ["789"],
          "block": {
            "name": "Heat 24",
            "showSessionTimes": true,
            "capacity": 10,
            "freeSpots": 10,
            "resourceId": "-1",
            "prices": [...],
            "bookingMode": 0,
            "start": "2026-04-07T15:36:00",
            "stop": "2026-04-07T15:43:00"
          }
        }
      ]
    }
  ]
}
```

### 7. Book a time slot
`POST /public-booking/{clientKey}/booking/book`

Request:
```json
{
  "productId": "103983",
  "pageId": "739282",
  "quantity": 1,
  "resourceId": "19476",
  "proposal": {
    "blocks": [
      {
        "productLineIds": ["789"],
        "block": {
          "name": "Heat 24",
          "start": "2026-04-07T15:36:00",
          "stop": "2026-04-07T15:43:00",
          "capacity": 10,
          "freeSpots": 10,
          "resourceId": "-1"
        }
      }
    ],
    "productLineId": null
  },
  "contactPerson": {
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "+12395551234"
  },
  "orderId": null
}
```

Response:
```json
{
  "schedules": [...],
  "orderId": "63000000007315961",
  "projectId": "63000000007315962",
  "parentBillLineId": "63000000007315965",
  "prices": [...]
}
```

### 8. Add product to cart (sell)
`POST /public-booking/{clientKey}/booking/sell`

Request:
```json
{
  "ProductId": 123,
  "Quantity": 1,
  "OrderId": null,
  "ParentOrderItemId": null,
  "DynamicLines": []
}
```

Response:
```json
{
  "success": true,
  "orderId": 1001,
  "orderItemId": 5001,
  "prices": [...],
  "modifiers": [...],
  "supplements": [...]
}
```

### 9. Confirm external payment
`POST /public-booking/{clientKey}/payment/confirm`

Request:
```json
{
  "id": "pay_abc123",
  "paymentTime": "2026-04-01T00:00:00Z",
  "amount": 49.98,
  "orderId": 1001,
  "extraData": {}
}
```

Response:
```json
{
  "status": 0,
  "reservationNumber": "RES-2026-001",
  "reservationCode": "rABC123",
  "orderId": "1001"
}
```
- `status` — 0=Confirmed, 1=Cancelled, 2=Failed, 3=Uncertain, 5=Pending

### 10. Cancel order
`DELETE /public-booking/{clientKey}/bill/{orderId}/cancel`

> Note: Angelina doc says `/order/{orderId}/cancel` but that returns 404.
> The working path is `/bill/{orderId}/cancel` per latest João doc.

### 11. Register a contact person
`POST /public-booking/{clientKey}/person/registerContactPerson`

Request:
```json
{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@example.com",
  "phone": "+12395551234",
  "orderId": 1001
}
```

## Enums

### ProductKind
| Value | Name | Description |
|-------|------|-------------|
| 1 | Normal | Standard product |
| 2 | Entry | Entry/admission |
| 3 | Membership | Membership |
| 4 | Voucher | Voucher |
| 5 | GiftCard | Gift card |
| 6 | Dynamic | Combo with age groups |
| 7 | Combo | Combo/package |
| 8 | ServiceCharge | Service charge |

### BookingMode
| Value | Name |
|-------|------|
| 0 | Individual (per person) |
| 1 | PerSlot (per session) |

### AvailabilityStatus
| Value | Name |
|-------|------|
| 0 | Available |
| 1 | FullyBooked |

### PaymentStatus
| Value | Name |
|-------|------|
| 0 | Confirmed |
| 1 | Cancelled |
| 2 | Failed |
| 3 | Uncertain |
| 4 | BillNotFound |
| 5 | Pending |
| 6 | PaymentNotFound |
| 7 | Voided |
| 8 | DepositsNotProcessed |

### DepositKind
| Value | Name |
|-------|------|
| 0 | Money |
| 1 | Point |
| 2 | Credit |

### BillLineKind
| Value | Name |
|-------|------|
| 0 | Normal |
| 1 | Supplement |
| 2 | Modifier |

## Typical Booking Flow
```
1. Authenticate           → POST /auth/{clientKey}/publicbooking
2. Get products           → GET  /public-booking/{clientKey}/products
3. Check available days   → GET  /public-booking/{clientKey}/availability?productId=...
4. Get time slots         → POST /public-booking/{clientKey}/availability?date=...
5. Book with time slot    → POST /public-booking/{clientKey}/booking/book
6. Review order           → GET  /public-booking/{clientKey}/order/{orderId}/overview  (NOT YET DEPLOYED)
7. Confirm payment        → POST /public-booking/{clientKey}/payment/confirm
```

## Notes
- All date/time values use ISO 8601 format
- Response fields are camelCase (not PascalCase as some Confluence docs show)
- CORS is enabled for all origins
- Token actually expires in 86400s (24hr) despite docs saying 3600s
- The old SMS-Timing API at `booking-api22.sms-timing.com` still works and is what the current site uses
- BMI confirmed (2026-04-01) that some Angelina-doc endpoints are not deployed yet
