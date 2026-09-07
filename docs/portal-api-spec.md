# Portal API Specification — Group Function Contracts, Payments & Briefings

**Version:** 1.1  
**Base URL:** `https://headpinz.com/api/portal` (serves both HeadPinz and FastTrax — venue is derived from each record's center code)  
**Auth:** Same admin token used across all admin endpoints (`ADMIN_CAMERA_TOKEN` env var)

---

## Authentication

Pass the admin token via query param or header (same pattern as all `/api/admin/*` endpoints):

```
GET /api/portal/payments?token=YOUR_TOKEN&bmiCodes=3288,3312

# or via header:
x-admin-token: YOUR_TOKEN
```

Unauthorized requests return `401 { "error": "Unauthorized" }`.

---

## Data Conventions

- **All monetary values are in cents** (integer). `totalCents: 158226` = $1,582.26
- **BMI reservation IDs are strings** — they exceed `Number.MAX_SAFE_INTEGER`. Never parse as numbers.
- **Timestamps are ISO 8601** in UTC
- **Venue codes:** `fort-myers`, `naples`, `fasttrax`

---

## Endpoints

### 1. `GET /api/portal/payments`

Bulk payment lookup for list views. Pass up to 30 BMI codes at once.

**Query params:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `bmiCodes` | string | Yes | Comma-separated BMI reservation IDs (max 30) |

**Example:** `GET /api/portal/payments?bmiCodes=3288,3312,3290`

**Response:** `200 OK`

```json
{
  "results": [
    {
      "bmiCode": "3288",
      "venue": "naples",
      "status": "deposit_paid",
      "isFullyPaid": false,
      "totalCents": 158226,
      "depositPaidCents": 79113,
      "balanceRemainingCents": 79113,
      "payments": [
        {
          "type": "deposit",
          "amountCents": 79113,
          "method": "card",
          "squarePaymentId": "abc123...",
          "paidAt": "2026-06-01T14:30:00Z"
        }
      ],
      "priorPayments": [
        {
          "amountCents": 50000,
          "source": "bmi_legacy",
          "paidAt": "2026-05-15T00:00:00Z"
        }
      ],
      "giftCardGans": ["HPN12345678"],
      "savedCardOnFile": true
    },
    {
      "bmiCode": "3312",
      "venue": "fort-myers",
      "status": "balance_charged",
      "isFullyPaid": true,
      "totalCents": 250000,
      "depositPaidCents": 125000,
      "balanceRemainingCents": 0,
      "payments": [
        {
          "type": "deposit",
          "amountCents": 125000,
          "method": "card",
          "squarePaymentId": "def456...",
          "paidAt": "2026-05-20T10:00:00Z"
        },
        {
          "type": "balance",
          "amountCents": 125000,
          "method": "auto_card",
          "squarePaymentId": "ghi789...",
          "paidAt": "2026-05-28T12:00:00Z"
        }
      ],
      "priorPayments": [],
      "giftCardGans": ["HPFM98765432"],
      "savedCardOnFile": true
    }
  ]
}
```

BMI codes with no website record are omitted from `results` — that tells the portal it's legacy/PandaDoc flow.

---

### 2. `GET /api/portal/payments/{bmiCode}`

Single event payment detail. Same shape as one entry in the bulk response, plus additional fields.

**Response:** `200 OK`

```json
{
  "bmiCode": "3288",
  "venue": "naples",
  "status": "deposit_paid",
  "isFullyPaid": false,
  "totalCents": 158226,
  "depositDueCents": 79113,
  "depositPaidCents": 79113,
  "balanceRemainingCents": 79113,
  "payments": [
    {
      "type": "deposit",
      "amountCents": 79113,
      "method": "card",
      "squarePaymentId": "abc123...",
      "squareOrderId": "ord_abc...",
      "paidAt": "2026-06-01T14:30:00Z"
    }
  ],
  "priorPayments": [],
  "giftCardGans": ["HPN12345678"],
  "savedCardOnFile": true,
  "balancePaymentLinkUrl": null,
  "depositAttempts": 1,
  "depositLastError": null,
  "balanceChargeAttempts": 0,
  "balanceLastError": null
}
```

**404** if BMI code has no website record.

---

### 3. `GET /api/portal/documents`

Find contracts for an event.

**Query params:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `bmiCode` | string | Yes | BMI reservation ID |

**Response:** `200 OK`

```json
{
  "documents": [
    {
      "id": "61c90c39",
      "bmiCode": "3288",
      "venue": "naples",
      "status": "deposit_paid",
      "contractStatus": "signed",
      "plannerEmail": "sarah@headpinz.com",
      "plannerName": "Sarah Johnson",
      "guestEmail": "rachel@example.com",
      "guestName": "Rachel Smith",
      "recipientLink": "https://headpinz.com/contract/61c90c39",
      "eventName": "Hayes' 9th Birthday",
      "eventDate": "2026-06-15T15:00:00-04:00",
      "totalCents": 158226,
      "serviceChargeCents": 3553,
      "taxCents": 0,
      "isTaxExempt": false,
      "dateCreated": "2026-05-28T09:00:00Z",
      "dateSent": "2026-05-28T09:01:00Z",
      "dateSigned": "2026-06-01T14:25:00Z",
      "dateModified": "2026-06-01T14:30:00Z",
      "hasPdf": true
    }
  ]
}
```

---

### 4. `GET /api/portal/documents/{id}`

Full contract detail with line items.

**Response:** `200 OK`

```json
{
  "id": "61c90c39",
  "bmiCode": "3288",
  "venue": "naples",
  "status": "deposit_paid",
  "contractStatus": "signed",
  "approvalRequired": false,
  "plannerEmail": "sarah@headpinz.com",
  "plannerName": "Sarah Johnson",
  "guestEmail": "rachel@example.com",
  "guestName": "Rachel Smith",
  "guestPhone": "+12395551234",
  "recipientLink": "https://headpinz.com/contract/61c90c39",
  "eventName": "Hayes' 9th Birthday",
  "eventNumber": "H1120",
  "eventDate": "2026-06-15T15:00:00-04:00",
  "eventDateDisplay": "Jun 15 3:00 PM",
  "guestCount": 24,
  "notes": "Birthday Child's Name & Age: Hayes, 9\nType of Birthday Package: VIP 4 lanes\n...",
  "lineItems": [
    {
      "name": "VIP Bowling - 4 Lanes (3hr)",
      "category": "revenue",
      "unitPriceCents": 68000,
      "qty": 1,
      "totalCents": 68000,
      "plu": "SQCAT_ABC123"
    },
    {
      "name": "Chicken Tenders & Fries (24 guests)",
      "category": "revenue",
      "unitPriceCents": 1200,
      "qty": 24,
      "totalCents": 28800,
      "plu": "SQCAT_DEF456"
    },
    {
      "name": "200 Token Game Zone Cards",
      "category": "revenue",
      "unitPriceCents": 4500,
      "qty": 24,
      "totalCents": 108000,
      "plu": "SQCAT_GHI789"
    },
    {
      "name": "Service Charge",
      "category": "service_charge",
      "unitPriceCents": 3553,
      "qty": 1,
      "totalCents": 3553,
      "plu": null
    }
  ],
  "totalCents": 158226,
  "serviceChargeCents": 3553,
  "taxCents": 0,
  "isTaxExempt": false,
  "eligibleCents": 154673,
  "priorPayments": [],
  "isFullyPaid": false,
  "depositDueCents": 79113,
  "depositPaidCents": 79113,
  "balanceRemainingCents": 79113,
  "dateCreated": "2026-05-28T09:00:00Z",
  "dateSent": "2026-05-28T09:01:00Z",
  "dateSigned": "2026-06-01T14:25:00Z",
  "dateCompleted": null,
  "dateModified": "2026-06-01T14:30:00Z",
  "hasPdf": true,
  "pdfUrl": "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/contracts/61c90c39.pdf"
}
```

**Line item categories:**
| Category | Description |
|----------|-------------|
| `revenue` | Billable product (bowling, food, activities, etc.) |
| `service_charge` | Mandatory service charge (non-refundable) |
| `tax_exempt` | Tax exempt flag product (GF Tax Exempt) |

**Computed fields:**

- `serviceChargeCents` = sum of `service_charge` line items (also stored as `tax_cents` in our DB — it's a flat service charge, not sales tax)
- `eligibleCents` = `totalCents - serviceChargeCents` (commission-eligible revenue)
- `isFullyPaid` = `status` in (`balance_charged`, `completed`) or (`deposit_paid` and `balanceRemainingCents === 0`)

---

### 5. `GET /api/portal/documents/{id}/pdf`

Download the signed PDF.

**Response:** `302 Redirect` to the signed PDF URL (Vercel Blob storage).

Returns `404` if no signed PDF exists yet.

---

### 6. `GET /api/portal/documents/changed`

Backfill — documents modified since a timestamp.

**Query params:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `since` | string | Yes | ISO 8601 timestamp |
| `limit` | number | No | Max results (default 50, max 200) |
| `offset` | number | No | Pagination offset (default 0) |

**Response:** `200 OK`

```json
{
  "documents": [
    {
      "id": "61c90c39",
      "bmiCode": "3288",
      "venue": "naples",
      "status": "deposit_paid",
      "dateModified": "2026-06-01T14:30:00Z"
    }
  ],
  "total": 1,
  "hasMore": false
}
```

Returns lightweight stubs — portal fetches full detail via endpoint 4 as needed.

---

### 7. `GET /api/portal/briefings`

How many safety briefings each pit staff member ran on a racing day. Feeds the portal's pit board
TV (`portal.headpinz.com/tv/pit-board`) and the check-in board's briefed-today strip.

Served from FastTrax: `https://fasttraxent.com/api/portal/briefings` (the HeadPinz host mirrors the
same deployment). Unlike the endpoints above, this one is FastTrax-only data — HeadPinz venues run
no briefing rooms.

**Query params:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `date` | string | No | Racing business day, `YYYY-MM-DD`. Defaults to FastTrax's current business day. |

**Example:** `GET /api/portal/briefings?date=2026-09-07`

**Response:** `200 OK` (`Cache-Control: no-store` — it drives a live board)

```json
{
  "businessDay": "2026-09-07",
  "venue": "FT",
  "staff": [
    { "userId": 32410, "firstName": "Pedro", "briefed": 5 },
    { "userId": 31877, "firstName": "Anthony", "briefed": 4 },
    { "userId": 33021, "firstName": "Ivan", "briefed": 3 }
  ],
  "unattributed": 2,
  "active": [
    {
      "userId": 32410,
      "firstName": "Pedro",
      "sessionId": "58509552",
      "track": "blue",
      "heatNumber": 35,
      "stage": "karts"
    },
    {
      "userId": 31877,
      "firstName": "Anthony",
      "sessionId": "58509571",
      "track": "red",
      "heatNumber": 33,
      "stage": "briefing"
    }
  ]
}
```

**`userId` is the 7shifts USER id**, not the punch ID — punch IDs are reissued when someone leaves,
so a report joining on one would attribute last season's races to this season's new hire. It is the
same key the portal's pit board roster uses (`PitEmployee.userId`), so counts merge onto a person by
id with no name matching. Staff with no briefings are absent from `staff[]`, never present with `0`.

**One group is one count.** A Mega-night group is sent to both briefing rooms and occupies two rows
in `briefing_assignments`; the endpoint counts `DISTINCT session_id`, so it is counted once.

**`unattributed`** is the number of groups on the day with no staff member recorded — sends from
before hosts were captured (2026-09-03) and sends where nobody typed a punch ID at the tablet. It is
reported rather than dropped: a night where eight groups went unclaimed is a different fact from a
quiet night, and only one of them needs looking into.

**`active[]` is who is running a group RIGHT NOW** — for the race tag the pit board prints beside
the flag count (`B35`, `R33`, `M12`). It is what makes the difference between "Pedro has briefed
nine groups today" and "Pedro is on 35 at this moment".

| Field        | Meaning                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `userId`     | 7shifts USER id — the same key as `staff[].userId`, so both merge onto one person.                             |
| `firstName`  | First name only, as claimed at the briefing tablet.                                                            |
| `sessionId`  | Pandora session id, **as a string** — these exceed `Number.MAX_SAFE_INTEGER`.                                  |
| `track`      | `blue` \| `red` \| `mega`. The tag's letter and colour: **blue → B, red → R, mega → M**.                       |
| `heatNumber` | The number after the letter. **Null** for a group event or custom race with no heat — render the letter alone. |
| `stage`      | `briefing` \| `holding` \| `karts` \| `racing` \| `pitIn`.                                                     |

**One entry per person, for their most advanced group.** A marshal who has just walked one group to
the karts and been handed the next in a briefing room holds two sessions, and both facts are true —
the pill has room for one, so it names the group whose racers are already strapped in. The ranking
is `racing > karts > holding > briefing > pitIn`, and **`pitIn` is last, not first**: a group in the
pit has its karts back and is leaving, so tagging their marshal with it would name the race they
have just finished while a room full of people waits for them.

**Absent from `active` means free.** Somebody with a `staff[]` row and no `active` entry has briefed
today and is holding nobody right now — which is exactly what the boards mark green.

**`active` ignores `date`.** There is no historical form of "who is holding a group", so it always
describes this instant, whatever day the counts were asked for. It is also independent of the
counts: if the floor cannot be read it comes back `[]` rather than failing the request, so a Redis
blip costs the tags and never the numbers.

**Business-day note.** FastTrax's racing day rolls at **2 AM ET** (a race night runs past midnight);
the portal's business day rolls at **5 AM**. Pass the day you are displaying rather than relying on
the default — between 2 and 5 AM the two calendars disagree, though no races run in that window, so
the counts themselves never differ. Omitting `date` returns FastTrax's own business day.

**Error codes:** `400 INVALID_REQUEST` (`date` not `YYYY-MM-DD`), `401 UNAUTHORIZED`,
`500 INTERNAL_ERROR`.

---

### 8. `POST` Webhook — Document & Payment Events

Fires to `https://portal.headpinz.com/api/webhooks/website-documents` on state changes.

**Headers:**

```
Content-Type: application/json
X-Webhook-Signature: sha256=<HMAC-SHA256 hex digest of body using shared secret>
X-Webhook-Event: document.deposit_paid
```

**Payload:**

```json
{
  "event": "document.deposit_paid",
  "timestamp": "2026-06-01T14:30:00Z",
  "data": {
    "documentId": "61c90c39",
    "bmiCode": "3288",
    "venue": "naples",
    "status": "deposit_paid"
  }
}
```

**Webhook events fired:**

| Event                       | When                                          |
| --------------------------- | --------------------------------------------- |
| `document.created`          | Contract created and sent to guest            |
| `document.updated`          | Contract re-sent with changes                 |
| `document.signed`           | Guest signed the contract                     |
| `document.resign_required`  | Price changed post-signing, re-sign needed    |
| `document.cancelled`        | Event cancelled                               |
| `document.denied`           | Post-paid approval rejected                   |
| `document.expired`          | Contract expired                              |
| `payment.deposit_paid`      | Deposit collected (card or legacy conversion) |
| `payment.balance_charged`   | Balance auto-charged via saved card           |
| `payment.balance_link_sent` | Payment link sent (auto-charge failed)        |
| `approval.needed`           | Post-paid event awaiting management approval  |
| `approval.approved`         | Post-paid event approved                      |

**Signature verification:**

```
expected = HMAC-SHA256(requestBody, WEBHOOK_SECRET)
actual = request.headers["X-Webhook-Signature"].replace("sha256=", "")
if (actual !== expected) reject
```

**Retry policy:** 3 attempts with exponential backoff (5s, 30s, 5min). Non-2xx = retry.

---

## Status Reference

| Status              | Description                             | `isFullyPaid` |
| ------------------- | --------------------------------------- | ------------- |
| `pending`           | Quote created, not yet sent             | `false`       |
| `pending_approval`  | Post-paid, awaiting management          | `false`       |
| `contract_sent`     | Contract sent to guest                  | `false`       |
| `deposit_paid`      | Deposit collected, balance due at T-72h | `false`       |
| `resign_required`   | Price changed, guest must re-sign       | `false`       |
| `balance_charged`   | Balance collected, fully paid           | `true`        |
| `balance_link_sent` | Auto-charge failed, payment link sent   | `false`       |
| `completed`         | Event occurred, all settled             | `true`        |
| `cancelled`         | Event cancelled                         | N/A           |
| `denied`            | Post-paid approval rejected             | N/A           |
| `expired`           | Contract expired                        | N/A           |

---

## Error Responses

All errors follow:

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_CODE"
}
```

| HTTP | Code              | Meaning                           |
| ---- | ----------------- | --------------------------------- |
| 400  | `INVALID_REQUEST` | Bad params (e.g., >30 BMI codes)  |
| 401  | `UNAUTHORIZED`    | Missing/invalid Bearer token      |
| 404  | `NOT_FOUND`       | BMI code or document ID not found |
| 429  | `RATE_LIMITED`    | Too many requests (100/min)       |
| 500  | `INTERNAL_ERROR`  | Server error                      |
