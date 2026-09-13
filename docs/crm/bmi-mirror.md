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
project is in the mirror. The delta's watermark is the `window_until` of the
last `ok` run per tenant.

**A project whose detail read failed** is stored from the `liveReservations`
row so the mirror is not blind to the change, named in the run's `error`, and
its id is enqueued as a RETRY (`bmi-mirror-delta:<ck>:<until>:partial`,
`chain:false`). Without that retry it would never be looked at again:
`liveReservations` filters by modified stamp, so a project that changed once
and failed once drops out of every later window. The key is a pure function of
the window, so the retry is created once and `crm_jobs`' attempt cap parks it
if Office keeps refusing. A partial row also resolves the live row's NAMES
back to ids through the tenant's metadata, and stores neither half when it
cannot — the upsert COALESCEs `state_id`, so a fresh `state_name` beside a
stale id would make the row contradict itself.

**Draining the chain.** A backfill run hands back `result.nextPayload`: the
exact cursor the next run needs. In production the cron drains the queue; on a
preview it never fires (`verifyCron` short-circuits), so the History screen's
mirror card posts `nextPayload` back, run after run, until the span is
finished — one press, one finished backfill, nothing left pending. A fresh
`{clientKey, from, until}` always restarts at the FIRST window, so a caller
that ignores `nextPayload` re-reads window 1 forever.

"Ran" is not a result: check `crm_bmi_sync_runs` (every window `ok`) and
`crm_bmi_projects` counts against Office before calling a backfill done.

Proven on production Neon 2026-09-13 (`headpinzftmyers`, 2025-12-01→31): one
window = 3,208 projects — 220 group events read in detail across a drained
chain of four runs, and **2,988 online bookings bulk-upserted** through
`upsertMirrorRowsBulk` (its first execution against Postgres; a second run of
the same window inserted 0). Mirror now holds 220 + 3,319 Fort Myers rows and
84 + 22 Naples rows; every `crm_bmi_sync_runs` row `ok`, no job left pending.

## Accounts and contacts

A mirrored host becomes a `crm_contacts` row (matched by `bmi_person_id`, then
`phone_e164`, then `email_key`; a match backfills the person id) and a
`crm_accounts` row: a **business** when the project names one, else a
**household** keyed `household:<last name>:<phone digits | email |
person:id>` — never the surname alone.

**Where a business name actually lives** (probed live 2026-09-13 at Naples,
because it is not where the plan assumed): an Office **person entity has no
`company` field at all** — its keys are `privateMemo, publicMemo, tags,
memberships, alias, …, name2, free1, free2, kind, …, addresses`. The business
is a SECOND PERSON RECORD and the project points at it with **`companyId`**;
that record's `name` is the company (`5725529` → "Naples Bears", `5638044` →
"Blossom Academy", `5843900` → "Home Team Pest Defense"). Roughly one project
in ten has one. The detail phase therefore reads `person/{companyId}` when the
project names one, and `accountKeyFor` prefers that name over the host's own
(never-present) company field. Two different hosts booking the same company
(Naples had two "Arthrex" events in a month, each with its own `companyId`
record) normalise to one `name_key` and share ONE account.

`companyId` was missing from `OFFICE_ID_FIELDS`, so it parsed as a NUMBER. At
Naples the ids are seven digits and nothing broke; on a 17-digit tenant it
would have rounded and read the WRONG person — the 2026 off-by-one under a new
field name. It is in the list now (`daily-events/data/bmi-office.ts`), pinned
by `bmi/transport.test.ts` with a fixture id that a naive parse corrupts.

That makes TWO B1 hunks in `bmi-office.ts` (C5's file): the optional
`sessionTag` on `officeGet`, and this field. The write side is closed to
match — `projectPutJson` (`lib/bmi-office-actions.ts`) now passes `companyId`
in its raw-id list, so a 17-digit value is injected raw instead of going out
quoted as `"companyId":"630…"`, a shape no proven Office write has sent. Small
ids still leave as numbers, byte-identical to the rails that have always
worked. **Still open for C5:** `fetchProjectRawIds` parses with the DEFAULT
`BMI_ID_FIELDS`, so a 17-digit `companyId` would round on the way IN to
`putProjectFields`; both tenants' company ids are seven digits today.

`crm_accounts.lifetime_cents` is the sum
of the account's non-cancelled group events, recomputed after every run. The
mirror row keeps `account_id` / `contact_id`.

**One index B1 does not own.** `upsertAccountByKey` needs a UNIQUE
`(kind, name_key)` on `crm_accounts` for its `ON CONFLICT`, and `crm_accounts`
is PR1's table (§3.8 lets a later PR add columns to its OWN sub only). B1
creates it in `leads/data/accounts-db.ts` for now, after merging any duplicate
rows (`CREATE UNIQUE INDEX IF NOT EXISTS` does not skip the uniqueness check),
inside its own try/catch so a failure is logged instead of being cached in the
memoised `schemaReady` promise — a rejection there would 500 every account
read until the lambda recycled. **The lead should move this index into PR1's
DDL**, and B3 should know it exists.

## Attribution (the KPI substrate)

`responsible_user_id` is the project's Office `userId`; the screens join it to
`crm_reps.bmi_user_id` for the rep chip and fall back to `responsible_name`.

Two facts, both probed live 2026-09-13:

- **Office user ids are PER TENANT.** At Naples `41096` is Lori and `1559644`
  is Stephanie; the seeded `crm_reps.bmi_user_id` values (`465247` Lori,
  `465242` Stephanie) are Fort Myers ids. One TEXT column cannot attribute both
  centres — the rep chip resolves at Fort Myers and stays blank at Naples until
  `crm_reps` can hold an id per client key. Flagged to the lead; PR1 owns that
  DDL.
- **`getMetadataLookups().userNames` never sees a tenant's own staff.** It
  reads `u.name || u.displayName || firstName+lastName`, and an Office metadata
  user row has only **`username`**, so the map holds the hard-coded Fort Myers
  `USER_NAMES` and nothing else — which is why the first Naples backfill
  mirrored every row with `responsible_name: null`. The CRM fills the gaps from
  the tenant's own `username` (`transport.ts` `tenantFacts`, curated names
  still win) and does NOT change the shared lookup, which the pit board and the
  daily-events screens read. At Naples those usernames are first names, so the
  History rows read "was Lori's" / "was Stephanie's" as the prototype does.

`leads → bmi` is the declared import direction, so the bmi sub reaches the
leads data module with a dynamic import (`service/deps.ts` `leadsLinker`); the
static graph stays acyclic.

## Routes

- `GET /api/admin/crm/history?q=&accounts=0&events=0&status=0` — accounts (name
  / contact / phone digits / email) + events matching `q` + the mirror's state.
  The two lists page with their OWN cursors: `accounts=0` / `events=0` say
  "that list is finished", so a "Load more" for one never re-reads the other
  from its first page (which would render those rows twice). `status=0` skips
  the mirror counts — two unfiltered `count(*)` over a table that runs to six
  figures — so the screen pays for them once per mount, not once per keystroke.
- `GET /api/admin/crm/accounts/[id]` — one account across every year.
- `GET /api/admin/crm/last-year` — hosts from 3–8 weeks ahead of today, one
  year back, who have NOT come back. "Come back" means a lead or a
  non-cancelled Office project (same account / phone / email) dated in the
  current cycle — `window.from + 1 year − 8 weeks` onwards. A booking a
  fortnight after last year's event is not a return: that host is exactly who
  the reach-out is for.

All keyset-paginated, `limit ≤ 200`.

## Not in B1

"Start reach-out" and "New lead" create leads — that rail is the leads PR's
(B3); the buttons render disabled until it lands. The mirror never writes to
Office; C5 owns the write rails.
