# Cross-rail audit: Pandora ↔ Office/public-booking chains that can break sync (2026-08-12)

Full sweep of production code (`apps/web/{src,app,lib}`, both bridges; scripts/tests excluded)
for sequences that hit the Pandora rail and a cloud rail (Office API / public-booking) back to
back. Five parallel full-file read passes; every finding carries file:line evidence.

**Rail model (grounding):**

- **Pandora** (`bma-pandora-api.azurewebsites.net`) → the center's **LOCAL Firebird**. Even its own
  writes propagate asynchronously (200 before the row lands).
- **Office API** (`office-api22.sms-timing.com`) and **public-booking** (`api.bmileisure.com`) →
  the vendor **CLOUD**. `booking-api22.sms-timing.com` (the `/api/sms` proxy) is a **fourth**
  cloud surface with its own cache.
- The sides converge only via **Fast WSync**: cloud→local lag = minutes (measured ~6 min for
  reservations, 20–25s best case for state); local→cloud can **jam for hours** (one duplicate row
  kills the whole upload batch).
- Verified from code comments, tasks/lessons.md, and the live-verified rails map. Per-endpoint
  store for a few Pandora endpoints (person create/PATCH) is inferred from code comments, not
  re-probed live.

Hazard patterns: **A** write X → read Y expecting visibility · **B** write X → write Y off a stale
read · **C** read X decides a write on Y · **D** fallback split-brain (write lands on a different
side depending on which rail was healthy) · **E** read-merge-write across rails.

---

## TIER 1 — Duplicate-row / WSync-jam generators (divergence writers)

### 1.1 Cloud attach → local schedule, seconds apart — the documented jam class, on THREE rails
- Kiosk check-in: attach [PUB] `src/features/kiosk/checkin/server.ts:1198-1278` → schedule [PAN]
  `schedule-racers.ts` — ladder ≈34.5s vs minutes of lag. **NEW:** straggler re-POSTs are skipped
  entirely when Pandora returns a count-only response (`schedule-racers.ts:158`), and a count is
  trusted as per-racer identity (`:139-141`).
- Booking rail: `checkout.ts:146/1466` registerProjectPersons [PUB] → `kiosk-post-reserve.ts:358-501`
  `/bmi/schedule` [PAN] — 8s sleep + 10/20s re-posts ≈38s (W52504 class).
- Web credit rail: `app/api/booking/v2/reserve/route.ts:908-920` — same shape verbatim.
- **Sweep gap:** `race-session-assign-sweep` (cron */5) draws only from `booking_metadata.heats`
  with a 6h `booked_at` window — check-in-rail failures are NEVER candidates; `listPendingScheduleRows`
  ("PR2 sweep") still has zero callers.
- **`bmi-register.ts:60-127` never inspects the attach response at all** (no `res.ok`, no
  `success:false` check, bare `catch {}`) — a failed cloud attach is invisible, the racer later
  fails local scheduling, staff seat by hand → duplicate pair.

### 1.2 Office heat-retime reconcile invalidates the Pandora insert key mid-session (NEW second entry into the jam)
`server.ts:403-501` — Office [cloud] schedule read re-times Neon heats, resets
`schedule_status='pending'`, NULLs `bound_heats`; `completeCheckin` then re-POSTs the same human
under a **new `(personId|heatStart)` key**, so Pandora's `already_linked` idempotency cannot
dedupe → second local row. Runs outside the bill lock; no freshness check on the Office copy
(which itself lags local staff moves). Twin: `race-session-assign.ts` sweep replays the frozen
Neon `heatStart` forever after a BMI-side heat move — infinite quiet failure.

### 1.3 "Removed from BMI" judged by diffing Office [cloud read] against a public-booking write
`server.ts:1830-1887` + `roster-merge.ts:89-105` — attach happened on PUB, removal "proof" is an
Office read: propagation lag is indistinguishable from staff deletion, and the most recently
attached signers are exactly the ones mid-sync. Dropped guest gets re-typed → `pandoraCreatePerson`
(documented NOT an upsert; "8 records for one kid") → duplicate person → duplicate projectPerson.

### 1.4 Pandora-minted person → immediate PUB attach, terminal failure, manual-only re-driver
Kiosk/at-home waiver join (`app/api/kiosk/waiver/join/route.ts:60-163` →
`bmi-attach.ts:24-97`): local mint is visible on the cloud only after WSync-up (jammable for
hours); lag-failure lands as terminal `'failed'`; the only re-driver is the **manual admin**
`waiver-attach-backfill` route — no cron. Client hook `reservation-join.ts:60-88` treats
`attach:"neon-only"` responses as success and never retries; its idempotency set is per-mount.

### 1.5 waiver-attach-backfill reconcile can itself re-POST a duplicate
`app/api/admin/waiver-attach-backfill/route.ts:118-206` — reconciles against the **Office**
roster while the attach writes **PUB**; an attach from moments ago may be invisible → re-POST.
The route's own comment says duplicate-projectPerson behavior on re-POST is **unproven** (probe
step 4 never recorded).

### 1.6 Rounded 17-digit IDs written back INTO the sync stream
`lib/bmi-attraction-cancel.ts:186-219` — full project GET with **bare `JSON.parse`** → mutate →
`PUT` the ENTIRE project back (bare `JSON.stringify`) → **rounded personId/bill ids land in the
cloud store and then sync down to Firebird**. `toMinimalProject` / `fetchProjectRawIds` exist for
exactly this and are unused here. Aggravator: runs right after the cascade wrote `-4` via Pandora
[local], so the Office GET is stale and the PUT re-asserts a pre-cancel cloud snapshot. 200
trusted, no verify. (Other bare-parse id round-trips — display-only but same class:
`group-function/event-details/route.ts:113,140-144`, `bmi-scan.ts:280-284`.)

---

## TIER 2 — Money decided across rails

### 2.1 group-quote-sync refunds off ONE Office read
`app/api/cron/group-quote-sync/route.ts:248-260` — a single `fetchProject` `stateId === "-4"`
authorizes GC drain + deposit refund + balance refund (Square, irreversible) + cancel + email.
No second read, no local-rail corroboration, no next-pass re-confirmation.

### 2.2 bmi-payment-retry-sweep double-post window
`settleRow` gap = `collected − recorded` where `recordedCents` AND `balanceCents` come from **one
Office snapshot** — a payment taken at the desk (local-first) is invisible until WSync-up, which is
the jammable leg → sweep can re-post money the center already has. `recordProjectPayment` trusts
`status<400` (no ledger re-read) and the row resolves terminally.

### 2.3 Licence gate reads cloud, grant writes local → double-charge / duplicate membership
`race-pack-license.server.ts:56-121` — `personHasActiveLicense` reads Office memberships; the
grant writes a Pandora membership into Firebird. Until WSync-up, the gate keeps saying "needs
licence": a second purchase in the window re-charges $4.99 and writes a **duplicate membership**.
`square/pay/route.ts:405` hardcodes the fallback `true` (unreadable Office record ⇒ charge), by
design. Obligation ledger prevents double-charge per purchaseKey only — not across purchases.

### 2.4 Race credits: cloud decides, local validates+deducts, wrong id space
Coverage decided from Office `deposit/history` ($0 heats in cart); validated + deducted on Pandora
`DPS_OVERVIEW`/`addDeposit(-1)` — with `bmiPersonId` (an **Office localId**) as the Pandora person
key (`race-credit-redeem.ts:114`, `race-credits.ts:271-276`). Production signature: the 9
permanently-parked deposit rows 404ing "No person found with that ID", retried 19,114 times
(`bmi-deposit-retry.ts:186-190`). Validate→deduct window spans the Square charge + PB confirm +
state loop; no balance floor (ledger can go negative); kiosk pack deduct is NOT gated on the grant
outcome (`unified-reserve.ts:3267-3283`); Redis NX idempotency guards fail OPEN.

### 2.5 Stale cloud moneyDue → second payment confirm
`unified-reserve.ts:1554-1570 → 3080-3091` — the PB `moneyDueCents` snapshot is captured
pre-charge and confirmed post-charge; a desk payment that landed local-first makes the bill read
full-due → a second money confirm onto the ledger.

### 2.6 Deposit proxy declares success on ANY 2xx + no idempotency on T_DEPOSIT
`app/api/pandora/deposit/route.ts:127-145` never checks `body.success`/`depositID` (the direct
client `pandora-deposits.ts:171-175` does) → the retry sweep resolves rows on false successes
(`deposit-retry-sweep:78-101`), and `addDeposit` is an unconditional INSERT with no idempotency
key — a timeout retry after a landed write = permanent duplicate row.

---

## TIER 3 — Project-state clobber / split-brain

### 3.1 The `-3` (Pandora, async) vs custom-state (Office) race — mitigation window < measured lag
Documented 2026-07-22 (~80% kiosk bookings reverted). Current reassert windows: 12–16s
(`ensureAttempts 3-4 × 4s`) vs propagation measured at 20–25s (`bmi-cancel.ts:311-314`) and
worst-case minutes. The claim-gate reads Office while the local `-3` is in flight →
`left-alone` silent skip (`vip-state.server.ts:123-128`, `reconfirmBill`); `ensureAttempts`
protects only post-stamp drift, never the skipped stamp.

### 3.2 `setProjectState` split-brain by construction
`bmi-office-actions.ts:207-389` — custom ids: Office-first → Pandora fallback logged
`(fallback, UNVERIFIED)`; built-in ids (`-3`/`-4`): **Pandora-first trusting `res.ok` only, no
`body.success` (`:268`), no verify** → Office fallback. Verify loop reads Office ONLY, so a
Pandora-fallback custom write is judged "NOT landed" (the 2026-08-03 ~88-duplicate-email class);
`observed===null && wroteVia==='office'` is assumed good.

### 3.3 `reconfirmBill`'s naked Pandora state write
`reservation-edit/bmi-sync.ts:110-121` — `fetch(...).catch(()=>{})`: response never inspected at
all. Called from 3 sites, including once **per attraction change** in a loop. (Module header's
"every call lands in the proxy's audit log" is false for this write.)

### 3.4 `express-revoke` — Office read decides, Pandora writes, nothing verifies, and NOTHING CALLS IT
`express-revoke.ts:48-84` — reads Office state, writes `-3` via the unverified Pandora-first path.
Its only caller is a manual script; the promised cron was never built. The express-lane safety
demotion effectively does not run in production.

### 3.5 admin `audit-bmi` recover
`app/api/admin/booking/audit-bmi/route.ts` — GET joins Neon vs Pandora only (cloud-side truth
invisible) and probes Pandora with **`bmiBillId` where the reservation read expects the project
id** (billId+1) — every row may be reading the wrong entity. POST writes a blind `-3` over any
custom state (VIP/kiosk/waiver), trusts `res.ok` (`pandoraSetState:72`), applies ONE `centerCode`
to the whole batch.

### 3.6 `cancelBmiProject` split store
`cancellation/bmi-cancel.ts:254-347` — idempotence check reads Office (`-4` may be cloud-only
while local still holds capacity); when no project resolves, falls back to a PUB bill delete —
but `projectId: undefined` also happens when **Office auth merely failed**, so which store the
cancel lands in depends on Office health. `void publicBillDelete` is fire-and-forget racing the
verify poll. (Counterweight: its 22s Office re-read ladder after the Pandora write is the best
Hazard-A mitigation in the codebase.)

### 3.7 `booking/confirm` route reverts local state from the cloud
`app/api/booking/confirm/route.ts:260-364` — on Redis-cache miss it re-confirms on PUB, which per
its own header reverts `-3` → `-101`: a cloud write silently undoing a local state.

---

## TIER 4 — Memo/notes: three-store read-merge-write

### 4.1 `appendProjectPrivateNote` by construction (Office read → Office PUT → verify → PUB
`booking/memo` REPLACE → verify via Office → Pandora `/memo/private` REPLACE)
`bmi-office-actions.ts:910-1107` — merge base is ALWAYS the Office copy: a note that landed via
PB/Pandora is invisible to the next merge (duplicated once rails converge; lost if replaced), and
local staff text not yet synced up is wiped by the replaces. The PB write is verified by an
**immediate Office re-read** (cross-rail visibility budget ≈0) → false failure → Pandora fires
too: one logical append = three writes on three stores. Callers: kiosk post-reserve (×2 per
booking), check-in, reservations-admin notes (returns `bmiMemoSynced:true` on the unverified
Pandora path and persists that into `admin_actions`), group crons (no `billId` → terminal Pandora
replace).

### 4.2 daily-events `syncBmiNotes`
`daily-events/service.ts:1333-1400` — Office read-modify-PUT of the same private log with **no
verify re-read** (the family's own `noteVisible()` exists 30 lines from the documented no-op
warning), can drop the PB-written `── FastTrax Web ──` tail; fire-and-forget, reports
"Synced to BMI" unconditionally.

### 4.3 `bmi-office-notes.ts` — Redis-only today, `TODO` flush into the same memo field = pre-built collision.

---

## TIER 5 — Identity / id-space (the root cause under Tiers 1–2)

### 5.1 Two person-id namespaces in one field, untyped
`bmiPersonId` (17-digit Office/cloud) vs `pandoraPersonId` (short local). Local-rail writers using
the cloud id unguarded: `race-credit-redeem.ts:114`, `race-pack-grant.server.ts:50`,
`addon-grant.server.ts:76`, `square/pay/route.ts:352`, and **`checkout.saveBookingDetails:352-374`
— the web rail persists 17-digit ids into `racerAssignments` that are later POSTed to
`/bmi/schedule`, which rejects them (a 17-digit id 500s the endpoint); the assign sweep replays
the same payload.** Kiosk rails split correctly (`kiosk-post-reserve.ts:150`; check-in splits
batches at `server.ts:1626-1660`, office-id batch marked UNPROVEN). Read paths fold the two ids
by name; write paths don't.

### 5.2 Cloud ids read against Pandora → false "no waiver / no person"
`valid-count.ts:26-69`, `checkin/waiver.ts:33-71` (location hardcoded FT for all centers),
`waiver-duplicates.ts:22-43`, `checkin-race-flags.ts:187-210` — a cloud-origin or not-yet-synced
person answers `false` → guest re-signs → duplicate person path. `KioskPartyManager` PATCHes a
birthdate then immediately GETs the same record (`app/api/pandora/route.ts:139-185`) — the read
can return the pre-patch state (async propagation) → wrong minor/adult template.

### 5.3 `projectId = billId + 1` is pure arithmetic, never validated on either side before local
writes (`unified-reserve.ts:3099`, `bmi-rebuild.ts:293`, `reserve/route.ts:852`,
`race-confirm-reconcile:89`) — and two implementations differ (`Number(slice(-10))+1` vs
`BigInt+1n`).

### 5.4 `office-search.rankSearchResults` dedupes duplicate accounts by display NAME keeping the
most-recent `localId` — the chosen id feeds the Pandora deposit money path (2.4's 404 signature).
`pre-race-tickets` warms the Office code cache with **Pandora roster personIds verbatim** every
2 min (`route.ts:784-795`), no negative caching.

---

## TIER 6 — Wrong tenant / location on cross-rail hops

- `checkout.ts` omits `clientKey` at `:575` (abandon verify), `:1432` (rebuild liveness),
  `:1465-1466` (rebuild register), `:461` (credit confirm) → Naples bills read/written against the
  FM tenant. Rebuild fail-open (`:1431-1436`: ANY overview error ⇒ "expired" ⇒ rebuild) is a
  duplicate-live-bill generator.
- `unified-reserve.ts:3202-3207` — state-write location chosen by `raceItems.length > 0`: a mixed
  Naples bill sends `-3` to the FastTrax Firebird.
- `bmi-rebuild.ts:329-353` stamps VIP with hardcoded `centerCode:"fasttrax"` while the `-3` went to
  `params.pandoraLocationId`.
- `licence-meta.ts:207` hardcodes the FM Pandora location for all racers;
  `patchBmiPersonPhone` defaults `"headpinz"` while `patchBmiPersonBirthdate` defaults
  `"fasttrax"`; kiosk template route silently defaults an unknown location that the sign route
  refuses (template and signature can disagree about the center).

---

## TIER 7 — Cross-rail read staleness (ops/guest-visible, not directly sync-breaking)

- `qualification-refresh.ts:129-157` merges Office memberships/deposits + Pandora waiver into one
  row that PRICES the kiosk charge (desk-bought licence invisible for minutes → second sale;
  spent credit still shown).
- `race-live-state.server.ts` joins PB bill lines × Pandora sessions on a wall-clock MINUTE; feeds
  the `race-dayof-pay` settle gate and VIP move SMS; an empty-lines 200 is cached as fresh truth.
- `unified-reserve.ts:3102-3122` — `bmi:confirmed` Redis cache is written before the local legs and
  short-circuits retries: a booking whose Pandora `-3`/schedule failed is "successful" forever
  (cron backstops only).
- `checkout.ts` writes on PB and verifies on `booking-api22` (`/api/sms`) — two cloud surfaces
  treated as one store (C1/C2/C3).
- `eticket-removals` pass-3 wide-move guard FAILS OPEN on an unreadable roster
  (`route.ts:273-275`) while `checkin-alerts` answers the same question fail-closed
  (`route.ts:930-942`).
- `stale:true` is set only on the proxy's failure path — a `prefer=cache` HIT (up to 10 min old)
  carries no staleness marker and passes every freshness check.
- `group-event/confirm` PATCHes a phone on Pandora expecting day-of **cloud** readers to see it;
  waiver signed local while cloud reads unsigned until sync.

---

## Consolidated trust-the-200 list (single-rail, found en route)

| Where | Trusted |
|---|---|
| `bmi-register.ts:76-80,119-123` | response never read at all |
| `bmi-office-actions.ts:268` (`viaPandora`) | `res.ok`, no `body.success` — ALL `-3`/`-4` writes |
| `bmi-office-actions.ts:662` (`updateProjectName`) | `res.ok` only |
| `reservation-edit/bmi-sync.ts:110-121` | nothing — `.catch(()=>{})` |
| `reservation-edit/bmi-sync.ts:355-359,469-472` | `removeItem` status only — repo's own "200 ≠ success" rule |
| `unified-reserve.ts:3227` | `stateRes.ok` as "state landed" |
| `admin/checkin/route.ts:228-241` (`checkInViaPandora`) | `res.ok`, no body check |
| `app/api/pandora/deposit/route.ts:127-145` | any 2xx = success |
| `audit-bmi/route.ts:72` (`pandoraSetState`) | `res.ok` (the read 25 lines above checks `success`) |
| `lib/bmi-attraction-cancel.ts:213-219` | `status===200`, full-entity PUT |
| `bmi-office-actions.ts:431-439` (`recordProjectPayment`) | `status<400`, sweep resolves on it |
| `daily-events/service.ts:1383-1396` (`syncBmiNotes`) | PUT status, reports "Synced" |
| `checkout.ts:493` | `removeBookingLine` failure only warned; cart still drives charge |
| `admin/checkin/route.ts:856-884` | headsock `deducted` never set true; RMW no compare-and-set |

## Where the codebase already gets it right (patterns to copy)
`removeProjectPersonRow` (read-delete-verify), `bmi-attach.ts` success rule
(`200 {"success":false}` = failure), `pandora/waiver` salvage-probe retry ladder,
`waiver-attach-backfill` reconcile-before-repost + unreadable≠empty, `valid-count`
never-cache-unreadable, `licence-clear` refuse-to-clear-without-evidence, `cancelBmiProject`'s
22s cross-rail verify ladder, `checkin-alerts` fail-closed express dedupe,
`bmi-confirm.ts:160-162` refusing a 200 without `reservationNumber`.
