# Called heat from the venue WebSocket — get session status off Pandora polling

**Why:** `/api/cron/races-current-warm` fires once a minute and LOOPS for 52s, asking
Pandora `/bmi/races/current` about once a second — **~2,200 calls/hour, ~53,000 a day**,
more than half of everything we send that vendor. It exists to learn one fact: which heat
is called on each track. The venue's own WebSocket already pushes that fact and we have
never listened (flagged in `reference_venue_timing_broadcast_schema` since 2026-08-12).

**Measured before building anything** (2026-08-19, from `kart:events:queue` +
`briefing_events.called_at`, n=92 called heats):

|                                           | value                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| WS frame in our Redis vs what we recorded | **median 4.8s earlier**                                                                           |
| worst cases (vendor degradation windows)  | **789s**, 378s, 143s, 71s earlier                                                                 |
| cases where the poll won                  | 1 (−11.1s)                                                                                        |
| `ResourceId` → track, contradictions      | **0** across 2,496 records / 10 event types                                                       |
| id widths on the wire                     | `RaceId`/`SessionId`/`DriverId`/`ParticipantId` all 8d — **safe**; `PersonId` 17d — **corrupted** |

This is a **cost** change, not a speed change: 5s on a board that polls every 1-2s is not
visible. The prizes are 53k calls/day and the tail where polling was minutes late.

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

### Go / no-go, from one real race day

- [ ] **Coverage** — every heat Pandora recorded called, the WS saw too. (92/92 in the
      historical buffer, but that is the same source both sides; the live day is the test.)
- [ ] **Track** — zero wrong-track attributions, zero unresolvable.
- [ ] **Lead** — median > 0; count how often the poll wins.
- [ ] **Re-call** — a re-called heat keeps its first stamp (mirrors `preserveFirstCall`).
- [ ] **Desk Clear** — observe what the shadow does around a Clear before trusting it.

---

## Phase 1 — promote, keep Pandora as the net

- [ ] **Extract the merge** out of `refreshRacesCurrent` so ONE function owns
      `preserveFirstCall` + Clear tombstones + the age gate, and both writers call it. A
      second writer that reimplements any of it is how a cleared heat returns to the wall.
- [ ] WS handler writes the real carry (`pandora:last-race:fasttrax:*`) through that seam.
- [ ] **Slow the loop, do not delete it**: step 1s → 30s. ~2,200/hr → ~120/hr.
- [ ] **Bridge-health gate**: `kart:bridge:last-event` older than ~2 min → the loop returns
      to 1s stepping on its own. The bridge has gone silent mid-session before and needed a
      hand reboot; a half-open socket looks exactly like a quiet venue.
- [ ] Kill switch `VENUE_CALLED_FAST_PATH=false` → Pandora-only. Default ON (house rule).

## Phase 2 — retire the loop after two clean race days.

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
