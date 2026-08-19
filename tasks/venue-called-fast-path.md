# Called heat from the venue WebSocket — get session status off Pandora polling

**Why:** `/api/cron/races-current-warm` fires once a minute and LOOPS for 52s, asking
Pandora `/bmi/races/current` about once a second — **~2,200 calls/hour, ~53,000 a day**,
more than half of everything we send that vendor. It exists to learn one fact: which heat
is called on each track. The venue's own WebSocket already pushes that fact and we have
never listened (flagged in `reference_venue_timing_broadcast_schema` since 2026-08-12).

**Measured before building anything** (2026-08-19, from `kart:events:queue` +
`briefing_events.called_at`, n=91 comparable called heats):

|                                           | value                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| WS frame in our Redis vs what we recorded | **median 4.8s earlier** (p25 2.7s, p75 7.7s)                                                      |
| cases where the poll won                  | 4 of 91 (min −10.9s)                                                                              |
| `ResourceId` → track, contradictions      | **0** across 2,496 records / 10 event types                                                       |
| id widths on the wire                     | `RaceId`/`SessionId`/`DriverId`/`ParticipantId` all 8d — **safe**; `PersonId` 17d — **corrupted** |

Mostly a **cost** change: 5s on a board that polls every 1-2s is not visible, and the prize is
53k calls/day. But the tail is a quality change too — on the degraded evening of 8/18 our
record of Mega 60's call was **13 minutes late** while the venue had it on time.

---

## Phase 0 — the shadow (this PR)

- [x] `extractSessionCalls` in `venue-broadcast.ts` — the module that already owns the wire
      format, alongside `extractSessionLifecycle`. Track from `ResourceId`
      (`VENUE_RESOURCE_TRACKS` already had `-1 → mega`), **null rather than a guess**.
- [x] `venue-called.server.ts` — folds call / green / flag into `venue:called:{track}` and an
      append-only `venue:called:log` (2,000 entries, 72h). **Nothing reads these keys.**
- [x] Wired as a **fourth `after()`** in the kart webhook, beside the clock and the incident
      log. Never throws.
- [x] `scripts/venue-called-diff.mts` — the scoreboard: coverage, wrong-track, lead, re-calls.
- [x] 17 tests on frames captured verbatim from the wire, including the ugly ones (`-1`
      sentinel, `"Heat 69"` before it became `"69 - Mega Starter"`).

### Gate answers — from HISTORY, no race day needed (owner asked, correctly, 2026-08-19)

Ran against the 8/16-8/19 buffer joined to `briefing_events.called_at` (95 called heats):

- [x] **Track** — 0 wrong, 0 unresolvable. `ResourceId` never lied.
- [x] **Coverage 91/95.** All four misses sit in ONE window, 8/17 15:07-15:19, where the
      buffer holds **zero frames of any type** — the bridge was dead, not the venue quiet.
      Silent loss is the WS failure mode, and the reason the poll stays.
- [x] **Lead** — median 4.8s, p25 2.7s, p75 7.7s; 4 of 91 arrived LATER than the poll.
- [x] **Duplicate delivery** — **1,714 of 1,716 venue records arrive twice** (~0.1s apart),
      so a naive count reads 67 "re-calls" where only **35 of 94 heats** truly re-fired.
- [x] **It fires more than once, and the FIRST firing is the call.** Across all 35 multi-fire
      heats the shape is identical: the first firing lands **2-10s before** we recorded the
      call (5s, 9s, 1s, 6s, 2s, 4s, 8s…), and later firings land **after** it (−129s, −240s,
      −149s, −325s…) — the venue re-announcing a heat that is due and still on the grid.
      **first-firing-wins** is the rule, and it also mirrors `preserveFirstCall`.
- [x] **The tail cases are OUR record being late, not the venue being early.** Mega 60's first
      firing was 21:30:01 and we recorded 21:43:11 — then recorded heat **61 twenty seconds
      after 60**, on a track whose heats run ten minutes apart. That is the carry catching up
      in one go during the evening Pandora was degraded, not a desk calling two heats 20s
      apart. The venue's timeline fits the cadence; ours does not.
      _(An intermediate reading of this data said the opposite — that the venue was nagging
      early and the 789s was not a real win. The bunching disproves it. Owner pushed back on
      that reading and was right.)_

---

## Phase 1 — the WS writes the carry, through the existing merge seam

- [ ] **Extract the merge** out of `refreshRacesCurrent` so ONE function owns
      `preserveFirstCall` + Clear tombstones + the age gate, and both writers call it. A
      second writer that reimplements any of it is how a cleared heat returns to the wall.
- [ ] WS handler writes the real carry (`pandora:last-race:fasttrax:*`) through that seam,
      first-firing-wins per session, ignoring firings for a heat already finished.
- [ ] **Slow the loop, do not delete it**: step 1s → 30s. ~2,200/hr → ~120/hr.
- [ ] **Bridge-health gate**: `kart:bridge:last-event` older than ~2 min → back to 1s
      stepping automatically. Proven necessary by the 8/17 dead window.
- [ ] Kill switch `VENUE_CALLED_FAST_PATH=false` → Pandora-only. Default ON (house rule).

**Why not "the venue triggers a Pandora read" instead** (considered, rejected): a triggered
read is still a Pandora read, so it fails in exactly the window the WS is most valuable —
the degraded evening that made our heat-60 record 13 minutes late. Deriving the state from
the wire survives that; asking Pandora about it does not.

## Phase 2 — an operating-hours gate on the slowed loop (it polls all night for heats that

cannot exist), and revisit whether 30s can go to 60s.

## Side finding worth its own fix

**Every venue record reaches us twice** — 1,714 of 1,716 in the buffer, ~0.1s apart, some
sharing an identical `bridgeReceivedAt`. That doubles webhook invocations (~6,300/hr), doubles
the queue's growth (87,000 entries deep) and doubles every `after()` handler's work. Either two
bridge sockets are forwarding, or the venue emits each notification twice and the bridge's
`changedOnly` dedupe does not apply because singleton pushes always forward. Worth chasing
separately — it is free capacity.

---

## Not moving to the WS yet, and why

- **Rosters.** `session-participants` is the endpoint actually failing (437 timeouts/hr, 45s
  holds), so it is tempting — but the WS roster is a **subset**: 3 of 12 heats had more
  Pandora rows than WS drivers. A board reading 12 when the truth is 15 tells staff three
  people are missing. Needs its own investigation; fine as a pre-warm later.
- **Anything keyed on `personId`.** 4,750 of the ids on that wire are already corrupted by
  the bridge's `JSON.parse` (proved live: `63000000000021716` → `...710`). Photos, wallet
  licence and the headsock deduction all key on it. Fix = raw-text forwarding through the
  bridge + `parseWithRawIds` at the webhook.
- **Check-in state.** There is **no** check-in or payment field anywhere on that wire —
  verified by scanning every field name of every record type. The board's numerator has to
  come from Pandora, or from our own Neon record of the check-ins we write (open question:
  does the front desk ever check people in directly in BMI, bypassing us?).
