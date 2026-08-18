# Front Desk Wall — HeadPinz Fort Myers

Five TVs over a second bank of kiosks, driven as ONE object off the shared clock.
Mockups: `tasks/front-desk-wall-mockups.html` (published as an artifact).

Owner decisions locked 2026-08-17:

- boards are **~6 inches apart** (not the karting boards' ~4 feet)
- "two locations" = **FastTrax FM + HeadPinz FM** — the two buildings the VIP night visits
- outer TVs **fully participate**; they hold brand marks only during the statement slide

## Screen allocation

`HPFM:1` is the existing kiosk-bank TV and is untouched. Verified against the live
registry 2026-08-17 (12 rows, `HPFM:2`–`HPFM:6` free).

| Screen    | TV  | wall pos | pairing (machine) | brand mark |
| --------- | --- | -------- | ----------------- | ---------- |
| `HPFM:2`  | 1   | 0 / 5    | `hpfm-fd-a` 0/2   | fasttrax   |
| `HPFM:3`  | 2   | 1 / 5    | `hpfm-fd-a` 1/2   | —          |
| `HPFM:4`  | 3   | 2 / 5    | none (single)     | —          |
| `HPFM:5`  | 4   | 3 / 5    | `hpfm-fd-c` 0/2   | —          |
| `HPFM:6`  | 5   | 4 / 5    | `hpfm-fd-c` 1/2   | headpinz   |

## The design law for this wall

The karting boards carry `NOTHING READABLE MAY CROSS THE GAP` (SceneBirthdayTakeover) because
they sit ~4 feet apart. At 6 inches the gap reads as **word-spacing**. So:

> **A word never crosses a gap. A sentence may.**

The five panels share one baseline and one type size and read left-to-right as a single line,
while every panel stays independently complete. A dead player leaves four panels still saying
something true. Record this next to the 4-foot rule so neither is applied to the wrong wall.

## Architecture: `pairing` vs `wall`

`ScreenPairing` currently serves two jobs at once, and they collide here:

- `resolvePair()` returns `null` unless a group has **exactly 2** screens — that's what builds
  the two-monitor launcher (`buildDualStartupScript`).
- `SceneBirthdayTakeover` and `track.ts megaSplit` read `pairing.position/count` as the
  **choreography** primitive.

A 5-wide choreography group would kill the dual launchers for players A and C. Fix — one new
optional field, additive, no migration:

```ts
export interface ScreenWall {
  wallId: string;
  position: number;        // 0 = leftmost
  count: number;
  /** Gap between panels as % of ONE panel's picture width. ~6in on a ~48in
   *  picture ≈ 12. Drives the virtual canvas any wall-wide gradient paints into. */
  gapPct?: number;
  brand?: "fasttrax" | "headpinz" | "none";
}
```

Added to `ScreenConfig` as `wall?: ScreenWall`. `pairing` keeps its exact current meaning.

One resolver so no scene has to know which field it got:

```ts
// features/signage/wall.ts — PURE, unit-tested, same posture as pairing.ts / track.ts
export function choreo(config: ResolvedScreenConfig): { position: number; count: number; gapPct: number };
export function wallSpan(position, count, gapPct): { start: number; end: number };  // [0,1] of the virtual canvas
export function wallCentre(position, count, gapPct): number;
```

`choreo` = `wall ?? pairing ?? { position: 0, count: 1 }`. Existing karting boards carry only
`pairing` and behave identically.

`resolveScreenConfig` gains `wall`, clamped like every other field: position into `[0, count-1]`,
`count >= 1`, `gapPct` into `[0, 100]` default `12`, unknown `brand` → derived (first = fasttrax,
last = headpinz, inner = none). Never throws, never discards — the CONFIG_VERSION contract.

## The loop

**All five run a byte-identical playlist.** Scene selection is `slot % totalSlots`, so two panels
with different slot totals wrap at different moments and the wall visibly tears.

| Scene          | Slots | Time  |
| -------------- | ----- | ----- |
| `vip-showcase` | 4     | 2m40s |
| `open-now`     | 2     | 1m20s |
| `kiosk-howto`  | 1     | 40s   |
| `ads`          | 1     | 40s   |
| **total**      | **8** | 5m20s |

**No `requiresData` entries.** A data-gated scene is dropped from the rotation when empty, which
changes `totalSlots` — and five players poll on independent 15s phases, so they can briefly
disagree about whether it's empty. That's a torn wall for up to 15 seconds. Same reason
`event-welcome` is deliberately absent: `HPFM:1` already carries the party board.

## Scenes

Three new, one existing scene amended.

### `vip-showcase` (new) — 4 slots

Four sub-slides at `VIP_SLIDE_MS = 20_000`. 20s divides 40s evenly, so a slide never straddles a
slot boundary. 4 slots = two full passes. Slide index is `Math.floor(nowMs / VIP_SLIDE_MS) % 4`
— clock-derived, same pattern as `SceneAdRotation`.

| Slide            | pos 0         | pos 1              | pos 2               | pos 3              | pos 4                   |
| ---------------- | ------------- | ------------------ | ------------------- | ------------------ | ----------------------- |
| 1 The statement  | FastTrax mark | TWO LOCATIONS.     | ONE PRICE.          | ONE VIP EXPERIENCE.| HeadPinz mark           |
| 2 The night      | 3–4 HOURS     | STARTER RACE       | 1.5 HRS VIP BOWLING | INTERMEDIATE RACE  | ONE BOOKING             |
| 3 What's in it   | Racing licence| POV race video     | NeoVerse VIP lane   | $10 Game Zone card | Laser Tag or Gel Blaster|
| 4 The price      | ALL ACCESS    | today's tier, huge | the other tier      | 2 GUESTS MINIMUM   | Book it — callout band  |

Content comes from `getLiveVipCombo()` — `includes`, `perks`, `voucherIncludes`, `price`. Never a
hand-typed copy.

**THE IDENTITY RAIL — every slide must name its own product.** (Owner 2026-08-17: "what if I walk
up after VIP is already stated, I'd never know what I'm looking at.") Slides 2 and 3 carried no
product name at all: five panels of legs or inclusions belonging to nothing. A persistent gold
band runs along the bottom of **all four** slides:

| pos 0        | pos 1          | pos 2                 | pos 3                | pos 4               |
| ------------ | -------------- | --------------------- | -------------------- | ------------------- |
| ALL ACCESS   | VIP EXPERIENCE | FASTTRAX + HEADPINZ   | FROM $79 PER PERSON  | BOOK AT ANY KIOSK ▼ |

Read across it is one line. Read alone, the two tokens that matter each land **whole on a single
panel** — the name on pos 0, the price on pos 3 — so the wall still identifies itself with a
player down. It also puts the price on screen for the full 2m40s rather than only slide 4's 20
seconds, which is why slide 4's separate CTA band was removed as redundant.

Eyebrows are self-identifying for the same reason: "Your VIP night", "All Access includes".

**Price rule.** `$79` / `$99` read from `getLiveVipCombo().price`; day tier from the combos
feature's own resolver, never re-derived here (Mega Tuesday bills as weekday tier for combos but
`scheduleForDate` returns `"mega"` — re-deriving is how that gets quoted wrong). Both tiers stay
on the wall so it is true on any day. House rule: a displayed price must be the price the kiosk
will charge.

Voucher terms are deliberately **not** on the wall — unreadable at TV distance, and the kiosk
states them at the point of sale where they bind.

### `open-now` (new) — 2 slots

Ten attraction tiles dealt across five panels by position, so the wall is the venue's menu board
and no two panels repeat.

- Status + next time from `feed.nextAvailable` (needs `showNextAvailable: true`), which already
  reads `kiosk:avail:v4:{center}`.
- Prices from the modules the kiosk charges from — `lib/attractions-data.ts` `ATTRACTIONS` and
  `booking/service/race-products.ts`. Never a second copy.
- **A paused product shows no price and no time** — same `pausedProductIds` gate
  `SceneAdRotation` already honours.
- **Bowling shows availability, not a price.** Lane pricing is dynamic through QAMF; the static
  catalogue carries `price: 0`. Inventing a lane price is exactly the mismatch the pricing rule
  exists to prevent.

### `kiosk-howto` (new) — 1 slot

One verb per panel, each with the `KioskCallout` band pointing down at the machine below it:
CHECK IN · BUY A LANE · BOOK A RACE · LOAD A CARD · BUY THE VIP NIGHT.

This is the strongest argument against parking the outers on a permanent logo — with all five
participating, every kiosk in the bank gets an instruction directly above it.

### `ads` (existing) — 1 slot, one change

`SceneAdRotation` picks `slides[Math.floor(nowMs / AD_ROTATE_MS) % slides.length]` — the same
slide on every screen. Correct for one TV, a hall of mirrors across five. Offset by wall position:

```ts
slides[(Math.floor(nowMs / AD_ROTATE_MS) + choreo(config).position) % slides.length]
```

With no `wall` configured the offset is 0, so `HPFM:1` and every existing board are unchanged.

### `celebration` (existing interrupt)

Enabled. A booking/check-in on a kiosk below takes the wall. Scope is empty on all five so they
celebrate together. The name lands **whole on the centre panel**; outer panels carry glow and
supporting detail. Needs the same `choreo()` treatment so it isn't five identical cards.

## Interrupts

| Interrupt          | State | Why |
| ------------------ | ----- | --- |
| `celebration`      | on    | The guest is standing at the bank below — reacting is the point of hanging it there. |
| `vip-welcome`      | off   | Not in the precedence chain anyway (owner: "it shouldn't just take over everything"), and the VIP *product* has its own 4-slide showcase here. |
| `billboard-crown`  | on    | **Load-bearing, and not what it looks like.** The crown scene is declared but NOT in `IMPLEMENTED`, so it is never selected. The flag's other job is telling `SceneAdRotation` to run the kiosks' own catalog on the kiosks' own cadence — the "I am over a bank of kiosks" signal. Both meanings are correct for this wall; when the crown scene lands, these five should crown. Deliberate, not a hack. |

## Motion

No new CSS. The wall-wide light pass reuses `tv-sweep` with a per-panel phase offset via
`data-glow-phase-ms` — the mechanism `syncGlowPhase` already provides and that the kiosk bank's
attract car already uses to hand off screen to screen. Nothing new to register in
`TV_MOTION_PERIODS_MS`.

If any new looping animation does get added: it must be 1400ms or 2800ms (the house beat), and it
must land in both `app/tv/tv.css` and `TV_MOTION_PERIODS_MS` **in the same commit**.

## Launchers

- Player A → dual launcher, `HPFM:2` + `HPFM:3`
- Player B → single launcher, `HPFM:4`
- Player C → dual launcher, `HPFM:5` + `HPFM:6`

Works because `pairing` stays exactly-2. `git`-clean because `wall` carries the 5-wide job.

## Build order

- [ ] 1. `types.ts` — add `ScreenWall`, `ScreenConfig.wall`
- [ ] 2. `defaults.ts` — resolve + clamp `wall`; add the `front-desk` role preset
- [ ] 3. `wall.ts` + `wall.test.ts` — `choreo`, `wallSpan`, `wallCentre` (pure)
- [ ] 4. `SceneVipShowcase.tsx` — 4 slides × 5 positions
- [ ] 5. `SceneOpenNow.tsx` — tiles, paused gate, real price sources
- [ ] 6. `SceneKioskHowto.tsx` — 5 verbs + callout band
- [ ] 7. `SceneAdRotation.tsx` — position offset (3 lines)
- [ ] 8. `SceneCelebration.tsx` — position-aware composition
- [ ] 9. `registry.tsx` — wire 3 scenes into `SceneSlot`, `IMPLEMENTED`, `sceneHasData`
- [ ] 10. `constants.ts` — bump `SIGNAGE_VERSION` to `0.6.0` with a changelog line
- [ ] 11. `SignageAdminClient.tsx` — Wall fieldset (id, position, count, gap %, brand)
- [ ] 12. `scripts/signage-provision-front-desk.mts` — seed + assert
- [ ] 13. Smoke: five browser windows at `/tv?screen=HPFM:2..6` on one laptop, BEFORE hanging

## Verification

The seed script's verify pass asserts, and fails loudly on:

- exactly 5 front-desk screens
- **byte-identical playlists across all five** (the tear invariant)
- wall positions exactly `0..4`, count 5, no duplicates
- `hpfm-fd-a` resolves to 2, `hpfm-fd-c` resolves to 2, `HPFM:4` unpaired
- prints all five preview URLs and the three launcher targets

Smoke before hanging: all five panels on one laptop, same shared clock. Watch one full 5m20s
loop and confirm the statement slide lands on all five at the same instant.

## Photography — a real gap, and a live bug

The venue photo library does not currently contain a usable VIP-lanes shot:

- **`KIOSK_PHOTOS.vipLanes` (`/images/headpinz/hyperbowling.jpg`) is not a photograph.** It is a
  6.8 KB video still with **"NO MATTER WHO YOU ARE" burned into it**. Its own comment in
  `features/kiosk/assets.ts` says it exists to be the bowling-tier card because `vip` "looked
  wrong on a lanes card" — so this text-laden frame is on the **kiosk's live bowling card today**.
  That is a bug outside this wall's scope, but it should be fixed.
- **`KIOSK_PHOTOS.vip` (`pricing-combos.webp`) is a racing shot**, not bowling.

The mockups fall back to `gallery-bowling.webp` and `duckpin-bowling.webp`, both real interiors.
Neither shows a VIP suite.

**Recommendation: shoot the missing set before this wall goes up.** A ~2-hour evening shoot
covering the VIP suite lit for glow, the NeoVerse wall, a group at a VIP lane, chips & salsa on
the table, and the kiosk bank in use would serve this wall, the kiosk cards and the website. That
is a better spend than generated imagery: a guest standing in the building recognises their own
lanes, and an invented interior that is nearly-but-not-quite the room reads as a stock photo.

## Open decisions

1. **Which brand mark on which end?** Mocked FastTrax left / HeadPinz right. Depends on which way
   the room faces. Config field either way.
2. **Spanish.** The kiosk hard rule scopes to the kiosk i18n catalogue, and no signage scene is
   bilingual today (all 12 boards English). But this wall is guest-facing in a ~20–27%
   Spanish-speaking market. Recommendation: English throughout, **price slide alternating** — the
   slide that converts, the shortest copy, the least English impression lost. Running the whole
   wall bilingual halves every message's airtime.
3. **Does the wall sleep at close?** The `sleep` scene exists; I have not traced where `asleep` is
   set for a HeadPinz screen. Needs verifying, not assuming.
