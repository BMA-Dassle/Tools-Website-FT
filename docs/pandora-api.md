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
| locationID * | string | path | Square location ID (e.g., `TXBSQN0FEKQ11` for FastTrax FT Myers) |
| personID * | string | path | BMI Firebird person ID (NOT SMS-Timing ID). Maps via SMS-Timing Office API `externalId` field, but NOT the same value. Example: Curtis Stavich = `713365` in Pandora, `313535` in SMS-Timing, `34147` as externalId. |
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

## Environment Variables

| Variable | Value | Description |
|----------|-------|-------------|
| `SWAGGER_ADMIN_KEY` | `NCrVi4BwlNpz5qVR9WayitENvgeOwl4L2wZIOnyJOoA=` | API key for Pandora API |
| `SQUARE_FT_LOCATION_ID` | `TXBSQN0FEKQ11` | FastTrax Fort Myers Square location ID |

## Notes

- This API connects directly to BMI's Firebird database, not the SMS-Timing/BMI Public API layer.
- The `related` field is useful for the family-sharing-email scenario — shows all people linked to the same account.
- `waiverExpiry` gives a direct waiver check without parsing memberships from the Office API.

## ID Mapping

The Pandora API uses BMI Firebird database IDs which are DIFFERENT from SMS-Timing IDs:

| Person | Pandora/Firebird ID | SMS-Timing ID | SMS-Timing externalId |
|--------|-------------------|---------------|----------------------|
| Eric Osborn | `409523` | `409523` | `34205` |
| Curtis Stavich | `713365` | `313535` | `34147` |

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
