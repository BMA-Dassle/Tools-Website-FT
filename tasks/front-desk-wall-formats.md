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

## The rhythm (owner 2026-08-19)

A STANDING STATE THAT GETS TAKEN OVER, and it needs no new mechanism: the playlist is
NINE slots, which at 40s each is **six minutes exactly**.

| | slots | time | span |
| --- | --- | --- | --- |
| `open-now` — pricing | 7 | 4:40 | middle three |
| `vip-showcase` — the takeover | 2 | 1:20 | the whole wall |

Two slots is precisely ONE full pass of the showcase's four 20-second slides, so no slide
is ever cut in half. VIP is on 22% of the time, against 50% in the first cut.

**Six subject slots over three panels.** The middle three deal in two sets and cut
together on the slot boundary, so everything is seen inside eighty seconds: set A is
Bowling · Gel+Laser · Game Zone, set B is At FastTrax · VIP Experience · Bowling. Bowling
appears twice because it is a bowling centre — the second pass leads with the VIP tier of
tonight's package rather than repeating the same rows.

**No house ads and no kiosk how-to slot.** "Buy it on the kiosk below" is permanent chrome
under every pricing panel, so telling a guest where to buy costs no airtime — which is
what made the separate how-to scene deletable. A generic advert alongside a real price is
the weaker of the two, so `ads` is now only a FALLBACK, never a scheduled turn.

## Build order

- [x] 1. `types.ts` — `SceneSpan`, `PlaylistEntry.span`, `ScreenWall.outsideScene`, and
      `bowling-checkin` on `SceneType`
- [x] 2. `wall.ts` — `spanRange()`, span-aware `choreo()`, `inSpan`
- [x] 3. `defaults.ts` — resolve/clamp both new fields; the 9-slot preset with spans
- [x] 4. `director/schedule.ts` — substitute `outsideScene` for a panel outside the span,
      gated on the wing's board actually having data (see § the dead-panel guard)
- [x] 5. `SceneBowlingCheckin.tsx` — names, lanes, "your shoes are being brought out"
- [x] 6. `feed.ts` + `bowling-db.ts` `getSelfCheckedInWithLanes()` — self check-ins with
      assigned lanes, first names only per the TV PII posture
- [x] 7. `SceneOpenNow` composes over the span-relative 0..2 and carries the callout band
- [x] 8. admin: the wing-scene picker on the Wall fieldset
- [x] 9. seed script writes the wing scenes and asserts them
- [x] 10. tests — 40 in wall.test.ts including the wing substitution matrix
- [ ] 11. Smoke on the glass: five windows, one 6-minute cycle, confirm the takeover lands
      on all five at the same instant and the wings hold through the standing slots

## The dead-panel guard

`SceneEventWelcome` returns **null** with no events and no VIPs. That is safe for an
ordinary rotation entry, because `requiresData` keeps it from ever being selected empty —
but a wing's `outsideScene` is substituted DIRECTLY, so TV5 would have gone black on a
quiet night. The substitution therefore consults `hasData` and falls back to `ads`.

It falls back to ads and NOT to the pricing board, and that is forced: `open-now` is a
three-panel composition, so a single wing rendering it would paint panel 0 of the set and
duplicate its neighbour. `ads` is the one scene that is complete on any single panel,
which is also why it is the floor everywhere else in the platform.

`bowling-checkin` reports `hasData: true` always, because it owns a designed empty state
("check in at any kiosk below and your lane will show up here") — so TV1 holds its board
all evening whether or not anyone has checked in.

## Open

- Whether TV1 should list DESK check-ins too, or self-service only. Built self-only, since
  that is what was asked and a desk check-in already had a human tell them the lane.
