# 3CX (`bma.3cx.us`) — what the CRM may actually do

Every statement below was **probed live, read-only, on 2026-09-13** with the
production `THREECX_CLIENT_ID` / `THREECX_CLIENT_SECRET` pair from
`apps/web/.env.local`, before any client code was written against it (brief
§4 C3). Nothing here is inferred from documentation. The probe is the committed
`src/features/crm/calls/service/threecx.ts` `probe()`, invoked through a local
git-excluded `scripts/_crm-3cx-probe.mts` wrapper (R14). **It dials nothing.**

## The credential

`POST https://bma.3cx.us/connect/token`, form-encoded
`client_id` / `client_secret` / `grant_type=client_credentials`.

- **200.** `{"access_token": "...", "expires_in": 60, "token_type": "Bearer"}`
  — the token lives **60 seconds**, which is why `getThreecxToken` caches with a
  10 s early refresh and `threecxFetch` clears the cache and retries once on a 401.
- The JWT decodes to:

  ```
  sub    "vercel"
  scope  "xapi"
  aud    "/api"
  iss    "bma.3cx.us"
  role   ["App", "Reports", "system_owners", "CallFlowApp", "MyPhone"]
  ```

  `Reports` is what makes the call log readable; `App` / `system_owners` is what
  makes Call Control readable. **The API user therefore holds Call Control and
  call-report rights** — the brief's open question ("unknown whether the
  `THREECX_CLIENT_ID` user has Call Control on the sales extensions + call-report
  rights") is answered YES for reads.

## What answered, and what did not

| Call                                                                 | Result               | Used for                                          |
| -------------------------------------------------------------------- | -------------------- | ------------------------------------------------- |
| `POST /connect/token`                                                | **200**              | every call below                                  |
| `GET /callcontrol`                                                   | **200** — 99 DNs     | the extension roster, live parties                |
| `GET /callcontrol/{dn}`                                              | **200**              | one extension's devices/parties                   |
| `GET /xapi/v1/Users?$select=Id,Number,FirstName,LastName`            | **200** — 50 rows    | extension ↔ person                                |
| `GET /xapi/v1/ReportCallLogData/Pbx.GetCallLogData(…)`               | **200** — 500 rows   | **the reconcile job**                             |
| `GET /xapi/v1/ActiveCalls`                                           | 200 (empty at probe) | not used                                          |
| `GET /xapi/v1/Recordings`                                            | 200                  | not used (D7 is open)                             |
| `GET /xapi/v1/CallHistoryView?$filter=SegmentStartTime ge …`         | **500**, empty body  | —                                                 |
| `GET /xapi/v1/CallHistoryView?$top=2`                                | **timeout** (> 15 s) | —                                                 |
| `GET /xapi/v1/CallLogData?$top=1`                                    | **404**              | —                                                 |
| `GET /xapi/v1/ReportCallLogData(periodFrom=…)` (unbound call syntax) | **404**              | —                                                 |
| `GET /xapi/v1/CrmTemplates?$top=3`                                   | **404**              | see "the public routes" below                     |
| `POST /callcontrol/{dn}/makecall`                                    | **not probed**       | click-to-call — a probe would ring a real handset |

### Reading the call log — the only shape that works

`ReportCallLogData` is declared in `$metadata` as an `EntitySet` over
`Pbx.CallLogData`, but the rows come out only through the **bound** OData
function `Pbx.GetCallLogData`, whose twelve parameters are all required
(`<Function Name="GetCallLogData" IsBound="true">` in `/xapi/v1/$metadata`):

```
GET /xapi/v1/ReportCallLogData/Pbx.GetCallLogData(
      periodFrom=2026-09-12T00:00:00Z,periodTo=2026-09-13T23:59:59Z,
      sourceType=0,sourceFilter='',destinationType=0,destinationFilter='',
      callsType=0,callTimeFilterType=0,
      callTimeFilterFrom='0:00:0',callTimeFilterTo='0:00:0',hidePcalls=true)
    ?$orderby=StartTime desc&$top=200
```

`sourceType` / `destinationType` / `callsType` `0` mean "all"; `hidePcalls=true`
drops the PBX's own plumbing. This is `callLogPath()` in `service/threecx.ts`.

`CallHistoryView` (the per-segment view) is **not usable on this PBX** — it
500s with an empty body under a filter and times out without one. Nothing in
the CRM reads it.

### `Pbx.CallLogData` — the fields we rely on

From `$metadata` plus 500 live rows (14-day window):

| Field                                                            | Note                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `CallHistoryId`, `MainCallHistoryId`                             | GUID **per call**; every leg of one call shares it → **the dedupe key**                                |
| `CdrId`                                                          | GUID per leg                                                                                           |
| `CallId`, `SegmentId`, `Indent`                                  | small ints                                                                                             |
| `StartTime`                                                      | ISO instant, UTC                                                                                       |
| `SourceDn`, `SourceCallerId`, `SourceDisplayName`                | on an inbound call `SourceDn` is the **trunk** (`10000`) and `SourceCallerId` is the guest's **E.164** |
| `DestinationDn`, `DestinationCallerId`, `DestinationDisplayName` | on an inbound call `DestinationDn` is the **extension**; on an outbound call the pair is reversed      |
| `RingingDuration`, `TalkingDuration`                             | **ISO-8601 durations** — `PT0S`, `PT1M12.577027S`                                                      |
| `Answered`                                                       | boolean                                                                                                |
| `Direction`                                                      | `Inbound` · `Outbound` · `Internal` · `Inbound Queue`                                                  |
| `CallType`                                                       | `Extension` · `Queue` · `System` · `Digital Receptionist` · `External`                                 |
| `Status`                                                         | `Answered` · `Unanswered` · `Waiting`                                                                  |
| `RecordingUrl`                                                   | a PATH, not a URL — `9027/[Name]_9027-+1239…_2026…(708).wav`                                           |
| `Reason`                                                         | free text ("Ended by …", "… was replaced by …")                                                        |

**One call is several rows.** A guest calling the main line produced, in one
`CallHistoryId`: a `System` / `Digital Receptionist` leg, an
`Inbound Queue` leg on `Call Center (8524)` with `Status: Waiting`, and the
`Extension` leg that was actually answered. `service/journal.ts`
`groupCallLog()` folds them: one `crm_calls` row per `CallHistoryId`, keyed on
the answered extension leg when there is one.

### Call Control

`GET /callcontrol` returns `[{dn, type, devices[], participants[]}]`. Types seen:
`Wextension`, `Wqueue`, `Wivr`, `Wroutepoint`, `Wparkextension`, `Wspecialmenu`.
A device is `{dn, device_id: "sip:6002@…", user_agent: "Yealink SIP-T54W …"}`;
`participants[]` is empty unless a call is live.

`POST /callcontrol/{dn}/makecall {destination, timeout}` is the click-to-call
verb (`Tools-Call-Center/api/3cx/call-action.js` uses the sibling
`/participants/{id}/{action}`). It was **deliberately not probed** — it would
have rung a real handset — so `service/dial.ts` treats a failure as normal:
the Neon `crm_calls` row is written FIRST (R2), and if 3CX refuses, the
response carries `fallback: "tel"` and the sheet hands the rep a `tel:` link
instead of an error. That degrade is tested.

## The two public routes

`/api/crm/3cx/lookup` and `/api/crm/3cx/journal` are two of the three documented
public `/api/crm/**` exceptions (brief R3): the 3CX **server-side CRM
Integration** template calls them from the PBX, which cannot hold an admin
session.

**Which secret transport?** `GET /xapi/v1/CrmTemplates` is **404** for this API
user, so the question "can the template send a custom header?" could not be
settled from the API. Both are therefore accepted and compared against the same
value:

- header `x-crm-3cx-secret: <CRM_3CX_SECRET>` (preferred), **or**
- query `?k=<CRM_3CX_SECRET>` — the same shape the Vox MO webhook uses, and the
  one a template variable can always produce.

`service/secret.ts` `threecxSecretOk()` **fails closed**: when `CRM_3CX_SECRET`
is unset the routes answer **401**, they do not fail open the way `VOX_MO_TOKEN`
does (`app/api/sms-webhook/vox/inbound/route.ts`). A test pins exactly that.
`CRM_3CX_SECRET` is **not set today**, so both routes answer 401 and the Calls
screen shows the banner "3CX journaling is not connected yet".

Once the secret exists, point the PBX's CRM template at:

```
Lookup   GET  https://headpinz.com/api/crm/3cx/lookup?number={Number}&k=<secret>
Journal  POST https://headpinz.com/api/crm/3cx/journal?k=<secret>
         {"callId","direction","number","extension","startedAt","endedAt","duration","status"}
```

**Production host only.** A Vercel preview sits behind Vercel Authentication, so
the PBX cannot reach it (brief §1.12) — the inbound smoke happens after the
merge to `main`, never on a preview.

## Extensions seen on the PBX

`GET /xapi/v1/Users` gives `{Id, Number, FirstName, LastName, EmailAddress}`.
Sales-relevant numbers observed at probe time include `9027` Stephanie
Tajkowski, `9025` Jordyn Button, `9024` Katarina Hagler, `9028` Jasmine Button,
`9029` Mary McDonald, `8041` Paula McGarvey, and the desk DNs `4002` (HeadPinz
Naples Desk 2), `4303` / `4305` (HeadPinz Fort Myers desks), plus the queue
`8524` "Call Center" and the routing IVR `8522`.

`crm_reps.threecx_extension` is the join, and **it is empty in the seed** — the
owner must map each rep to their extension (Statuses screen / seed) before
click-to-call can ring the right handset and before reconcile can attribute a
call to a rep. Until then the CRM still records every external call and matches
it to a lead by E.164; it simply leaves `rep_id` null.

## Open owner decisions

- **D7 — recordings.** `RecordingUrl` is present on answered calls and
  `GET /xapi/v1/Recordings` is readable. The CRM stores the path in
  `crm_calls.recording_url` but **renders no player and no link**: whether staff
  may replay a guest call from the CRM, and for how long recordings are kept,
  is the owner's call. Nothing is exposed until it is made.
- **`CRM_3CX_SECRET`** must be generated (32+ random chars) and added to Vercel
  for `tools-website-ft`, Production scope.
- **3CX admin:** create the server-side CRM Integration template pointing at the
  two URLs above once the secret exists.
