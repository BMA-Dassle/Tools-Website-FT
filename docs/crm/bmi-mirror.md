# Sales CRM — the BMI mirror (B1)

`crm_bmi_projects` is a read-only copy of every Office project, the substrate
for **History & accounts**, **This time last year** and (later) the KPI board.
Code: `apps/web/src/features/crm/bmi/`; screens:
`apps/web/src/components/features/crm/history/`.

## Reads only

Nothing here writes to Office. Every read goes through `bmi/transport.ts` →
`officeGet(clientKey, endpoint, sessionTag)` (precision-safe
`parseWithRawIds(text, OFFICE_ID_FIELDS)`, 17-digit ids as strings) with a
**stable per-caller session id**: `crm-backfill-<clientKey>` for the backfill,
`crm-delta-<clientKey>` for the delta — never the guest `events` session,
never a clock (tasks/lessons.md 2026-08-25). Fan-out is capped at 2 concurrent
dayPlanner windows and 4 concurrent project/person reads.

## Jobs

Both run through `crm_jobs` (`/api/cron/crm-jobs` every 2 min in production;
`POST /api/admin/crm/jobs/run` or the History screen's **BMI mirror** card on a
preview, where crons never fire).

| kind                  | payload                                 | what one run does                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bmi-mirror-backfill` | `{clientKey, from, until}` (YYYY-MM-DD) | ONE 30-day window: `dayPlanner?resourceIds=<all metadata resources>&from&till&showAll=true` → distinct project ids (`kindId -10` kept and flagged) → ≤ 80 `project/{id}` + `person/{id}` reads per run → upsert. Re-enqueues **itself** (`…:<windowFrom>:d<offset>#<chain>`) until the window's list is done, then the next window (`…:<windowFrom>#<chain>`). |
| `bmi-mirror-delta`    | `{clientKey?}` (omitted = every tenant) | `liveReservations?from=<last ok until − 10 min>&until=<now>` (ET wall clock; the endpoint filters by created/modified stamp) → full detail read per changed id → upsert `source:'delta'`. A complete run enqueues the tenant's next 5-minute bucket (`bmi-mirror-delta:<ck>:<bucket>`), so one director run seeds the chain.                                   |

Every run writes one `crm_bmi_sync_runs` row. `ok = true` on a backfill run
means every detail in that run was read; on a delta run it means every changed
project is in the mirror (a project whose detail read failed is stored from
the live row and named in `error`). The delta's watermark is the `window_until`
of the last `ok` run per tenant.

"Ran" is not a result: check `crm_bmi_sync_runs` (every window `ok`) and
`crm_bmi_projects` counts against Office before calling a backfill done.

## Accounts and contacts

A mirrored host becomes a `crm_contacts` row (matched by `bmi_person_id`, then
`phone_e164`, then `email_key`; a match backfills the person id) and a
`crm_accounts` row: a **business** when the Office person carries a company,
else a **household** keyed `household:<last name>:<phone digits | email |
person:id>` — never the surname alone. `crm_accounts.lifetime_cents` is the sum
of the account's non-cancelled group events, recomputed after every run. The
mirror row keeps `account_id` / `contact_id`.

`leads → bmi` is the declared import direction, so the bmi sub reaches the
leads data module with a dynamic import (`service/deps.ts` `leadsLinker`); the
static graph stays acyclic.

## Routes

- `GET /api/admin/crm/history?q=` — accounts (name / contact / phone digits /
  email) + events matching `q` + the mirror's state.
- `GET /api/admin/crm/accounts/[id]` — one account across every year.
- `GET /api/admin/crm/last-year` — hosts from 3–8 weeks ahead of today, one
  year back, with no later lead (by account / phone / email) and no later
  Office project.

All keyset-paginated, `limit ≤ 200`.

## Not in B1

"Start reach-out" and "New lead" create leads — that rail is the leads PR's
(B3); the buttons render disabled until it lands. The mirror never writes to
Office; C5 owns the write rails.
