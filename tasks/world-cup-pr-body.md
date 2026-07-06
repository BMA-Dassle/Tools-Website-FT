# PR: World Cup VIP Bowling — headpinz.com/book/v2 (FM launch, Naples flag-dark)

**Branch:** `feat/world-cup` → `main` · **Spec:** [tasks/world-cup-vip-bowling-plan.md](world-cup-vip-bowling-plan.md)

## What

Limited-time bookable experience for the 2026 World Cup knockout rounds (through the July 19
final): a **VIP lane for 2.5 hours from each match kickoff**, the match on the NeoVerse LED
walls, chips & salsa included, shoe rental extra, at **normal VIP pricing** ($112.50/lane
Mon–Thu, $137.50/lane Fri–Sun = the existing 1.5-hr + 1-hr VIP rates). Both centers are built;
**launch = Fort Myers only** (Naples ships behind `NEXT_PUBLIC_WORLD_CUP_VIP_NAPLES_ENABLED=false`
until its LED wall is verified). Everything self-hides after the final.

## How it works

- **`src/features/world-cup/`** — fixture table (16 matches, ET kickoffs, editable `teams`
  labels as rounds resolve), per-center env kill switches, config-driven validation, pure
  line-item builder, staff strings. Client and server import the same fixture table.
- **Entry:** `/book/bowling/v2?experience=world-cup&location=fort-myers` seeds a match-mode
  bowling item (VIP pinned). **`WorldCupMatchStep`** replaces the Slots/Tier/Offer steps:
  targeted QAMF probe at the exact kickoff → hold with the seeded **150-min offer-row option
  id** (never `slot.optionId` — Open-Pkg-Duration lesson). No exact-kickoff slot → "Sold out";
  never a shifted start. Stale links (window over / center off) degrade to the normal wizard.
- **Stock wizard protected:** Tier/Offer steps filter out `world-cup-*` experiences (they'd
  otherwise be bookable at any hour); Contact/Players/Shoes steps run unchanged (shoes stay a
  paid $5/pair add-on; chips & salsa is the existing $0 KDS-routed comp item, one per lane).
- **Fail-closed server guards on BOTH reserve rails** (bowling-only carts use
  `/api/bowling/v2/reserve`; mixed carts use `unifiedReserve`): disabled center, non-kickoff
  start, or past kickoff → 400/409 **before any Square/QAMF write**. Match persisted to
  `booking_metadata.worldCup` at capture; Conqueror gets Title `World Cup {name} (Np)` + a
  `*** WORLD CUP: … ***` notes banner (Title+Notes patched together).
- **Marketing:** premium double-width tile on `/book/v2` (HeadPinz brand, center + flag +
  window gated, real VIP-lanes photo) and `WorldCupVipPopup` on the 4 promo mounts —
  **date-gated to start 7/5 00:00 ET, the exact instant the USA250 popup self-expires** (the
  two can never stack).
- **`scripts/seed-world-cup-vip.ts`** — idempotent, dual-mode (dedicated Square catalog item,
  recommended; or zero-Square-ops rate bundle), hard-fails on placeholder ids. Offer upserts
  conflict on `(experience_id, center_code)` — NOT the main seed's dropped
  `(center_code, qamf_web_offer_id)` target, which would steal the shared VIP offers from
  `vip-mon-thur`/`vip-fri-sun`. Deliberately seeds ZERO duration options.
- **Self-updating matchups** (`features/world-cup/live-teams.ts` + `GET /api/world-cup/fixtures`):
  TBD team labels live-fill from ESPN's public scoreboard, matched by EXACT kickoff instant, only
  into null slots (committed strings remain the manual override). One Redis key (1h TTL, 10m on
  errors) + per-lambda memo; fail-soft to "Teams TBD"; display-only (validation keys off
  date/hour); kill switch `WORLD_CUP_LIVE_TEAMS_ENABLED=false`. Feeds the picker, the tile's
  next-match teaser, and both reserve rails' QAMF banner/metadata.

## Test evidence

- **vitest:** 729 passed / 5 failed — all 5 failures are `lib/guest-survey-db.test.ts`,
  pre-existing on `origin/main` (untouched by this branch). New suites: 43 tests green
  (fixtures: bands/cutoffs/window/popup gates/ET bookedAt matching incl. Z-form; validation:
  center fail-close incl. per-center + master kill, non-kickoff rejection, past-kickoff
  rejection; line-item math both seed modes × lanes × bands; entry parse).
- **tsc:** clean (only pre-existing failures in two *untracked local* scratch scripts that
  never reach CI).
- **`turbo run build`:** compiles + type-checks + full route manifest + **a11y gate**
  (`[a11y-gate] ✓ zero jsx-a11y violations`) clean — the gate initially failed the first
  Vercel deploy on the match-card button (text nested too deep for
  `control-has-associated-label`); fixed with an explicit `aria-label` in `d914373d`.

## NOT in this PR (blocking follow-ups, in order)

1. **QAMF ops:** ~~option ids~~ **DONE + live-tested 7/3** — all four 150-min option ids are in
   the seed (FM 175→1397, 174→1389; Naples 141→1125, 139→1109). **Fort Myers verified
   end-to-end**: test holds at real kickoff times landed on a VIP lane and were deleted.
   **Naples still blocked**: both offers are enabled but every hold 409s
   `LanesNotAvailable` — the offers need their VIP lane-group/schedule mapping in Conqueror,
   then one re-verified hold, before flipping `NEXT_PUBLIC_WORLD_CUP_VIP_NAPLES_ENABLED`.
2. **Square ops (dedicated mode):** catalog item "World Cup VIP Match Window (2.5 Hrs)",
   variations Mon–Thur $112.50 / Fri–Sun $137.50, all locations, same category/tax as
   `BESYYLCKLOVD7YE4GYJU24HR` → 2 variation ids. (Or flip the seed to FALLBACK mode: zero
   Square ops, two-line receipt.)
3. Run `npx tsx scripts/seed-world-cup-vip.ts` against prod Neon; verify
   `GET /api/bowling/v2/experiences?centerCode=TXBSQN0FEKQ11` shows both rows with offer
   option ids set and empty durationOptions.
4. Vercel env `NEXT_PUBLIC_WORLD_CUP_VIP_NAPLES_ENABLED=false` **before merge**; merge + deploy.
5. **Live smoke FM** (repo rule): real booking of an upcoming match → Conqueror shows VIP lane,
   150 min at kickoff exactly, "World Cup" title + banner + SHOES NOT INCLUDED; Square day-of
   order lines × lanes + $0 chips + shoes + fee; deposit = eGift card = tax-inclusive total;
   Neon `booking_metadata.worldCup` present; confirmation email shows the match. Then
   refund/void per usual. Negative: Naples fully dark (no tile/step; doctored reserve replay
   rejected pre-charge); popup absent before 7/5; normal bowling wizard unchanged.
6. Naples later: verify wall → ops ids → re-run seed → flip env → redeploy → Naples smoke.
7. As rounds resolve: **nothing to do** — labels live-fill from ESPN within ~1 h (Redis TTL).
   Manual lever if the feed misbehaves: edit `teams` in `src/features/world-cup/fixtures.ts`
   (committed strings always win) or set `WORLD_CUP_LIVE_TEAMS_ENABLED=false`.
8. Post-final: surfaces self-hide;
   `UPDATE bowling_experiences SET is_active=FALSE WHERE slug LIKE 'world-cup-%';` + cleanup PR.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
