# Guest Survey API — Portal Handoff

Read this once before building the dashboard. Everything you need to wire up
charts, tables, and CSV exports for the post-visit survey program lives behind
five JSON endpoints + one OpenAPI spec.

- **OpenAPI 3.0 spec:** [docs/guest-survey-api.yaml](./guest-survey-api.yaml) — drop into Swagger UI.
- **Base URL:** `https://headpinz.com`
- **Auth:** every endpoint listed here is admin-gated. Pass the operator's admin
  token as `x-admin-token: <token>` header (preferred) or `?token=<token>` query.
- **Same token** the portal already uses for `/api/admin/bowling/*`.

## What the program does

When a QAMF lane reservation transitions to `completed`, the system fires an
SMS to the customer's phone with a short link to `/survey/<token>`. If SMS
fails AND a `guestEmail` is on file, it falls back to an HP-branded email
(SendGrid). The guest answers 3–5 tag-driven questions and picks a reward:

| Reward             | Mechanism                                                             | Stored as                                         |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------------- |
| **500 Pinz**       | Square Loyalty `adjust_points`                                        | `reward_kind='pinz'`, `reward_ref=<event_id>`     |
| **$5 e-gift card** | Square Gift Card minted via Order + 100%-discount + ACTIVATE-by-order | `reward_kind='gift_card'`, `reward_ref='GS-XXXX'` |
| **Skip reward**    | (Page closes without picking)                                         | `reward_kind='declined'`                          |

Surveys are tagged with the visit context — `baseline`, `bowling`, `fnb_service`,
and `closing` for every bowling survey, plus optional cross-sell tags
(`food_drink`, `arcade`, `gel_blaster`) when racing surveys ship in PR-GS4.

## Endpoints at a glance

| Method | Path                                         | Purpose                                                                            |
| ------ | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| GET    | `/api/admin/guest-survey/list`               | Paginated survey rows + CSV export. Powers tables.                                 |
| GET    | `/api/admin/guest-survey/stats`              | Aggregates for cards + charts (funnel / rewards / per-tag / per-day / per-center). |
| GET    | `/api/admin/guest-survey/question-stats`     | Per-question histogram + averages.                                                 |
| POST   | `/api/admin/guest-survey/backfill-completed` | One-shot — send to recently-completed visits.                                      |
| POST   | `/api/admin/guest-survey/backfill-consent`   | One-shot — opt-in upcoming reservation phones.                                     |
| POST   | `/api/admin/guest-survey/send-test`          | Live-fire one survey to a phone.                                                   |
| POST   | `/api/admin/guest-survey/issue-reward-test`  | Live-fire one reward issuance.                                                     |
| POST   | `/api/admin/guest-survey/wipe-test-data`     | Destructive — wipe admin-test rows.                                                |
| POST   | `/api/admin/guest-survey/sync-questions`     | Reconcile the in-DB question pool with the in-code seed.                           |

The five GETs are what the portal dashboard consumes. The POSTs are operator
tools you can either skip or surface in an admin-only panel.

## Listing surveys — `/api/admin/guest-survey/list`

The workhorse. Every filter is optional and ANDed. Defaults: `limit=50`,
`offset=0`, `format=json`, no date range.

### Common params

| Param              | Type   | Notes                                                                     |
| ------------------ | ------ | ------------------------------------------------------------------------- |
| `limit`            | int    | 1..500.                                                                   |
| `offset`           | int    | For pagination — use with the `count` returned.                           |
| `since`            | ISO    | `sent_at >= since`. Accepts `2026-05-15` or full timestamp.               |
| `until`            | ISO    | `sent_at <= until`.                                                       |
| `centerCode`       | string | `TXBSQN0FEKQ11` or `PPTR5G2N0QXF7`.                                       |
| `origin`           | string | `bowling` \| `racing`.                                                    |
| `tag`              | string | Survey must include this tag. e.g. `tag=fnb_service`.                     |
| `rewardKind`       | string | `pinz` \| `gift_card` \| `declined`.                                      |
| `hasResponses`     | bool   | `true` → only submitted surveys.                                          |
| `hasReward`        | bool   | `true` → only surveys that issued a reward.                               |
| `phone`            | string | Filter to one customer's history. Any input format — normalized to E.164. |
| `squareCustomerId` | string | Same purpose as `phone`, keyed by the Square customer id.                 |
| `format`           | string | `json` (default) or `csv` (downloads as `guest-surveys-YYYY-MM-DD.csv`).  |

### Drill-down links on every row

The portal gets three pre-built URLs per survey so you can render direct
"open in Square" / "view survey" buttons without computing anything client-side:

| Field                        | Points to                                                                                                                               | Always present?                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `squareDashboardUrl`         | The customer's Square profile                                                                                                           | Yes                                    |
| `surveyResultUrl`            | The customer-facing survey page (`/survey/<token>`) — operator can open it to see exactly what the guest sees + their submitted answers | Yes                                    |
| `squareGiftCardDashboardUrl` | The Square Gift Card admin page for the issued $5 card                                                                                  | Only when `rewardKind === 'gift_card'` |

Per-customer history is one fetch: `GET /api/admin/guest-survey/list?phone=+12397762044`.

### Example — completed bowling surveys with a Pinz reward, last 30 days

```
GET /api/admin/guest-survey/list
  ?since=2026-04-20
  &origin=bowling
  &rewardKind=pinz
  &hasResponses=true
  &limit=200
```

### Response (JSON)

```jsonc
{
  "ok": true,
  "count": 47,
  "limit": 200,
  "offset": 0,
  "filters": { "since": "2026-04-20", "origin": "bowling", "rewardKind": "pinz", ... },
  "surveys": [
    {
      "id": "27f3d726-d7df-4b82-937d-9a2485b0b3d7",
      "token": "6d2e7b6b-2e32-4f4b-99d4-cddf09edf4f7",
      "squareCustomerId": "MAM5YPC3YGEJPTTVRBFPJ307RM",
      "phoneE164": "+12397762044",
      "origin": "bowling",
      "originRef": "1454",                       // QAMF reservation id (string)
      "centerCode": "TXBSQN0FEKQ11",
      "visitDate": "2026-05-20",
      "context": {
        "origin": "bowling",
        "centerCode": "TXBSQN0FEKQ11",
        "visitDate": "2026-05-20",
        "tags": ["baseline", "bowling", "fnb_service", "closing"],
        "channel": "sms"                          // 'sms' default; 'email' if SMS failed
      },
      "questions": [ /* the exact question set shown to the guest, see schema */ ],
      "responses": {
        "1": "5",                                 // keyed by question_id
        "2": "Yes",
        "3": "4",
        "42": "Justin at the bar was great!"
      },
      "rewardKind": "pinz",
      "rewardRef": "evt_loy_abc123",             // Loyalty event id
      "rewardValue": 500,                         // points (pinz) or cents (gift_card)
      "sentAt": "2026-05-20T20:05:11.234Z",
      "openedAt": "2026-05-20T20:11:48.000Z",
      "completedAt": "2026-05-20T20:14:22.105Z",
      "expiresAt": "2026-05-27T20:05:11.234Z",
      "promoCode": null,                          // GS-XXXX, present only on gift_card reward
      "promoCodeGiftCardId": null,                // Square gift card id (gftc:hex), present only on gift_card
      "promoCodeGan": null,                       // 16-digit GAN
      "promoCodeRedeemedAt": null,                // ISO when the GC was used at POS
      "squareDashboardUrl": "https://app.squareup.com/dashboard/customers/MAM5YPC3YGEJPTTVRBFPJ307RM",
      "squareGiftCardDashboardUrl": null,         // only on gift_card rewards
      "surveyResultUrl": "https://headpinz.com/survey/6d2e7b6b-2e32-4f4b-99d4-cddf09edf4f7"
    }
  ]
}
```

### Example — CSV download

```
GET /api/admin/guest-survey/list?since=2026-05-01&format=csv
```

Returns `text/csv` with 20 columns. `questions_json`, `responses_json`, and
`context_json` are kept as JSON strings inside their cells (so a downstream
sheet can re-parse without dealing with column explosion). Comma/quote/newline
are properly escaped.

## Dashboard stats — `/api/admin/guest-survey/stats`

The card data + chart data in one call. Same filter set as `/list` minus the
pagination + reward filters; everything else (date range, center, origin, tag)
applies and the response computes counts on the filtered set.

### Example

```
GET /api/admin/guest-survey/stats?since=2026-04-20&centerCode=TXBSQN0FEKQ11
```

### Response

```jsonc
{
  "ok": true,
  "window": { "since": "2026-04-20", "until": null },
  "filters": { "centerCode": "TXBSQN0FEKQ11", "origin": null, "tag": null },
  "funnel": {
    "sent": 247,
    "opened": 119,
    "completed": 64,
    "openRate": 0.4818, // opened / sent
    "completionRate": 0.2591, // completed / sent
  },
  "rewards": {
    "pinz": 41,
    "gift_card": 21,
    "declined": 2,
    "issued": 62, // pinz + gift_card
    "redeemed": 7, // gift cards with redeemed_at set
  },
  "byTag": [
    { "tag": "baseline", "sent": 247, "completed": 64 },
    { "tag": "bowling", "sent": 247, "completed": 64 },
    { "tag": "fnb_service", "sent": 247, "completed": 64 },
    { "tag": "closing", "sent": 247, "completed": 64 },
  ],
  "byDay": [
    { "day": "2026-04-20", "sent": 12, "opened": 6, "completed": 3 },
    { "day": "2026-04-21", "sent": 14, "opened": 8, "completed": 4 },
    // …one row per ET-day in the window
  ],
  "byCenter": [{ "centerCode": "TXBSQN0FEKQ11", "sent": 247, "completed": 64 }],
}
```

### Dashboard card mapping

| Card                       | Pull                                                                   |
| -------------------------- | ---------------------------------------------------------------------- |
| **Sends**                  | `funnel.sent`                                                          |
| **Open rate**              | `funnel.openRate * 100`%                                               |
| **Completion rate**        | `funnel.completionRate * 100`%                                         |
| **Pinz issued**            | `rewards.pinz`                                                         |
| **$5 gift cards issued**   | `rewards.gift_card`                                                    |
| **$5 gift cards redeemed** | `rewards.redeemed` (∴ unused = `rewards.gift_card − rewards.redeemed`) |
| **Daily trend**            | `byDay` (chart with three lines: sent / opened / completed)            |
| **Per-center compare**     | `byCenter`                                                             |

## Question-level analytics — `/api/admin/guest-survey/question-stats`

For the "what are guests actually saying" view. Only counts surveys with
`completed_at IS NOT NULL`.

```
GET /api/admin/guest-survey/question-stats?since=2026-04-20
```

```jsonc
{
  "ok": true,
  "window": { "since": "2026-04-20", "until": null },
  "filters": { "centerCode": null, "origin": null },
  "count": 12,
  "questions": [
    {
      "questionId": 1,
      "tag": "baseline",
      "ordinal": 1,
      "question": "How was your visit overall?",
      "kind": "rating_1_5",
      "totalAnswered": 64,
      "distribution": { "1": 1, "2": 2, "3": 7, "4": 20, "5": 34 },
      "averageRating": 4.31,
      "recentTextAnswers": [],
    },
    {
      "questionId": 7,
      "tag": "fnb_service",
      "ordinal": 2,
      "question": "How quickly did your server first check on you?",
      "kind": "multi",
      "totalAnswered": 48,
      "distribution": {
        "Within 1-2 minutes": 19,
        "Within 3-5 minutes": 21,
        "5+ minutes": 8,
      },
      "averageRating": null,
      "recentTextAnswers": [],
    },
    {
      "questionId": 42,
      "tag": "closing",
      "ordinal": 1,
      "question": "Team Member Fist Bump — do you know the name of a team member who made your visit exceptional?",
      "kind": "text",
      "totalAnswered": 28,
      "distribution": {},
      "averageRating": null,
      "recentTextAnswers": [
        "Justin at the bar was great",
        "Alex helped with my lane",
        "Mira was super friendly",
      ],
    },
  ],
}
```

`distribution` carries the histogram for `rating_1_5`/`yes_no`/`multi`.
`averageRating` is populated only for `rating_1_5`. `recentTextAnswers` is
populated only for `text` (capped at 25 — for full export, use
`/list?hasResponses=true&format=csv`).

## Question + response schema

The actual question set the guest sees is captured per-survey in
`surveys[].questions` (so future question pool changes don't retroactively
break older response interpretation). Each question:

```ts
{
  id: number,                // primary key in guest_survey_questions
  tag: "baseline" | "bowling" | "fnb_service" | "food_drink" | "gel_blaster"
     | "arcade" | "racing" | "closing",
  ordinal: number,
  question: string,
  kind: "rating_1_5" | "multi" | "text" | "yes_no",
  choices: string[] | null,  // only for `multi`
  gateOrdinal: number | null,
  gateAnswer:  string | null,
  active: boolean
}
```

Answers in `surveys[].responses` are keyed by `questionId` (stringified). Values:

| Kind         | Answer value                   |
| ------------ | ------------------------------ |
| `rating_1_5` | `"1"` .. `"5"`                 |
| `yes_no`     | `"Yes"` or `"No"`              |
| `multi`      | one of the `choices[]` strings |
| `text`       | free-form string               |

The current bowling question pool is fixed at 4 tags: `baseline`, `bowling`,
`fnb_service`, `closing`. The pool itself is editable via the
[sync-questions](#post-apiadminguest-surveysync-questions) endpoint — pushing
the in-code seed into the live DB. Future racing surveys (PR-GS4) will pull
from `racing` + at most one cross-sell tag derived from same-day Square
purchases.

## CSV column reference (for the table view)

```
token,sent_at,opened_at,completed_at,
origin,origin_ref,center_code,visit_date,
phone_e164,square_customer_id,square_dashboard_url,
reward_kind,reward_value,reward_ref,
promo_code,promo_gift_card_id,promo_gan,promo_redeemed_at,
square_gift_card_dashboard_url,survey_result_url,
questions_json,responses_json,context_json
```

Spreadsheet-friendly: every column is a scalar except the three trailing
`*_json` columns which carry the per-row JSON blobs as escaped strings.

## Operator tools (optional admin panel)

If the portal exposes an admin-only panel, the following POSTs are useful.
None of these are required for read-only reporting.

### `POST /api/admin/guest-survey/backfill-completed`

Send surveys to the last N days of completed reservations (default 5, max 14).
Honors per-phone dedup + already-surveyed skip + STOP. Idempotent.

```jsonc
// Request
{ "days": 5, "limit": 200, "dryRun": false }

// Response counts
{
  "reservationsScanned": 758,
  "completedReservations": 391,
  "uniquePhones": 229,
  "sent": 202,
  "skipped": 27,
  ...
}
```

### `POST /api/admin/guest-survey/backfill-consent`

Walks upcoming reservations and writes `marketing_consent` opt-in rows so the
QAMF webhook → survey flow doesn't default-deny new customers.

### `POST /api/admin/guest-survey/send-test`

Operator one-off: `{ phone, guestName, centerCode, force?, ensureOptIn? }`.

### `POST /api/admin/guest-survey/issue-reward-test`

Verifies the reward path against Square: `{ phone, guestName, centerCode, kind, surveyId? }`.
Returns the GAN (gift_card) or Loyalty event id (pinz).

### `POST /api/admin/guest-survey/wipe-test-data`

Destructive — wipes `admin-test*` rows + their promo codes + touches. Use
before a press demo to clean the analytics surface.

### `POST /api/admin/guest-survey/sync-questions`

Pushes the in-code question seed to the live DB (upsert + deactivate missing).

## Quick reference — every field returned

The full schema is in [guest-survey-api.yaml](./guest-survey-api.yaml). The
shape of `SurveyRow` matches the `GuestSurveyListItem` TypeScript type in
[apps/web/lib/guest-survey-db.ts](../apps/web/lib/guest-survey-db.ts).

## Production safety notes

- The `/list` and `/stats` endpoints are read-only and safe to poll at any rate
  (the portal can re-fetch every 30 sec for live dashboards). The aggregation
  queries hit indexed columns and are cheap.
- The backfill / wipe / send-test endpoints **mutate** state. Don't expose them
  as background polling targets.
- Phone numbers in responses are in **E.164** (`+12397762044`). Square customer
  IDs are opaque strings. The `squareDashboardUrl` field is the canonical
  drill-down link.
- Timestamps are ISO 8601 UTC. The `byDay` grouping in `/stats` uses the
  America/New_York date so daily buckets match the operator's day.
