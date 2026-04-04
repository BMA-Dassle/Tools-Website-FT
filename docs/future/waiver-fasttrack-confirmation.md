# Future: Waiver-Based FastTrax Express Confirmation

## Overview
Returning racers with valid waivers skip Guest Services and go directly to the 1st Floor Karting Counter. This feature was built and tested but deferred because:

1. **personId must be on booking/book** — BMI needs personId at timeslot booking time, not after conversion. Once a bill converts to a reservation, you can't add the personId retroactively.
2. **Pandora API ID mapping** — The Pandora waiver API uses Firebird IDs which don't always match SMS-Timing IDs. Need a reliable mapping (Eric: 409523 works for both, Curtis: 313535 in SMS-Timing but 713365 in Pandora).
3. **Multi-racer with different heat times** — Each racer card needs their own QR, reservation number, race name, and arrival time.

## What Was Built

### Pandora API Proxy
- **File**: `app/api/pandora/route.ts`
- Proxies waiver checks to `https://bma-pandora-api.azurewebsites.net/v2/bmi/person/{locationId}/{personId}`
- Auth: `Authorization: Bearer {SWAGGER_ADMIN_KEY}`
- Returns: `{ valid, personId, firstName, lastName, waiverExpiry, lastVisit, related }`

### Confirmation Page Features
- Per-racer cards with individual QR codes, reservation numbers, race names, heat times
- Waiver status badge per racer: green "Waiver OK" or amber "Waiver Needed"
- FastTrax Express panel (green, glowing) when ALL waivers valid:
  - "Skip Guest Services, go to 1st Floor Karting Counter"
  - 5 minutes before heat (vs 30 minutes)
  - 3 simplified steps
- Waiver warning panel (amber) when any invalid:
  - Lists who needs to re-sign with expiry dates
  - Shows full Racer's Journey steps
- Two-column desktop layout: racer cards left, journey/express right

### Key Findings
- `booking/book` DOES accept `personId` in the payload
- `registerProjectPerson` adds racers as participants on reservations
- `registerContactPerson` with `personId` applies deposit credits
- Once bill converts to reservation, you can't add personId retroactively
- personId should go on booking/book call AND registerProjectPerson at payment time

### Pandora API Details
See `docs/pandora-api.md` for full documentation.

**Working example:**
```
GET https://bma-pandora-api.azurewebsites.net/v2/bmi/person/TXBSQN0FEKQ11/409523?picture=false
Authorization: Bearer NCrVi4BwlNpz5qVR9WayitENvgeOwl4L2wZIOnyJOoA=

Response: { waiverExpiry: "2027-01-16", related: ["8449267"] }
```

### Test URLs
```
# Single racer, valid waiver
/book/race/confirmation?billId=63000000002932323&personIds=409523

# Two racers, both valid
/book/race/confirmation?billId=63000000002932323&billIds=63000000002932323,63000000002932324&racerNames=Eric%20Osborn,Curtis%20Stavich&personIds=409523,713365

# Mixed (one valid, one invalid)
/book/race/confirmation?billId=63000000002932323&billIds=63000000002932323,63000000002932324&racerNames=Eric%20Osborn,Test%20Racer&personIds=409523,999999
```

## TODO to Re-enable
1. Add `personId` to `bookRaceHeat` function in `data.ts` for returning racers
2. Map SMS-Timing personId to Pandora/Firebird ID (may need Pandora search endpoint or store mapping in Redis)
3. Pass personIds reliably through the booking flow to confirmation page
4. Test end-to-end with real multi-racer booking
5. Re-enable the FastTrack/waiver conditional rendering on confirmation page

## Files Involved
- `app/api/pandora/route.ts` — Pandora waiver proxy (KEEP)
- `app/book/race/confirmation/page.tsx` — Confirmation page with waiver logic (REVERT to simple)
- `app/book/race/components/OrderSummary.tsx` — Passes personIds in URL
- `docs/pandora-api.md` — Pandora API documentation
