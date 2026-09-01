# Kiosk "Your Crew" page — `/kiosk/racers`

**Branch:** `worktree-kiosk-crew-page` (supersedes `feat/kiosk-crew-page`) · **Base:** `7f0b30c35`
(origin/main, 2026-08-31) · **Status:** built 2026-08-31, owner smoke pending

> **2026-08-31 rebase.** This doc was written 2026-08-06 against kiosk 1.16.11 (schema v11); main
> moved ~750 commits (1.30.0, schema v14) before the build started, so the sections below are the
> ORIGINAL plan and several premises have moved. What changed:
>
> - **PR 1 is moot — dropped.** `239af574f` (8/7) landed main's own equivalent of the racer-scan
>   work the day after this was written: `racer` classification (pass 0), the router's `racer` arm
>   with optional `goRacerSignIn`, the people step's `consumeEntryScan("racer")` claim, and the
>   entryscan i18n. `c3a71e11` was never cherry-picked and nothing from it is needed. The
>   `/r/{code}` 404 became a full racer-hub `page.tsx` (via `resolveRacerHub`), and the pass-payload
>   pin lives in `member-qr.test.ts` (+ an end-to-end pin added to `classify-entry.test.ts` now).
> - **PR 2 shipped as kiosk 1.31.0** (this branch), with deltas from the text below: the waiver
>   flow's two-component split is gone on main, but the crew page keeps its own split because its
>   reducer is PERSISTED (a null config must never seed entryBrand/center — H2); the session banner
>   lost its tap-to-cart and now carries `KioskHoldBar` INLINE, so only the WHO half became the
>   door (no nested buttons); the empty state renders in the chooser branch of `KioskFlow`, not in
>   the shared `sessionBanner`; schema is v14 (both surfaces import it from `state/registry.ts`);
>   expect a pre-populated party on mount (the 1.26.0 voucher auto-link rail).
> - **PR 3 stays blocked, premises updated 2026-08-31:** the new onsite Api_External REST surface
>   (31 ops, `docs/intercard-api-external-rest.md`) has NO employee-lookup endpoint — it only
>   *accepts* an asserted `employeeID` (today the constant `WebReload`) and adds a `POST /compcard`
>   token-comp rail. Badge→employee resolution is still the unprobed TPI SOAP op or licensing-DB
>   SQL. The MSR wiring cost dropped (`KioskAdminMsr` is mounted on `/kiosk/admin`). The comp
>   guardrails below are STILL missing and `/api/kiosk/admin action=comp` is live without them
>   (negative amounts pass, arbitrary `depositKindId`, no cap, no audit; `KIOSK_ADMIN_PIN`
>   fallback still `"1185"`) — worth its own small PR regardless of staff mode.

---

## Progress

**PR 1 — racer-scan entry pieces onto main** — ~~dropped~~ landed independently as `239af574f` (8/7)

**PR 2 — the crew page** — DONE 2026-08-31 (kiosk 1.31.0, this branch)

- [x] `apps/web/app/kiosk/racers/page.tsx` — server shell, `isProductPaused("waiver")` gate
- [x] `apps/web/src/features/kiosk/crew/KioskCrewFlow.tsx` — `KioskCrewFlow` + `CrewInner`; `newCrewItem()` in `crew/crew-item.ts`
- [x] `apps/web/src/features/kiosk/i18n/messages/parts/crew.ts` — EN **and** ES
- [x] Register the fragment in `i18n/messages/index.ts`
- [x] `flags.ts` — `kioskCrewEnabled()` kill switch, default ON (`NEXT_PUBLIC_KIOSK_CREW`)
- [x] `KioskFlow.tsx` — session banner becomes a door (3 changes, below)
- [x] `AttractScreen.tsx` — retarget `goRacerSignIn` → `/kiosk/racers` (flag-gated)
- [x] `KIOSK_VERSION` → `1.31.0` + changelog
- [x] Tests: `crew/crew-session.test.ts` (party-never-items + envelope round trip) and the
      AUTHENTICATE end-to-end pin in `classify-entry.test.ts`
- [ ] Verification checklist (below) — owner smoke on a provisioned kiosk

**PR 3 — staff mode + comp** ⚠️ still blocked on a probe (see the rebase note above)

- [ ] PR 3a — probe: TPI `TransactionServerEmployeeAllLocations` (Api_External has no employee lookup)
- [ ] PR 3b — comp guardrails (positive-only, kind allowlist, cap, audit row) — **do this one soon regardless**

---

## Context

Today a racer can only be added to the kiosk **inside a purchase flow**. The roster lives in
`apps/web/src/features/kiosk/steps/KioskPeopleStep.tsx`, which is step 2 of the booking wizard — you
cannot reach it without first picking an activity and seeing prices. Two things fall out of that:

1. A group that walks in wanting to get everyone signed in and waivered **before** deciding what to do
   has no door. They have to fake-start a booking.
2. A racer scanning their wallet racing licence on the attract screen has nowhere useful to land if
   they have nothing booked today. `feat/kiosk-racer-signin` already detects this case
   (`reason: "no-reservation"`) and currently just dumps them on the activity chooser with the code
   stashed — they still have to pick an activity before anything happens.

This builds a standalone `/kiosk/racers` page — "Your Crew" — that does add / remove / sign-in with
**no prices, no cart, no checkout**, then hands the assembled party into the normal flow. It becomes
the landing pad for a scanned racing licence, and later the shell for a staff comp surface.

---

## Where the door goes — no new box

**The persistent session banner becomes the door.** `KioskFlow.tsx:1374` already renders a slim
`k-glass` strip inside `chrome()` on **every** kiosk screen while a session is live — green dot,
"Signed in — **Mike**", plus the hold countdown inline on the right. It is currently a plain
non-interactive `<div>`. Make the left span a button → `/kiosk/racers`.

Why this and not another utility tile:

- **Zero new boxes.** The utility grid is already a junk drawer; it does not need a seventh.
- **It's on every screen, not just the chooser** — `KioskCategories` renders inside `chrome(...)`
  (`KioskFlow.tsx:2095`), and so does every wizard step. A guest three steps into a booking can add a
  racer without losing their place.
- **It is semantically exact.** The banner's one job is saying *who is signed in*. Tapping it manages
  who is signed in.
- **The pattern already exists** — the cart pill is a status chip that is also a door.

Two constraints to respect:

- Owner 2026-08-04 deliberately **stripped the player count** off that line: *"can take out number of
  players from that top line as well as racing on right. Just need to show signed in."* Do **not**
  re-add a count. Keep "Signed in — Mike" and add only a chevron.
- The right side can carry `KioskHoldBar`, which has its own Extend button. **Make only the left span
  a button**, not the whole strip — no nested buttons. Same shape as the promo tile in the utility
  row, where only the label area is a door.

**Empty state.** Today the banner does not render at all when party *and* cart are empty
(`session.party.length > 0 || cartCount > 0 || …`), so a group that just walked in sees nothing. Give
the same strip, in the same place, a "nobody yet" state **on the chooser only**: *"Nobody signed in
yet · Add your people"*. Still zero new boxes — it is the existing element in a state it doesn't
currently have. Keep the existing hide rule for cart / checkout / upsell screens: navigating away
mid-payment is risky and the banner is correctly suppressed there.

```
ANY kiosk screen, once someone is signed in          Chooser, empty session
┌──────────────────────────────────────────┐         ┌──────────────────────────────────────────┐
│ ● Signed in — Mike              5:42  >  │         │ ○ Nobody signed in yet · Add your people >│
└──────────────────────────────────────────┘         └──────────────────────────────────────────┘
     ^ tap the left span              ^ hold bar          ^ same strip, new state, chooser only
     (the ONLY new affordance)          untouched

                              both → /kiosk/racers
┌────────────────────────────────────────────────┐
│  <   YOUR CREW                            [::] │
│      Who's with you?                           │
│                                                │
│  Add everyone who's here. Each person gets an  │
│  account and signs their waiver right now.     │
│  ┌──────────────────────────────────────────┐  │
│  │ MIKE OSBORN                        Main  │  │
│  │ Pro · 12 credits · Waiver OK             │  │
│  │ [licence]                       [remove] │  │
│  ├──────────────────────────────────────────┤  │
│  │ SARA OSBORN                              │  │
│  │ Starter · Waiver OK                      │  │
│  │ [make main]                     [remove] │  │
│  ├──────────────────────────────────────────┤  │
│  │ DAN P.                     needs waiver  │  │
│  └──────────────────────────────────────────┘  │
│  [ + New player ]      [ Sign in ]             │
│  ┌──────────┬──────────┬──────────┐            │
│  │ Phone QR │ Driver's │ FastTrax │            │
│  │          │ licence  │ licence  │            │
│  └──────────┴──────────┴──────────┘            │
│  ════════════════════════════════════════════  │
│  [          BOOK SOMETHING          ]          │
│  [             Start over            ]         │
│  No charge yet — this just gets everyone in    │
└────────────────────────────────────────────────┘
```

Everything inside the roster area is **already built**. The new page is a shell around it.

---

## What the page mounts — the waiver-flow pattern, NOT KioskPartyManager

`KioskWaiverFlow` is the existing precedent for a standalone kiosk page that adds people, and it does
**not** use `KioskPartyManager`. It mounts `KioskAttractionPeopleStep.Component` over a reducer with a
synthetic slug-less item, and its header says exactly why:

> *"Deliberately NOT an extraction: that file is multi-writer-hot (Alex ships to it directly), so the
> waiver flow reuses it through its public StepDef surface and inherits every change for free. The
> synthetic item is a slug-less attraction: no racing age floor, 'Activity Waiver' heading,
> signer-only guardians stay out of the party."*

Copy that. Two concrete wins:

1. **It kills the twin-drift risk.** `KioskPeopleStep` and `KioskPartyManager` are two implementations
   of one screen (`ec927d5d` warns a change to one must mirror the other). Mounting the step means
   there is no twin to mirror.
2. **The racer scan works with zero new code.** PR 1's cherry-pick already puts the
   `consumeEntryScan("racer")` claim *inside* `KioskPeopleStep`. No `claimRacerScan` prop, no new
   effect, no touching a 2404-line multi-writer file.

`StepDef.Component` takes `item` as a **prop** separate from `session`
(`apps/web/src/features/booking/state/steps.ts:35`), so the synthetic item never enters `session.items`
and never shows up as a phantom cart line:

```tsx
<PeopleScreens
  item={newCrewItem()}     // synthetic, prop-only — never persisted, never priced
  session={session}        // the PERSISTED kiosk session
  onChange={() => {}}      // nothing on a synthetic item to patch
  dispatch={dispatch}      // party mutations land in the persisted session
  setBusy={setPartyBusy}
/>
```

This is where the crew page **diverges** from the waiver flow: the waiver flow uses a *local,
non-persisted* reducer because its party must not leak into a booking session. Ours must — that is the
whole point.

---

## Worktree hygiene

This branch has its own worktree because `main` is dirty and several sessions run in parallel:

```
git worktree add .worktrees/crew -b feat/kiosk-crew-page origin/main
```

Branch off **`origin/main`, never local `main`** — at the time of writing local `main` was 34 commits
behind. Hard rules from prior incidents:

- **Edit inside `.worktrees/crew/…`.** A repo-root path silently edits the MAIN tree.
- **Never junction `node_modules`** into a worktree (7/20 wiped the main tree). Run `npm install` in it.
- **Verify the branch before every commit** — a background agent can move HEAD.
- Re-fetch before every push and assert fast-forward; `main` has been force-pushed before (8/5).
- Do not `git stash` and do not `git clean -fd` in this repo — WIP-commit instead.
- Not pushed to `origin` until it becomes a PR (CLAUDE.md § Branch hygiene).

---

## PR 1 — land the racer-scan entry pieces on main

`feat/kiosk-racer-signin` is **73 commits behind `origin/main`** and 6 of its 7 commits are wallet work
main has already superseded. Do **not** merge or rebase it.

**Cherry-pick exactly one commit: `c3a71e11`** ("racers sign in by scanning, from the entry screens").

Expected to apply cleanly: `entry-scan/classify-entry.ts` (+ test), `entry-scan/handoff.ts` (+ test),
`entry-scan/useEntryScanRouter.ts`, `entry-scan/EntryScanToast.tsx`, `checkin/server.ts`,
`checkin/types.ts`, `data/kiosk-checkins-db.ts`, `api/kiosk/checkin/lookup/route.ts`,
`i18n/messages/parts/entryscan.ts`, `components/AttractScreen.tsx`, and the new `app/r/[code]/route.ts`.
Re-verify — that list was measured before the 34-commit catch-up.

Conflicts, all resolved by taking main:

| File | Resolution |
| --- | --- |
| `middleware.ts` | Main already added `/r/`. Drop the branch hunk. |
| `license/types.ts` | Main already has `RACER_LOGIN_CODE_RE`. Take main. |
| `api/kiosk/license-lookup/route.ts` | Main already widened the `memberCode` guard to accept both shapes. **Drop the branch's separate `loginCode` field** — now redundant. |
| `license/lookup-client.ts` | Keep `fetchRacerMatches`, simplify to always post `{ memberCode: handle.code }`. |
| `steps/KioskPeopleStep.tsx` | Hand-resolve around main's wallet-QR chip (`ec927d5d`). **This is the file that carries the racer-scan claim the crew page depends on.** |
| `version.ts` | Rewrite the changelog on top of `1.16.11`; set `KIOSK_VERSION = "1.17.0"`. |

**Keep `app/r/[code]/route.ts`** — `licence-meta.ts:191` sets `licenceUrl: ${base}/r/${code}` and main
only has `/r/[code]/wallet`, so that link on every issued pass is currently a live 404.

> **Correction to the branch's premise, before smoke-testing:** the pass *barcode* carries
> `https://smstim.in/{site}/authenticate/?login_code={code}`, not `/r/{code}`. Main's `parseMemberQr`
> `AUTH_RE` already handles that shape, so `racerHandleFromRaw` resolves it via `parseMemberQr` and the
> `/r/` regex is the secondary path. Add a test pinning the real payload.

---

## PR 2 — the crew page

### New files

**`apps/web/app/kiosk/racers/page.tsx`** — thin server shell, the `app/kiosk/waiver/page.tsx` shape.
Gate on `isProductPaused("waiver")` → `<KioskVendorOutage />` server-side (every add mints a Pandora
person and signs a waiver; with BMI dark there is nothing to sign against, and the page is reachable
by typed URL and by scan).

**`apps/web/src/features/kiosk/crew/KioskCrewFlow.tsx`** — sibling of
`features/kiosk/waiver/KioskWaiverFlow.tsx`, same directory convention. Two components so the persisted
reducer never initializes against a null config:

- `KioskCrewFlow()` — `useKioskConfig()`, `<BrandedLoader>` until config resolves,
  `router.replace("/kiosk")` if it never does, else `<CrewInner config={config} />`.
- `CrewInner({ config })` — owns `usePersistedReducer`, `IdleWatcher`, header, `PeopleScreens`, footer.
- `newCrewItem()` — the synthetic slug-less `AttractionItem`, copied from `newWaiverItem()`.

**`apps/web/src/features/kiosk/i18n/messages/parts/crew.ts`** — `crewEn` + `crewEs`. **Do not touch
`en.ts` / `es.ts`** — a new screen adds a new fragment (parallel-safe).

### Modified files

- **`i18n/messages/index.ts`** — three lines, mirroring the `entryscan` registration.
- **`flags.ts`** — `kioskCrewEnabled()` → `process.env.NEXT_PUBLIC_KIOSK_CREW !== "false"`. Kill
  switch, defaults ON. Never an opt-in `=== "true"` gate.
- **`KioskFlow.tsx`** — three changes:
  1. `sessionBanner` — wrap the existing left `<span>` in a `<button>` → `router.push("/kiosk/racers")`,
     add a trailing `IconChevronRight`. `KioskHoldBar` stays a sibling, untouched.
  2. Render the banner in its **empty state on the chooser** (`!activeItem && party.length === 0 &&
     cartCount === 0`) — same strip, hollow dot, "Nobody signed in yet · Add your people".
  3. `goRacerSignIn` on the `useEntryScanRouter` host → `/kiosk/racers`.
- **`AttractScreen.tsx`** — retarget the cherry-picked `goRacerSignIn` from `/kiosk/flow` to
  `/kiosk/racers`.
- **`version.ts`** — `KIOSK_VERSION = "1.18.0"` + changelog entry.

**`KioskCategories.tsx` and `KioskPartyManager.tsx` are not touched at all.**

### Session sharing — the crux

`/kiosk/racers` is a different route from `/kiosk/flow`, so the party has to survive a navigation.
**Mechanism: mount `usePersistedReducer` with the same `storageKey` and `schemaVersion` `KioskFlow`
uses.** No new handoff module, no manual `sessionStorage` patching.

```tsx
const [session, dispatch, hydrated] = usePersistedReducer(initial, {
  storageKey: KIOSK_SESSION_STORAGE_KEY,   // "kiosk_booking_session"
  schemaVersion: KIOSK_SCHEMA_VERSION,     // 11 — both import from state/registry.ts
});
```

On mount `usePersistedReducer.ts:98-106` dispatches `restoreSession`, which replaces state wholesale —
an in-progress cart, its `bmiBillId`, promos and cursors all survive. The people step's own `dispatch`
calls (`addPartyMember`, `updatePartyMember`, `removePartyMember`, `setContact`) land straight in the
persisted session. **The reducer needs no new action.**

| # | Hazard | Mitigation |
| --- | --- | --- |
| H1 | Schema version drift | Both import `KIOSK_SCHEMA_VERSION` from one file. Cannot drift. |
| H2 | Null config poisons `entryBrand` on first render | Split the component so `CrewInner` only mounts once config is real. Strictly better than `KioskFlow`'s current fallback. |
| H3 | StrictMode double-mount | `didRestore` ref in the hook; `consumeEntryScan` is read-once by design. |
| H4 | Clobbering a cart before hydration | Hook won't write until `hydrated`; also gate the body on `hydrated` so a fast tapper can't dispatch against the pre-restore fallback. |
| H5 | Brief double-mount during `router.push` | Write-effect deps make this a no-op. Note it in the header so nobody "fixes" it. |
| **H6** | **A stale roster inherited by the next guest — names, DOBs, phones, emails** | **Highest severity.** `resetToKiosk` clears only the entry-scan stash. `IdleWatcher.onReset` and Start-over must `await abandonBooking(session)` → `clearBookingSession(KIOSK_SESSION_STORAGE_KEY)` → `resetToKiosk`. `abandonBooking` matters: a guest arriving from the chooser may hold live BMI/QAMF slots (the 7/19 stacked-holds incident). |
| H7 | Back-to-attract leaves the crew behind | Back goes to `/kiosk/flow`, never `/kiosk`. |
| H8 | Synthetic item leaking into the cart | It is a **prop**, never dispatched into `session.items`. Assert this in review. |

### Scan → page → auto-add, end to end

1. `EntryScanListener` → `useEntryScanRouter.handleScan(raw)`
2. `classifyEntryScan(raw)` pass 0 → `racerHandleFromRaw` → `parseMemberQr` `AUTH_RE` →
   `{ kind: "racer", value: code }`
3. `lookupByScan(center, raw)` → `POST /api/kiosk/checkin/lookup` → `lookupMemberMatches` →
   `matchByRacerContacts`
4. **Has a booking today** → `stashEntryScan({target:"checkin"})` → `/kiosk/checkin` *(unchanged)*
5. **`no-reservation`** → `stashEntryScan({target:"racer"})` → `goRacerSignIn()` → **`/kiosk/racers`**
6. `CrewInner` hydrates the session → `PeopleScreens` mounts → **the cherry-picked
   `consumeEntryScan("racer")` block inside `KioskPeopleStep` fires with no new code** →
   `runMemberLookup(handle)` → `fetchRacerMatches` → `POST /api/kiosk/license-lookup`
7. **1 match** → `signInLicenseMatch` → `handleVerified` → `dispatch(addPartyMember)` → persisted.
   **Several** → `LicenseMatchPicker`. **0** → scan note.
8. "Book something" → `/kiosk/flow` → chooser → Racing → people step arrives with the party populated
   and Continue already live.

**Do not mount `EntryScanListener` on the crew page.** Serial opens are exclusive; the people step's
own `useLicenseScan` is the port owner here and already handles both AAMVA licences and member QRs
live — a second racer walking up and scanning works with zero extra code. Put a comment where the
temptation lives.

### i18n

~15 new keys under `crew.*` — header/eyebrow/title, subtitle, empty state, the two CTAs, footer
tagline, the start-over confirm, and the two banner strings. **EN and ES in the same commit** (`es` is
typed `Record<keyof typeof crewEn, string>`, so a missing key fails `tsc`). Everything inside the
roster already comes from `parts/party.ts` — zero new keys there. Glossary nouns (FastTrax, HeadPinz,
Game Zone) stay English.

### Layout

`k-flow` shell, authored in fixed canvas px on the 1080×1920 stage — the `RaceInfoScreen.tsx` skeleton:
`k-flow-head` (96px back button + `k-eyebrow` + `k-display` 74px title) → `k-flow-body kiosk-scroll`
(subtitle + `PeopleScreens` + `k-glass` empty state) → `k-z-actions` (`k-btn-primary` "Book something"
+ `k-btn-ghost` "Start over") → 96px footer band. No `k-z-util` strip, no cart pill, no prices — that
is the whole point of the screen. `IDLE_MS = 120_000`, paused on `partyBusy`.

---

## PR 3 — staff mode + comp ⚠️ blocked on a probe

Owner chose **scan a staff badge** for staff auth (2026-08-06). Right gesture, but it rests on
something this codebase has never executed, so PR 3 starts with a probe, not with code.

**What is actually true today:**

- `docs/intercard-tpi-api.yaml` documents `/TransactionServerEmployeeAllLocations` — lookup by
  `EmployeeCardNumber`, returning `LocationEmployee { EmployeeID, FirstName, LastName,
  IsRedemptionGameAuthorized, CanAuthorizeMidwayGamePlay, AuthorizedLocations }`, plus a supervisor-
  override model (`AuthEmployee`) and a comp-reason enum.
- **Zero employee endpoints are called anywhere in the repo.** It is 28 lines of YAML and nothing else.
- Transport is fine — TPI is SOAP over public HTTPS and
  `src/features/game-cards/data/intercard.ts` already calls that same ASMX host from Vercel with the
  same per-location MAC auth. No bridge needed. *(The XML-over-TCP thing is EIS, a different protocol
  on the center LAN, and it can only load tokens.)*
- **But** the operation is tagged `TS Listings` — *"listings consumed by the on-prem Transaction
  Server."* The cloud ASMX may not route it, or our MAC may lack scope. `intercard.ts` records that
  three envelope shapes were wrong on first attempt against the live service. Do not spec on this
  unverified.
- **A staff badge is indistinguishable from a guest game card at scan time.** Both are corp-6283
  Intercard cards, both encode `;6283=<account>?`, and `EmployeeCardNumber` shares the account number
  space. Worse: today a staff badge scanned at attract matches `CARD_DIGITS_RE`, classifies as
  `game-card`, and **opens the Game Zone token-purchase flow**. Only a server lookup can separate them.
- The **MSR is the right reader** and is fully built (`useSerialMsr.ts`, `parseIntercardSwipe`, emits a
  bare digit string) — but it is mounted only in Game Zone, the gift-card split flow, and
  `/kiosk/admin`. The CRT-591 can read a stripe but **swallows the card** and has documented
  spurious-eject behavior — wrong gesture for a login.

**PR 3a — the probe (cheap, do it first).** `scripts/intercard-employee-probe.mts` calling
`TransactionServerEmployeeAllLocations` against the live ASMX with `INTERCARD_MAC_13` and a real staff
card number. Two outcomes:

- **It routes** → build the badge scan: an MSR listener on the staff screen (sole port owner — nothing
  else may hold that port), and a server route modeled on `app/api/kiosk/gift-card-lookup/route.ts`,
  *not* license-lookup, because "is this number a real employee card?" is exactly the oracle we must
  not offer. Copy its per-seed failed-lookup cap and generic error.
- **It does not route** → fall back to Office ID + per-staff PIN in a new Neon table. Same screens,
  different credential. (`features/daily-events/constants.ts` already holds a ~200-entry Office user
  ID → name directory, refreshed live from `/metadata`.)

**PR 3b — comp, race credits only.** The rail exists: `addDeposit({ personId, depositKindId:
DEPOSIT_KIND.RACE_COMP, amount })`, already wired at `/api/kiosk/admin` `action=comp`. It has **no
guardrails at all** and they land with this work:

- **Negative amounts pass** — the API supports them explicitly, so a typo silently *debits* a guest.
  Positive-only.
- **Any `depositKindId` string passes** from the client — allowlist it.
- No cap — add one.
- **Zero audit rows are written.** `lib/pandora-deposits.ts` asks for this in its own header. Write to
  `admin_action_events`, whose `actor` column exists precisely so per-staff attribution can land
  without a migration.
- `KIOSK_ADMIN_PIN` falls back to the hardcoded literal `"1185"` — **confirm Vercel actually sets it**
  before expanding admin powers.

**Explicitly out of scope**, and why: *attractions* have no comp rail (BMI `voucher/sell` is not
allowlisted in `app/api/bmi/route.ts`, and our native `attraction`/`race` voucher items are coded
`not_redeemable`); *whole-cart comp* lands on the seam where `unifiedReserve` trusts the client's promo
snapshot — the exact shape of the USA250 overcharge — on an unattended public device.

---

## Verification

Static, from `.worktrees/crew/apps/web`: `npm run typecheck` → 0 · `npx eslint <changed>` → no new
warnings (react-hooks rules matter here) · `npm test` · one `npm run build` at the end (runs the a11y
gate via postbuild). Never trust a piped exit code.

New tests: pin the real pass payload `https://smstim.in/908/authenticate/?login_code=…` →
`kind: "racer"` in `classify-entry.test.ts`; a round-trip test asserting a party written at
`KIOSK_SCHEMA_VERSION` survives `readSession`.

Manual, on a provisioned kiosk:

- [ ] **Door, signed-in state** — sign someone in, confirm the banner's left span is tappable on the
      chooser *and* mid-wizard, and that the hold bar's Extend button still works independently.
- [ ] **Door, empty state** — fresh session on the chooser shows "Nobody signed in yet · Add your
      people"; confirm it does **not** appear on cart / checkout / upsell.
- [ ] **Add + persist** — add a new player through photo + signature → DevTools
      `sessionStorage["kiosk_booking_session"]` shows `{"v":11,…"party":[{…}]}` and **no synthetic item
      in `items`**.
- [ ] **Hand-off** — "Book something" → Racing → people step has them already, **Continue live on
      arrival**.
- [ ] **Round trip with a cart** — with a race item held, add a second racer via the banner → cart,
      `bmiBillId` and the hold countdown all survive.
- [ ] **Remove cascade** — remove a racer with a heat assigned → heat unassigns, does not orphan.
- [ ] **Scan → check-in arm** — racer *with* a booking scans at attract → `/kiosk/checkin` *(unchanged)*.
- [ ] **Scan → crew arm** — racer with *nothing* booked scans → `/kiosk/racers` with them already on
      the roster. Back then Forward → **not added twice**.
- [ ] **Scan on the chooser** — same; confirm `KioskFlow`'s `consumeEntryScan("code-entry","game-card")`
      does not eat the payload.
- [ ] **Idle (H6)** — two racers + a held race → let "Still there?" expire → BMI hold released,
      `kiosk_booking_session` gone, next guest sees an empty crew.
- [ ] **Spanish** — `NEXT_PUBLIC_KIOSK_I18N=true` → every string on the page and both banner states are
      Spanish, nothing falls back to English.
- [ ] **Kill switch** — `NEXT_PUBLIC_KIOSK_CREW=false` → banner is not tappable, empty state gone,
      racer scan toasts instead of navigating, typed URL still works for staff.
- [ ] **Vendor outage** — waiver paused → page renders `KioskVendorOutage`.
- [ ] **Regression** — re-smoke `/kiosk/waiver` and the in-flow people step; both mount the same
      `KioskPeopleStep` the cherry-pick edits.

## Residual risks

1. **`consumeEntryScan` becomes variadic.** Grep every caller before merging — an untargeted
   `consumeEntryScan()` anywhere will now swallow `racer` payloads. Single most likely regression.
2. **PII on a shared screen (H6).** The crew page holds names, DOBs, phones and emails outside any
   purchase. Get the clear path right or the next guest inherits it.
3. **Stranded vendor holds** if the reset path skips `abandonBooking`.
4. `removePartyMember` cascades into an in-progress cart — new behavior for a screen showing no cart.
5. **Do not re-add the player count to the banner** — owner explicitly removed it 2026-08-04.
6. Keep the `EntryScanMiss: "racer-signed-in"` union member; still the fallback when the kill switch
   is off.
7. `app/r/[code]/route.ts` is a new public unauthenticated route — confirm the middleware shared-route
   entry covers it on both brand hosts.
