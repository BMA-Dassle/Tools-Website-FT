# WSync upload wedged by an orphaned participant — 2026-08-16

**Impact:** Fast WSync's **upload** rail (local → cloud) stopped for the whole
Fort Myers center. Nothing originating at the building — walk-in bookings, desk
edits, onsite check-ins — reached the BMI cloud while it was stuck. Downloads
(cloud → local) were unaffected and stayed current throughout, which is why
online bookings kept landing on the grid and the failure was invisible from the
guest side.

**Duration:** first logged error 18:33:40 ET, still recurring at 19:08:25 ET.
Not the first time: the same constraint jammed on 2026-08-11 (see
`tasks/lessons.md`), five days earlier.

**Trigger record:** `T_PARTICIPANT` key **58922217**, version
**13431524507100005**, dangling `F_PRJP_ID` **63000000008522132**.

---

## What the error actually said

```
Table: [T_PARTICIPANT] | Key: [58922217] | Version: [13431524507100005]
FirebirdSql.Data.FirebirdClient.FbException
violation of FOREIGN KEY constraint "FK_PAR_PRJP_ID" on table "T_PARTICIPANT"
Foreign key reference target does not exist
Problematic key value is ("F_PRJ_ID" = 63000000008522132)
  at Fast.Backend.Sync.Lib.Synchronization.Client.ClientOrchestrator
     .<UploadBatchHelperAsync>d__12.MoveNext()
```

Two details in that text are misleading and cost time:

- **`F_PRJ_ID` is not a real column.** The FK's actual child column is
  `F_PRJP_ID`. Grepping for the name in the message finds nothing.
- **The id is not a project.** `FK_PAR_PRJP_ID` points at `T_PROJECT_PERSON`, so
  `63000000008522132` is a **project-person** row, not a reservation.

## Investigation

**1. The id exists nowhere.** Probed every rail:

| Rail                                  | Result                         |
| ------------------------------------- | ------------------------------ |
| Office API (cloud), `headpinzftmyers` | 404                            |
| Office API (cloud), `headpinznaples`  | 404                            |
| Pandora (local), FastTrax FM          | 404                            |
| Pandora (local), HeadPinz FM          | 404                            |
| Public booking API                    | `Entity Bill not found by key` |
| Our Neon                              | no row                         |

**2. It was never a project.** Office `search?token=<id>` returns nothing, and
the id sits _between_ two consecutive reservations with no W-number skipped:

- `…8522128` bill / `…8522129` project = **W61030**, created 2026-08-15 19:35:47
- `…8522130`–`…8522135` — child rows of that transaction ← **`…132` is here**
- `…8522135` bill / `…8522136` project = **W61031**, 19:36:56

So `…132` was one of W61030's project-person rows.

**3. W61030's cloud roster is empty.** `persons=1`, `projectPersons: []`,
`stateId=-4`. The project-person was deleted cloud-side; the local participant
referencing it was not cascaded. Identical to the 8/11 signature (W59894,
`…8105115`).

**4. The row had already been repaired — and it did not help.** Local Firebird
showed `F_PRJP_ID` NULL and `F_PAR_VERSION` advanced from `13431524507100005` to
`13431524534936000`. A full-table orphan sweep returned **zero** rows. Yet the
error kept firing at the _old_ version, because WSync uploads from a queue, not
from current row state:

- `T_PARTICIPANT` — current, repaired, `F_PRJP_ID` NULL
- **`W_PARTICIPANT` — the pending-upload queue, still holding version
  `13431524507100005` with the dead `F_PRJP_ID`** ← the jam
- `X_PARTICIPANT` — audit/history (`F_X_CREATED`, `CF_X_SSE_INFO`), not shipped

Repairing `T_` was necessary and insufficient. The queued revision is what
retries.

**5. Who the row belonged to.** Person `63000000008486055` — a guest seated in an
11-up group heat (session `58599062`), participant created 8/16 12:02 ET. She
remained correctly on the grid throughout; nulling the roster link cost nothing
guest-visible. `CF_X_SSE_INFO` named the sessions that touched the row: created
under a check-in device at 11:15:39, modified from the pit app at 18:20–18:30,
minutes before the first error.

## Root cause

The row is a **hybrid**: `F_BLL_ID` (58922231) and `F_SES_ID` (58599062) are
local 8-digit ids, while `F_PERS_ID` (`63000000008486055`) and the dead
`F_PRJP_ID` are 17-digit cloud ids. A locally-created participant carried a cloud
project-person id that the cloud later deleted.

Pandora's `/bmi/schedule` **already guards this** — its own source calls
`getProjectPersonId(centerIP, prjId, racer.personId)` and skips the racer with
`person_not_on_project` when it misses. But `centerIP` is the tell: it asks the
**center's local** project-person table.

```
cloud-side delete of project-person
        │
        │  ← propagation window: LOCAL copy is stale-PRESENT
        ▼
/bmi/schedule → getProjectPersonId(local) → HIT → writes T_PARTICIPANT
        │
        ▼
delete syncs down, local T_PROJECT_PERSON row removed
        │
        ▼
participant orphaned; its queued W_PARTICIPANT revision violates the FK forever
```

The vendor's check was never wrong. It was pointed at the copy that is stale
during exactly the window in which this can happen. The age gap fits: the
project-person was allocated 8/15 19:36, the participant created 8/16 12:02.

## Fix

Branch `worktree-checkin-roster-guard`, commit `190212778`.

**Ask the cloud, where the delete lands first.**

- `projectRosterCloudBarrier` (`lib/bmi-sync-barriers.ts`) reads `projectPersons`
  from Office. It is the only barrier in that file that asks whether something
  has **gone** rather than arrived — every other one waits for an arrival and
  reads absence as "not yet".
- `partitionByCloudRoster` (`lib/bmi-cloud-roster.ts`) decides who is held. It is
  a leaf module with **zero imports** on purpose: `schedule-racers.ts` must not
  pull in the booking service, and a partial `vi.mock` cannot satisfy exports it
  never listed (this exact edge broke `schedule-sweep.test.ts` mid-build).
- Wired into `schedule-racers.ts` (kiosk check-in) and the
  `race-session-assign-sweep` cron — the two callers that act on reservations
  minutes-to-days old. `kiosk-post-reserve` is deliberately excluded: it seats
  racers moments after creating the reservation, so there is no window for a
  roster deletion, and an Office round-trip there sits in the guest's path.

**Two properties make holding a racer safe:**

1. **Held racers are `waiting`, never `refused`.** The `kiosk-bmi-sync-sweep`
   re-drives waiting rows every 2 minutes, and its Barrier A **re-attaches**
   anyone genuinely missing from the project before re-seating them. Held means
   queued, not dropped.
2. **An unreadable roster disables the guard.** It fails **open** by
   construction — an Office hiccup must never stop a check-in.

**Known false positive, accepted:** a person added at the desk exists locally
before the cloud has them, and while the upload rail is itself wedged that can
persist. They read as "off roster" and are held. Survivable only because of
property 1 above; a guard that _failed_ them would be worse than the jam.

## Also shipped: the Confirmation-Express gate

The state stamp was queued behind `party-ready` — every member local and
waivered — which is true well before anyone is on a grid. Staff read that state
as "here and checked in", so it could still claim work that hadn't finished.

`party-seated` = `party-ready` **plus** every seat verified against Pandora's
session participants.

- **Not our own `schedule_status`.** `server.ts` already warns it "goes stale the
  moment staff" hand-seat someone — gating on it would mean a hand-seated party
  never flips, turning a gate into a permanent block.
- **`race/next` was evaluated and rejected.** Probed live: it 404s
  "No upcoming race found" for a racer demonstrably seated earlier the same day
  (it only looks forward), and returned a **2023** session as "upcoming" for
  another. It answers a different question.

**Shipped as stage 1 of a two-stage cutover.** Consumer support (barrier, queue
type, probe dispatch) ships now; the writer still emits `party-ready`. Preview
and production share `bmi_sync_queue`, so emitting a barrier name production's
consumer does not know reproduces row #170 (2026-08-13, 20 burned attempts).
`seats` is already in the payload — **stage 2 is a one-line flip** of
`barrier:` in `server.ts` once this deploy is live in production.

## Verification

`tsc` clean · 4996 tests pass (341 files) · `next build` clean · a11y gate clean.

New tests cover: a removed racer is absent from the wire payload and comes back
`waiting`/`off-cloud-roster`; no POST at all when nobody is on the roster;
fail-open on an unreadable roster; matching a roster row that carries the racer's
_other_ id form; and `altPersonId` never reaching the vendor.

## Immediate remediation (still open)

The queued row must be made to match the repaired row. Prefer the vendor's
**WSync Fixes** tab; its automatic repair routines were already failing
(`Trying fix [UNQ_TAG_TAG_KIND] returned [False]`), so if it offers nothing:

```sql
UPDATE W_PARTICIPANT
   SET F_PRJP_ID = NULL
 WHERE F_PAR_ID = 58922217
   AND F_PAR_VERSION = 13431524507100005;
```

Better than `DELETE`: the participant still uploads, just without the dead roster
link, matching what `T_PARTICIPANT` already holds. Copy the row out first, and
pin both `AND` clauses so a newer revision can't be caught by accident.

Sweep for others before running it:

```sql
SELECT COUNT(*) FROM W_PARTICIPANT;

SELECT w.F_PAR_ID, w.F_PAR_VERSION, w.F_PRJP_ID
FROM W_PARTICIPANT w
LEFT JOIN T_PROJECT_PERSON pp ON pp.F_PRJP_ID = w.F_PRJP_ID
WHERE w.F_PRJP_ID IS NOT NULL AND pp.F_PRJP_ID IS NULL;

-- the 8/11 jam also orphaned a project-person↔schedule link table
SELECT TRIM(RDB$RELATION_NAME) FROM RDB$RELATIONS
WHERE RDB$VIEW_BLR IS NULL AND RDB$SYSTEM_FLAG = 0
  AND RDB$RELATION_NAME STARTING WITH 'W_'
ORDER BY 1;
```

## For the BMI ticket

Deleting a project-person does not cascade to participants, and `/bmi/schedule`
will attach a new participant to one already deleted upstream because it
validates against the center's local copy. Their own repair routines cannot clear
the result. Twice in five days.

Reproduction: `T_PARTICIPANT` 58922217, version 13431524507100005, dangling
`F_PRJP_ID` 63000000008522132, parent deleted cloud-side from W61030, local row
already repaired but the queued `W_PARTICIPANT` revision still replaying.

Worth asking them directly: **which identity does Pandora's schedule insert stamp
into `CF_X_SSE_INFO`** — the calling device's session, or a service identity? That
one answer decides whether our kiosk or BMI's own check-in app created this row.

## Schema reference (verified live, 2026-08-16)

| Thing                | Real name                                                          |
| -------------------- | ------------------------------------------------------------------ |
| Child table          | `T_PARTICIPANT`                                                    |
| Child PK             | `F_PAR_ID`                                                         |
| FK column            | `F_PRJP_ID` (the error text prints `F_PRJ_ID` — not a real column) |
| Parent table         | `T_PROJECT_PERSON`                                                 |
| Parent key           | `F_PRJP_ID`                                                        |
| Pending-upload queue | `W_PARTICIPANT`                                                    |
| Audit/history        | `X_PARTICIPANT` — **do not modify**                                |

## Probe scripts

Untracked, in `apps/web/scripts/` (main checkout):
`proj-8522132-and-w-frontier.mts` (existence on all rails + ours/cloud/local W
frontier), `proj-8522132-orphan-forensics.mts` (neighbourhood sweep dating the
id), `proj-8522132-classify-id.mts` (what kind of entity an id is),
`proj-8522132-w61030-roster.mts` (the emptied-roster clincher),
`race-next-semantics-probe.mts` (the probe that rejected `race/next`).

**Trap:** Office `search?token=W…` is **fuzzy**. Asking for a W that does not
exist still returns `kind===2` rows for unrelated reservations (`W61280` →
`"Josh Lund (№W48037)"`). Always confirm with `GET /project/{localId}` and require
`project.number` to equal the W you asked for. `wsync-dup-gap-frontier.mts` does
not do this and will over-report the cloud frontier — it reported W61299 when the
truth was W61279.
