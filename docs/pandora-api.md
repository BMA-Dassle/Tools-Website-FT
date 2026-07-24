# BMA Pandora API

Base URL: `https://bma-pandora-api.azurewebsites.net/v2`
Swagger Docs: `https://bma-pandora-api.azurewebsites.net/api-docs/#/BMI/get_bmi_person__locationID___personID_`

## Authentication

Header: `Authorization: Bearer {SWAGGER_ADMIN_KEY}`
Env var: `SWAGGER_ADMIN_KEY` = `NCrVi4BwlNpz5qVR9WayitENvgeOwl4L2wZIOnyJOoA=`

## Endpoints

### GET /bmi/person/{locationID}/{personID}

Fetches full customer details from BMI Firebird database including contact information, birthdate, waiver status, last visit date, related persons (family members), and optionally their profile picture.

**Parameters:**
| Name | Type | In | Description |
|------|------|-----|-------------|
| locationID _ | string | path | Square location ID (e.g., `TXBSQN0FEKQ11` for FastTrax FT Myers) |
| personID _ | string | path | BMI Firebird person ID (NOT SMS-Timing ID). Maps via SMS-Timing Office API `externalId` field, but NOT the same value. Example: Curtis Stavich = `713365` in Pandora, `313535` in SMS-Timing, `34147` as externalId. |
| picture | string | query | Include profile picture in response (true/false). Default: true |

**Response (200):**

```json
{
  "id": "string",
  "firstName": "string",
  "lastName": "string",
  "birthdate": "2026-04-03",
  "email": "string",
  "phoneNumber": "string",
  "pic": "string",
  "waiverExpiry": "2026-04-03",
  "lastVisit": "2026-04-03",
  "related": ["string"]
}
```

**Key fields:**

- `waiverExpiry` — Date the waiver/license expires. Compare to today to check validity.
- `related` — Array of related person IDs (family members sharing same email/account).
- `pic` — Base64 encoded profile picture (omit with `?picture=false` to reduce payload).
- `lastVisit` — Last time they raced.

### GET /bmi/person/search

Searches BMI Firebird customer records by **last name + birthdate**, ordered by last visit
(most recent first). Purpose-built for check-in/kiosk lookups — this is the search behind the
kiosk driver's-license sign-in ([lookup.server.ts](../apps/web/src/features/kiosk/license/lookup.server.ts)).
The Office API's `search/person` token search does NOT do names (bare name tokens 500) — use this.

**Parameters (query):**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| location | string | yes | Square location ID (e.g. `LAB52GY480CJF` FastTrax FM) |
| lastName | string | yes | Case-insensitive last name |
| birthday | string | yes | ISO date, e.g. `1990-01-01` |
| limit | integer | no | Max results, 1–100, default 10 |
| filter | string | no | Default `true` = exclude expired waivers. Pass `false` to include them (kiosk does — lapsed guests still sign in and re-sign). |

**Response (200):** `{ success, data: [{ id, firstName, lastName, birthdate, waiverExpiry, lastVisit }] }`
— `firstName` can be `null` on legacy duplicates; `id` comes in BOTH forms (17-digit modern and
legacy short like `553343`), and both forms work against Office `person/{id}` (verified 2026-07-23).
**404** = no customers matched (also seen as `200 {success:true,data:[]}`). Parse with
`parseWithRawIds` — 17-digit ids.

**Cold start:** the Azure app 502s the first request(s) after idle — retry 5xx (the same reason
`pandoraCreatePerson` retries). Verified live 2026-07-23: three 502s then clean 200s.

### GET /bmi/race/next/{locationID}/{person|participant}/{id}

Returns a racer's **next upcoming race** at a location. Used by the race check-in scanner
([apps/web/app/api/admin/checkin/route.ts](../apps/web/app/api/admin/checkin/route.ts)) to tell a
guest when they actually race when the QR they scanned isn't currently being called.

**Parameters:**
| Name | Type | In | Description |
|------|------|-----|-------------|
| locationID | string | path | Pandora location ID (e.g. `LAB52GY480CJF` for FastTrax FT Myers) |
| `person` / `participant` | literal | path | Path segment selecting the ID type — use `person` for a BMI person ID, `participant` for a participant ID. |
| id | string | path | The person ID or participant ID (matching the segment above). Pass as a string — never `Number()` it (BMI ID precision). |

**Response (200):** same race shape as `GET /bmi/races/current/{locationID}`, wrapped in `{ success, data }`:

```json
{
  "success": true,
  "data": {
    "trackName": "Blue",
    "raceType": "Starter",
    "heatNumber": 5,
    "scheduledStart": "2026-05-31T20:00:00.000Z",
    "sessionId": 123456
  }
}
```

**404** — no upcoming race scheduled for that racer (surfaced to staff as "No upcoming race found").

### PATCH /bmi/session/{locationID}

Sets a heat block's display name + style (setup) for a race level via BMI's `SESS_SET`
procedure. Used by the booking v2 confirm paths
([session-setup.ts](../apps/web/src/features/booking/service/session-setup.ts)) to replace the
manual "Placeholder" setup step: fired post-confirm from unified reserve, `/api/booking/v2/reserve`,
and the race-confirm-reconcile cron. Idempotent — re-applying the same style is a no-op.

**Parameters:**
| Name | Type | In | Description |
|------|------|-----|-------------|
| locationID | string | path | Pandora location ID (`LAB52GY480CJF` for FastTrax FT Myers — the only racing location) |

**Body:**

```json
{
  "track": "Blue",
  "heatStart": "2026-07-30T16:30:00",
  "level": "starter",
  "junior": false
}
```

- `track` — track name; bare name works, optional "Track" suffix accepted (e.g. `"Mega"` or `"Mega Track"`).
- `heatStart` — naive center-local ISO start of the heat block (same format booking v2 stores as `heatId`).
- `level` — `starter | intermediate | pro` (matches `RaceTier` exactly).
- `junior` — `true` = Junior style/name, `false` = Adult.
- `productLimitId` (optional, integer) — locks a BMI product limit on the heat; on virgin heats the
  limit name appends to the derived name. Booking v2 does NOT send it (owner decision 2026-07-01).

**Response (200):** sessionId, derived heat name, styleId, and the array of updated fields
(e.g. `["style", "name"]`).

**404** — `{"success":false,"message":"No heat found for that track and start time."}` (verified 2026-07-01).

## Environment Variables

| Variable                | Value                                          | Description                            |
| ----------------------- | ---------------------------------------------- | -------------------------------------- |
| `SWAGGER_ADMIN_KEY`     | `NCrVi4BwlNpz5qVR9WayitENvgeOwl4L2wZIOnyJOoA=` | API key for Pandora API                |
| `SQUARE_FT_LOCATION_ID` | `TXBSQN0FEKQ11`                                | FastTrax Fort Myers Square location ID |

## Notes

- This API connects directly to BMI's Firebird database, not the SMS-Timing/BMI Public API layer.
- The `related` field is useful for the family-sharing-email scenario — shows all people linked to the same account.
- `waiverExpiry` gives a direct waiver check without parsing memberships from the Office API.

## ID Mapping

The Pandora API uses BMI Firebird database IDs which are DIFFERENT from SMS-Timing IDs:

| Person         | Pandora/Firebird ID | SMS-Timing ID | SMS-Timing externalId |
| -------------- | ------------------- | ------------- | --------------------- |
| Eric Osborn    | `409523`            | `409523`      | `34205`               |
| Curtis Stavich | `713365`            | `313535`      | `34147`               |

Note: Eric's Pandora ID happens to match his SMS-Timing ID, but Curtis's don't match at all.
The Pandora API returns `id` in the response which IS the Firebird ID used in the URL.

## Verified Working (2026-04-03)

```
GET /v2/bmi/person/TXBSQN0FEKQ11/713365?picture=false
Authorization: Bearer NCrVi4BwlNpz5qVR9WayitENvgeOwl4L2wZIOnyJOoA=

Response:
{
  "success": true,
  "data": {
    "id": "713365",
    "firstName": "Curtis",
    "lastName": "stavich",
    "birthdate": "1991-08-04T04:00:00.000Z",
    "email": "curtis@headpinz.com",
    "phoneNumber": "2398989675",
    "waiverExpiry": "2026-10-28T10:00:00.000Z",
    "lastVisit": "2026-03-23T15:00:00.000Z",
    "related": []
  }
}
```
