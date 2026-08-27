# Open Tasks

## Mega Thursdays, Sep 3 – end of Oct 2026 (2026-08-25) — branch `worktree-mega-thursdays`

Owner: "September 3rd through end of october we're adding mega to Thursdays. So that means no
red or blue." Mega runs the combined circuit, so a Mega day sells Mega products and Blue/Red
do not run at all.

- [x] **One source of truth** — `src/features/racing/mega-calendar.ts`. Dated windows
      (`MEGA_DAY_WINDOWS`): Tuesday open-ended, Thursday `from: 2026-09-03, until: 2026-10-31`.
      `until` is REQUIRED on `MegaDayWindow` so a season cannot silently become permanent.
      Built on `withinRecurringDayRule` (et-time), which gained an optional `until`.
- [x] Twelve hardcoded `Tuesday` checks retired — both `scheduleForDate`s (v2 race-pricing +
      v1 packages), pre-race-tickets cron, camera-assign route + client, signage `demoIsMegaDay`,
      `megaLadder`'s `calendarMega` rung, kiosk attract slide + people-step notice, leaderboards
      fallback, both booking flows' junior guard, homepage alert.
- [x] Copy follows the calendar, not a literal: /racing, home attractions card + Mega alert,
      leaderboards, racing-content constants, racing FAQ, and `MegaTrackDayJsonLd` (one dated
      Event per Mega day, each taking hours from ITS OWN next occurrence).
- [x] Kiosk i18n EN+ES: `stepReason.megaTuesday` → `stepReason.megaDay`, day-neutral in both.
      The day NAME is a glossary proper noun from the window label, not a catalog entry.
- [x] Gates: tsc, 6398 tests (28 new in `mega-calendar.test.ts` + season cases in
      race-pricing), eslint clean on changed files, `next build` + a11y gate green.
      `/`, `/racing`, `/leaderboards` all render `ƒ` so the season flips with no redeploy.
- [x] Proven end to end: sellable tracks go `[Blue, Red]` → `[Mega]` on 09-03 … 10-29 and
      revert by themselves on 11-05.
- [ ] **Confirm with BMI/Pandora that the Thursday Mega sessions exist upstream.** This change
      makes the site sell and query Mega on those Thursdays; the heat picker still gates on BMI
      availability, so if the dayplanner has no Mega Thursday sessions the calendar will show
      those days as unavailable rather than wrong.
- [ ] Owner smoke on the first Mega Thursday (2026-09-03): booking shows Mega only, camera-assign
      shows the Mega chip only, pre-race e-tickets address "Mega Track".

## Kiosk Race Sims placeholder (2026-08-23) — branch `feat/kiosk-race-sims`

Owner: replace Kids Bowl Free on the kiosk with **Race Sims** (racing simulators, FastTrax FM).
Staff-only for ~1 month: guests see a locked "Coming Soon" tile; the kiosk-admin PIN (5 taps on
the tile → PIN sheet) opens the flow for that session. Full booking-session integration
(`racesim` SessionItem kind) with placeholder info; checkout fail-closed until real product ids.

- [x] KBF **disabled, not deleted** (owner correction): one shelf filter in KioskCategories is
      the whole off switch; `?goto=kbf` seed commented; web /book + kiosk check-in untouched.
- [x] Placeholder catalog `src/features/race-sims/products.ts` — 1 Race / 3-pack / 5-pack,
      placeholder prices, Track a/b/c, `squareCatalogObjectId: null` = fail-closed seam.
- [x] `racesim` kind through shared state (types, registries, CartView, getService, cascade),
      KIOSK_SCHEMA_VERSION 13; web STEP_REGISTRY.racesim stays `[]` (kiosk-only).
- [x] Server rail: quote prices from the catalog; guard 2e in `unifiedReserveInner` throws
      `RACESIM_NOT_CONFIGURED` (409) before any Square write on BOTH card + terminal rails.
- [x] Kiosk surface: RaceSimTile (KBF's slot, after the racing tile), PIN sheet
      (`data/admin-pin.ts`), steps racesim-product → racesim-track → kiosk-who, i18n EN+ES
      (`parts/racesim.ts`), `kioskRaceSimEnabled()` kill switch (default ON).
- [x] Tests: catalog, pricing builder, cart readiness, cascade, registry pins. Full suite +
      `next build` green.
- [x] Booking rail (merged to main via f512e12a): gel/laser slots on racing-style $0 track keys
      (one key per track, shared Race Sim resource cap 4), shared Square catalog id ARMED
      (PZXWYNOY4MUAPXACMBMTFYMD), $14 Mon–Thu / $16 Fri–Sun; guard 2e track-aware + refuses
      mixed racesim+HeadPinz carts; packs deferred (`bookable:false`).
- [x] Flow restructured to mirror RACING (owner 2026-08-26, branch `feat/racesim-racing-flow`):
      Who's racing? (whole party, racing semantics, own id `racesim-party`) → Your Info (the same
      ContactStep, forward-skipped) → Race Options → Track (TrackInfoBanner cards) → Time
      (heat-picker layout: 4-col grid, status matrix, capacity bar, tap-to-unpick, 10-min lead,
      cart + existing-reservation conflicts, `heldQty` re-hold when the party changes). Schema v15.
      Omitted as karting-only: pay-mode (until sim packs), Race Video & Extras, licence, age-7
      floor, tier badges. Waiver re-check on advance now blocks sims like racing.
- [x] **ARMED 2026-08-26:** track keys A 59535405 / B 59537905 / C 59537953 + shared page
      59716066 in `race-sims/products.ts` — guard 2e passes; sim singles book + charge for real
      behind the tile's PIN gate. Still unconfirmed: weekend = Fri–Sun; optional resourceId.
- [x] Track switcher on the Time screen + racing's full scheduling rule set on the sim grid and at
      reserve (7d31ec77): heatsConflict spacing (sim label "Race Sim" — 30 min vs karts, skip a
      session vs sims), group-event reopen/window/private-day, cross-reservation guard 0b-sim + cart
      kart↔sim guard, booked-heats returns prior sims. Product page = karting kiosk card (b80666ad).
- [x] LIVE BLOCKER RESOLVED 2026-08-26: "no sessions" was BMI-side — the (Web) keys had no planning
      link to the Race Sim resource; owner fixed it, sessions propose from 08-27 (32/day, cap 4).
- [x] Test kiosk (99, `context.kioskTest`) rolls the sim Time grid to tomorrow when today settles
      empty — racing's rig, amber staff banner, never on real kiosks (5b662135).
- [x] **Multi-session across tracks (owner 2026-08-26, karting parity):** `RaceSimItem.sessions[]`
      (racing's heats[]; {trackKey, slot, slotProposal, bmiLineId, heldQty}) — picks accumulate on
      the Time step, track cards only filter, unpick releases one line, one Square line per session
      × racers, one metadata entry per session. Owner rule: sim-vs-sim = SAME start on any track
      collides ("Picked on Track A"), back-to-back allowed, no gap; sim-vs-kart/attraction/bowling
      keeps racing's 30-min spacing. Conflict label per session = "Track A/B/C" (persisted +
      emitted by raceHeatsForPersonsOnDate). Schema v16.
- [x] Picks BMI stops proposing still render (f42fe7a8): BMI omits blocks with freeSpots < party
      and never returns full blocks, so our own hold hid the selected card and hid "4:15 on A" from
      B's grid — cards are rebuilt from the pick's block ("Picked" / "Picked on Track A").
- [x] Adversarial review (12 agents, 4 confirmed) fixed: party-change re-hold effect deadlock
      (ref-serialized, no cancel flag, unconditional teardown); cart sim↔attraction/bowling spacing
      now server-guarded + web attraction grid sees sim sessions; cart-level sim same-start refused
      server-side; bookRaceSimSessions threads a reparented bill id forward.
- [ ] Owner live smoke on kiosk 99 / FastTrax FM kiosk: tile lock, 5-tap+PIN, party → Race Options
      → Track → Time (tomorrow's grid after close), pick 10:00 A then see 10:00 greyed on B/C and
      10:15 open, unpick releases the BMI line, pay → Square lines per session, BMI lines on the
      Race Sim resource; HP kiosks show no KBF and no Race Sims tile.
- [ ] **Before arming real ids** (all recorded in products.ts header + guard 2e comment):
      decide the vendor booking rail (Square id alone would charge with no reservation);
      fix `resolveLocationId` attribution for mixed racesim+HeadPinz carts; owner prices.
- [ ] Track rotation config (weekly/biweekly lineup) — static Track A/B/C labels for now.
- [ ] Guest launch PR: drop the PIN gate + Coming Soon lock; real track names/photos.

## TVs did not recover from a network loss (2026-08-19) — branch `fix/tv-outage-recovery`

Owner: *"HeadPinz Fort Myers front desk TVs didn't recover nicely from network loss, they
crashed."*

**ROOT CAUSE — the failure is not the outage, it is the NAVIGATION.** Everything on a TV is
built to ride a network loss out: the feed poll keeps its last good answer, the clock keeps its
last offset, `tv_feed_cache:` paints real content on a cold boot. Exactly one thing is not
survivable, and it takes the panel out permanently:

> `window.location.reload()` with the origin unreachable lands Edge on **its own error page**.
> No script of ours runs there, so nothing retries. The launcher's relaunch loop never fires
> either, because **Edge did not exit** — it is alive, showing "can't reach this page". Restoring
> the network changes nothing. Since the shell method replaced explorer.exe there is no desktop
> to fix it from: it is Ctrl+Shift+Esc and Task Manager, at the venue.

Three things reload a TV and **all three were bare navigations**. The dangerous one needs no
network at all to fire: **the nightly recycle** (`recycle.ts`) is purely clock-driven, 02:00–06:00
venue time, and screens provisioned or power-cycled together share an uptime — so they reach the
window inside the same 5-minute check. **An outage overlapping those four hours takes a whole wall
at once**, which is the shape of the report. The other two are the self-update (latches on the
network, then can sit latched for hours behind a briefing hold) and the staff "reload screens"
press (arrives on a feed that may already be minutes stale).

**And the launcher had the mirror-image bug.** `WAIT_FOR_NETWORK` sat **above** `:launch`, so
`goto launch` jumped straight over it — the relaunch after a crash, which is precisely the one
that happens during an outage, went directly onto an error page. It also probed `1.1.1.1`, which
proves the internet is up and says nothing about whether DNS resolves us or Vercel is answering.

- [x] **`reload-gate.ts`** (framework-free, tested) — `originReachable()` probes
      `/api/kiosk/version` (no DB, no vendor, already `no-store`, already polled by every TV);
      `startGatedReload()` holds a wanted reload, retries every 30s, and calls `reload` **at most
      once, only with the origin confirmed up**. A probe that throws counts as unreachable — the
      one outcome to prevent is a navigation taken on a bad assumption.
- [x] **`useGatedReload.ts`** — the five-line React half. `armed` is a latch, so disarming (a
      briefing starts) cancels and re-arming resumes: the existing "held, not dropped" behaviour.
- [x] **All three reload paths wired** — TvShell (self-update **and** the nightly recycle) and
      TvApp (staff press, now latched the same way `updatePending` is).
- [x] **Drift pin** — a test walks `features/signage/**` + `app/tv/**` and fails on any
      `location.reload(` that is not handed to `startGatedReload`. Verified it names the file.
- [x] **Launcher: the network wait moved INSIDE the relaunch loop** (`call :waitnet` at the top
      of `:launch`), both shapes. In the dual script `:launch` is shared by the main path and the
      second board's `watch` re-entry, so one call covers both boards.
- [x] **Launcher: probes OUR origin** via `curl.exe`, falling back to the old ping when curl is
      absent or the URL will not parse. `TV_PROBE` is set **before** the re-entry dispatch,
      because both re-entered processes read it.
- [x] **Launcher: a network watchdog that recovers an ALREADY-DEAD board** — one extra minimised
      process, spawned once, checking every 60s. On the **down→up transition** (two consecutive
      failures, then a success) it `taskkill`s Edge; the main loop's `start /wait` returns,
      `:waitnet` confirms the network, and the board relaunches. Never kills *during* the outage:
      a screen that rode it out is showing its last good board, and recycling it would replace
      that with the launcher's waiting console.
- [x] **`app/tv/error.tsx`** — there was **no error boundary anywhere in this app**, so a scene
      exception handed the wall to Next's white "Application error" until someone drove out. Now:
      venue ground + the house loader (reads as "starting", not "broken"), then a gated reload
      after 8s, with a localStorage circuit breaker (3 crashes / 10 min) so a deterministic crash
      cannot put 19 screens into a reload loop against our own origin.
- [x] **`?debug=1` stops erasing itself** (found smoking the preview in real Edge — the pane has
      never worked on a board). TvApp reads `debug` off the live `window.location.search` on every
      render, and the boot effect replaceStates to the canonical URL, which dropped it: the pane
      painted for one render and vanished. `canonicalTvPath` in constants.ts now carries it, so it
      also survives a self-update reload. `demo` deliberately does not ride along.
- [x] **Smoked on the preview over CDP** (real Edge, share-bypass cookie, build `914f9981`):
      HPFM:2 and HPFM:4 both render their real boards; the debug pane now paints AND PERSISTS,
      reading `feed ok` / `SCENE vip-showcase` / `reloads allowed`; 20s of
      `Network.emulateNetworkConditions offline` and the wall keeps animating and advancing
      scenes with the pane still up; `/api/kiosk/version` throws while offline — which is exactly
      the input the gate refuses to navigate on — and answers with the deployed SHA the moment it
      is back. Zero app console errors (the only ones are the 3cx LiveChat widget's CORS failures,
      pre-existing and unrelated — worth asking separately why a chat widget loads on /tv at all).
      **NOT staged:** the `reloads HELD — waiting for the network` string needs a reload to be
      WANTED while offline, which needs an admin token to press "Reload screens". The policy
      itself is covered by the 12 unit tests.
- [x] **Crash breaker extracted and tested** (`crash-breaker.ts`, 10 tests). The boundary's reload
      is the easy half; the counter deciding when to STOP is the half that can hurt. Writing the
      tests corrected two things: the window SLIDES (clears on the most recent crash, not the
      first — my first test asserted the wrong one and failed), and a FUTURE timestamp is now
      ignored, because player PCs carry the wrong clock and one correction could otherwise latch a
      screen out of recovering for a whole window.
- [x] Gates: tsc clean · **1022 signage tests**, 5749 web tests · eslint 0 errors, zero **new**
      warnings (the `useRef(Date.now())` purity warning in TvShell is pre-existing on origin/main,
      confirmed by linting main's copy) · `next build` + a11y gate exit 0.

**OPEN**

- **No PR yet, and the launcher half needs an ops step.** The app fix reaches all 19 screens on
  the next self-update. The launcher fix does **not** — each player needs its `.bat` re-downloaded
  from the admin page and dropped into `C:\TV\`. Until then those screens keep the old behaviour:
  they will no longer navigate themselves into an outage, but a board already parked on an error
  page still needs a human.
- **Not smoked on glass.** The honest test is: pull the uplink at a player, watch it hold its last
  good board; leave it down past a probe or two; plug it back in and confirm the board recycles
  itself inside ~60s without anyone touching the PC.
- **Two sibling branches are still unmerged and cover adjacent halves of the same subject.** They
  are deliberately NOT folded in here (one PR, one purpose), but neither should be forgotten:
  - `worktree-tv-poll-wedge` (`b95beb9ec`) — a stalled `fetch` has no deadline, so the no-overlap
    poll loop can stop **forever**; and every hide→show flap forks the loop. That is the *other*
    way a wall goes quiet during bad wifi.
  - `fix/tv-poll-when-window-hidden` (`64cf1d918`) — Edge reports a fullscreen player as hidden
    when Windows thinks it is occluded, which stops every poll on the page.
- Not attempted: a service worker serving the cached app shell, which is the only thing that would
  also survive a **cold boot** during an outage (the launcher's `:waitnet` covers that case by
  holding the console instead, which is uglier but honest).

## Old Time Lanes screens (2026-08-19) — ON MAIN + SEEDED, not on glass

Owner ask: two screens at HeadPinz Fort Myers labelled **Old Time Left** / **Old Time Right**,
showing **only the PinBoyz logo on black** for now, **each on its own computer** — plus:
*"only use shell method for all screens."*

**ON MAIN as `55ae3f525`** (commit `4d0f21ddb`, pushed 2026-08-19 from worktree
`.claude/worktrees/old-time-lanes-screens`). origin/main moved TWICE mid-push — 8c6158d07 →
cfe9c683d → c40d1c4dc, both `feat(signage)`/`fix(bowling)` lane-ready work — so this carries two
merges. `types.ts` was touched by both sides and auto-resolved cleanly; gates re-run on the final
merged tree: tsc clean, **1000 tests**, `next build` exit 0, a11y 0, and the screen re-smoked in
real Edge after the merge (identical DOM).

- [x] **`venue-logo` scene** (`SceneVenueLogo.tsx`) — one mark, true black `#000`, nothing else.
      Reads no feed, no scope, no vendor: the one scene nothing upstream can blank. Wired into
      `registry.tsx` (switch + `IMPLEMENTED` + `sceneHasData`).
- [x] **`logo-only` role preset** — logo alone, every interrupt OFF, no `requiresData`.
      Distinct from `ads-only`, which stays the *degraded* fallback.
- [x] **`logo.ts` mark registry** — asset table + `resolveLogoMark`. Only marks we hold artwork
      for are listed; anything unrecognised resolves to the default rather than to a blank screen.
- [x] **Asset** `apps/web/public/promo/pinboyz-logo.webp` — 576×636, webp q92 with alpha, 74KB
      (from 478KB PNG). Served **`unoptimized`**: it is already at source resolution, and
      `images.qualities` is Next 16's default `[75]`, so the optimizer would re-encode a q92
      file down to 75 — a second lossy pass landing on hard black lettering over flat white.
- [x] **Admin form wired end-to-end** — `showVenueLogo` + `venueLogoMark` in `Draft`,
      `newDraft`, `applyRole`, `draftToConfig`, **and `draftFromScreen`** (that last one matters:
      `draftToConfig` REBUILDS the blob, so a field the form does not read back is dropped by
      the next unrelated save).
- [x] **SEEDED** — `signage-provision-old-time-lanes.mts --apply` ran; `HPFM:7` "Old Time Left"
      and `HPFM:8` "Old Time Right". All 12 verify asserts pass. Registry 17 rows → 19.
- [x] **Smoked in real Edge** over CDP against the live rows: exactly one `<img>` at
      `/promo/pinboyz-logo.webp`, natural 576×636 shown at 597×659 (≈1.04× — near native), black
      ground, zero console errors, identity stamps read `Old Time Left · HPFM:7 · v0.8.0` and
      `Old Time Right · HPFM:8 · v0.8.0`.
- [x] Gates: `tsc` clean · **973 signage tests** (22 new) · `next build` exit 0 · a11y gate zero
      violations · zero new lint warnings.
- [x] **ON MAIN** — so `https://headpinz.com/tv?screen=HPFM:7` / `:8` are live once Vercel
      finishes deploying. (Preview URLs are SSO-walled and cannot drive a player; the custom
      domain is the only option.) A ROLLBACK past this point puts both keys back on **house ads**,
      not a blank screen — `isSceneImplemented` makes the scheduler refuse a scene the deploy
      lacks.
- [ ] **Confirm the Vercel deploy went green**, then open both URLs on the custom domain.
- [ ] **Not on glass.** Nothing has been hung or pointed at these URLs yet.
- [ ] Clean up: `git worktree remove .claude/worktrees/old-time-lanes-screens` and delete the
      local branch `worktree-old-time-lanes-screens`.
- [ ] Owner call: the platform's **bottom-right identity stamp** (`Old Time Left · HPFM:7 ·
      v0.8.0`) is on all 19 screens and is still there. "Only a logo" may mean it should go on
      these two — one line in `TvShell` if so.

### Deliberately NOT paired

`pairing` does exactly two things here: it builds the **two-monitor launcher** (`resolvePair`)
and drives content composed across two boards. **Each of these screens is on its own computer**,
so the dual launcher is the wrong file for both — grouping them would put that wrong button on
the admin page and label each as sharing a PC it does not share. Left/right live in the NAMES,
and the provisioning script **asserts neither is paired**. When something genuinely spans the
two, the mechanism is `ScreenConfig.wall` (built for exactly that, and it implies no shared
player) — a one-line change to the script's `PLAN`.

### Shell method is now the ONLY method

Owner: *"I only want to use shell method for all screens."* The Run-key route is **gone** from
the setup steps; both launchers (single and dual) now share one `shellMethodSteps()` list, and
the steps teach **Ctrl+Shift+Esc** (Task Manager is handled by Windows, not the shell, so it
still opens on a machine whose shell is a batch file) **before** the step that removes the
desktop. Also added, because they were missing and the shell method makes them load-bearing:
**autologon via netplwiz** (without it a reboot leaves the wall on the lock screen and the shell
never starts) and an explicit **undo** step. Tests assert the Run key is absent, that the escape
hatch is taught before the shell change, and that the dual steps order `SWAP_SIDES` first.

## Called heat from the venue WebSocket (2026-08-19) — shadow BUILT, needs one race day

Full tracker: **[tasks/venue-called-fast-path.md](venue-called-fast-path.md)**

Getting session status off `races-current-warm`'s once-a-second Pandora poll (**~53,000
calls/day**, over half of everything we send that vendor). Phase 0 is an observer that
writes only `venue:called:*` and is read by nothing.

- [x] `extractSessionCalls`, `venue-called.server.ts`, fourth `after()` in the kart webhook,
      `scripts/venue-called-diff.mts`, 17 tests on verbatim frames.
- [x] Gates answered from HISTORY instead of a race day (owner pushed for this): track 0
      wrong, coverage 91/95 with all four misses inside a dead-bridge window, median 4.8s
      lead, and the first firing is the call — the later ones are re-announcements.
- [x] **Phase 1 BUILT**: merge extracted to one seam, WS writes the carry, loop 1s → 30s
      behind a bridge-health gate and a kill switch.
- [ ] **NOT SMOKED — nothing here has seen a live call.** Watch `[venue-called] CARRY` on the
      next race day, confirm the cron reports `stepMs: 30000`, and check `/bmi/races/current`
      traffic actually drops ~95%.

## Mega session tracker — the return-room pill (2026-08-18) — ON MAIN, NOT smoked

Owner ask: "for mega keep a pill next to the race on what room they will be returning to."

The tracker (a Mega pit sign with `pitMegaRole: "tracker"`, ScenePitBoard → SessionTracker)
pilled the room at **Pit in only**. So on a Mega night — one lane fed by two rooms — a race
wore its room through Holding and In karts, LOST it at the green flag, and got it back
fourteen minutes later. That gap is precisely when staff are deciding which room to clear.

**Root cause:** the stored lane has carried `room` on the racing slot all along (it travels
with the group through the promotion in `resolveLane`); the WIRE projection dropped it.

- [x] `PitLaneFeed.racing.room` added, and `resolveLane` passes `racing.room` through
- [x] `buildStageRail` puts `room` on all four lane rows (Holding / In karts / On track /
      Pit in) — each stage's OWN room, never a neighbour's, because on a busy night those
      four slots hold four different groups briefed in different rooms. Null where it is
      genuinely unknown: a heat only the timing feed put on track, and a hand-placed group
      from Override. The desk stages (Called, Briefing) carry no room at all
- [x] Tracker renders the pill beside the SESSION (after the level) instead of out at the
      right edge, on every lane row — the room is the half of "Session 25" that says whose
      it is. Guarded on `heatNumber != null` so no pill floats beside a "—"
- [x] Tests: 4 new in `briefing/stage-rail.test.ts` (each stage's own room; live-feed-only
      heat has none; hand-placed group has none; desk stages roomless) — verified they FAIL
      without the builder change — plus 2 in `pit/lane.server.test.ts` (the room travels
      onto the track; null stays null)
- [x] Gates: tsc, 5342 tests, eslint (0 new), prettier, `next build`, a11y gate
- [ ] **Smoke on a Mega night**: set a pit sign's `pitMegaRole` to tracker and watch one
      group carry its pill from the seats through the flag to the pit
- [ ] The other rail surfaces (idle pit wall, in-room briefing tablet) now HAVE `row.room`
      and ignore it. Only add it there if staff ask — the room is ambiguous only on Mega

Shipped straight to main as `66a58ee7d` (owner: "you can push this to main when done").

## Kiosk BOWLING check-in (2026-08-16) — BUILT, NOT live-smoked

Owner ask: add bowling to the kiosk check-in flow. Bowling needs NO account/waiver; it
exists only at HPFM + HPN (never FastTrax — duckpin is excluded); the flow must mirror the
web self check-in (`components/bowling/BowlingCheckin.tsx`): names, shoe sizes, bumpers —
the full check-in — then the lane-open the done screen already has.

**Grounding (all read in full):** KioskCheckinFlow.tsx, checkin/{types,server,service,
itinerary,browse-row,express}.ts, kiosk-checkins-db.ts, lookup/complete routes,
BowlingCheckin.tsx (via research), BowlingPlayersEditor.tsx, players + checkin API routes,
KioskBowlingDetailsStep.tsx, qamf-centers.ts, kiosk config.ts/flags.ts, bowling-db.ts
(reservation type, contact/group/short-code lookups), i18n catalog mechanics.

**Key facts driving the design:**

- A bowling-only guest is INVISIBLE to kiosk check-in today, three ways: their `/s/{code}`
  scan resolves no billId (stored URL is `?code=` only), phone lookup drops rows without
  `bmi_bill_id` (server.ts matchByContact), and browse is racing-only by design. Standalone
  HP-wizard bookings never get a `bmi_bill_id`; only unified-cart anchors do.
- The checkin rail is billId-keyed end to end (proof/ref tokens, events table, lock) but
  `kiosk_checkin_events.bill_id` is TEXT and `completeCheckin` already no-ops every BMI
  write when there is no racing — so a second handle kind rides through cleanly.
- Naples kiosks have NO check-in entry today (both doors gated `center === "fort-myers"`).
- Web check-in semantics to mirror: ≥1 real bowler name to finish; name required for any
  bowler holding a shoe size; rentals ≤ shoePairsAllowed (server 422); no edits after lanes
  open (server 409); "Bowler N" placeholders display as empty; bumpers = pure preference.

**Plan:**

- [x] `checkin/res-key.ts` (pure, tested): `bowl:{neonId}` handle helpers + HP-center
      bowling-row predicate (HPFM `TXBSQN0FEKQ11` / HPN `PPTR5G2N0QXF7`; FT duckpin
      excluded — this IS the "never at FT" gate)
- [x] server.ts: `loadSummary` bowl-key branch (anchor = getBowlingReservation, group =
      listCancelGroupReservations, record = null); scan resolution for bowling short codes
      (possession of the emailed/SMS link = proof); matchByContact includes HP bowling
      rows without a bill (dedupe combo legs through their money group); browse regroups
      by money key (deposit order → bill → row, listCancelGroupReservations precedence)
      and includes HP-bowling groups (racing rule unchanged, duckpin/attraction-only
      still excluded); bindPartyMembers/listBindableParty short-circuit on bowl keys
- [x] types.ts + itinerary.ts: `bowlingCheckinEligible` on bowling activities
- [x] `checkin/bowler-details.ts` (pure, tested): prefill mapping (hide "Bowler N"),
      validation (name-with-shoes, allowance), rental count
- [x] `shoe-catalog.ts` extraction (SHOE_SIZES/SHOE_CATEGORIES/categoryOf) shared by
      KioskBowlingDetailsStep + the new screen — kills a would-be third copy
- [x] `checkin/CheckinBowlingDetails.tsx`: kiosk-styled bowler cards (name, Own shoes /
      Toddler / Men's / Women's cascade, bumpers Yes/No, shoe counter), loads players +
      lane phase per eligible reservation, saves via the SAME players PATCH the web uses,
      409 = lanes already open (notice, continue), then hands off to checkInEveryone
- [x] KioskCheckinFlow.tsx: new `bowling` stage. bowling-only → itinerary → bowler details
      → complete → done (party/waiver skipped entirely); racing/attraction combos keep
      party (+assign) and get bowler details LAST before complete; done-screen subtitle
      is bowling-truthful (`checkin.done.bowlingSet`) instead of "front desk knows"
- [x] Doors: KioskFlow chooser + AttractScreen adzone button open at ALL venues (label
      venue-aware: FT keeps "Race Reservation", HP venues say "Reservation Check-In")
- [x] FT-building kiosks NEVER do bowling (owner 2026-08-16: "people being confused if
      they try to do a lane from FT"): lookup carries the kiosk's `venue`; at FT the
      browse list stays racing-only, phone/scan hits on bowling-only reservations answer
      `bowling-elsewhere` → "check in at the HeadPinz kiosks" (never a bare not-found),
      combos check in racing-only (bowler details skipped) and the done screen shows a
      HeadPinz note instead of the lane-open button
- [x] i18n: `checkin.bowl.*` in parts/checkin.ts + `attract.reservationCheckin*` in core —
      EN + ES same commit
- [x] Tests green (189/189 checkin suite incl. 15 new) + `tsc --noEmit` clean + eslint
      clean on touched files. `next build` NOT run this session — multiple agents share
      this working tree and a build would fight their `.next`; run it before commit.
- [ ] LIVE smoke (owner): standalone HP bowling res found by phone AND by scanning the
      confirmation link; names/shoes/bumpers land in Neon + QAMF + shoe KDS; lane opens
      from the done screen; a combo still schedules racers first, then bowler details;
      Naples kiosk now shows the check-in door (new there — was FM-only)

## "In Karts" — a fifth stage, and the rail that makes room for it (2026-08-14) — on `feat/checkin-board-in-karts`, NOT smoked

A group now has a stage between the seats and the green flag. The journey is
**Called → In the room → Holding → In karts → On track**, and a session may still go
straight from Holding to On track — In Karts is a waypoint, never a gate.

**The trigger is the pit station's "Play pre" button** (owner 2026-08-14). The pre-race
announcement is what sends a seated group to their karts, so `playPreRace` moves the lane
itself — same reasoning that put the lane's release on the post-race cue: a press that
makes a noise is a press staff actually make, where a press that only updates a screen is
one they forget (7 "send to holding" presses across 131 room occupancies, 2026-08-13).

**One predicate, two source slots.** `resolveLane` promotes from `karts ?? holding`; the
test for "have they gone out" is untouched, so Holding→Race behaves exactly as before and
Karts→Race is provably the same code path. Every promotion case is asserted twice, once
per slot (`pit/lane.server.test.ts`, 22 cases).

**The desk had to shrink to fit it.** Five panels per room column did not fit a monitor —
the column already needed `overflowY: auto` for the fourth, and a box below the fold cannot
flash for attention (owner: "all states on one screen height wise"). Holding, In karts and
On track are now three rows of ONE panel, **Out of the room**, with the holding camera
spanning the rail at the unchanged `CAM_W`. Called and In the room are untouched — they own
every repeated press and both deadline flashes. Mockup, approved before build:
https://claude.ai/code/artifact/f3551c54-cd0f-4be9-9ea3-58114fe3c964

- [x] `karts` slot on `PitLaneFeed` + stored lane (optional key — lanes written before it
      still resolve)
- [x] `resolveLane` promotes from `karts ?? holding`; clears only the slots naming the
      promoted session, so a group sent to the seats behind a karts group survives
- [x] `markInKarts` — idempotent, frees the seats, refuses a session already racing
- [x] `playPreRace` reads `holding ?? karts` and calls it after the PA and the Neon row
- [x] `sendToHolding` displacement follows the staged group, not the empty seats
- [x] `pitDisplaySession` returns `holding ?? karts` — the wall must not blank when the cue plays
- [x] Desk rail `OutOfRoomPanel` + `StageRow`; per-row badges; empty collapses to one line
- [x] Override slot `"karts"` end-to-end (panel, hook, API, `vacateSessionElsewhere`)
- [x] Pit wall idle list gains an **In karts** row; `downstreamHeats` de-dups on it
- [ ] LIVE SMOKE — press Play pre on a real heat and watch the seats free, the karts row
      fill, and the group promote on the green exactly as a holding group does
- [ ] **Verify the fit on the actual desk monitor**: no `overflowY` scrollbar on either
      column with both tracks busy AND one lane held (the tallest real state)
- [ ] A truthful `in-karts` briefing_events action — deliberately NOT added here; `audio-pre`
      already stamps the moment, and a new enum value wants its own migration

## Pit assignment board — the signage scene (2026-08-13) — BUILT on `feat/signage-pit-board`, not live

Replaces the vendor FTBlueAssignmentTV (an SMS-Timing app on the venue timing server —
zero matches repo-wide, so it could only be replaced, never restyled). Concept mockup
iterated with the owner first (artifact "FastTrax Pit Board"); every decision on it is
recorded there and mirrored in code comments.

**The operational model (owner 2026-08-13):** check-in → briefing → **send to holding**
(new press: frees the room, seats the group) → racing → finish raises the HOLD →
**race returned** (new press: karts fully back in the lane) releases it. The board is
ALWAYS assignment; it holds its session until that session green-flags, then rolls.
Spots come from **BMI's `raceInfo.startPosition`** on the Pandora participants payload
(owner-confirmed field 2026-08-13 — the list the vendor board reads; it was missing from
our canonical `Participant` type, now added). When BMI has gridded, its numbers show
verbatim, gaps and all; rows the grid hasn't placed fall back to the derived rule —
checked-in fill the front in check-in order, no-shows always hold the last slots behind a
solid red ring — numbered past the highest real spot. Full names + photos on this board by
owner decision (the vendor board always showed both); first-names-only everywhere else.

- [x] Pure core `src/features/signage/pit/pit-board.ts` — ordering + rail state machine, tested
- [x] Lane state `pit/lane.server.ts` — Neon-first (briefing_events: `ended/holding`, `pitted`),
      Redis display state, racing resolved via the new `pit:race-started:{sid}` green-flag
      marker written by the timing webhook (race-finish.server.ts)
- [x] Feed: `TvFeed.pitBoard` (roster + camera/birthday/VIP joins) on the 15s poll,
      `pitLanes` on the 2s pulse so staff presses land in seconds
- [x] Camera chips: `viewpointCredit > 0` = has video; join from camera-assign records
- [x] Photo path `/api/tv/pit-photo` — Redis-cached BMI pic, bounded to the session roster
- [x] Scene `ScenePitBoard` + registry + `pit-board` role preset + signage admin checkbox
- [x] Check-in console: "➜ Send to holding" per room, "⏎ race returned" per track
- [x] BMI spot list found + wired: `raceInfo.startPosition` (owner-supplied payload) — the
      derived ordering stays only as the pre-grid fallback
- [ ] LIVE SMOKE — provision a screen on the pit TVs, run a real evening cycle; note WHEN
      BMI mints startPosition relative to the call (fallback covers the gap either way)
- [ ] Consider per-venue caching for `readPitLanes` on the pulse if Redis reads show up
- [ ] Demo mode (`?demo=pit`) for after-hours preview — not built; the board has a designed
      idle state, and live smoke is the real test

## Camera return strip on the briefing TVs (2026-08-12) — ON MAIN `d817e156`, LIVE

Nothing recorded a POV camera coming back: the out-side is the grid scan, the return was
only ever inferred days later when a video turned up. A camera left in a kart looked
exactly like one returned fine, until the next group was handed it. Owner: "when a race
finishes we would turn those camera numbers RED. They would not turn green till we see
them check into one of the systems." Mockup approved before building.

Derived, never remembered — see `src/features/signage/briefing/camera-return.ts` for the
rules and why each exists.

**TWO SECTIONS, and the NEXT RACE BEING CALLED is what moves a camera.** The first cut had
one row of red and green and green did not read — the owner watched six on the wall and
asked what they meant. It also leaned on two invented numbers (a 10-min overdue line, a 90s
green hold); both are gone. INCOMING holds the group just off track, grey until a camera
registers and green once it does; when the next heat on that track is called, incoming
settles — green ones leave, grey ones move left into STILL OUT, keeping their track's colour
and going solid (2026-08-13: they used to turn one alarm red, which lost the where-to-walk
signal exactly when it was needed; red is now only the no-track fallback). Per-track, per-heat
number, off the same `pandora:last-race:*` watermarks the track boards use.

- [x] Day-scoped scan index — `camera-scan-log:{businessDay}`, key/member/TTL **verbatim
      from `02528335`** so `feat/video-liveness-alerts` still merges cleanly.
- [x] `camera-seen:{camera}` off VT3's **registration** time, not the upload (owner: "we're
      watching for the registered time…not waiting for the video to finish upload").
      Measured +2 min median after the flag; 12/12 cameras over three heats.
- [x] Pandora `actualEnd` backstop for the flag — **not optional**: only 5 of 17 already-run
      sessions had a bridge marker on 8/12 (kart heartbeat 23 min stale).
- [x] Periodic backstop for a missed webhook — the 2-min video-match cron stamps every
      camera in its VT3 poll, before its matching loop, so a dropped event self-heals.
- [x] On the 2s pulse (per-venue Redis cache makes it one GET), so a registration clears
      within seconds instead of waiting out the 15s poll.
- [x] Track colour on the calm boxes; solid red reserved for the chase list because Red
      Track's accent IS red. Every box carries a word — "due" / "back" / minutes missing.
- [x] On-track clock moved into the strip's right end — **supersedes** the 8/11 "top right".
- [x] Maintenance bench (`camera_maintenance`, hand-editable) — 3, 6 and 31 on it.
- [x] Kill switch `SIGNAGE_CAMERA_RETURN_ENABLED`, SIGNAGE_VERSION 0.3.0, demo fixtures.
- [x] `scripts/camera-return-peek.mts` — IMPORTS the shipped decision function so it cannot
      drift; splits "came back" from "no finish record yet"; shouts if a benched camera was
      scanned to a racer anyway.
- [x] `scripts/camera-strip-seed.mts` — run ONCE per deploy that introduces either key, or
      the wall fills with red for cameras sitting on the shelf (19 of 42, measured).
- [ ] **ONE LIVE RACE NIGHT on the new two-section model.** The single-row version ran live
      8/12; the sections, the grey state and the next-race-call rule have not.
- [x] **EIGHT dead cameras benched 8/12** — 3, 6, 31, 44, 55, 58, 84, 91. Each confirmed by
      ZERO rows in `video_decision_log` over 30h under EITHER identifier
      (camera_number OR system_name) while the pipeline logged 1,447 rows across 75
      cameras — so silence is meaningful, not a keying artefact. Every one of their
      `camera-seen` stamps came from a staff RE-SCAN, never a registration: handed out,
      handed back, never filming. 58/84/91 are the units flagged after 8/9 W57384.
- [ ] **THE REAL COST, and the reason camera-assign needs a guard: 349 races in 14 days
      were filmed by nothing.** Handouts per camera over 14 days: cam 3 = 88, cam 58 = 87,
      cam 84 = 75, cam 31 = 52, cam 44 = 42 (those five are 344 of the 349); 6/55/91 are
      1-2 each. Benching hides them from the WALL but does not stop staff scanning them
      out — 11 racers were given a dead camera on 8/12 alone. The camera-assign page
      refusing or warning on a benched camera is the actual prevention and is now the
      highest-value item in this whole feature.
- [ ] ~~Six dead cameras found on night one~~ superseded by the two items above: — 84 (89d), 3 (84d), 44 (61d), 58 (31d),
      31 (18d), 6 (8d) silent, out of 69 in rotation. 3/6/31 benched; **44, 58 and 84 are
      the owner's call.** 58 and 84 were flagged for a bench check after the 8/9 W57384
      incident and never actioned — a reason to merge `feat/video-liveness-alerts`.
- [ ] **Camera-assign should refuse/warn on a benched camera.** Three of them were scanned
      to five racers on 8/12; hiding them from the wall is right, but this is the actual
      prevention. Small change to that page.
- [ ] Probe `sys.vt3.io` for a camera/system status collection — owner asked to "check the
      socket for cameras"; VT3 creds are Vercel-only so it could not be run locally.
      `scripts/_vt3-camera-surface-probe.mts` is written and ready to run where they exist.
- [ ] The same strip on the camera-assign station, which is where cameras go OUT. Higher
      operational value than the briefing TVs; deliberately a separate PR.

## Check-in board: room camera, overdue flashing, and the briefing LOG (2026-08-12) — ON MAIN

Owner's live pass over `/admin/{token}/checkin?board=1` while the venue was open. All of it
landed in one push; the insurance log is the part that matters beyond today.

- [x] **In the room is two columns** — session + clocks LEFT, camera RIGHT. The bottom rail
      (progress, its caption, Restart) is flush with the bottom of the picture, which needed
      the row to stop inheriting the panel's growth (it was aligning to the panel edge, so
      it lined up with nothing).
- [x] **The preview says it is clickable at rest** — pill + ring + zoom cursor, no
      hover-only affordance (the desk monitor is a touch screen). Click opens ONE
      full-screen viewer at 1600px: Red/Blue switch, the clocks, and Start / Restart, so
      staff can watch a room fill and roll the film without closing it. The small preview
      stops polling while it is open (the proxy's frame cache is keyed by device AND size,
      so two pollers = two upstream pulls/sec at the same camera).
- [x] **"FREE" is now earned, not assumed** — an idle room whose group is out counts them
      back off the live on-track clock: `BACK IN 4:12` → `RETURNING NOW` → `FREE` (owner:
      free ~1 min after the flag). Rules + bounds in `briefing/room-return.ts` (19 units).
      Heat-number match keeps two Mega rooms from both claiming one race; a later heat on
      track, an end stamp, or a 45-min window each close the claim, and Undo revokes it via
      the session's briefed marker.
- [x] **Overdue boxes flash** — In the room amber >3 min waiting, red >5, with "Video never
      started for Session N" across the bottom of the box. Called flashes through the last
      minute of the check-in window and red once past it, reading `checkinWindowMins` from
      the TRACK BOARDS' own signage config (8 today, both tracks) so desk and wall escalate
      on one deadline. Thresholds pure + tested (`briefing/desk-alerts.ts`, 10 units).
- [x] **INSURANCE LOG (Neon)** — new append-only `briefing_events`: sent / started /
      restarted / ended, carrying which film and its length. Time in the room and "did the
      film finish" are DERIVED (`briefing/briefing-log.ts`, 13 units), never stored, and the
      common no-explicit-end case closes off the film's own length + the helmet phase — so
      no cron. Written before the Redis state at all three call sites; a write failure fails
      the action rather than proceeding unrecorded. Surfaced as the board's "Briefing log —
      today" strip so staff can see it landing, and readable per session from
      `apps/web/scripts/briefing-log-peek.mts`.
- [x] **The board self-updates** — `src/hooks/useBuildUpdate.ts` polls the deploy sha every
      2 min; the board hard-reloads after one unbroken quiet minute (no scan, no pending
      action, no viewer, no settings sheet) and offers a "New version ready — reload" pill
      meanwhile. Safe here because the scanner re-attaches from `getPorts()` with no user
      gesture and all board state is server-polled.
- [ ] **OWED: one live send through this build** to see the log strip fill (writes only
      happen on a real Send/Start — today's earlier sends predate the table).
- [ ] **OWED: guest-facing smoke of the camera viewer** on the real desk monitor (local dev
      has no `NX_CLOUD_*`, so the frame is blank off Vercel).
- [ ] Consider: the camera-monitor TV's big pane still shows the ON-TRACK clock while a
      briefing is live; the briefing session + film countdown are only the small strip over
      the camera. Owner saw it and moved on — offer the swap if it comes up again.

## Video match three-leg contract (2026-08-10) — A + C BUILT & PUSHED, B deferred

Spec: [video-match-plausibility-spec.md](video-match-plausibility-spec.md). From the 8/9
W57384 VIP incident (95 wrong-footage matches day-wide, 87 SMS-delivered). Owner approved
A + C 8/10; B (liveness alerts) deferred; A4 self-heal pulled out of PR A on owner's size
concern.

- [x] PR A — `feat/video-match-plausibility` PUSHED: plausibility gate in
      `matchVideoToAssignment` (per-candidate skip so the walk continues to the true
      owner), verdict = midpoint-or-containment (bare overlap disqualified — 12 of the
      8/9 wrongs edge-clip past it, incl. all 8 red-h16→h17 mis-sends), ladder actuals →
      start-only → scan-anchor, `implausible-window` review reason + admin chips,
      session-actuals write-through, kill switch `VIDEO_MATCH_PLAUSIBLE`. 15 new units;
      replay on real 8/9 corpus (`scripts/video-plausibility-replay.mts`): 447 plausible /
      94 implausible / 23 unknown, named cases + stolen-video redirect proofs PASS
- [x] PR C — `feat/camera-assign-heat-guard` PUSHED (8ad938f5): late-aware picker
      (earliest heat with no actualStart, 30-min grace) + `expectedNext` on /session +
      orange wrong-heat banner blocking scan binding until switch-or-confirm
- [ ] MERGE both + one shadow-watch night (`video-match-shadow.mts --watch`): wrong-window
      auto-sent must be 0
- [ ] PR A2 follow-up (deferred from A): self-heal displacement of implausible occupants —
      after a week of clean metrics
- [x] PR B — `feat/video-liveness-alerts` PUSHED (02528335; owner un-deferred it 8/10
      "make it permanent" after Garry Cooley + 19 live wrongs on 8/10): /api/cron/
      video-liveness every 5 min — wrong-window (email; post-PR-A this is the gate-
      regression alarm), zero-scan heats (radio+email within 5 min of launch), silent/
      dead cameras (radio at ≥3/heat; nightly 10 PM digest lists bench-check units) +
      camera-scan-log:{businessDay} zset. 17-agent adversarial review confirmed 6 defects
      in the first cut (midnight business-day math, systemNumber vs cameraNumber keys,
      stale scan-log after redo, dedupe-before-dispatch, SCARD-null-as-zero, radio noise)
      — all fixed, 15 units green. Kills: VIDEO_LIVENESS_ALERTS / \_RADIO
- [ ] SEPARATE + time-boxed: manual reassign of the 8/9 recoverable videos before VT3
      expiry ~8/22 (codes in memory `project_vip_0809_video_cascade`)

## Site nav rode along onto /waiver from the FastTrax menu (2026-08-07) — DONE

**Report:** clicking Waiver in the fasttraxent.com menu renders the site menu bar over the
waiver screen; a hard refresh removes it. HeadPinz behaves.

**Cause:** `app/layout.tsx` decides the chrome from middleware's `x-no-chrome` /
`x-no-mobile-bar` headers, and a root layout does not re-render on client-side navigation
(Next.js partial rendering). The entry page's decision was frozen for the whole visit. The
HeadPinz nav comes from the per-section layouts under `app/hp/`, which unmount on
navigation — so the same defect was invisible there.

- [x] `apps/web/src/lib/constants/chrome-routes.ts` — one pure registry: which paths are
      chrome-free, which only drop the mobile Book-Now bar, plus `chromeFlagsForPath()`
      mirroring the layout's own booleans. Unit-tested (14 cases).
- [x] `apps/web/src/components/layout/ChromeGate.tsx` — client gate; uses the server's
      answer for the entry path (so hydration matches even under the `/hp` rewrite) and
      re-derives from the registry on every navigation after it.
- [x] `apps/web/app/layout.tsx` — every chrome slot (Nav, Footer, mobile bar, chat +
      3CX call-us, mini-carts) goes through the gate.
- [x] `apps/web/middleware.ts` — all the per-host path lists collapse into
      `applyChromeFlags()` over the shared registry, so server and client can't drift.
- [x] Both ad popups suppress themselves on chrome-free screens via the same registry.

**Verified:** Chromium against the dev server, 9/9 checks — nav/footer/chat gone after the
menu click, identical to a hard refresh, chrome returns on Back, HeadPinz unaffected, no
hydration errors. The same script on the pre-change tree fails exactly the reported checks
(4/9), which is the reproduction.

**Two deliberate behaviour changes** that fall out of unifying the lists: HeadPinz booking
confirmations now drop the mobile Book-Now bar (FastTrax already did), and the chrome-free
screens (`/waiver`, `/join`, `/r/`, `/passes/`, `/july4`) can no longer show the VIP or
Naples ad popups after a client-side navigation. The FastTrax/HeadPinz mobile bar also
returns correctly now when a guest navigates OFF a bar-less page that keeps its nav
(`/racer`, confirmations) — before, the bar stayed off for the rest of the visit.

**Found while fixing, NOT fixed here (needs its own PR):** every `/hp` page renders the
HeadPinz mobile Book-Now bar TWICE — once from `app/layout.tsx` (`showHpChrome`) and once
from `app/hp/layout.tsx`. Confirmed on `/fort-myers` before and after this change, so it
predates it. Two stacked identical fixed bars, two click targets. The fix is to delete one,
almost certainly the one in `app/hp/layout.tsx`, after checking every `app/hp/**/layout.tsx`
for the same duplication.

## FastTrax operational changes — new Mon–Fri hours + Mega is Junior Pro only (2026-08-05)

Two owner-announced operational changes, both landing **2026-08-10**:

1. **Mon–Fri open moves 1:00 PM → 3:00 PM.** Sat/Sun (11 AM) and every closing time
   are unchanged.
2. **Mega days run Junior Pro races only** — no Junior Starter (never existed in BMI)
   and no Junior Intermediate (retired). Consequence: a junior must qualify all the
   way to Junior Pro on a split-track day before they can race a Mega Tuesday.

### Hours — one registry, effective-dated (not a flip)

The same four hours lines were hardcoded in five display surfaces plus two
behavioural ones. A plain edit would have published the NEW hours during the five
days we still open at 1 PM. So `apps/web/src/lib/constants/fasttrax-hours.ts` is now
the single source of truth and every consumer asks for the hours **on a date**:

- [x] `fasttrax-hours.ts` — `SCHEDULE_ERAS` (newest first) + formatters + week
      grouping + the schema.org opening-hours builder. Next hours change = one entry.
- [x] Marketing surfaces read TODAY in ET: `components/Nav.tsx`,
      `components/Footer.tsx`, `components/home/Attractions.tsx` (hours pills),
      `components/seo/JsonLd.tsx` (LocalBusiness + Restaurant + Mega Tuesday event
      start/end), `app/racing/layout.tsx` (the rainy-day FAQ hours sentence).
- [x] `app/api/pandora/races-current/route.ts` — live-races operating window takes its
      OPEN from the registry; the deliberately generous close-side grace stays local.
- [x] `race-restriction-rules.ts` — the opening-heats express-only window is anchored
      to the venue open time **for the heat's own date**, not "now". A heat on Aug 8
      keeps the 1:00–1:24 PM window while a heat on Aug 11 gets 3:00–3:24 PM; both
      correct at the same instant. (`openingWindowExpressOnly.windows` →
      `windowsForDate(isoDate)`.) Without this the rule would have silently stopped
      firing on weekdays — 1:00 PM would have had no heats in it.
- [x] Verified: rendered copy is byte-identical to the live site before 8/10
      ("Mon–Thu: 1:00 PM – 11:00 PM" …) and flips on the 10th. Every route builds as
      `ƒ` (dynamic) — the root layout's `headers()` call means no redeploy is needed
      for the switchover.

### Mega = Junior Pro only

- [x] Catalog is the functional truth: **Junior Intermediate Race Mega removed** —
      `24966320` (new) + `43732358` (existing) — from
      `src/features/booking/service/race-products.ts` AND v1 `app/book/race/data.ts`
      (lockstep). Junior Pro Race Mega is now the only junior product on the track,
      so `filterProducts` and `juniorProductsOnTrack` follow automatically.
- [x] `RACE_BUILD_PRODUCTS["junior:intermediate:Mega"]` deliberately KEPT so a session
      that picked the heat before the deploy still resolves a real $0 build product
      instead of hitting `bmiBookingTarget`'s error path. Delete once none can be live.
- [x] Guard widened from "first-time juniors" to "any junior not Junior-Pro qualified"
      in both wizards — v2 `RaceDateStep.tsx` (`juniorsBlockedOnMega`, via
      `isQualifiedForTier(…, "junior", "pro")`, never a substring match) and v1
      `app/book/race/page.tsx` (`countJuniorsBlockedOnMega`, via `getRacerTier`).
      Unverified juniors count as blocked.
- [x] Copy updated: `/racing` page + `racing-content.ts` cards/track warning, the Mega
      Tuesday FAQ, `MegaTrackTuesdayJsonLd` description, homepage `TuesdayAlert`,
      `embed/booking-info/products.ts` notes.
- [x] Kiosk copy in EN **and** ES: `peopleUi.megaJuniorWarning`,
      `stepReason.megaTuesday` (+ the matching `KioskFlow.tsx` reverse-map key and the
      v2 `canAdvance` reason string — all three must stay identical), attract-slide
      notice → "Junior Pro only on Mega".

### Gates run

`tsc --noEmit` 0 · `vitest` 3479 passed / 250 files · `eslint` 0 errors (only
pre-existing warnings) · `next build` 0 · `a11y-gate` 0 violations. New tests:
`src/lib/constants/fasttrax-hours.test.ts` (16), the era-crossing opening-window
block in `race-restriction-rules.test.ts`, the Junior-Pro-only block in
`race-products.test.ts`.

### Open

- [ ] **Not committed / not deployed** — the change set is in the working tree only,
      pending the owner's call on branch + PR (shared tree, multi-writer).
- [ ] **BMI side is not ours to change.** The Junior Intermediate Mega dayplanner still
      exists upstream; we only stopped selling it. If ops leaves those heats on the
      Mega dayplanner they'll sit empty (harmless) — but a walk-in booked at the
      register under `43732358` would still run, so ops should pull the tier from the
      Tuesday dayplanner too.
- [ ] **The attract-slide model is English-only** (`title` / `bannerAction` / `notice`
      are raw strings in `kiosk/assets.ts`, not catalog keys). Pre-existing gap across
      every slide, not introduced here — worth routing through the i18n catalog.
- [ ] **Never smoked.** No card charge, no kiosk device run, no Google re-crawl check.

## Group event moves between centers — FT → HeadPinz Fort Myers (2026-08-03)

US Anesthesia Partners (**H3194**, BMI project **56000667**, 8/8 4:36 PM, $2,146.35)
is moving from FastTrax to HeadPinz Fort Myers. Both share one BMI client
(`headpinzftmyers`), so the move keeps the same project, contract, deposit and gift
card — but the quote's center stamp was written only at INSERT, so nothing followed
the event. See lessons.md § "A derived flag written only at INSERT rots" (third
instance) and § "Refunding a deposit while its gift card stays funded pays twice".

- [x] **`syncQuoteCenter`** (group-quote-dispatch) re-derives `center_code /
  center_name / square_location_id / brand / base_url / gan_prefix /
  hermes_center` on every "Send Contract" pass, gated on
      `center_code`/`square_location_id` so ~170 legacy `gan_prefix` rows don't churn.
      Audit-logs `center_moved`, writes a BMI private note, folds the move into the
      post-sign `changes[]` set (a venue change can move zero money, which the
      `changes.length === 0` early-exit would otherwise swallow).
- [x] **`reconcileDayofOrder`** rebuilds on a **location** mismatch, not just a total
      mismatch — a Square order's location is immutable — and cancels the superseded
      order at its OWN location.
- [x] **`isFastTraxSubject`** replaces `subject.includes("FT")` (also matched GIFT /
      LEFT / SOFT / CRAFT / DRAFT / AFTER; the check can only ADD FastTrax, so a false
      positive pinned a HeadPinz-bound event to FastTrax permanently). Tested.
- [x] **Cancel path drains the deposit gift cards before refunding**
      (`drainInternalDepositGiftCards`, `ADJUST_DECREMENT` / `PURCHASE_WAS_REFUNDED`),
      so a cancel-and-rebook move can't refund the card AND leave the GC funded.
      Drain failure pages staff (`notifyGiftCardDrainFailed`) and never blocks the refund.
- [x] **`scripts/gf-center-move-check.mts`** — read-only: BMI location vs quote stamp vs
      day-of order location vs gift-card balance. Run before and after the move.
- [ ] **Not yet verified live** — nothing has moved yet. When sales flips H3194's BMI
      Location to HeadPinz and re-flips the project to "Send Contract":
      run `npx tsx scripts/gf-center-move-check.mts 56000667` and confirm all ✓.
- [ ] **Deadline:** the T-72h balance charge fires **Aug 5 ~4:36 PM ET** on the card on
      file, using the frozen `balance_cents`. Move + reprice before then or the balance
      collects at FastTrax pricing and the difference has to be settled as a reprice delta.
- [ ] **Unverified external behavior:** a cross-location gift-card `LOAD` (FT-minted card,
      HPFM-located quote) is expected to work — Square gift cards are seller-wide, and
      cross-location _redemption_ is already proven in `group-dayof-pay` — but no card in
      our own history has activities at two locations, so it is inference, not evidence.
      If the T-72h load errors, `sumGiftCardLoadsForPayment` makes the retry idempotent;
      the failure is loud (`balance_last_error`), not silent.

## Google review ask on the survey reward screen — branch `feat/survey-google-review` (2026-08-02)

The guest survey ends on the reward-confirmation screen (500 Pinz / $5 e-gift card) —
the highest-goodwill moment we have with a guest, previously spent on nothing. Adds a
"Got 10 more seconds?" Google review CTA there, shown ONLY to guests whose own answers
say the visit went well.

- [x] **`src/lib/constants/review-links.ts`** — single source of truth for per-center
      Google review destinations, keyed by Square location id (= `guest_surveys.center_code`).
      `{ placeId }` builds the `writereview` URL that opens the star form directly;
      `{ url }` is a full-URL escape hatch. Unknown center → `null` → no ask (fail-closed,
      so a new center never gets pointed at another center's listing).
- [x] **Positive-sentiment gate** — `isPositiveSentiment()` in `features/guest-survey/gating.ts`,
      beside the existing `LOW_RATING_THRESHOLD` so there is ONE definition of a bad visit.
      Requires: overall (baseline #1) answered and ≥ 4, no `rating_1_5` anywhere ≤ 3,
      and recommend (baseline #2) ≠ "No". Questions addressed by (tag, ordinal), never by
      text, so seed copy edits can't silently disable the gate. Fail-closed on a missing or
      unanswered overall question. Plus `toAnswerMap()` to narrow a stored `responses_json`
      blob honestly (drops non-scalars rather than letting an object stringify to
      "[object Object]" inside a comparison).
- [x] **`GET /api/surveys/[token]/review`** — tracked 302 hop. The CTA links here, not
      straight at Google, so the click is recorded server-side (the CTA opens in a new tab,
      which is exactly the case a client beacon drops) and sentiment is RE-VERIFIED against
      the stored responses — a hand-crafted URL can't harvest the link. Records a
      `marketing_touches` 'converted' touch with `meta.stage: "review_click"`, matching the
      reward route's `reward_issued` shape, so existing admin stats pick it up with no
      schema change. Non-happy / incomplete / unmapped-center all 302 to the brand home,
      never an error page.
- [x] **`GoogleReviewCta.tsx`** — own client component. `target="_blank"` is required, not
      cosmetic: on the gift-card screen it sits below the QR, GAN and GS-XXXX promo code,
      and navigating away in place would take all of that off the guest's screen. Styled
      accent-OUTLINED so it never competes with "Add to Apple Wallet". Fires
      `clarityEvent("survey:review_click")`.
- [x] Rendered once in `RewardConfirmation` (covers both the Pinz and gift-card branches),
      and on `ThanksAlreadyPanel` for a reopened link — a happy guest who closed the tab on
      the reward screen gets a second chance, gated on the same stored answers.
- [x] **Middleware dedupe** — `/review` + `/review/naples` now build their targets from
      `googleReviewUrl(...)` instead of duplicating the two place ids inline. Behavior
      identical (asserted in the unit test).
- [x] **Click tracking on the survey row** (owner ask: "keep track of how many people click
      it"). New `guest_surveys` columns `review_click_count` / `review_first_click_at` /
      `review_last_click_at`, added to the DDL **plus idempotent ALTERs** so prod picks them
      up on the next `ensureGuestSurveySchema()` — no migration step. Incremented by
      `recordGuestSurveyReviewClick()` as a single atomic `SET count = count + 1` (the
      increment happens in Postgres, so a double-tap or two open tabs can't lose a count).
      **Awaited** in the route, unlike the fire-and-forget touch: a serverless teardown the
      instant we return a redirect can drop a detached write, and this is the number ops
      reads. Wrapped in try/catch — a lost count beats a broken link.
      Counted rather than booleaned because the CTA opens in a new tab, so the reward screen
      survives behind it and repeat taps are real.
- [x] **Admin stats** — `getGuestSurveyStats` gains
      `reviewClicks: { clickers, clicks, clickRate }` (clickers = distinct people, the
      headline; `clickRate` divides by **completed**, not sent, because the CTA only exists
      after submit), plus `reviewClickers` on `byDay` and `byCenter` so you can see which
      center's guests actually review. `/api/admin/guest-survey/stats` spreads the object,
      so it surfaces with no route change.
- [x] Incidental: `theme.ts` extracted from `SurveyForm.tsx` so server + client can share
      the palette. Side effect — the terminal panels (`ThanksAlreadyPanel` / `ExpiredPanel`)
      were hardcoding the HeadPinz background even for FastTrax racing surveys; they now
      follow the brand theme like the form `Shell` already did.
- [x] 49 units green (11 sentiment, 7 review-links, 12 review-route incl. hand-crafted-URL
      bypass attempts and the counting-fails-still-redirects case); full suite 2885 green;
      tsc clean; eslint exit 0; zero jsx-a11y in changed files; `next build` **compiled successfully**
      (verifies the middleware edge bundle with its new imports + the client/server
      boundaries). Build's type-check step then failed only on pre-existing UNTRACKED WIP
      leftovers in the working tree (`scripts/*.mts` ×4, `VipExperiencePopupClient.tsx`) —
      not on main, not in this commit.

**NOT smoked live.** Needs a two-brand phone pass: happy path → CTA appears → lands on the
right listing; overall-5-but-one-area-2 → no CTA; reopened link → CTA; and
`/api/surveys/<unhappy-token>/review` → home, not Google. Then confirm the count landed:
`GET /api/admin/guest-survey/stats` → `reviewClicks.clickers` incremented (and
`review_click_count` on the row), which also proves the idempotent ALTERs ran against prod.

**FastTrax place id — RESOLVED 2026-08-02.** All three centers now go straight to the star
form. FastTrax = `ChIJ3w3IFwAV24gRAVrB_FB6JE4`, derived from the feature id in Google's own
Maps URL for the 14501 Global Pkwy listing (`0x88db150017c80ddf:0x4e247a50fcc15a01`,
CID 5630759922376464897). A place id is base64url over the FID pair; the conversion was
validated by round-tripping both known HeadPinz ids byte-for-byte first. The interim
search-results URL is gone.

Two traps if this ever needs re-deriving: HeadPinz Fort Myers (`0x88dda5…`) is across the
same parking lot, and a CLOSED FastTrax exists at 17455 Summerlin Rd. The distinct
`0x88db15…` prefix is the tell. A unit test now asserts **every** mapped center resolves to
a `writereview?placeid=` URL, so a future `{ url }` fallback fails the build rather than
silently costing guests an extra tap.

Follow-ups (out of scope, not started):

- `emails/race-results.html:548` sends FastTrax racers to HeadPinz Fort Myers' place id.
- `pickBrand()` in `api/surveys/[token]/reward/route.ts` + `send-sms/route.ts` does
  `centerCode in CENTER_META ? "HeadPinz" : "FastTrax"`, but `CENTER_META` _contains_
  FastTrax — so racing reward SMS is branded "HeadPinz".

## Video match hardening — branch `feat/video-match-hardening` (2026-08-02)

Root causes proven by the 8/2 investigation (live Redis forensics, 7/10–7/28 corpus:
8,687 matched / 846 unmatched): junk short clips (0–120s) get matched + SMS'd and steal
racer slots (152 matched junk, 39 proven thefts); the webhook processes VT3 events in
arrival order while only the cron sorts by `created_at`, so out-of-order uploads swap
pairs of racers; held videos are nameless and never notify. Scope of THIS PR (matcher
correctness only — admin UX / Neon persistence / SMS-Timing reconcile are later PRs):

- [x] **Junk quarantine** — videos with duration < `VIDEO_JUNK_MIN_S` (default 120s)
      never auto-match/notify; recorded to the review bucket with new reason
      `"junk-short"`. Kill switch `VIDEO_JUNK_QUARANTINE=false` (default ON per house
      flag rule).
- [x] **Junk→real auto-swap** — when a real (≥ threshold) video walks to a slot occupied
      by a junk-grade one, displace the junk to the review bucket and take the slot;
      notify fires for the real video. Same kill switch.
- [x] **Ordered matching** — webhook no longer creates matches inline in arrival order.
      New-match events buffer in `video-pending:*` (merged per code), and a locked drain
      processes them oldest-`created_at`-first after a `VIDEO_MATCH_SETTLE_S` (90s)
      settle window, per-camera order enforced. Drain runs opportunistically on webhook
      calls + every cron tick (including the bridge-alive early exit). PATH-1 updates
      (overlay/block/deferred notify) stay inline — they're order-insensitive. Kill
      switch `VIDEO_MATCH_ORDERED=false` reverts to inline behavior. Side fix: a
      sample-uploaded-first video (no created_at) now buffers + matches instead of
      being dropped until the bridge goes quiet.
- [x] Admin: render the `junk-short` reason chip on review rows (list route already
      passes `reason` through).
- [x] Vitest units (19 green) for the pure logic: junk classification bounds, buffered-event merge,
      drain ordering (per-camera holds, settle window, created_at/id tiebreak).
- [x] `scripts/video-match-shadow.mts` — local monitor: `--replay` (what would the new
      rules have done over today's live corpus) + `--watch` (post-merge verification:
      junk-matched must go to zero, buffer depth, drain lag). Read-only.
- [x] tsc + eslint + a11y-gate green; 19 new units green; shadow --replay validated on
      8/2 LIVE traffic (4 junk matches incl. 1 texted guest, 3 swap repairs identified,
      cam61 flagged flaky with 39 junk clips); branch pushed + rebased on 384194fd.
      NOTE: 6 pre-existing failures on main (guest-survey-db.test.ts × 5 — seed is 30
      questions, test expects 22; steps-v3-gating.test.ts × 1) — unrelated, present at
      base, flagged to owners.
- [ ] **Owner: open PR + merge = go-live.** Post-merge: run
      `npx tsx scripts/video-match-shadow.mts --watch` from apps/web — junk-matched
      must stay 0, quarantined rows appear, pending buffer drains <5 min. Also new
      Neon table `video_decision_log` auto-creates on first write.
- [ ] ALSO ADDED (owner request mid-build): durable Neon `video_decision_log` — every
      match outcome w/ candidate context, notify results (incl. silent no-contact
      skips), block flips, buffer entries, drain summaries. Fire-and-forget writes.

## Kiosk attract motion — HeadPinz first (2026-07-26, branch `feat/kiosk-hp-attract`)

Owner-picked scope after the demo artifacts (claude.ai/code/artifact/4fc7ccbb + 290a6377).
People walk past the kiosks; current attract motion is below peripheral-vision threshold.
FastTrax picks (drive-by + relay wave) come in a LATER PR — this one is HeadPinz + shared plumbing.

**BUILT + PUSHED 2026-07-26** — commit `5d2916cb` on `feat/kiosk-hp-attract`; 9 unit tests green,
eslint + a11y-gate clean, tsc clean on touched files (pre-existing errors in the OTHER sessions'
uncommitted ReturningRacerLookup work were left alone).

- [x] `attract/billboard.ts` — bank position maps (FT 1–7 in order; **HPFM 3,2,6,1,4**;
      **Naples 10,9,7,8**), slide sets per venue, pure clock-phase fn + unit tests. Kiosks NOT in
      the map sit out of the choreography (owner call — no number-order fallback)
- [x] `AttractBillboard.tsx` — billboard overlay, navy veil so the finale never bleeds into the
      rotating welcome text; pointer-events-none; **default ON at BOTH HeadPinz venues** (owner),
      kill = `NEXT_PUBLIC_KIOSK_BILLBOARD=false`
- [x] Rotating welcome line, clock-synced 4s fade; kill = `NEXT_PUBLIC_KIOSK_WELCOME_ROTATE=false`
- [x] HeadPinz banner bowling ball (CSS sprite, same 8s slot + stagger as the FT car); rumble on
      both brands; car stagger moved to the position map (fixes HPFM handoff order)
- [x] kiosk.css keyframes + KIOSK_GLOW_PERIODS_MS same-commit
- [ ] **Owner: live smoke on a real HeadPinz kiosk bank** (billboard sync across screens, ball
      crossing, welcome rotation, tap-through during the takeover) — then PR review + merge
- [ ] Later PR: FastTrax full-screen drive-by + bank relay wave (picked; not started)

## Post-day-of refund flow — BUILT + MERGED 2026-07-28, FLAGS OFF

**Plan + flag-flip runbook: [tasks/future/post-dayof-refund-plan.md](future/post-dayof-refund-plan.md).**
All owner decisions from §5 answered 2026-07-27. §8 Tier-3 smoke COMPLETE — three live shapes
(`--live` MID 18/18 · `--live --post` POST 18/18 · `--live --post --race` POST + collapsed pack
line + FULL refund 20/20), all run with the master switch OFF.

Staff entry point: a **Refund** button on the manage modal for rows Cancel refuses (terminal
status + a day-of payment), opening the edit modal with `intent="refund"`.

**Remaining (owner, in this order — see the plan doc):** ~~deploy, then set ONLY
`RESERVATION_EDIT_V2_MID_DECREASE=true` and `RESERVATION_EDIT_V2_POST=true`~~ —
**SUPERSEDED 2026-08-07:** all four `RESERVATION_EDIT_V2*` vars are now kill switches
(default ON via `editFlagEnabled()`), so there is nothing to set. Deploy and smoke one real
refund from the portal. Delete any `RESERVATION_EDIT_V2*=true` rows left in Vercel — they
are dead config now, not the thing turning the feature on.

Owner requirement (2026-07-27): **the Payments tab and History tab in ManageReservationModal
must reflect EVERYTHING we do to a reservation** — edits, partial/full refunds, store credit,
gift-card adjustments, and the new post-day-of refund chain. Any money step that doesn't
surface in those two tabs is unfinished. Full plan doc lands at
tasks/future/post-dayof-refund-plan.md (research workflow in flight).

Owner requirement (2026-07-27): **full testing is part of the plan** — unit tests per money
step/allocator/guard, live API probes at the non-accounting location `6MZJFTGAYD7TC`, and an
end-to-end seed+smoke of the real flow (book → pay deposit → check in → charge day-of →
partial refund chain → verify Square + Neon + Payments/History tabs) before anything is
called done. No flag flips without the smoke checklist passing.

## KNOWN ISSUE (parked 2026-07-27): PRE-phase race edit — heat removal can't match order line

Owner call: **park until the post-day-of refund flow ships, then return.** Repro (res 16924-era,
Pedro Quinones fort-myers 7/27 9:36 PM, 3 heats): Edit Reservation → remove one "Starter Race
Red" heat → PRICE panel shows `pricing_unresolvable`: "no order line matches removed heat
'Starter Race Red' — the order money can't be derived safely; adjust this one manually in
Square". Source: the exact-match guard in `raceLegPlan` — a removed heat must match a live order
line by `catalogObjectId` OR exact `name`. Guard is failing SAFE (no money moves), so no urgency.

**ROOT CAUSE FOUND 2026-07-28** (while building the Refund action): a race booked as a **PACK**
bills the day-of order as ONE collapsed line — res 16426's order carries a single "Rookie Pack"
×1 = $27.67, not per-heat race lines. Per-heat removal therefore has nothing to match, by
construction; it is not a name/catalog divergence. Post-payment phases route around it entirely
via `spec.orderLines` (return the pack line — that IS the refund), and the guard message now
points there. **PRE still needs a real fix:** reprice against the pack (a partial pack removal has
no defined price) or refuse pack bookings with a pack-aware message. Do NOT widen the matcher to
unit-price fallback — on a collapsed pack line that would silently refund the wrong amount.

## Bowling reservation flow redesign (single time pick + offer-accurate availability) — BUILT 2026-07-19, DARK

Full plan: [tasks/bowling-reservation-flow-plan.md](bowling-reservation-flow-plan.md). **Built on
branch `claude/bowling-reservation-flow-0rd3nx` (plan PR0→PR3 as sequential commits), pushed for
Vercel preview testing.** Fixes four owner-reported problems in web booking v2 AND kiosk bowling:
double time selection, offers shown at times not actually bookable for that duration (1.5h
available ⇒ 2h shown), dated offer screen, past times shown as available (12:00 PM at 12:17 PM).

What's live-on-merge even with the flag dark: past-time now-floor on all full-day scans ·
`optionCheck=accurate` duration filtering for the classic offer step, World Cup, and combo legs ·
duration guards at hold/reserve/reschedule (typed 409s, pre-charge only, fail-open on infra
errors) · superseded-hold release. What's flag-gated (`NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW`, or
per-session `?bowlingV3=1` on web + `/kiosk/flow?bowlingV3=1`): the v3 Date → Experience →
Time flow (merged tier+package screen, "Next Available" hero + accurate grid, tap = eager hold)
on web AND kiosk. Accurate mode is implemented as plan branch D (windowed necessary-condition
filter) — the QAMF probes below can upgrade it to branch A/B/C.

- [ ] **Owner: preview-test both surfaces** — `/book/bowling/v2?bowlingV3=1`,
      `/book/kbf/v2?bowlingV3=1`, `/kiosk/flow?bowlingV3=1` on the Vercel preview; plus classic
      flow regression (flag dark): offer step now hides truly-unfittable durations, and no past
      times anywhere at :17 past the hour
- [ ] Run QAMF probes P1–P8 from local dev (`scripts/qamf-duration-probe.mts`, plan §7) — P6
      picks the availability design branch (A–E); D is what's built
- [ ] Then: PR4 polish leftovers if any → PR5 flip (flag default-on + schema bumps 2→3 / 10→11,
      ops sign-off on preview per plan §11) → PR6 delete classic steps
- [ ] Known pre-existing failure unrelated to this train: `lib/guest-survey-db.test.ts` (5, see
      2026-07-06 note below)

## Kiosk Online & Group Waiver — ON MAIN, BUTTON OFF BY DEFAULT (2026-07-18/19)

Attract-screen entry → `/kiosk/waiver`: guest picks today's reservation (next 2h, waiver
events, event name or "First L." labels — daily-events group/online split), sees "First L."
of everyone registered with a currently-valid waiver, and adds people via the LIVE kiosk
people step (`KioskAttractionPeopleStep.Component` mounted over a local, non-persisted
instance of the real booking reducer — deliberately NOT an extraction, that file is
multi-writer-hot; the waiver page inherits the guardian-signer flow, Title Case etc. for
free). Joins persist to Neon `kiosk_waiver_joins` FIRST; BMI `registerProjectPerson`
attach runs after. Race now / Bowl now attract chips hidden same day (owner: "might come
back later" — commented in AttractScreen).

Flags (owner 2026-07-19, revised after first live look — "turn the event thing off by
default for now"): attract button is OPT-IN, default OFF —
`NEXT_PUBLIC_KIOSK_GROUP_WAIVER_ENABLED=true` in Vercel + redeploy shows it; the
/kiosk/waiver page stays typed-URL reachable for staff testing. BMI attach stays
default-ON (`KIOSK_WAIVER_BMI_ATTACH=0` kills it) — moot while the flow is unused.
NOTE from the 1 AM live test: a just-created reservation takes up to ~6 min to reach the
picker (5-min daily-events cache warm + 60s shaped cache) — expected, but remember it
when testing.

Probe `apps/web/scripts/kiosk-waiver-attach-probe.mts` dry-run DONE (2026-07-19):
A1 = personsByIds has NO waiver fields (Pandora fan-out in roster route is required);
A2 = Pandora person GET accepts 17-digit Office ids (live-verified).

- [ ] **A3 probe (recommended even though attach defaults ON):** staff-create a THROWAWAY
      test reservation + test person, run
      `PROJECT_ID=… PERSON_ID=… APPLY=1 npx tsx scripts/kiosk-waiver-attach-probe.mts`
      → confirm projectPersons +1, state/products unchanged, idempotency. A rejected attach
      is contained (Neon row 'failed', guest unaffected) but watch `listFailedJoins()`
      after the first real event; kill with `KIOSK_WAIVER_BMI_ATTACH=0` if BMI misbehaves.
- [ ] **Owner live smoke** on a real kiosk (picker window + labels, new person photo+sign,
      returning OTP person, minor + guardian-signer flow, sequential second signer, idle
      reset).
- [ ] Follow-up: migrate `app/event/[slug]/page.tsx` local `makeDisplayName` to
      `@/lib/display-name`; consider a retry sweep for `kiosk_waiver_joins` rows with
      `bmi_attach_status='failed'` (`listFailedJoins()` exists).

## Kiosk — expired returning-racer license (deferred, needs a data source) (2026-07-19)

Shipped `d63fc584`: a MIXED race party (returning + new racer) auto-enrolls the new
racer(s) in the full Rookie Pack and skips the license/POV step. Owner asked to also show
the license page when a **returning** racer's license is EXPIRED — deferred because the
data + charge path don't exist:

- **No license-expiry signal anywhere.** The racer lookup (`PersonData` in
  `ReturningRacerLookup.tsx`) returns `memberships` (tier-name strings, no dates),
  `races` (a count), `birthDate`, `creditBalances`, `waiverValid` — **no license field**.
  `PartyMember` has none either. Only the **waiver** has an expiry (`waiverValid` /
  `waiverExpiry`); the racing license does not.
- **Charge also keys off `isNewRacer`.** `checkout.ts` charges the license per
  `m.isNewRacer && !packageRacerIds` — so even if the page were forced to show for a mixed
  party, a returning racer (`isNewRacer=false`) with an expired license would NOT be
  charged. Structurally, "needs a license" == `isNewRacer` today.
- **To implement:** source a license-expiry date (confirm whether BMI Office's person
  response carries one, or whether "Racing License" appears in the memberships array as
  active-only), then flag an expired returning racer as needs-license (set `isNewRacer=true`
  or add a `needsLicense` field) so the page shows AND the license charges. Until then a
  returning racer is assumed licensed — matching the web flow.

## Kiosk minors-first + guardian-signs waiver — BUILT (2026-07-18), not yet live-verified

Minors can register FIRST on the kiosk; a guardian is only involved when the minor's waiver
actually needs signing (first-timer or expired — a returning minor with a valid waiver needs no
guardian at all). Guardian resolution overlay in `KioskPeopleStep`: pick an adult already here
(party adult or prior guardian chip) · add a NEW adult · find an existing account (OTP lookup).
Guardian must have a valid OWN waiver first (signs it in-chain), then signs the minor's waiver
as Pandora `sigPersonID` (plumbed through `/api/pandora/waiver` POST → `pandoraSignWaiver` →
`WaiverSigning.signerPersonId`; self-sign default unchanged). Signer-only guardians live in
`session.guardians` (NEW — machine actions add/update/removeGuardian, schema v10) so they are
excluded from products/heats/charges/BMI bill registration BY CONSTRUCTION; roster shows a
dashed "Guardians — signed, not playing" chip with **Join the fun** (same id moves into party,
minors' `guardianMemberId` refs stay valid). Receipt contact switches to the guardian when the
Main person is a minor. ~~BMI-level `guardianID` link is best-effort via re-upsert.~~
**RESOLVED 2026-07-25 (Strachan incident):** the "re-upsert" provably CREATED A DUPLICATE person
per minor sign (Pandora create is NOT an upsert — see lessons.md § Pandora create is NOT an
upsert). `linkMinorToGuardian` was removed; the waiver's `sigPersonID` is the guardian record.

- [ ] **Live-verify on the kiosk dev flow** (see plan verification list): minor-first paths
      (valid-waiver / new-adult / lookup / expired-adult chain), guardian absent from charges +
      `registerProjectPerson`, log line `signer=<short id>`, two-minors-one-guardian, join-the-fun.
- [x] ~~Confirm whether the Pandora upsert persists `guardianID` on an existing person~~ —
      confirmed 2026-07-25: it persists it on a fresh DUPLICATE person (guardian's `related`
      pointed at two no-waiver orphans). `linkMinorToGuardian` dropped.

## Kiosk CRT-591 card reader/dispenser — DRIVER + TEST PANEL + GAME ZONE WIRED (branch `kiosk`)

**Driver + test panel (2026-07-17, hardware-verified):** Web Serial driver for the CRT-591 COM
protocol (`apps/web/src/features/kiosk/card-reader/` — frame codec w/ STX-resync, ACK/NAK/EOT
engine, typed commands, e1/e0 decode, auto-baud + identity discovery, B0 auto-reinit) + staff
test panel (`/kiosk/admin` → Card reader tab) + USB wedge capture. Verified on the real unit
(CRT-591-(R02)HB-HDN, fw `CRT-591-V1.00`, 115200 baud, magstripe over COM via `C 36 37`; buy
= `MOVE 34h`→read→`MOVE 30h` present, reload = `ENTRY 32h`→read→`MOVE 30h`→`ENTRY 30h` stop).
Docs `docs/crt-591/{README,protocol}.md`.

**Game Zone guest flow wired (2026-07-18):** `simDispense()` + typed-number input replaced with
the real reader. Reusable `useGameCardDispenser` hook (card-reader/) owns one connection per
session. BUY = one upfront charge (`/api/game-cards/purchase` kind:`new_card`, charge-only) then
per card: `dispenseAndRead` → `/api/game-cards/load-card` (creditTokens) → present (or capture
to bin on load fail); blanks are pre-encoded so no Intercard issuance needed. RELOAD = insert →
read → **always return the card** → verify → pay once (`purchase` kind:`reload`, unchanged) →
`prohibitEntry`. Also fixed the location-code bug (component sent 9/11; canonical 12/6/13 via
new `centerCodeFor` in `config/intercard-centers.ts`) — reload was throwing UNKNOWN_LOCATION at
both Fort Myers venues. 170 kiosk+game-cards tests green; tsc + eslint clean; routes smoke-OK.

- [ ] **Hardware session:** run buy (multi-card) + reload end-to-end on the kiosk against real
      Intercard — confirm balances via `/verify`; drill stacker-empty + a forced load failure
      (capture path) + Fort Myers reload (location-code fix).
- [ ] Request the CRT-591-(R02)HB-HDN magstripe protocol doc from the vendor (only the M001
      RFID/IC doc exists publicly; magstripe commands are reverse-engineered from captures).
- [ ] Follow-up: `msrEnabled` (reload-only, non-dispenser MSR) hardware path — currently the
      typed/wedge input; new_card linking for signed-in guests.

## Gate /api/bmi-office behind OTP verification — NOT STARTED (security)

`/api/bmi-office` is an unauthenticated proxy to BMI Office: anyone can call
`?action=search&q=<phone>` then `?action=person&id=…` / `?action=deposits&personId=…` and get
full racer PII (name, email, DOB, memberships, credit balances) with zero verification. The
returning-racer flow's OTP gate is client-side only — `ReturningRacerLookup` fetches all PII
into state BEFORE sending the code, and the `verified:<phone>` Redis flag set by
`/api/sms-verify` PUT is never checked server-side.

- [ ] Gate `action=person|deposits` (at minimum) on the `verified:<phone>` flag
- [ ] Reorder the client flow: send + verify OTP first, then fetch accounts
- [ ] Check the v1 component + any other `/api/bmi-office` callers before tightening

## Reservation-edit: VIP rows blocked from scaling edits (two primary-kind lines) — 2026-07-11

VIP experiences (`vip-fri-sun`, `pizza-bowl-vip`, `fun-4-all-vip`, world-cup variants) bundle
"VIP Chips & Salsa" (product 109, kind `open`) alongside the lane product — so these rows have
TWO primary-kind lines. `resolveBookedPricing` throws "found 2" (no stamp; backfill skips them)
and `repriceBowling` hard-refuses at edit time ("multiple primary lane lines"). VIP rows fall
to carry mode: shoes/roster/food edits work; player/lane/duration edits refuse. ~30 upcoming
rows affected as of 2026-07-11.

Fix needs a design decision, not a hack: either (a) reclassify chips & salsa as `addon_food`
in the catalog (check the VIP booking flow doesn't key on kind `open`, and decide whether it
scales with lane count on edits — the experience bundles it per lane), or (b) teach
reprice/derivation a designated-primary rule (e.g. the experience's duration-override family)
and scale bundled secondaries × laneCount per the original §4 spec. Until then the clean
refusal stands.

## Resadmin VIP race-truth (board stops clock-guessing race Done) — MERGED TO MAIN 2026-07-08

Problem: VIP combo cards mark a race step "✓ Done" purely off the clock
(`stepProgress` in `src/features/reservations-admin/combo-board.ts` — `now >= start+duration`),
so a delayed heat shows Done while the party is still waiting; retirement (30 min past last
step) can drop a delayed combo from Active Only before the race runs. Bowling already has
QAMF lane truth (`legStatus`); races have no truth signal today.

**Pandora SHIPPED `actualStart` / `actualEnd` — verified live 7/8 ~7PM ET** (explicit
`null` until they happen, never omitted) on the session objects of
`GET /v2/bmi/sessions/{locationID}` — deliberately timestamps NOT a state enum (vt3
`status`-drift lesson, see lib/video-match.ts:31). Derivation: `actualEnd` set → Finished ·
`actualStart` only → On track · neither + session is the track's `races/current` entry →
Called · neither + scheduledStart past → Delayed (amber) · neither + future → Upcoming.
Cancelled needs no state: heat vanishes from the bill's re-read `liveHeats`.
Live-test notes: delays are real (Blue heat 35 started 22 min late — the exact bug);
**actualEnd can fail to stamp** (heat 35 stayed open while 36-40 finished) so on-track must
be sanity-capped: finished if a later same-track heat has actualStart, or ~20-min cap.
Past dates return empty — same-day only. Our sessions proxy passes the fields through
as-is; pre-race-tickets keeps the Redis cache ≤2 min stale during ops hours.

Built on branch `fix/resadmin-vip-race-truth` (651bf4d8, pushed — PR: https://github.com/BMA-Dassle/Tools-Website-FT/pull/new/fix/resadmin-vip-race-truth). States shipped as finished/on_track/called/not_called; derivation is the pure module `src/features/reservations-admin/race-live-state.ts` (18 new unit tests; 55 green in the feature dir; tsc clean apart from 2 pre-existing scratch-script files).

- [x] **Server** (`app/api/admin/bowling/reservations/route.ts`): where `liveHeats` attaches,
      resolve each heat → Pandora session (sessions proxy `prefer=cache`, warmed 2-min by
      pre-race-tickets; match track + scheduledStart, UTC↔naive-ET convert) and stamp
      `raceState: "ran" | "called" | "not_called"` (absent = no data → clock fallback).
      Sources in order: session `actualStart`/`actualEnd` (once live) → `races/current` +
      Redis last-race-per-track watermark (`pandora:last-race:fasttrax:{blue|red|mega}`,
      checkin-alerts-warmed; heats run in order per track so watermark past heat = ran) →
      nothing. Reuse the 60s in-memory cache pattern (10s board poll must add no load).
- [x] **Board logic** (`combo-board.ts`): `ComboScheduleStep.raceState`; `stepProgress`
      precedence mirrors bowling — `called`/on-track → active "On track now" regardless of
      clock; `ran` → done; `not_called` past scheduled end → active+overdue amber
      "Delayed · not called yet"; no signal → current clock behavior.
- [x] **Retirement**: combo with a `not_called`/`called` race step can't go `inactive`;
      hard cap end of operating day (no-show party: heat still gets called track-wide,
      which retires the card 30 min later anyway).
- [x] **UI** (`VipComboCards.tsx`): pill wordings only. Main list inherits via schedule index.
- [x] **Tests**: extend `combo-board.test.ts` — delayed heat stays active past clock-end;
      watermark/actualEnd flips done early+late; no-signal fallback; retirement guard.
- [ ] **Live smoke** on a real combo night (delayed heat shows amber, flips Done on next call).

Phase 2 (separate, later): party-level truth — participants `checkedIn` + F_PAR_STATE docs
(asked Pandora) or vt3 video-match; needs racer personIds or name matching vs
`booking_metadata.racerNames`.

## Race close-out on track truth (race-dayof-pay settle gate) — MERGED TO MAIN 2026-07-08

Branch `fix/race-dayof-settle-truth` (84cc3d7f, pushed — STACKED on
`fix/resadmin-vip-race-truth`; merge that PR first, then re-base/merge this one).
The cron's no-check-in fallback charged races the instant the clock passed the first heat's
scheduled start ("TEMPORARY" per its own header) — heats run 6-22+ min behind, so guests could
be charged before racing. Owner decisions 7/8: settle when the LAST booked heat actually
finished (Pandora actualStart/actualEnd via `raceSettleGate` in race-live-state.ts);
unresolvable heats clock-settle at start +45 min; past-date stragglers immediately; +6h hard
cap; resolved-but-delayed heats WAIT past the net (truth wins); `reservation-status-close`
+2h flip, attractions, combos, -5 arrival path all unchanged.

- [x] Pure `raceSettleGate()` + 8 unit tests (63 green in feature dir; tsc clean)
- [x] Fetchers extracted to `race-live-state.server.ts` (shared board + cron; verbatim move)
- [x] Cron gates race fallback; `dayof_order_source` = `-fallback-raceend` (verified finished)
      vs `-fallback-timepassed` (any clock path); skip logs show gate waiting reason
- [x] Merged to main 7/8 (ff, with fix/resadmin-vip-race-truth) — deploys with next Vercel build
- [ ] **Live smoke** on a race night: `?dryRun=1&token=…` shows `waiting: … on_track` for a
      delayed heat instead of charging at scheduled start; settles minutes later with source
      `-raceend`; a -5 arrival still charges immediately (source `race-dayof-pay`)

## Ultimate VIP improvements — MERGED TO MAIN 2026-07-06, ALL DEFAULT ON; live smoke pending

Owner decisions (locked 7/6): reserve the combo's Starter anchor heats from regular bookings
(release 60 min before, Starter anchors only) · steer later same-date VIP bookings onto the
existing group's schedule (default + highlight, staff email flags non-matches) · juniors get a
mirror heat right AFTER the adult heat on both race legs, same per-person price. Owner 7/6:
everything defaults ON — each env flag is now a kill switch (`=false` in Vercel + redeploy;
build-baked). Plan file: `~/.claude/plans/cheeky-wandering-lampson.md`.

- [x] **Anchor reserve** — `vip-combo-anchor-reserve` restriction rule (empty slot at
      2/4/6/8/10 PM blocked on every track/tier, occupied-session joins allowed, 60-min
      lift, "VIP Reserved" disabled card) + per-rule `exemptComboBookings` / ctx
      `isComboBooking` so the combo's own `bookHeatsOnAdvance` path bypasses ONLY this rule.
      Kill: `NEXT_PUBLIC_COMBO_VIP_ANCHOR_RESERVE=false` (also inert if the combo is off).
      NOTE: on deploy the 2/4/6/8/10 PM heats grey out for regular racers immediately.
- [x] **Group match** — `combo-group-match.ts` (pure matchers) + `combo-existing.server.ts`
      over `listVipComboReservations` + GET `/api/booking/v2/combo/existing` (fail-open, no
      PII) + grid banner/badges ("Joins/Near the 4 PM group", gold ring) + staff-email match
      note (exact / same-hour-different-race ⚠️ warning + subject suffix / different-hour
      neutral FYI — 2026-07-10: warning narrowed to the same-hour case only). Kill:
      `NEXT_PUBLIC_COMBO_GROUP_MATCH=false` (email note unflagged). Advisory-only: reads
      booking_metadata heat times; office reschedules degrade the hint, never block.
- [x] **Junior mirror** — mixed parties book juniors on the first junior block strictly
      after the adult heat (36-min window, `pickJuniorMirror`); leg end = last race + 30 min
      (`raceLegEndMs`) so the bowling 75-min window measures from the junior heat; confirm
      modal shows "Juniors race at 2:12 PM on Blue"; staff email rows tagged "— Juniors".
      Kill: `NEXT_PUBLIC_COMBO_JUNIOR_MIRROR=false` = byte-identical same-start path. Known
      limits: junior Starter is Blue-only (juniors race Blue whatever the adults pick);
      Mega Tuesday stays junior-blocked (no BMI junior Starter Mega product).
- [x] Merged 1 → 2 → 3; ~36 new unit tests green; tsc clean; branches deleted.
- [ ] **Post-deploy live smoke:** regular picker greys "VIP Reserved" at 2:00 PM (2:12
      bookable), combo still books 2:00, card frees at T-59 · book VIP group A at 4 PM →
      reopen wizard → badge; book B on it → "same Starter heat" email; group C same hour
      but different heat (e.g. 4:12) → ⚠️ SAME HOUR, DIFFERENT RACE email; group D at 8 PM →
      neutral FYI note, no warning · 2 adults + 1 junior e2e on a non-Tuesday (junior heat right
      after adult on BOTH legs on the BMI bill; bowling scheduled off the junior heat).
- [ ] **Unrelated, found during merge:** `lib/guest-survey-db.test.ts` has 5 pre-existing
      failures on main (seed grew 22 → 30 questions — racing survey — without updating this
      older test). Fix or retire the stale test.

## Cancel & refund improvements (all-kinds cancel + store-credit gift cards) — BUILT 2026-07-03

**Branch `feat/cancel-refund-improvements` — not yet merged.** Owner decisions: no reschedule
flows beyond the existing bowling one; every other change = CANCEL with two outcomes — refund
to card, or convert the deposit into a NEW customer gift card (Square-generated GAN — internal
WEBHPFM… GANs are blocked from online payment) that the guest rebooks with (self-settles
weekday/weekend price differences). Combos staff-only; customer self-serve = gift card only;
staff can keep the GAN (notifyGuest=false) for phone rebooks; every cancel emails+texts.

**Built:** money-group cascade (`src/features/cancellation/` — 82 unit tests) over every row
sharing the deposit order (combos + mixed carts cancel together): audit row →
exactly-once per-tender refunds OR gift-card issuance (GAN persisted BEFORE
activation/delivery) → mark legs cancelled → best-effort teardown (day-of orders w/ tendered
refusal, GC drain ADJUST_DECREMENT + deactivate, QAMF delete, BMI project -4 via W-number
search + verify, add-ons, loyalty, promo) → email/SMS. New `reservation_cancel_events` audit
table doubles as idempotency attempt counter. Routes: `POST /api/admin/reservations/cancel`
(dry-run preview, both outcomes, all kinds), `POST /api/booking/v2/self-cancel` (HMAC sig),
legacy cancel routes delegate (fixes the combo single-leg bug for stale tabs). Portal: cancel
on ALL kinds + Cancel Combo on VIP cards + outcome picker modal (auto dry-run body) + GAN
copy button + durable "GC 1234-… ($X)" / "-$X" display on cancelled rows. Customer: v2
confirmation "Can't make it?" section + BowlingConfirmation gift-card-only swap — **shipped
ON, no flags (owner call 7/3)**; the guest card is branded **HeadPinz FastTrax Gift Card**
(order line item, emails, SMS, all UI).

- [x] 82 feature unit tests green; tsc + eslint parity with main; each step committed green
- [x] Dry-run exercises on prod rows (all shapes + a live combo; partial-redemption block
      verified on a real tonight-combo) · owner previewed the modal on Vercel preview
- [x] **Probe ran 7/13 — VERDICT: PURCHASE** (gift-card tender accepted on a GIFT_CARD-line
      sale; full sequence verified, probe objects cleaned up). Code default flipped to
      "purchase" on main (0b99d15a) — no env needed; `STORE_CREDIT_STRATEGY=comp` is the
      explicit fallback. If comp is ever re-enabled, create the dedicated catalog discount +
      `SQUARE_STORE_CREDIT_DISCOUNT_CATALOG_ID` (else it books against the survey discount).
- [ ] Post-deploy live smoke: race gift-card cancel e2e (GAN redeemable online, sweep
      dry-runs skip the -4, day-of order CANCELED) · admin refund + idempotent re-run ·
      combo both outcomes · tendered-day-of refusal

## Race product step redesign (Option C) + stepper overlap fix — SHIPPED 2026-07-02

Owner picked Option C from mockups: each tier is ONE card; Single vs 3-Race Pack are
side-by-side selectable columns inside it (5 cards → 3 for a returning racer). Copy rewritten:
one-line descriptions, qualification/ages in the tier section header (junior screens drop the
adult age line), "Runs on Red + Blue — pick your track with your heat time" dot line replaces
bare track chips, prices unified white (amber only for "Save $X"), first-visit license note
shows ONLY for new racers. Discount banner 🏁 emoji → IconDiscount2 (@tabler/icons-react).
Selection semantics untouched (each column selects its RaceProduct via handleCardClick).
Also: sticky stepper + timer bar `top-18/top-20` → `top-[120px]` (fixed nav is ~120px tall —
was overlapping the stepper).

- [x] `RaceProductStep.tsx` TierCard replaces ProductCard; `BookingFlow.tsx` sticky offsets
- [x] Verified live via dev server + puppeteer with seeded `sessionStorage.booking_session`
      (v2 envelope, item cursor): returning pro (3 cards, both packs, Save $13), new racer
      (license breakdown + note), junior (Blue-only, meta sans age), weekend (Save $21,
      $19.99/race, no Pro), pack-column click → SELECTED flag + Next enabled, mobile 390px
      stacks clean, stepper clears nav. 268 booking tests + tsc clean.
- [x] Merged to main per owner (was slated for preview-first; owner said push to main)

## Cross-reservation heat spacing + heat-cap removal — 2026-07-02

**Problem (owner):** racers dodge the per-racer spacing rules (same-track 13-min, cross-track
30-min) by booking each heat in a SEPARATE reservation — the conflict check only saw the cart,
and only client-side. **Decisions:** spacing rules only (no daily cap — the per-cart
6-heat `SINGLE_RACE_MAX_PER_RACER` is REMOVED entirely) · hard block · forward-only (no
backfill; personId matching covers returning racers; a re-registered "new" racer duplicates
the BMI person and slips — accepted).

**How:** persist `bmiPersonId` + racer name per heat in `booking_metadata.heats` at reserve
(shared `raceHeatsMetadata` in checkout.ts, used by BOTH reserve paths) → server guards in
`/api/booking/v2/reserve` (step 0b) + `unifiedReserve` (guard 0b) query Neon
(`raceHeatsForPersonsOnDate`, excludes own bill so retries don't self-conflict) and run
`findCrossBookingConflict` (conflict.ts — same heatsConflict rules) BEFORE any Square write →
409 EXISTING_BOOKING_CONFLICT with racer name + times. Picker greys the same slots up front
via GET `/api/booking/v2/booked-heats`. Fail-open on query errors everywhere.

- [x] 268 booking tests pass (7 new) · tsc clean · SQL live-validated against prod Neon
      (0 matches expected pre-rollout; 299 heats scanned; exclude param works)
- [ ] Live verify post-deploy: book a race, then try an adjacent heat for the same racer in a
      fresh session → picker greys it / reserve 409s; confirm new rows carry bmiPersonId

## Race restrictions: reserve 2 Starter slots/hour + unconditional junior back-to-back — IN PROGRESS 2026-07-02

**Owner decisions (2026-07-02):** all three tracks (Red/Blue/Mega) · only ADULT starter counts
toward/consumes the guarantee (junior starter is a consumer like int/pro) · 60-min last-minute
lift on the reserve rule · blocked slots HIDDEN. Plus: junior back-to-back becomes unconditional
("regardless of anything") — no last-minute override, and adjacency counts ANY junior race
(cross-tier via categoryTrackBlocks, not just the candidate's own tier). Hidden like Pro.

**Design:** new constraint `reserveStarterRoomPerClockHour {minRoom:2}` in
race-restriction-rules.ts. Counts remaining "starter room" in the candidate's clock hour =
distinct heat starts that are empty OR occupied by an adult-starter race (occupied heats are
tier-exclusive in BMI availability, so tag blocks by source product). Blocks a non-adult-starter
pick when booking it would leave room < 2. Room-counting (vs. hardcoded cap of heats/hour − 2)
degrades conservatively when BMI drops passed/sold-out heats and handles partial hours.
Two rule entries cover "everything except adult starter": tiers [intermediate,pro] all
categories + tier starter category junior (Blue only — juniors don't run Red/Mega starter).

- [x] `race-products.ts`: `singleRaceProductsOnTrack(track, schedule, racerType)` (all
      tiers+categories, !packType); reimplemented `juniorProductsOnTrack` on top of it
- [x] `race-restriction-rules.ts`: renamed `noAdjacentOccupiedSameTier` → `noAdjacentOccupied`
      with `scope: "tier" | "category"`; junior b2b rules → scope category, override dropped;
      new `reserveStarterRoomPerClockHour` constraint + `trackAllTierBlocks` ctx (tagged
      `adultStarter`); 2 new rules; header doc updated
- [x] Unit tests: 52 pass (12 new reserve-room cases + junior b2b cross-tier/unconditional)
- [x] `RaceHeatPickerStep.tsx`: junior-Mega-only fan-out → all-tier per-track `crossTierProducts`
      fan-out (skipped for adult-starter grids); one query set feeds junior + tagged unions
- [x] `race.ts` `assertHeatBookable`: all-tier union, Promise.all best-effort sibling fetches;
      junior union now covers Blue AND Mega
- [x] `_restriction-smoke.mts`: rewritten to run EVERY single product on a track with the unions
- [x] vitest (261 booking tests) + tsc clean (only pre-existing scratch-script errors)
- [x] LIVE SMOKE (2026-07-02): Blue Thu = exactly right blocks (hour-18 reserve, junior
      cross-tier b2b at 17:48/19:00, Starter never blocked); Mega 7/7 empty→no blocks; Red Fri
      sparse→no blocks. Live data forced one fix: joining an already-occupied session consumes
      no room → never reserve-blocked (was blocking a 16:48 join).
- [x] Verified live: occupied heats ARE tier-exclusive (16:12 occupied-Int absent from Starter
      list); room-counting is drop-off-safe by construction either way.
- ⚠️ DISCOVERED: Blue ran a 12-MIN cadence on 2026-07-02 (17:00/17:12/17:24…), not the 15-min
  the opening-heats-express-only-15min windows + jr-b2b gap-16 comment assume. Reserve rule
  is cadence-independent (counts real slots); the OPENING-WINDOW rule for Blue would cover
  3 heats (13:00/13:12/13:24) on 12-min days, not 2 — confirm intent with owner.
- [ ] Commit on a fresh branch off main (changes currently uncommitted in the working tree;
      current checkout is feat/account-dashboard-login — unrelated)

## Self-service "edit reservation up to check-in" — SPEC, awaiting approval 2026-06-21

> **2026-07-11:** the admin-side superset of this feature is now fully specced, APPROVED, and
> **BUILT** (branch `claude/reservation-editing-plan-vvh9ee`, all flags OFF) — see
> [tasks/future/reservation-editing-plan.md](future/reservation-editing-plan.md) § 16 for the
> flag matrix + the live-smoke gate that must run before enabling (staff edit engine: repricing,
> refunds both directions, QAMF/BMI sync, card-on-file vault + 72h sweep, EditReservationModal,
> self-hosted payment-difference page). This self-service spec becomes a thin guest-facing
> client of that engine; the engine now exists.

**Goal:** let a guest change their booked bowling reservation (food, players, lanes, time)
any time before check-in; if the change increases the total, charge the difference.

**Locked decisions (from owner 2026-06-21):**

- Scope = **everything**: food add-ons, player count, lanes, time.
- Difference charged by **re-entering a card on the edit page** (Square Web Payments; no card-on-file assumption).
- **Add-only — no reductions/refunds.** An edit may never lower the paid total; staff handle reductions manually.

**Grounding (verified):**

- Edit surface = the existing confirmation page reached via `headpinz.com/s/{shortCode}` (short-url → confirmation).
  Reservation lookup already exists: `GET /api/bowling/v2/reservations/by-code`.
- Repricing must reuse the quote path (`/api/square/bowling-orders/quote` + reserve pricing) to honor the
  **displayed-vs-charged hard-fail guard** (project rule) — recompute exactly, never trust client totals.
- Food-line attach to the day-of order already exists (shipped c00286ac) — Phase 1 reuses it.
- **QAMF has NO time/lane reschedule API in our client** (`patchReservation` = Title/Notes/Status only; we only
  _sync_ BookedAt FROM Conqueror). Changing time/lanes ⇒ **cancel (`deleteReservation`) + `createReservation`**
  anew → re-check availability, re-link deposit/day-of order, risk slot loss. This is the hard part.

**Editability guard (all phases):** allow only while `status ∈ {confirmed, confirm_pending}`,
`dayof_order_sent_at IS NULL` (not checked in / lane not opened), and event time still in the future.
Optimistic guard against the lane-open cron racing the edit.

**NARROWED v1 (active, owner 2026-06-21): edit the PIZZA TOPPINGS + SODA flavor of a Pizza Bowl only.**
No player/lane/time changes; no adding pizzas/sides. Guests re-pick toppings/drinks before check-in.

- [ ] Edit surface on the confirmation page (`headpinz.com/s/{shortCode}`): load current pizza/soda
      selections per lane, reuse `BowlingFoodStep` UI to re-pick toppings + drink.
- [ ] Edit endpoint: guard (pre-check-in, future, status ok) → recompute rawItems (pizza/soda lines w/ new
      topping/drink notes) → reconcile onto the day-of Square order (update existing food line NOTES by uid,
      or remove+re-add) → update persisted `bowling_reservation_lines`.
- [ ] $0 swaps (same topping count) are free. **Adding paid extra toppings (>1/lane = $1 each):** OPEN
      QUESTION below — include the re-enter-card charge now, or restrict v1 to no-new-cost edits (paid extras
      added at the counter).
- [ ] If the food line isn't on the order yet (older orders pre-fix), add it during the edit.

**Later phases (deferred):** Phase 2 player count (reprice + `setLanePlayers`); Phase 3 lanes/time reschedule
(HARD — no QAMF reschedule API; cancel+rebook only, slot-loss risk). Spike Phase 3 before building.

**Payment-for-difference design:** recompute authoritative total → `diff = new_total − already_paid`;
enforce `diff ≥ 0` (add-only); if `diff > 0` require a fresh Square nonce on the edit page, charge with an
idempotency key bound to (reservationId, new_total), apply to the day-of order; hard-fail + page on-call if
displayed diff ≠ charged diff. Record an edit-audit row (what changed, diff, payment id, timestamp).

**Open questions for owner:**

- Phase 3: acceptable that a time/lane change briefly cancels + rebooks in QAMF (tiny window where the old
  slot is released)? Or restrict time/lane edits to "request" (staff-confirmed) rather than self-service?
- Any cap on how close to start time edits are allowed (e.g. block within 1h of the slot)?

**Verification:** live smoke per phase — book → edit (add paid item) → confirm difference charged once, day-of
order + Neon lines updated, QAMF reflects change, KDS gets the added food. No double-charge on retry.

## Christmas in July — landing page (B2B holiday open house, 2 locations) — IN PROGRESS 2026-06-15

Branch: `feat/xmas-in-july-landing` off `origin/feat/xmas-in-july-event` (NOT yet on main).
URL slug stays `xmas-in-july`; display title is **"Christmas in July"**.

**What it actually is (per flyer — corrected mid-build):** a festive **business-leader open house**,
NOT a public free-race promo. Holiday bites + signature drinks + venue/party-hosting pitch.
Included per guest: 2 drink tickets · holiday buffet (TBD) · complimentary bowling · 1 go-kart race (FM).
**Two events, one page, choose location:** Fort Myers 7/30 (HeadPinz & FastTrax, racing) and
Naples 7/23 (HeadPinz only — NO FastTrax, so RSVP-only). Both 4–7 PM; racing slot 4:30–5:30 PM.
Open RSVP. Decisions: one page w/ location chooser · RSVP + race booking · open access.

### Done

- [x] Assets on Vercel Blob (`events/xmas-in-july/`): bowling hero loop (1080/720 + poster), 7 gallery
      photos (WebP+JPEG, family pic dropped → 6 used). Upload script `scripts/upload-xmas-assets.mjs`.
- [x] Racing video = reused FastTrax homepage hero (`images/hero/hero-video.mp4` + `hero-racing.webp`).
- [x] `group-events.ts`: `GroupEventLanding` (heroVideo, included[], locations[], featureVideo, gallery,
      finePrint, eventTime) + `GroupEventLocation` (key/label/venue/date/address/racing). Populated
      `xmas-in-july` with B2B copy, both locations, what's-included. Dropped hard `minAge:18`.
- [x] Page: location-aware hero (bowling video) → "What's Included" → racing feature video → gallery →
      location chooser → RSVP. Naples branch skips waiver/DOB (RSVP-only); FM keeps race-booking funnel.
      Reduced-motion/Save-Data → poster. Confirmation hides waiver/racing-license for Naples.
- [x] RSVP endpoint stores `location` (both venues share the slug — only differentiator for ops).
- [x] tsc clean · build clean · a11y gate 0 violations · SSR renders all sections + chooser.

### TODO

- [ ] **GF photos** — owner sending 2–3 group-function photos; optimize + upload + slot into gallery.
- [ ] Buffet menu (TBD on flyer) — copy update when known.
- [ ] Live smoke on a deploy: FM path (choose FM → email → name+DOB → waiver → book race heat) +
      Naples path (choose Naples → email → name → RSVP confirmation). Verify RSVPs tagged by location.
- [ ] Commit + push branch (not committed yet) → PR link.
- [ ] Confirm with owner: keep slug `xmas-in-july` or add `christmas-in-july` alias.

## ⚠️ Temporary fallbacks to remove later

- **Race + standalone-attraction day-of auto-charge on start-time-passed** (added 2026-06-09,
  user-requested stopgap). `/api/cron/race-dayof-pay` normally settles the day-of order only when
  it sees the guest Arrived (-5) on the SMS-Timing dayplanner. As a safety net it now ALSO settles
  when the **activity start time has passed** (earliest heat for race, earliest slot for
  attraction — from `booking_metadata`, NOT `booked_at`), even if the Arrived scan failed/never
  fired. Standalone attractions = no bowling sharing the day-of order (bowling carts settle via
  lane-open). Remove once -5 detection is proven reliable. Search `FALLBACK` in
  `apps/web/app/api/cron/race-dayof-pay/route.ts` to delete (revert the scan-error bail too).
  NOTE: legacy attraction rows booked before this have empty `booking_metadata` → no start time →
  they're skipped (settle them manually via `?billId=…&token=…` if needed).

## HP Arena E-Tickets — Laser Tag + Gel Blaster at HeadPinz FM (LIVE — 2026-06-11)

**Status:** fully live, including the "now checking in" flow. Runbook + integration notes:
`docs/hp-arena-etickets-rollout.md`. Owner decisions: FM only (Naples later) · laser tag +
gel blaster · full HeadPinz identity (HP sender `+12393022155`, headpinz.com links).

- [x] PR-1..PR-5 (shared plumbing, HP ticket views, pre-session cron, schedule, scanner +
      `ARENA_QR_ENABLED`) — merged to main 2026-06-11, cron live (owner approved skipping the
      dry-run sequence; sender = existing HP DID).
- [x] PANDORA ASK — delivered same-day: `sessions/current` (called arena sessions) +
      `sessions/next` (next unstarted session by person/participant). Wired:
      `arena-checkin-alerts` cron (1 min — `race:called:{sid}` banner + NOW CHECKING IN
      SMS/email, source `arena-checkin-cron`) and scanner (called-signal green gate w/
      time-window fallback, "come back at X" via sessions/next).
- [ ] OWNER 0b: verify whether ONLINE arena bookings attach participants pre-session (book one
      2h+ out, probe participants). If purchaser-only/none → coverage = POS/phone population;
      follow-up = send e-ticket link at booking-confirmation time.
- [ ] OWNER 0d: sign off ImportantArenaInfo arrival/waiver copy (conservative defaults live).
- [ ] POST-LAUNCH WATCH (first week): admin board arena rows, `cron:log` `arena-pre` +
      `arena-checkin`, `unclassifiedSessions` in cron responses, undelivered rate on the HP DID,
      racing `bySource.eTicket` canary.
- ⚠️ BEFORE NAPLES: `ticket:bySession:{sid}:{pid}` + `alert:arena-pre/arena-checkin:{sid}:{pid}` + `race:called:{sid}` keys are NOT location-scoped — fine at FM (FT+HP FM share one BMI
  server / sessionId namespace), but Naples is a separate BMI server → add a location
  segment to these keys first.

## HPN Arena E-Tickets (Naples) + e-ticket overnight clear (IN PROGRESS — 2026-08-16)

**Owner ask:** (1) e-tickets fully working for HeadPinz Naples (Gel Blasters); (2) no e-ticket
sends outside business hours — queued sends still in the retry/quota queues overnight must be
cleared, not sent.

**Grounding (verified 2026-08-16):** Naples' arena dayplanner resource is ALSO named `HP Arena`
(live Pandora probe: 200 with "55 - Nexus Laser Tag" today; NEXUS/Arena/Gel Blaster variants all
404). Session names use the same "NN - Nexus Gel Blaster / Nexus Laser Tag" convention →
`classifyArenaSession` works unchanged. Pandora proxies already allowlist `PPTR5G2N0QXF7`.
Quota-queued SMS survive up to 7 days and WOULD send at 3am when the 1h cooldown lapses
(`sms-retry-sweep` runs `* * * * *`, no hour gate anywhere in the e-ticket send rail).

### PR A — `feat/hpn-arena-etickets` (BUILT 2026-08-16, commit 7132f0f6)

- [x] Location-scope BMI-id-keyed Redis keys, legacy-default (`lib/bmi-key-scope.ts`): FM/FT
      (shared BMI server) key shapes stay byte-identical (no migration); non-FM locations
      (Naples) gain a `{locationId}` segment. Keys: `ticket:bySession`, `ticket:byParticipant`,
      `alert:arena-pre`, `alert:arena-checkin(:session)`, `race:called`,
      `eticket-nocontact:arena-*`. `getParticipantTicketRef`/`findTicketIdFor`/
      `setParticipantTicketRef` gain a locationId arg (racing callers pass FT const).
- [x] RetryEntry + QueuedSend gain `locationId?`; `drainRetries` dedup-map writes SCOPED keys
      for Naples entries (else retry-path double-send).
- [x] `src/features/arena-tickets/centers.ts`: per-center config (FM + Naples: locationId,
      resources `["HP Arena"]`, DID +12394553755, 8525 Radio Ln address, phone). Both arena
      crons + scanner called-board loop centers. Kill switch `ARENA_NAPLES !== "false"`.
- [x] Ticket views + email footers + cards help line: address/phone by `ticket.locationId`
      (`arenaLocationMeta`). `/api/race-session-state` accepts `locationId`; admin resend
      picks the ticket center's DID. Scanner scan path already threads QR locationId.
- [x] Unit tests: key scoping (FM legacy / Naples scoped), center config (centers.test.ts).

### PR B — `feat/eticket-overnight-clear` (stacked on A)

- [x] `src/features/eticket/quiet-hours.ts`: quiet window default 02:00–08:00 ET (owner call
      2026-08-16 — HPFM/HPN run past midnight some nights; alternate is
      `ETICKET_QUIET_START_ET=4`; env-tunable numbers, not opt-in flags). Gates the 5 e-ticket crons
      (pre-race-tickets, arena-tickets, checkin-alerts, arena-checkin-alerts,
      eticket-removals; dryRun bypasses for ops testing) + `drainRetries` (retry queue is
      e-ticket-only) + per-entry triage of e-ticket sources in the sweep's quota drain.
- [x] Age cap at drain: e-ticket entries older than `maxQueueAgeMs` (30 min check-in alerts /
      3h pre-session) are logged + dropped in BOTH drains (never send stale even if the clear
      cron misses).
- [x] New cron `eticket-overnight-clear` (`20 7,8 * * *` + in-code 2–5am ET gate, the
      wallet-overnight-clear pattern): purge e-ticket entries from `sms:retry:pending` +
      `sms:quota:queue` with `logSms` audit rows (error "expired in queue — not sent
      (after hours / stale)"). dryRun + kill switch `ETICKET_OVERNIGHT_CLEAR !== "false"`.
- [x] Admin board: amber "expired in queue" pill in EticketAdminClient (resend stays possible).
- [x] vercel.json entry. Unit tests: quiet-hours boundaries + source scoping + age caps.

**Verify before calling live (owner):** deploy → `curl ?dryRun=1` on arena-tickets (expect
hp-naples candidates once Naples has arena sessions in the next 2h) and on
eticket-overnight-clear (expect wouldRun/etHour + empty-queue report) → watch admin board
arena rows + `cron:log` `arena-pre`/`arena-checkin` for `hp-naples:`-prefixed
unclassifiedSessions → first real Naples session day, confirm SMS arrives from
(239) 455-3755 with Radio Ln address on the ticket.

**Open for owner:** Naples ticket copy says "HP Arena desk" (BMI resource name at Naples IS
"HP Arena", but guest-facing Naples branding is "NEXUS arena") — kept FM copy verbatim; flag
if you want NEXUS wording. Quiet window DECIDED 2026-08-16: start 2am ET (late-close nights);
if ops prefers 4am, set `ETICKET_QUIET_START_ET=4` (env only, safe by construction — the
stale-age drop covers the purge-to-quiet gap). Whole stack stays on
`feat/eticket-overnight-clear` (contains `feat/hpn-arena-etickets`) for merge later — NOT
merged to main, NOT pushed.

## Booking V1→V2 FULL CUTOVER + race-pack port (IN PROGRESS — 2026-06-07)

**Goal (user directive):** V2 is the booking system. Replace ALL booking entry points
with entry into V2, AND port race-packs to V2 (the only activity with no v2 today).

**Grounding:** ~90 v1 entry points inventoried; 4 shared components carry most traffic.
Cutover mechanism = server-side redirects (catch emails/QR/bookmarks) + middleware fix +
update the hot shared links. Honors the repo cutover rule (redirect v1→v2; delete v1 later).
Decisions locked by `tasks/future/race-pack-as-credit-purchase.md` + v1 parity: race-pack
DEFERS redemption (credits spent in the existing v2 race flow), NO expiration (v1 = year-2999),
single Square SKU + name override, grant via `addDeposit(+N)` on Square capture.

### Phase A — Entry-point cutover for race/attraction/bowling/KBF (conflict-free w/ other workflow)

- [ ] Middleware: exclude `/v2` paths from the HeadPinz `/hp` + `/book/bowling*` + `/book/kids-bowl-free*`
      rewrites (FIXES latent bug: `headpinz.com/book/bowling/v2` → `/hp/book/bowling/v2` 404). Point
      HeadPinz `/book` (exact) → `/book/v2` instead of `/hp/book`.
- [ ] `next.config.ts` redirects (307 temporary during cutover — flip to 308 when v1 deleted):
      `/book`→`/book/v2`, `/book/race`→`/book/race/v2`, `/book/{gel-blaster,laser-tag,duck-pin,shuffly}`→`…/v2`,
      `/book/bowling`→`/book/bowling/v2`, `/book/kids-bowl-free`→`/book/kbf/v2`, plus `/hp/book/*` equivalents.
      EXCLUDE `/book/race-packs`, `/book/confirmation*`, `/book/checkout`, anything `/v2`.
- [ ] Update 4 shared components → v2: `components/Nav.tsx`, `components/MobileBookBar.tsx`,
      `components/headpinz/Nav.tsx`, `components/headpinz/MobileBookBar.tsx`.
- [ ] Update high-traffic CTAs (home Hero, pricing, racing, leaderboards, hp/fort-myers, hp/naples) → v2.
- [ ] Update static email-template booking URLs (redirects also catch these).
- [ ] **MERGE GATE:** bowling/KBF v2 must pass the QAMF+Square smoke test before this branch hits prod.

### Phase B — Race-pack v2 port (DONE — STANDALONE, 2026-06-07)

**Approach:** standalone `/book/race-pack/v2` (user: "whichever easiest/most efficient"). Deliberately
NOT the in-cart `CreditPackItem` from the design doc — that threads through `unified-reserve.ts` +
`types.ts`, which the other workflow is mid-refactor on. Standalone matches what v1 actually does
(race-packs is its own flow) and reuses v1's PROVEN, server-atomic Square + `addDeposit` money rail.
Touches ZERO files the other workflow is editing.

- [x] `src/features/booking/data/packs.ts` — 6 SKUs verified 1:1 vs v1 (price, depositKind, raceCount, shared Square SKU).
- [x] `src/components/features/booking/RacePackFlow.tsx` — pick pack → identify racer (returning lookup /
      new) → review + clickwrap → `PaymentForm` (lineItem + `postPaymentAction:addDeposit`).
- [x] Route `app/book/race-pack/v2/page.tsx` (thin server shell + metadata).
- [x] Confirmation reuses v1 `/book/race-packs/confirmation` (already renders the viaDeposit "Credits
      Loaded" + "Credits Pending" states) — left on v1, NOT redirected.
- N/A `CreditPackItem` union / `credit-pack` service / `unified-reserve.ts` wiring / step registry —
  unused by the standalone approach (charge goes through `/api/square/pay`, never unified-reserve).
- N/A Landing tile on `/book/v2` — the v1 `/book` hub never listed packs either (parity-correct).
- ⚠️ Simplification vs v1: per-mode OTP omitted (loading credits is non-extractive — the buyer pays to
  ADD value, so there's no account-takeover surface to gate). Revisit if abuse ever appears.
- FOLLOW-UP (optional): in-cart `CreditPackItem` integration once the other workflow's unified-reserve
  refactor lands, if mixing a pack into a multi-activity session is ever wanted.

### Phase C — Race-pack cutover (DONE — 2026-06-07)

- [x] Redirect `/book/race-packs` → `/book/race-pack/v2` (middleware `bookingV2Target`, exact match so
      `/book/race-packs/confirmation` stays on v1). Pricing "View Packages" CTA covered by the redirect.
- [ ] Retire/delete the v1 `/book/race-packs` page in a later PR after ops sign-off.

### Phase D — HeadPinz center-aware v2 landing (DONE — 2026-06-07)

Convert HPFM/HPN booking to v2 with center-scoped offering order on `/book/v2`.

- [x] `landingOfferingsFor(brand, center)` in `activities-catalog.ts` — Naples scopes to ONLY
      Naples-available offerings (drops FT-only race/duckpin/shuffly); Fort Myers/unknown shows all;
      within scope the VISITOR'S brand propagates first (FastTrax-first on FT, HP-first on HP;
      shuffly's "auto" brand resolves to the entry brand). + 5 unit tests (26/26 catalog tests pass).
- [x] `?location=` → `session.center`: `EntryContext.center` + parsed in `parse-entry-context.ts`
      (was an unused gap — `setCenter` was never dispatched in v2, so center was always null/FM).
      `BookingFlow` seeds `setCenter` on a fresh session → Naples books with the Naples clientKey.
- [x] `/book/v2` page resolves center from `?location` + passes ordered offerings + center to PromoLanding.
- [x] `PromoLanding` tile links carry `?location` so the picked activity seeds the right center.
- Entry: Naples hero CTA (`/hp/book?location=naples`) → Phase-A redirect → `/book/v2?location=naples` → scopes. ✓
- ⚠️ Minor pre-existing gaps (not blocking): HP nav "Book Now" goes bowling-direct (not the grid) and
  one `/naples` laser-tag link lacks `?location` → defaults to FM center. Polish later if wanted.

## Group-Function: re-price after paid-in-full (IMPLEMENTED — 2026-06-06)

- **Plan + impl log:** [group-function-paid-in-full-reprice.md](group-function-paid-in-full-reprice.md)
- **Problem:** A BMI edit on a _paid-in-full_ event recomputed balance as `total − deposit_due`, ignoring the balance already collected → re-sign re-charged it → **overcharge**. No path to charge just the delta. Also: paid Square balance links were never reconciled.
- **Scope (Eric):** Only paid-in-full events. Resign required regardless. Increase → charge difference + load gift cards (card on file, or capture a card on re-sign). Decrease → flag staff, no auto-refund. Deposit-phase flows untouched.
- **Status:** PR-1 + PR-2 implemented on branch `feat/gf-balance-link-reconcile`; typecheck/lint/prettier clean. **Not committed; not live-smoke-tested.** Verify §6 before go-live.

## PR-B5: Bowling + KBF into Unified BookingFlow (IN PROGRESS — 2026-06-02)

- **Branch:** `feat/booking-b2-race` · merged with main 2026-06-02
- **What shipped (all build-verified):**
  - D1: Type extensions — BowlingItem/KbfItem with 30+ fields, LoyaltyState on BookingSession, 5 new reducer actions
  - D2: Bowling service — `service/bowling.ts` (hold/confirm/cancel/reserve) wired into `getService()`
  - D3: 7 bowling step components — Players, Slots, Tier, Offer (QAMF hold), Shoes, Attractions (info-only), Food
  - D4: 2 KBF steps — KbfIdentity (lookup→OTP→verify), KbfBowlers (family member selection)
  - D5: Hold timer generalized — ReservationTimer handles BMI + QAMF with 8-min auto-extend
  - D6: Checkout bowling path → `bowlingReserve()` → `/api/bowling/v2/reserve`
  - D6b: Shared HeadPinz Loyalty — LoyaltySection at checkout for ALL HeadPinz bookings (earning + redeeming)
  - D7: Step registry — all bowling/kbf placeholders replaced with real components
  - D8: Deposit unification — bowling reserve uses `createDepositAndCharge()`, same as race/attraction
  - D9: DiscountCodeInput on bowling slots step
  - D10 (2026-06-02): BowlingSlotsStep → HP_LOCATIONS for real center hours
  - D11 (2026-06-02): BowlingOfferStep — duration picker for hourly, line-item enrichment (label/price/catalog/deposit%), per-lane vs per-person multipliers, product overrides
  - D12 (2026-06-02): Checkout quote fetch from `/api/square/bowling-orders/quote` + real line-item display (product names, per-line amounts, booking fee, tax, deposit breakdown)
  - D13 (2026-06-02): BowlingShoesStep stores shoe product metadata for checkout name resolution
  - D14 (2026-06-02): BowlingAttractionsStep → info-only (attractions are separate cart items, same as racing)
  - D15 (2026-06-02): Loyalty params wired to BMI reserve path (loyaltyAccountId, rewardTierId, rewardDiscountCents)
  - D16 (2026-06-02): Mixed-cart guard — **NEVER LANDED / entry is stale** (verified 2026-06-10: `addItem` allows mixed carts — `machine.test.ts:62` asserts it; `buildCombinedLineItems` merges race+bowling+attraction into one Square order). Kept that way DELIBERATELY: combo specials ([combo-specials-plan.md](combo-specials-plan.md)) require race+bowling in one session. Do NOT re-add a guard.
- **Still needs before go-live:**
  - Smoke test with QAMF staging + Square sandbox
  - Full Square Loyalty API reward creation in BMI reserve route (currently applies discount only; bowling route has full implementation)

## v2 Checkout: Server-side atomic BMI payment/confirm

- **Priority:** Medium (v2 checkout milestone)
- **Context:** v1 confirms BMI payment client-side on the confirmation page after Square charges. PR #13 (2026-06-02) added retry + error UI as an immediate fix, but the architecture still has a gap if the browser closes between Square charge and confirmation page load.
- **v2 fix:** Add `confirmBmi` postPaymentAction to `/api/square/pay` so Square charge + BMI confirm happen atomically server-side. Extract shared `lib/bmi-client.ts` for BMI auth + `confirmPayment()`. Wire into v2 checkout service.
- **See:** [restructure-plan.md § v2 checkout: server-side atomic BMI payment/confirm](restructure-plan.md)

## SEO: HeadPinz metadata on shared /book routes

- **Priority:** High
- **Issue:** `headpinz.com/book/*` pages show FastTrax title/description in Google results because `/book` routes use the root layout metadata (FastTrax-branded), not the `/hp` layout
- **Root cause:** Middleware line 69 excludes `/book` from the `/hp` rewrite, so shared booking pages inherit the root `app/layout.tsx` metadata
- **Fix:** Use `generateMetadata` in `/book` pages that reads the `x-brand` header (set by middleware) to return HeadPinz or FastTrax metadata dynamically
- **Files:** `app/layout.tsx`, `app/book/[attraction]/page.tsx`, `app/book/race/page.tsx`, `middleware.ts`
- **Google result example:** `headpinz.com/book/gel-blaster` shows "Indoor Go-Kart Racing & Entertainment | Fort Myers, FL" and "63000 sq ft of high-performance electric go-kart racing..."

## Daily Events admin (ported from employee portal) — BUILT 2026-07-12, feat/daily-events-admin

Ports portal.headpinz.com/management/operations/daily-events (group event ops board + detail)
into this repo at `/admin/{token}/daily-events` (+ `/admin/embed/daily-events` HMAC embed).
Feature at `src/features/daily-events/` + `src/components/features/daily-events/`; routes at
`app/api/admin/daily-events/{reservations,reservations/[projectId],payments,event-metadata}`.
Owner directive honored: upstream BMI calls are byte-faithful ports of the portal's (only
deviations: parseWithRawIds response parsing per the precision hard rule; resource mappings +
waiver thresholds frozen from a 2026-07-12 portal-DB export into constants.ts; payments read
`group_function_quotes` directly by projectId instead of the portal→website proxy hop).
Dropped per owner: party assignments, PandaDoc (replaced by native ContractSection).
`event_metadata` re-homed to website Neon (portal-verbatim DDL) — run
`scripts/migrate-daily-event-metadata.mjs` once at cutover (PORTAL_DATABASE_URL + DATABASE_URL).

**Remaining before staff cutover:**

- [ ] Owner live pass: page vs portal side-by-side (same date/location), detail modal, print
      outputs, food-out manual save on a REAL event (verifies the BMI private-note sync write —
      left untested on purpose; sync no-op path + Neon cycle verified with a synthetic id).
- [ ] Portal repo (separate PR): add `daily-events` to embed TOOL_PATHS, swap its page for the
      iframe, retire its party-assignment note writer (two writers would alternate the
      "----- Portal Staff -----" section), keep TV dashboard (still reads portal event_metadata).
- [ ] Run the event_metadata backfill at cutover.
- [ ] Env check on Vercel: ANTHROPIC_API_KEY or VERCEL_AI_GATEWAY_KEY must be present for
      food-out AI extraction (graceful "AI extraction failed" fallback otherwise).

**Cleanup candidate discovered:** `lib/bmi-office-actions.ts` `fetchProject`/`fetchPersonsByIds`
parse BMI payloads with plain JSON.parse — latent 17-digit precision hazard for OTHER callers
(this feature deliberately does not reuse them). Fix in its own PR.

## Ultimate Qualifier: same-track gap 60 → 30 (owner 2026-08-04) — DONE, unsmoked

Owner: "Ultimate qualifier booking restriction if on same track can be dropped to 30 minutes.
Both web and kiosk."

The UQ Starter→Intermediate buffer (60 min) budgeted qualifying + POV review + appetizer AND the
walk to the other track. Staying on one track drops the walk, so same-track pairs now need only
30 min. Cross-track stays 60.

- [x] `lib/packages.ts` — `minMinutesAfterEndOf` gains `sameTrackMinutes?`; all 5 UQ variants set
      `{ ref: "starter", minutes: 60, sameTrackMinutes: 30 }`. Mega + both junior variants are
      single-track, so they are effectively 30 flat.
- [x] `packageGapMinutesFor(rule, refTrack, candidateTrack)` added to BOTH conflict modules
      (v1 `lib/heat-conflict.ts`, v2 `src/features/booking/service/conflict.ts` — kept in
      lockstep). Reuses each file's `normalizeTrack`, so "Blue Track" ≡ "Blue"; an empty/unknown
      track on either side counts as a track CHANGE and keeps the stricter 60.
- [x] **Web (v1, `/book/race`)** — `app/book/race/components/PackageHeatPicker.tsx` resolves the
      gap PER CARD from `refPick.trackOption.track` vs `proposal._track`.
- [x] **Kiosk + web v2** — `src/components/.../race/PackageHeatPicker.tsx`: `effectiveGapByRef`
      (Map<ref, minutes>) became `effectiveGapByRefTrack` (Map<`ref|track`, minutes>). The
      late-night dead-end fallback still floors at 30 and now evaluates each proposal against
      its OWN resolved gap.
- [x] Step-banner copy is now dynamic: one number when every track resolves the same, otherwise
      "…30 min … on the same track — 60 min if you switch tracks". Keyed EN+ES as
      `racePackage.gapNote` / `racePackage.gapNoteSplit` (kiosk i18n hard rule).
- [x] `UQ_LONG` marketing copy: "scheduled an hour later" → "scheduled at least half an hour
      later" (the old line is wrong for same-track now).
- [x] No server-side change needed — `assertHeatBookable` enforces tier + restriction rules, NOT
      the package gap. The gap is a picker-side rule in both flows.
- [x] Gates: tsc clean, eslint 0 errors (4 pre-existing warnings), a11y-gate green, 1386 booking + kiosk tests pass, `packageGapMinutesFor` unit-tested in `conflict.test.ts`.

**Not done — needs a live pass:**

- [ ] Web `/book/race`: UQ weekday adult, pick a Red Starter → Red Intermediate 30–59 min later
      is now pickable; the same-time Blue Intermediate still reads "Available 60 min after…".
- [ ] Kiosk: same check on the shared picker, plus the Spanish banner (switch locale on the
      Intermediate step) and a single-track variant (Mega Tuesday / junior Blue) showing the
      one-number "30 min" form.
- [ ] Confirm ops actually want 30 min on Mega — that variant is single-track, so it went from a
      hard 60 to a hard 30 with no cross-track escape hatch.

**Pre-existing, NOT fixed here:** the v2 `PackageHeatPicker` is otherwise all hardcoded English
(card status labels, tooltips, roster, banners) despite being a kiosk surface. Only the gap note
is keyed. Worth its own i18n PR.

---

# E-ticket retraction on removal (2026-08-06)

## The bug

A racer taken off a heat kept the e-ticket SMS we had already sent them. Measured
across 8/5–8/6: **29 cron sends named a heat the recipient is now off**, 19
distinct racers. Every one went out BEFORE the heat ran — median ~50 min of lead
time, up to 135 — so there was a real, actionable window and nothing used it.

**Root cause: the SMS is a one-shot snapshot with no retraction path.** The
`/t/{id}` and `/g/{id}` pages already poll session-participants every 20s and
flip to `InvalidCard` (verified — and `InvalidCard` is evaluated before `isPast`
and `checkingIn`, so removal wins the render race). But that only helps a guest
who reopens the link. The text in their pocket stayed wrong.

**Why nothing caught it:** Pandora exposes no removal event. `excludeRemoved`
filters on `F_PAR_STATE = 5`, but that field is NOT in the response body — a
removed racer's record is byte-identical in shape to an active one. Verified
against live payloads. The only way to know is to pull the roster twice and diff.

## What shipped

- **`src/features/racing/eticket/removal-sweep.ts`** — notify index + pure
  `removalVerdict` guard matrix + retraction copy/send.
- **`app/api/cron/eticket-removals/route.ts`** — every 2 min, `*/2 * * * *`.
- **`pre-race-tickets`** — `recordNotified` on both send paths;
  `releaseVacatedHeat` now also `forgetNotified`s the vacated heat.
- **`checkin-alerts`** — `fetchPandoraPidsAnyState` fail-open FIXED (see below).
- Kill switch `ETICKET_REMOVAL_SWEEP` (defaults ON, `!== "false"`).

## A move is not a removal — four guards

Moving a racer A→B removes them from A, and `pre-race-tickets` already owns that
case ("was X -> now Y" + `supersedeMovedTicket`). Double-texting on a move would
be strictly worse than the bug. Guards, in order:

- **G1** racer is ACTIVE on any other heat today
- **G2** old ticket carries `movedTo`
- **G3** participant index repointed at another session
- **G4** 6-minute grace = 3 pre-race ticks, so the move path always wins the race

**G1 had to be widened, and the replay is what caught it.** Built only from
sessions we'd e-ticketed, it missed a racer moved to a not-yet-ticketed heat —
racer 18586763 (bounced across four heats in twelve minutes on 8/6) drew four
retractions. Now computed across the whole day, lazily, only when someone is
about to be retracted, via `prefer=cache` so it is Redis reads not Pandora.

## Fail closed, always

The diff is a POSITIVE signal ("Pandora affirmatively has them at state 5").
Inferring removal from mere ABSENCE is indistinguishable from Pandora blinking,
and would text racers mid-outage that their race had vanished. So: either roster
call non-200, malformed, or flagged `stale` by the proxy's cache-fallback path →
skip the whole session. Empty all-state roster → skip. Heat already ran
(`actualStart`/`actualEnd`) → skip; beyond retracting.

Same reasoning fixed `fetchPandoraPidsAnyState`, which returned `new Set()` on a
non-200 — making `!allPandoraPids.has(pid)` pass for EVERY express holder, so the
one existing removal check silently inverted itself exactly when Pandora was
unhealthy. Now returns null and the caller drops the express path for that tick.

## Verification

- 19 unit tests on the guard matrix (incl. move-vs-grace ordering, GSM-7 body).
- Full suite: 256 files / 3563 tests green. tsc + eslint clean.
- **Live replay of 8/6** (`scripts/eticket-removal-replay.mts`, untracked local probe): 33 removals →
  **28 suppressed as moves, 5 genuine scratches retracted**, one text each.

## Known limits

- A racer scratched from one heat while still active on another gets NO
  retraction (G1 is blunt and suppresses it). False negative, chosen
  deliberately: a wrong retraction is far worse than a missed one. `participantId`
  could distinguish move-vs-second-booking precisely if this ever matters.
- Only pre-race notifications are swept. Check-in alerts fire when the heat is
  already being called, so the retraction window is ~0 and the heat-ran guard
  would exclude them anyway.
- **Not yet smoked against a live scratch.** The notify index only populates
  once `pre-race-tickets` runs with this code deployed.
- BMI precision is NOT a concern on this path (checked, not assumed): Pandora
  returns `personId` as a QUOTED STRING — `"personId":"63000000007188906"` —
  so `JSON.parse` round-trips 17-digit ids bit-exact and `typeof` is `string`.
  The proxy, the crons and this sweep never coerce them.

# WSync dup-jam fix — single-writer pipeline with sync barriers (2026-08-12, planned)

Owner directive: the check-in duplicate-projectPerson jam "can't happen" — fix it. Constraints
set by owner: ONE writer per BMI entity (never write the same thing to both cloud and local);
after a Pandora-side sign/mint, WAIT for it to reach the Office/cloud side before cloud calls.
Full audit: tasks/audit-pandora-office-cross-rail-2026-08-12.md. Rule memory:
feedback_single_writer_per_bmi_entity.

Design (rails stay as-is — attach = public-booking ONLY, seat = Pandora ONLY, no Office writes
on this path; the fix is barriers + patience, not new writers):

- [ ] PR0 probe A (cheap, closes a stale doc flag): confirm registerProjectPerson against a
      CONFIRMED project formally. Production evidence 8/11 already shows it working
      (W59832 attach @17:10, hours post-confirmation, cloud row 63000000008105288) — retire the
      "unverified against CONFIRMED" banner in kiosk/waiver/bmi-attach.ts + flags.ts if probe
      agrees (retire-banners rule).
- [ ] PR0 probe B: timing probe — after Pandora person mint / waiver sign, poll Office person
      GET until visible; measure local→cloud lag distribution (drives barrier-A budget).
- [ ] PR0 probe C (optional, biggest prize): inventory whether the Office API exposes a
      cloud-side schedule-linkage write (the projectPerson add is already proven on the Office
      rail per the 7/31 remove-probe). If a cloud seat write exists, attach+seat can land on ONE
      side and WSync delivers both rows down together — the race disappears entirely.
- [x] PR1: stop manufacturing duplicates — PUSHED 2026-08-12 branch fix/kiosk-bmi-sync-sweep (53f3121d), waiver-join rail folded in per owner —
      (a) treat `person_not_on_project` as RETRYABLE (vendor-documented), never fold into
      `schedule_status='failed'` (kiosk/checkin/server.ts:1671);
      (b) fix count-only responses skipping straggler re-POSTs (schedule-racers.ts:158);
      (c) wire the never-built async sweep off listPendingScheduleRows — retries spanning
      minutes, using the documented local-visibility probe
      (Pandora GET /bmi/reservation/{loc}/{id}: 200=synced down, 404=not yet) as the gate;
      (d) barrier A on the other direction: after kiosk person mint, gate the cloud attach on
      Office-side person visibility (same sweep, opposite probe);
      (e) staff memo only after N minutes of REAL failure, with reason distinguishing
      "waiting on sync" from "vendor refused" — the current instant
      "AUTO CHECK-IN INCOMPLETE" memo is what sends staff to hand-seat (= the duplicate).
- [ ] PR2 (separate, same rule): remove cross-rail write FALLBACKS elsewhere
      (setProjectState Pandora↔Office, appendProjectPrivateNote's 3-store escalation) — each
      entity gets one rail; a fallback that writes the other side is a split-brain generator.

## Auto-move to holding when the room empties + Nx briefing bookmarks (2026-08-14) — BUILT, unpushed, NOT smoked on a live briefing

Owner: "the goal would be to auto move the session to holding if the room empties…
they're not near a computer." Plus: "I'd like to create bookmarks on the cameras."

**The problem is a missing press, not a slow one.** Measured on `briefing_events`:
7 `holding` presses across 131 room occupancies (~60 briefings on 8/13 alone). When
staff DO press it they are a median **24s EARLY** — someone at the desk anticipating
the film's end. The room's occupancy is otherwise only ever closed by `replaced`.

**Evidence the camera can answer it** (backtest over all 75 of 8/13's occupancies,
`_nx-auto-holding-backtest.mts` / `_nx-post-helmet-motion.mts`, both gitignored):
Nx records motion on both briefing cameras at 3-80s granularity (`analytics` periods
are 0 — no object detection, so no people COUNTING, only activity).

| quiet window      | fires     | median after film end | beat the next group in |
| ----------------- | --------- | --------------------- | ---------------------- |
| 90s               | 45/75     | 2:39                  | 44/45                  |
| 45s               | 56/75     | 1:46                  | 55/56                  |
| **30s (shipped)** | **62/75** | **1:29**              | **61/62**              |

Fire delay scales with roster size — 1-2 racers median +0:30, 10+ median +2:04 — i.e.
gear-up time, which is exactly what a clock cannot model. 15 of the 16 firings at the
0:30 floor are 1-2 person groups. **7 archive stills pulled at firing instants: all
completely empty rooms.** Misses skew LARGE (rosters 14/12/9/9/8): a big group keeps the
room busy until the next group walks in, so there is no quiet moment — those already
close as `replaced`, so nothing is lost, but auto-holding covers big groups least.

**NOT the auto-advance timer the owner had removed** (phase.ts, same week: "there
shouldn't be any auto moving to holding"). That was a 30s countdown declaring a room free
on a guess. `briefingTimelineAt` is untouched, the helmet phase still never ends, the desk
keeps its control. This fires only on the NVR observing an empty room.

- [x] `nx/motion.server.ts` — `motionInLast`; **unreadable = `unknown`, never `quiet`**
      (the relay intermittently 200s with an EMPTY body; parsed leniently that would
      empty every room on one tick). `nxRelayGet`/`nxRelayPost` exported from
      camera.server.ts so there is one auth path.
- [x] `briefing/auto-holding.ts` — pure decision, 16 tests. Gate = film AND helmet phase
      done (a group sits still to watch a film); `unknown` motion refuses; refuses when
      the lane's holding slot holds a DIFFERENT session (sendToHolding displaces the
      previous holder into `racing` — being wrong there lies to the pit board);
      gives up 45min after the film.
- [x] `briefing/auto-holding.server.ts` — sweep + the switch. Timing gate evaluated BEFORE
      any network call, so idle/mid-film rooms cost zero Nx traffic. `SET NX` claim taken
      LAST (claiming first would burn a busy room's only chance).
- [x] Kill switch in the CHECK-IN BOARD SETTINGS SHEET (owner's ask), Redis-backed,
      default ON, no TTL, server-wide — surfaced on the board poll as
      `BriefingBoardStatus.autoHolding`, flipped via `POST /api/admin/briefing`
      `{action:"auto-holding"}`.
- [x] `ended` reason `auto-holding`, distinct from `holding` — an insurance log must not
      record a camera's inference as a person's observation.
- [x] `/api/cron/briefing-auto-holding` every minute + `?dryRun=1`.
- [x] **Nx bookmarks** `briefing/bookmarks.server.ts` — name = `sessionLabel()`
      ("Session 43 · Junior Starter", the house grammar), description = what happened,
      tags = low-cardinality facets (`briefing`, `start`/`end`, room, race type; NO
      per-session tag — it would add hundreds of single-use tags and the number is
      already in the name). Start written in `startBriefing` (first start only, beside
      the room photo); end in `sendToHolding`, so the staff press and the sweep share
      one seam. Best-effort throughout.
- [x] tsc 0 · eslint 0 · 441 signage tests · `next build` 0 · a11y gate 0
- [x] Smoked live: sweep dry-run read prod Redis + both cameras (`quiet` in 232ms/1364ms)
      and correctly refused on the timing gate; bookmark create/read/delete verified on
      the real NVR and **cleaned up — zero bookmarks left on either camera**.
- [ ] **Never seen fire on a real briefing.** First race night: run
      `/api/cron/briefing-auto-holding?dryRun=1` and read `why` per room before trusting it.
- [ ] Nx write permission: bookmarks need "Manage bookmarks". The owner login has it; the
      planned view-only service account (camera.server.ts) MUST be granted it too or the
      markers stop silently.
- [ ] `cleared` / `replaced` room ends write no bookmark — only `holding`. Extend if wanted.

## Race-event camera bookmarks (2026-08-14) — ON MAIN, never seen fire on a live race

Owner: "bookmarks for other race events. Session start, session paused, session resumed,
sessions end… write this to all the cameras for that track." Built and pushed autonomously
(owner asleep, explicitly authorised: "non fatal so you can build, test and push").

**Fan-out, measured against the live device list:** blue **15** cameras, red **17**,
mega **32** (the joined circuit — same reason both briefing rooms serve Mega). Pit rows
included: a session's story ends in the pit lane. Offline cameras excluded — a marker with
no footage behind it reads as "not captured" during a review, which is worse than none.

**Where each event comes from — three are exact, one is sampled:**
| event | source | accuracy |
| ---- | ---- | ---- |
| start | venue broadcast `RaceStart` → webhook | the venue's own `ActualStart` |
| end | venue broadcast `RaceFinish` → webhook | the venue's own `ActualEnd`, STAMPED pushes only |
| paused / resumed | SMS-Timing socket `S` field, 1/min cron | ±60s, sub-minute pauses missed |

Pause is on no wire at all — it exists only as socket state, so it is polled. The marker's
range leads in 2 min so the footage behind it contains the _cause_, and the description
says the moment is approximate. Worth having: a kart pause is nearly always an incident.

- [x] `nx/track-cameras.ts` — pure name matcher, 10 tests. **The double space is real**:
      three devices are `FT Track - Red  - …`; a matcher on the literal `"Red - "` silently
      drops them. Also refuses `FT Redemption` (the naive `/Red/` trap).
- [x] `briefing/race-state.ts` — pure frame parse + transition, 12 tests. `"{}"` = a real
      "no race" answer, distinct from unreadable; **no transition across a heat change**
      (heat 42 ending while 43 loads paused is not a pause).
- [x] `briefing/race-bookmarks.server.ts` — fan-out, NX claim per (race, phase) taken
      BEFORE any camera (the broadcast replays the whole day's list on every push —
      unclaimed this writes hundreds of duplicates across 15-32 ribbons), concurrency 6,
      **one retry for stragglers only** (measured: relay drops ~1 write in 15).
- [x] `briefing/race-state-watch.server.ts` + `/api/cron/race-state-watch` every minute.
- [x] Second kill switch on the check-in board settings sheet, separate from auto-holding:
      that one changes how the night RUNS, this one only annotates. Volume is the likely
      reason to reach for it.
- [x] tsc 0 · eslint 0 · **4671 tests** · `next build` 0 · a11y 0
- [x] Smoked live on the real NVR: 15-camera fan-out in ~1.8s/event, replay guard returned
      0 on the second attempt, socket state read 912ms for both tracks. **All 29 test
      bookmarks deleted — verified 0 remaining across all 39 FT cameras.**
- [ ] **Never seen fire on a live race.** Expect ~2-3k bookmarks on a 60-heat Saturday
      (4 events × 15-32 cameras). If the ribbons are unreadable, the switch is on the board;
      the obvious trim is finish-line + pit only, which is a one-line change to
      `cameraOnTrack`.
- [ ] Pause detection has never been observed against a real pause — no race was running
      when this was built. First race night, watch `/api/cron/race-state-watch`.

---

## POV highlight reel — check-in guide wall (PAUSED 2026-08-17)

Full tracker: **[tasks/pov-highlight-reel.md](pov-highlight-reel.md)**

Racers' fastest laps, cut from their Viewpoint video, on the guide wall.

- [x] Data layers **on main**: `race_lap_results`, `race_best_laps` (best lap + `PassingTimeUtc`),
      `race_timings.pause_count`, `pov-reel/select.ts`. Queue 5,000 → 100,000 / 72h.
- [x] **Alignment SOLVED** — the camera burns a wall clock into every frame, so a lap time maps to
      a file offset. Verified to ~50ms. No vendor ask, no bridge change.
- [x] `pov-clipper/` Railway service written (also on `feat/pov-reel-clipper`).
- [ ] **Deploy the clipper — it has NEVER run against a live video.** Watch `anchor` in the
      results; a wall of `"estimate"` means the OCR is broken.
- [ ] Daily cron → `/build`, result webhook, `pov_reel_clips` manifest with **reconcile, not
      rebuild** (keep survivors, cut only new, delete droppers a run late).
- [ ] Signage scene on the guide wall. **Must not re-download the reel** — Cache Storage with its
      own cache name, and the briefing takeover must still win.
- [ ] Re-check the 5 Pro / 5 Intermediate split once a full week exists: 3 days of real data
      produced 44 eligible candidates and **zero Pro**.
