# HP Arena check-in TV (Nexus Laser Tag / Gel Blaster)

Branch `feat/arena-checkin-tv`. One screen at HeadPinz Fort Myers, one at Naples.

## What the owner asked for

> Make a Laser Tag / Gel Blaster check in TV, with video and static ads of laser
> tag running in its dead time. Should mirror what we do for karting check in.
> Except we will not use a check in board here — we simply call and check them
> in. Seed the database with the board, keeping in mind we will do one in Naples
> as well.

Three requirements, and the third is the one that shapes the design:

1. **Mirror the karting check-in TV.** Same platform, same shared-clock
   discipline, same "the time on your ticket is a check-in cut-off" framing.
2. **No check-in board.** Karting has a scan rail (`racer-scanned` events),
   a "6 of 14 checked in" counter and a briefing-room handover. The arena has
   NONE of that: staff call the session and check people in at the desk. So
   there is no rail, no counter, no send. The board reports **the call**.
3. **Ads in dead time.** Karting boards deliberately show no ads (owner
   2026-08-11) because a track board must never make a racer wait one out. The
   arena board is the opposite: it stands in a HeadPinz lobby, sessions are
   ~15 minutes apart, and most of its day is dead time worth selling into.

(2) + (3) together mean the call must **preempt** the rotation rather than take a
slot in it. That is the one structural difference from `race-checkin`, which
owns its wall outright.

## Grounding — what was verified before writing any of this

Read in full: `signage/types.ts`, `defaults.ts`, `constants.ts`, `flags.ts`,
`assets.ts`, `track.ts`, `director/{schedule,types,SceneDirector}.tsx`,
`scenes/{registry,SceneRaceCheckin,SceneAdRotation}.tsx`, `service/feed.ts`,
`service/race-checkin.ts`, `data/signage-{screens,assets}-db.ts`,
`briefing/{types,useBriefingAssets}.ts`, `video-cache.ts`,
`arena-tickets/{constants,types,checkin-alerts}.ts`,
`app/api/pandora/{sessions,races-current}/route.ts`,
`racing/races-current.server.ts`, and the signage admin client/API.

**LIVE PROBE (2026-09-01), and it settles the Naples question.** Swept
`GET /v2/bmi/sessions/{loc}?resourceName=HP Arena` over the last 10 days:

| Location | Resource | Result |
| --- | --- | --- |
| HP Fort Myers `TXBSQN0FEKQ11` | `HP Arena` | 1–36 sessions/day. `"25 - Nexus Laser Tag"` / type `Laser Tag`, `"53 - Nexus Gel Blaster"` / type `Gel Blaster` |
| HP Naples `PPTR5G2N0QXF7` | `HP Arena` | 0–8 sessions/day, **identical resource name and identical session naming**, both activities |
| FastTrax `LAB52GY480CJF` | `HP Arena` | 200 / n=0 every day |

So Naples needs no separate shape, no separate classifier, and no new resource
name. It is the same board with a different location id and a lighter day.

Also learned from that probe: a 200 from `/bmi/sessions` does **not** prove the
resource exists at that location — FastTrax answers 200/n=0 for `HP Arena`.
Resource names validate globally. Only a non-empty day proves anything, which is
why the sweep ran over ten days rather than today (today was empty everywhere).

`GET /v2/bmi/sessions/current/{loc}` answered 200 at all three locations. It is
already the production source for the arena SMS cron
(`arena-tickets/checkin-alerts.ts`, live since 2026-06-11), so its shape is not
being taken on trust here.

## Design

### The call owns the wall, the rotation fills the rest

New scene `arena-checkin`, an **interrupt** — precedence
`sleep → arena-checkin → celebration → crown → rotation`. It sits above
celebration deliberately: at the arena the call is the only thing on the screen
anybody has to act on.

Rotation underneath is `[arena-promo ×2 slots (requiresData), ads ×1 slot]` —
the uploaded films and the house slides, which is the "video and static ads"
half of the ask.

### Where the call comes from

`sessions/current/{locationId}` → classified by `classifyArenaBoardSession`
(see the probe findings below for why the board needs its own rather than the
SMS cron's) → per-venue 8s cache + a **location-scoped** Redis carry. Scoped
because the two arenas sit on separate BMI servers whose session ids share a
numbering space — an unscoped key would put a Naples call on a Fort Myers wall.

Rides the **15s feed**, not the 2s pulse. A call is a 15-minute event and the
pulse is a Redis-only budget; putting a Pandora read on it would be wrong.

**Two calls at once is the normal case**, not an edge: FM runs Laser Tag and Gel
Blaster off one resource and both can be called together. One panel per kind,
up to three.

### What ends a call

Karting ends a heat on the briefing-room send. The arena has no send, so the
only honest signals are Pandora's own ~20-minute expiry of `sessions/current`
and a hold window measured from `calledAt`. Default hold 10 minutes, clamped
2–20, per-screen.

## What the probes turned up that changed the design

A 30-day sweep of every arena session name at both venues (2026-09-01) found
four distinct `type` strings at Fort Myers across 494 sessions, and the two
minority ones both matter:

| `type` | FM count | What the SMS cron's classifier does | What the board does |
| --- | --- | --- | --- |
| `Laser Tag` | 361 | laser-tag | laser-tag |
| `Gel Blaster` | 119 | gel-blaster | gel-blaster |
| `- Gel Blaster or Laser Tag` | 10 | **laser-tag** (tests laser first) | **`either`** |
| `Nexus LaserTag` | 4 | **null** — no space, substring misses | **laser-tag** |

Naples: 26 sessions, only the two clean strings.

`- Gel Blaster or Laser Tag` is a **birthday party** that decides which game on
the day. Guessing "Laser Tag" is a cosmetic inaccuracy in a text message and an
instruction to walk to the wrong half of the arena on a wall — so the board has
its own classifier (`classifyArenaBoardSession`), a deliberate superset of the
cron's, which answers `either`, paints it in a neutral colour and says "come to
the arena desk". It also collapses non-alphanumerics before matching, so
`Nexus LaserTag` is recognised.

That third kind is why the board lays out up to **three** panels, not two.

### Owed, and deliberately NOT done here

`classifyArenaSession` in `~/features/arena-tickets/types.ts` misses
`Nexus LaserTag`, so those ~4 sessions a month get **no arena check-in SMS at
all**. That is a real gap, but fixing it changes who receives a text message —
a different blast radius from a TV — so it is reported rather than bundled into
this PR.

## Rebased onto main, and one thing changed because of it

The branch was cut from a local `main` that turned out to be 367 commits stale
(116 of them touching signage — video walls, the front-desk five, `venue-logo`,
top-times). Rebasing onto `origin/main` conflicted in eleven files; all but one
were both-sides-added and kept whole.

The exception matters. Main has since added **`VenueInfo.squareLocationId`**
holding the exact three strings this feature had added as `pandoraLocationId`.
They are not two ids that happen to coincide — Pandora keys its session
endpoints on the Square location id, which `app/api/pandora/sessions/route.ts`
and `arena-tickets/constants.ts` both already relied on without saying so. So
`pandoraLocationId` was **deleted**: two fields holding identical strings is a
synchronisation bug waiting to happen, and it would have claimed a fifth "where"
id this repo does not have. The fact is now written down on `squareLocationId`
instead.

Signage version landed at **0.9.0** (main was already at 0.8.0).

## Checklist

- [x] Probe FM + Naples arena sessions (10-day sweep)
- [x] ~~`VENUE_INFO.pandoraLocationId`~~ — dropped on rebase; `squareLocationId` IS the id Pandora keys on
- [x] `arena/arena-board.ts` — pure rules + tests
- [x] `arena/arena-sessions.server.ts` — Pandora read, cache, carry
- [x] `TvFeed.arena` section, built only for arena screens
- [x] `SceneType` += `arena-checkin`, `arena-promo`
- [x] `ScreenConfig.arenaBoard`, resolver, role preset
- [x] `SceneArenaCheckin.tsx`
- [x] `SceneArenaPromo.tsx` + `useArenaFilms` + cache-name param on `video-cache`
- [x] Asset keys `arena-video:laser-tag` / `:gel-blaster` + admin upload rows
- [x] Director precedence
- [x] `arenaBoardEnabled()` kill switch
- [x] `?demo=arena` fixture
- [x] Admin form round-trip
- [x] Seed script for `HPFM` + `HPN`
- [x] `classifyArenaBoardSession` — birthday `either` + unspaced `LaserTag`
- [x] Three-panel layout ladder (solo / duo / trio)
- [x] `signage-arena-board-probe.mts` — read-only "what would the board show now"
- [x] Rebased onto `origin/main` (367 commits), 11 conflicts resolved
- [x] Tests (6787 pass), lint, typecheck, build, a11y gate — all re-run after the rebase
- [x] Seeded `HPFM:9` and `HPN:1` (`--apply`, verified)

## Smoke, when it is deployed

1. `/admin/<token>/signage` → the two Arena Check In rows, **Preview arena call**
   and **Preview arena (busy)** buttons on each.
2. Upload the two promo films in the asset panel (Laser Tag / Gel Blaster).
3. `/tv?screen=HPFM:9` — films + house slides while nothing is called.
4. `npx tsx scripts/signage-arena-board-probe.mts` during opening hours, next to
   the wall, and check the board agrees with what it prints.

## Still unproven

- **No arena board has been watched through a real call.** The takeover, the
  hold expiring and the hand-back to adverts are all tested as pure rules and
  previewed with fabricated calls; none has been seen against a live
  `sessions/current` row, because the probe found zero called sessions at both
  venues at every hour it ran.
- **No promo film has been uploaded**, so `arena-promo` has never played a real
  file — only the still fallback path is exercisable today.
- **No physical panel exists at either venue yet.** The rows are seeded and will
  show house adverts until a player is pointed at them, which is the correct
  behaviour for an unattended screen id.
