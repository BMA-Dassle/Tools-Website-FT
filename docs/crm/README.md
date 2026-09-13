# Sales CRM — developer notes

The group-events Sales CRM lives in `apps/web` at **`/admin/crm`** (ADR
[0002](../adr/0002-crm-under-admin.md)); `/crm` redirects there. This file is the
build brief's §3 distilled; the brief itself is the contract during the build.

## Where things are

| Layer          | Path                                                                                                                                             | Notes                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Pages          | `apps/web/app/admin/crm/{page,layout,[...view]/page}.tsx`, `app/admin/_tools/crm/AdminToolPage.tsx`, `app/admin/[token]/crm/page.tsx` (307 shim) | `requireCrmUser()` gates every page; `CrmApp` gets the minted API token as a prop                                                      |
| Route handlers | `apps/web/app/api/admin/crm/**/route.ts`                                                                                                         | thin: zod → `withCrmRoute` → service; `runtime = "nodejs"`, `dynamic = "force-dynamic"`                                                |
| Cron           | `apps/web/app/api/cron/crm-jobs/route.ts` (`*/2 * * * *`, `maxDuration = 60`)                                                                    | token-first manual bypass, then `verifyCron`; drains `crm_jobs`                                                                        |
| Feature code   | `apps/web/src/features/crm/<sub>/{data,service,schemas,queries,index}.ts`                                                                        | subs present: `core reps leads activities rules statuses bmi sms email calls collateral cold kpi jobs`; `availability` arrives with C4 |
| Client         | `apps/web/src/components/features/crm/` (`CrmApp.tsx`, `shell/`, `primitives/`, `styles/crm.css`, `lib/crm-fetch.ts`)                            | client modules import `core/{contracts,nav,screens,format,dates,types,centres}` by path, never the `core` barrel                       |
| Wire contract  | `src/features/crm/core/contracts.ts`                                                                                                             | dependency-free; `TEST_IDS`, response shapes, `CRM_API = "/api/admin/crm"`                                                             |
| Tests          | colocated `*.test.ts`; transports under `apps/web/test/msw/`                                                                                     | `msw@2.15.0` per test file (`installMsw(...handlers)`), no global setup                                                                |
| Proof          | `apps/web/e2e/crm-signin.spec.ts`                                                                                                                | `SSO_GATEWAY_DIR=C:/GIT/tools-auth/.claude/worktrees/crm-roles E2E_ADMIN_SSO=1`                                                        |

Import rules: `core` may be imported by every sub; subs import each other only
through `index.ts` and never cyclically (`leads → rules, statuses, bmi`;
`contracts → leads`; `kpi → everything, read-only`). Old code in `apps/web/lib/*`
is reached only from the `bmi`, `sms` and `contracts` transport files.

## Identity

`requireCrmUser()` / `crmUserFromRequest()` (`core/identity.ts`) read the
existing Auth.js session. Roles arrive gateway-stripped: `sales` → rep,
`sales-director` → director, `access` alone → 404. The join key is the
**lowercased email** → `crm_rep_logins` → `crm_reps`; `session.sub` (the Entra
oid) is stored as `crm_reps.sso_sub` on first sign-in and decides nothing.
Directors: Jacob, Eric. Buckets (Guest Services) and holds (Marketing Director)
are `crm_reps` rows a person signs in AS through `crm_rep_logins`.

## API conventions (`withCrmRoute`)

read input (query for GET, JSON body otherwise) → zod (400 `invalid_request`)
→ `isAdminApiRequest` two-branch (body/query `token` beats the `x-admin-token`
header; failure = 404 `{"error":"Not found"}`, byte-identical to the middleware's
own `/api/admin/*` refusal, so `crmFetch` reads either as "credential expired,
reload") → `crmUserFromRequest()` (401 / 403
`session`) → `director` option (403 `director_only`) → handler. A plain object
return is wrapped `{ok:true, …}`; `CrmHttpError` maps to its status; anything
else is a 500 logged with `actor_email`. Every JSON response is
`cache-control: no-store`. Mutations write `crm_audit`. Errors from Office
surface as `{ok:false, error, officePrompt?}`.

PR1 routes: `GET /me`, `GET|POST /settings`, `GET|POST /statuses`,
`POST /statuses/map`, `GET /statuses/office-states?centre=`, `GET /jobs`,
`POST /jobs/run` (`noop`, `seed`; every other kind fails "not implemented").

## Data (30 `crm_*` tables, `core/schema.ts` `ensureCrmSchema()`)

Conventions: `id BIGSERIAL`; **every BMI / Pandora / Square / Graph / 3CX / Vox id
is TEXT**; money `*_cents BIGINT`; `TIMESTAMPTZ`; `archived_at` soft delete;
JSONB for `meta / when / then / lines / raw`; `actor_email` on every mutation
log. Each sub owns its `data/*-db.ts` with a memoised `ensureSchema`; later PRs
only `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in the owning sub. Preview and
production share Neon — every name is `crm_`-prefixed and nothing outside the
CRM reads them.

Seed (`core/seed.ts`, idempotent): 7 reps (`kelsea lori stephanie gs mkt jacob
eric`), 6 logins, 10 statuses, rules R1–R7, templates T-1..T-6, 3 settings. Runs
lazily when `crm_reps` is empty and on demand via `POST /jobs/run {kind:"seed"}`.

## BMI rules that bind every PR

- Read Office through `~/features/daily-events/data/bmi-office.ts` (`officeGet`,
  `getMetadataLookups`) or `fetchProjectRawIds`; read Pandora with
  `parseWithRawIds(await res.text(), [...BMI_ID_FIELDS, "projectID"])`. Never
  `res.json()` / `JSON.parse` on anything carrying an id.
- **One writer per project:** every CRM write of project fields goes through
  `putProjectFields({clientKey, projectId, patch})` in `lib/bmi-office-actions.ts`
  — Redis lock `crm:office:project:<id>` → GET → `toMinimalProject` → the
  existing `putProject` (confirm-once) → verified re-read. Custom states via
  `setProjectState` with the id from `crm_status_bmi_map`; notes via
  `appendProjectPrivateNote` / `updateProjectPublicNotes`.
- Neon first, external second (R2): the intent row exists before the call and
  records the verdict after it.
- Kill switches only: `CRM_BMI_WRITES`, `CRM_BMI_WRITES_OFF_CENTRES`,
  `CRM_SMS`, `CRM_EMAIL`, `CRM_CALLS`, `CRM_AUTO_ASSIGN` — all `!== "false"`;
  `crm_settings.bmi_writes` with **no row = ON** (the screen says "Pause BMI
  writes").

## Jobs

`crm_jobs` is the CRM's own retry table (never `bmi_sync_queue`, which preview
and production share). Lease 120 s, batch 50, 45 s deadline; a failure is
`failed` with backoff `min(600, 30 × attempts)` s, `parked` after
`max_attempts` (default 20). `jobs/registry.ts` has one line per kind; a PR
replaces its own. `POST /api/admin/crm/jobs/run` runs a handler inline (how
previews are smoked — `verifyCron` skips every cron on a preview).

## The public web form (`POST /api/sales-lead/submit`, B3)

v1 alongside v2 (R16): same URL, same request body, same response shape — the
five `SalesLeadForm.tsx` pages are unchanged except where noted below. What the
implementer of any later change must know about that body:

- **The form sends every optional control raw**, so an untouched one arrives as
  `""`, not as an absent key. `WebSubmitSchema` treats `""` as "not filled in"
  (the `blank()` wrapper) — a blank time still falls back to `12:00` exactly as
  the legacy route's `body.preferredTime || "12:00"` did. Never tighten one of
  those fields to reject `""`: it 400s the guest and no `crm_leads` row is
  written (R2).
- **`kind` has three values, not two** — `"group" | "birthday" | "all"`.
  `/group-events`, `/hp/fort-myers/group-events` and `/hp/naples/group-events`
  all render `<SalesLeadForm kind="all">`.
- **`preferredDate` is required.** Pandora's party-lead schema has
  `eventDate: z.iso.date()`, so a blank date has always failed this rail (the
  legacy route forwarded `""` and answered 502). The route refuses it by name
  and the form now gates step 2 on the date, so the guest is stopped at the
  field. A lead whose date is genuinely unknown still cannot be STORED, because
  `crm_leads.event_date` is `NOT NULL` (PR1 DDL) and `CrmLead.eventDate` is
  `string` in the shared vocabulary — making it nullable is a cross-sub change
  (`core/types.ts` + every reader), so it is an owner/lead decision, not a
  B3 edit.
- **"Missing" and "invalid" are different answers.** `classifyWebSubmitIssues`
  decides from the RAW body: a key the guest left blank is missing (legacy
  wording, legacy order), anything present-but-rejected is
  `Invalid fields: …`. A malformed email must never be reported as missing.
- The contract test (`app/api/sales-lead/submit/route.test.ts`) is fed the
  literal object `SalesLeadForm.tsx` builds, empty strings included. Keep it
  that way — an idealised fixture certifies a contract the form never sends.

## Environment

| Variable                                                                                               | Used by                                                                         | Notes                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`, `REDIS_URL`                                                                            | everything                                                                      | shared with the rest of `apps/web`                                                                              |
| `SSO_ISSUER`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, `AUTH_SECRET`                                      | the existing SSO                                                                | no CRM-specific addition                                                                                        |
| `ADMIN_CAMERA_TOKEN`, `ADMIN_API_SIGNING_SECRET`                                                       | `isAdminApiRequest`, `mintAdminApiToken`                                        | never in a client module (`scripts/check-admin-token-leak.mjs`)                                                 |
| `CRON_SECRET`                                                                                          | `verifyCron` on `/api/cron/crm-jobs`                                            | fails OPEN when unset (existing behaviour)                                                                      |
| `BMI_OFFICE_USERNAME`, `BMI_OFFICE_PASSWORD_B64`                                                       | Office reads/writes                                                             | the daily-events transport has a built-in default; `lib/bmi-office-token.ts` also accepts `BMI_OFFICE_PASSWORD` |
| `SWAGGER_ADMIN_KEY`                                                                                    | Pandora (party-lead mint, built-in state writes)                                | B3                                                                                                              |
| `CRM_UNASSIGNED_TEAMS_CHAT_ID` (fallback `CRM_JACOB_TEAMS_CHAT_ID`)                                    | the "Sales Leads - Assignment Pending" card (`leads/service/notify.ts`)         | B3 — sent ONLY for a lead nobody owns (held, or no rule named a rep); unset = skipped with a logged reason      |
| `QAMF_BOWLING_CLIENT_ID/SECRET/SUBSCRIPTION_KEY`                                                       | lane availability                                                               | C4                                                                                                              |
| `VOX_API_KEY`, `VOX_MO_TOKEN`, `SMS_A2P_DID`                                                           | SMS (existing) — rep DIDs live in `crm_reps.vox_did` ONLY                       | C1                                                                                                              |
| `CRM_GRAPH_TENANT_ID`, `CRM_GRAPH_CLIENT_ID`, `CRM_GRAPH_CLIENT_SECRET`, `CRM_GRAPH_WEBHOOK_URL`       | Graph mail (NEW names; never reuse `GRAPH_TENANT_ID`, which is the Teams bot's) | C2                                                                                                              |
| `SEVEN_SHIFTS_API_TOKEN` (or `_ACCESS_TOKEN`), `SEVEN_SHIFTS_COMPANY_ID`                               | shifts mirror                                                                   | B2                                                                                                              |
| `THREECX_CLIENT_ID`, `THREECX_CLIENT_SECRET`                                                           | 3CX call control                                                                | C3                                                                                                              |
| `CRM_BMI_WRITES`, `CRM_BMI_WRITES_OFF_CENTRES`, `CRM_SMS`, `CRM_EMAIL`, `CRM_CALLS`, `CRM_AUTO_ASSIGN` | kill switches                                                                   | unset = ON                                                                                                      |

## SMS consent basis (placeholder — C1 fills the enforcement table)

| Lead source                                      | Text allowed?                                                                    | Basis                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `web`, `phone`, `walkin`, `referral`             | yes, `category:"transactional"` from the rep's DID                               | the guest gave us this number for THIS enquiry                  |
| any source with an inbound message on file       | yes                                                                              | the guest texted us first                                       |
| `cold`, or `is_prospect` with no inbound message | **no** — Call / Email only; the service answers `{ok:false, error:"no_consent"}` | no consent exists; `"marketing"` is always blocked by `voxSend` |
| STOP / START / HELP                              | handled by the existing `/api/sms-webhook/vox/inbound`                           | replies from the DID the guest texted                           |

## Local wrappers (never deliverables)

`apps/web/scripts/_crm-*.mts` are git-excluded and outside tsc. A wrapper is
≤ 20 lines that loads `.env.local` and calls a committed module
(`ensureCrmSchema` + `runSeed`, `listOfficeStateNames`). Everything reachable
from CI lives in committed code and is invoked through `/jobs/run` or a test.
