# FastTrax Sales API — Integration Guide

**For: HeadPinz Portal developers**
**Date: 2026-05-02**
**API Version: 1.0**

---

## Overview

Read-only HTTP JSON API exposing the FastTrax + HeadPinz **Web Reservations** sales data. Same data the operator-facing dashboard renders at `/admin/{token}/sales`.

**Base URL:** `https://fasttraxent.com`
**OpenAPI spec:** `https://fasttraxent.com/api/admin/sales/openapi.json` (no auth — public for tooling discovery)
**Swagger UI:** `https://fasttraxent.com/admin/{ADMIN_TOKEN}/api-docs` (operator-only — requires admin token in URL)

---

## Authentication

Every request requires an API key in the `x-api-key` header (or `?apiKey=` query param as fallback).

```
GET /api/admin/sales/list?from=2026-04-25&to=2026-05-02
x-api-key: qQ-Fb8bri1BDZgjLoPLsITiZcPl9vJI59aMnwEw_q3E
```

**Rotation:** keys are stored in the `SALES_API_KEYS` env var as a comma-separated list. Multiple keys are supported simultaneously so old keys can be deprecated without breaking integrations. Key rotation is operator-initiated — request a new key from FastTrax ops.

**Failure modes:**
- Missing or wrong key → `404 {"error":"Not found"}` (intentionally indistinguishable from a typo so the route stays unfindable).
- Valid key, malformed query → `500 {"error":"..."}`.
- Valid key, no data → `200` with empty arrays.

---

## Endpoint reference

### `GET /api/admin/sales/list`

Returns aggregated metrics + raw reservation entries for an ET-day range.

**Query parameters**

| Param | Type | Default | Description |
|---|---|---|---|
| `from` | YYYY-MM-DD | today (ET) | Start date inclusive, ET calendar day |
| `to` | YYYY-MM-DD | today (ET) | End date inclusive, ET calendar day |
| `limit` | integer | 1000 | Cap on raw entries returned in `entries[]`. Aggregations always cover the full range. |

**Example response (truncated)**

```json
{
  "range": {
    "from": "2026-04-25",
    "to": "2026-05-02",
    "days": 8
  },
  "totals": {
    "reservations": 194,
    "racers": 297,
    "racingReservations": 165,
    "racingPackReservations": 11,
    "attractionReservations": 11,
    "mixedReservations": 7
  },
  "racing": {
    "reservations": 176,
    "newRacers": 92,
    "returningRacers": 84,
    "expressLane": 77,
    "rookiePack": { "count": 9, "pctOfNew": 9.8, "pctOfRacing": 5.1 },
    "packages": {
      "total": 35,
      "byType": [
        { "id": "ultimate-qualifier-weekend", "label": "Ultimate Qualifier", "count": 19, "pctOfRacing": 10.8 },
        { "id": "rookie-pack-weekend",        "label": "Rookie Pack",        "count": 4,  "pctOfRacing": 2.3 }
      ]
    },
    "pov": {
      "count": 52,
      "qty": 140,
      "attachRate": 29.5,
      "byNewRacer": 45,
      "byReturning": 7,
      "attachRateNewRacer": 48.9,
      "attachRateReturning": 8.3,
      "byTier": [
        { "tier": "starter",      "racingCount": 68, "povCount": 19, "attachRate": 27.9 },
        { "tier": "intermediate", "racingCount": 74, "povCount": 33, "attachRate": 44.6 }
      ]
    },
    "license": { "count": 81 },
    "addOnAttachCount": 8,
    "addOnAttachRate": 4.5,
    "topRaceProducts": [
      { "name": "Pro Race Mega",          "count": 110 },
      { "name": "Starter Race Red",       "count": 96 }
    ]
  },
  "attractions": {
    "reservations": 11,
    "topAddOns": [
      { "name": "Nexus Gel Blaster",     "count": 6 },
      { "name": "Nexus Laser Tag Arena", "count": 5 }
    ]
  },
  "byDay": [
    { "ymd": "2026-04-25", "reservations": 22, "racers": 38 },
    { "ymd": "2026-04-26", "reservations": 35, "racers": 52 }
  ],
  "sms": {
    "totals": {
      "attempts": 5959,
      "ok": 5910,
      "delivered": 5602,
      "bookingConfirm": 257,
      "eTicket": 2010,
      "checkIn": 1828,
      "video": 1822,
      "other": 42
    },
    "byDay": [
      {
        "date": "2026-05-02",
        "attempts": 558,
        "ok": 555,
        "delivered": 516,
        "bySource": {
          "bookingConfirm": 18,
          "eTicket": 184,
          "checkIn": 164,
          "video": 206,
          "other": 4
        }
      }
    ]
  },
  "entries": [
    {
      "ts": "2026-05-02T18:54:49.015Z",
      "billId": "63000000003382314",
      "reservationNumber": "W33846",
      "brand": "fasttrax",
      "location": "fortmyers",
      "bookingType": "racing",
      "participantCount": 1,
      "isNewRacer": true,
      "packageId": "ultimate-qualifier-weekend",
      "povPurchased": true,
      "povQty": 1,
      "licensePurchased": true,
      "expressLane": false,
      "raceProductNames": ["Starter Race Blue", "Intermediate Race Blue"],
      "addOnNames": [],
      "email": "asjleyobert@icloud.com",
      "phone": "9416613469"
    }
  ]
}
```

### `GET /api/admin/sales/openapi.json`

Returns this OpenAPI 3.0 spec. No auth.

---

## Field semantics & gotchas

### Time zones

- **All `from`/`to` query params and `byDay`/`bySource`/`SmsDailyCounts.date` rows are bucketed in `America/New_York` (ET).** Reservations made between midnight UTC and 4 AM ET roll into the *previous* ET calendar day.
- **`entries[].ts` is UTC ISO 8601.** Convert client-side if you need ET display.

### Racer counts

- `participantCount` on each entry = MAX of `line.persons` across distinct karting scheduled lines on the bill, not the count of lines. So an Ultimate Qualifier (Starter + Intermediate, same racer) reads `participantCount = 1`, not 2.
- `totals.racers` is the sum of `participantCount` across all entries in range.

### Package taxonomy

- `packageId` examples: `rookie-pack-mega`, `ultimate-qualifier-weekend`, `ultimate-qualifier-weekend-junior`. Strip the schedule suffix (`-mega` / `-weekday` / `-weekend`) and `-junior` to get the base family.
- `racing.packages.byType` lists each variant; consumers that want family-level rollups should aggregate by stripped suffix.

### `bookingType`

| Value | Meaning |
|---|---|
| `racing` | One or more karting heats |
| `racing-pack` | A 3-race pack purchase (delivery is separate from a single heat) |
| `attractions` | Gel blasters, laser tag, shuffleboard, etc. — no karting |
| `mixed` | Both karting + attractions on the same bill |
| `other` | Doesn't fit the above (gift cards, league signups, etc.) |

### SMS sources

The SMS log buckets every send into one of five categories:

| Category | Source field | Triggered by |
|---|---|---|
| `bookingConfirm` | `booking-confirm` | Booking-confirmation flow at checkout |
| `eTicket` | `pre-race-cron` | Pre-race e-ticket cron (~30 min before each heat) |
| `checkIn` | `checkin-cron` | "Now checking in" alerts when a heat is called |
| `video` | `video-match` | Race-video-ready notifications |
| `other` | `admin-resend`, `level-up`, `other` | Manual resends + future categories |

`attempts` counts every send try; `ok` is provider-accepted (HTTP 2xx); `delivered` is carrier-confirmed handset receipt (DLR webhook). Each is a strict subset of the previous: `delivered ≤ ok ≤ attempts`.

### Caching

The endpoint reads live from Postgres + Redis on every call. **No client-side cache** — fine for dashboard polling at intervals ≥ 30 seconds. If you need higher refresh rates, add a small server-side cache (we can introduce one if it shows up in our logs).

---

## Practical recipes for the portal

### "Today so far" KPI tile

```
GET /api/admin/sales/list
```
Defaults to today (ET). Read `totals.reservations`, `totals.racers`, `racing.expressLane`.

### "Last 7 days" trend chart

```
GET /api/admin/sales/list?from=2026-04-26&to=2026-05-02
```
Use `byDay[]` for the chart series.

### Top race products (last 30 days)

```
GET /api/admin/sales/list?from=2026-04-03&to=2026-05-02&limit=1
```
Read `racing.topRaceProducts[]`. Pass `limit=1` to skip the heavy `entries[]` array if you only need aggregates.

### Daily SMS volume by source

```
GET /api/admin/sales/list?from=2026-04-26&to=2026-05-02
```
Read `sms.byDay[]`. Each entry has `bySource.{bookingConfirm,eTicket,checkIn,video,other}` for stacked-bar rendering.

### Audit a specific reservation

Pass `limit=1000`, then filter `entries[]` client-side by `reservationNumber` or `billId`.

---

## CORS

The OpenAPI spec route allows `*` origin. Data endpoints currently do not — let us know what origin the portal will call from and we'll add it to the allowlist.

---

## Rate limits

No hard rate limit at the moment. Practical guidance: keep dashboard polling at ≥ 30s intervals. If your integration needs sub-second freshness for a real-time display, ask us to wire up a Server-Sent-Events stream instead of hammering the polling endpoint.

---

## Support

Open a ticket with FastTrax ops (`ops@fasttraxent.com`) for:
- Issuing a new API key
- Rotating an existing key
- Adding origins to CORS allowlist
- Requesting new fields or endpoints

---

## API key for HeadPinz Portal

```
x-api-key: qQ-Fb8bri1BDZgjLoPLsITiZcPl9vJI59aMnwEw_q3E
```

⚠️ **This is a production-grade key — store it in your portal's secret manager, never commit to source.**

The matching env var in fasttrax-web is `SALES_API_KEYS` (comma-separated list to support rotation):

```
SALES_API_KEYS=qQ-Fb8bri1BDZgjLoPLsITiZcPl9vJI59aMnwEw_q3E
```

To rotate without breaking the portal:
1. Generate a new key.
2. Append it to `SALES_API_KEYS` (e.g., `OLD_KEY,NEW_KEY`).
3. Update the portal to send `NEW_KEY`.
4. Once verified, remove `OLD_KEY` from the env var.
