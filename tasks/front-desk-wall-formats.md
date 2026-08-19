# Front Desk Wall — 5-wide and 3-wide formats

Owner decisions 2026-08-18:

- The **wall is always five panels.** `count` stays 5 and positions stay 0–4. What varies is
  which panels a given SCENE occupies — "the wall span stays the same, just some things go
  across 5 and some over the middle 3".
- **VIP showcase spans all five.** It is the hero and reads best across the whole wall.
- **Menu board, kiosk how-to and house ads span the middle three** (TV2–TV4).
- **TV1** becomes the self-check-in board: who has checked themselves in, which lane, and
  that their shoes are being brought out to them.
- **TV5** becomes today's events and VIPs — the same board the front kiosk TV (`HPFM:1`)
  already runs.
- When a wing has nothing to show, it **falls back to the advertising**.

## The model

`span` on the PLAYLIST ENTRY, not on the screen:

```ts
type SceneSpan = "wall" | "middle";          // middle = positions 1..count-2
interface PlaylistEntry { scene; slots?; requiresData?; span?: SceneSpan }
```

This keeps the tear invariant intact for free: the playlist stays byte-identical on all five
panels, the span is part of that identical playlist, and each panel works out from its OWN
position whether it is inside the span. Nothing is negotiated between screens.

`outsideScene` on the SCREEN, because it is a fact about that panel's job:

```ts
interface ScreenWall { wallId; position; count; gapPct?; brand?; outsideScene?: SceneType }
```

TV1 `outsideScene: "bowling-checkin"`, TV5 `outsideScene: "event-welcome"`, TV2–4 absent.

`choreo(config, span)` returns a SPAN-RELATIVE position, so a 3-wide scene sees `0..2 of 3`
and never has to know it is sitting on a 5-panel wall:

| panel | position | span "wall" | span "middle" |
| ----- | -------- | ----------- | ------------- |
| TV1   | 0        | 0 of 5      | **outside**   |
| TV2   | 1        | 1 of 5      | 0 of 3        |
| TV3   | 2        | 2 of 5      | 1 of 3        |
| TV4   | 3        | 3 of 5      | 2 of 3        |
| TV5   | 4        | 4 of 5      | **outside**   |

## THE TEAR TRAP, and why the fallback is what it is

The obvious reading of "fall back to the 5 screen design" is: when TV1 has no check-ins, let
it JOIN the middle scene so the composition becomes 5-wide. **That tears the wall**, and for
exactly the reason `requiresData` is banned here.

Whether the wings are occupied is data (`is the check-in list empty?`), five players poll on
independent 15s phases, so for up to fifteen seconds TV2 can believe the composition is
3-wide while TV1 believes it is 5-wide. Both would then render "the leftmost slice" and the
wall would show the same panel twice.

So the fallback is: **a wing with nothing to show runs the ADS scene as its own panel.**

That is safe because the ad rotation is not a spanning composition at all — each panel
already picks its own slide from the catalog off the shared clock (offset by position so no
two match). "Five panels of advertising" and "one 5-wide advertising composition" are the
same thing for that scene, so the wall reads as all-advertising with no position ambiguity
and no window in which two panels can disagree.

The corollary is the rule to hold onto: **a scene's span never changes at runtime.** The
menu board is always 3-wide, the showcase always 5-wide. Only WHICH SCENE a wing renders
changes, and a wing is a composition of one.

## Build order

- [ ] 1. `types.ts` — `SceneSpan`, `PlaylistEntry.span`, `ScreenWall.outsideScene`, and
      `bowling-checkin` on `SceneType`
- [ ] 2. `wall.ts` — `spanRange()`, span-aware `choreo()`, `inSpan`
- [ ] 3. `defaults.ts` — resolve/clamp both new fields; spans on the `front-desk` preset
- [ ] 4. `director/schedule.ts` — substitute `outsideScene` for a panel outside the span
- [ ] 5. `SceneBowlingCheckin.tsx` — names, lanes, "your shoes are coming out to you"
- [ ] 6. `feed.ts` — the self-check-in section (`bowling_reservations`, `checkinMethod:
      "self"`, assigned lanes). First names only, per the TV PII posture
- [ ] 7. the three wall scenes read the span-relative position
- [ ] 8. admin: span per scene, wing scene per screen
- [ ] 9. reseed `HPFM:2`–`6` with spans + wing scenes
- [ ] 10. tests, including that a wing outside the span never renders a spanning slice

## Open

- Whether TV1 should list DESK check-ins too, or self-service only. Built self-only, since
  that is what was asked and a desk check-in already had a human tell them the lane.
