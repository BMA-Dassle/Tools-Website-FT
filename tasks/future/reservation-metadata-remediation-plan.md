# Fix Existing Reservations for the Edit Engine — Remediation Plan

## Context

Live testing on the Vercel preview showed "a lot of problems with existing reservations." Research confirmed why: the two metadata stamps the edit engine leans on — `booking_metadata.bowling` (pricing mode/lane count/duration) and per-heat `bmiLineId` — were introduced **on this unmerged branch** (PR 0, commit `14e6a43`). **Zero production rows have them.** Every pre-existing reservation takes the legacy-derivation path; where that fails, edits degrade to carry-mode (shoes/roster/attractions only) and player/lane/duration edits are blocked with `pricing_unresolvable`.

Owner decision (2026-07-11): legacy race-heat removals **refuse cleanly and age out** — no Redis-log mining, no cancel+rebook fallback now.

## Grounding (verified by three exploration agents)

| Gap | Affected rows | Effect today | Recoverable? |
|---|---|---|---|
| `booking_metadata.bowling` stamp | ALL production bowling/KBF rows | Scaling edits (players/lanes/duration) blocked whenever derivation fails; QAMF lane-rebook throws "no experience stamp" | **Yes — pure offline derivation** from stored lines + `player_count` + experience tables (`resolveBookedPricing`, `reprice.ts:65-110`) |
| Heat `bmiLineId` | ALL production race rows | Heat removal fails at **execute time, after money moved** (`bmi-sync.ts:314-323`) | **No** — only ever returned by the original `booking/book` response; order-overview API has no line ids (`bmi.ts:91-104`) |
| Heat `category`/`tier` | none — already stamped on main | — | n/a |
| `center_code` raw compares | v1-namespace rows (Square location ids) | `bmi-sync.ts:143,377` pick BMI client key via `=== "naples"` — a v1 Naples row (`PPTR5G2N0QXF7`) silently gets the Fort Myers key | **Yes — code fix** via existing `resolveCenter` (`cancellation/centers.ts:49`) |
| Zero-line rows (admin KBF `book-lane`/`bowl-now`, walk-in webhook/cron rows) | admin + POS-created rows | No primary line → nothing to reprice even with a stamp | Not worth reconstructing — these rows have no deposit/gift-card money model; backfill skips + reports them |

Key precedents to reuse: `apps/web/app/api/admin/bowling/backfill-memo/route.ts` (same table, same joins, ADMIN_CAMERA_TOKEN + `{dryRun}` body), `apps/web/scripts/combo-tax-backfill-run.mts` (skip-and-report discipline), `resolveBookedPricing` in `reprice.ts` (the derivation itself — reuse, don't reimplement).

## Changes

### PR A — code hardening (no data migration)

1. **Plan-time guard for legacy heat removals** (owner decision). In `plan.ts` `raceLegPlan` (~line 837, where removals are matched to order lines): if any removed heat has `bmiLineId == null` AND the leg has a `bmi_bill_id`, throw `EditGuardError("bmi_line_unavailable", "this heat was booked before line tracking — remove it via Cancel & Rebook")`. Moves the failure from mid-cascade (after refunds) to the modal preview. Mirror check exists at `bmi-sync.ts:314-323`; keep it as the execute-time backstop.
2. **Center resolution in bmi-sync.** Replace raw compares at `bmi-sync.ts:143` (`clientKey`) and `:377` (attraction `location`) with `resolveCenter(row.centerCode).slug === "naples"`. Import from `~/features/cancellation/centers`.
3. **Self-heal: persist the derived stamp after a successful edit.** `bowlingLegPlan` already resolves `booked` (source `"stamp" | "derived"`); thread it onto `EditPlanLeg` (e.g. `resolvedStamp: BowlingBookedStamp | null`, null under carryPrimary) and in `service.ts` `commitNeon` write it via `updateReservationAfterEdit` even when the row had no prior stamp (today `bowling-db.ts:2671-2676` only refreshes an existing one). Covers rows booked by stale clients that omit `bookingMeta`.

### PR B — pricing-stamp backfill (the main fix)

**New route:** `POST /api/admin/bowling/backfill-pricing-stamp` — auth `ADMIN_CAMERA_TOKEN` query param, body `{ dryRun?: boolean (default true), limit?: number (default 200), neonId?: number }` (single-row mode for spot repairs). Structure mirrors `backfill-memo/route.ts`.

**Logic** (new module `apps/web/src/features/reservation-edit/stamp-backfill.ts` so the route stays thin):
1. Scan: `bowling_reservations` where `product_kind IN ('open','kbf')`, `status != 'cancelled'`, `booking_metadata->'bowling' IS NULL`, ordered `booked_at DESC`.
2. Per row: load lines (child table), load products dual-namespace (raw `center_code`, then `resolveCenter(...).slug` — same probe as `plan.ts:448-452`), resolve experience the same way `plan.ts:541-564` does (slug match on items' `squareProductId` OR `durationOptions.overrideSquareProductId`). **Extract that experience-resolution block from `plan.ts` into a shared exported helper** rather than duplicating it.
3. Run `resolveBookedPricing({ bookingMetadata: null, playerCount, lines, experienceKind, experienceSlug })` in try/catch.
4. Success → `UPDATE ... SET booking_metadata = COALESCE(booking_metadata,'{}') || jsonb_build_object('bowling', stamp)` (additive, never clobbers `heats`/`worldCup`). Failure → skip with reason (zero lines / no primary / unknown experience / non-sane multiplier).
5. Report `{ scanned, stamped, skipped: [{neonId, reason}], dryRun }`. Idempotent by construction (only touches rows missing the stamp). No per-row `recordAdminAction` (bulk metadata, not money).

**NOT doing** (with reasons, so nobody re-litigates):
- `center_code` column normalization — separate pre-existing effort (`tasks/future/center-code-normalization.md`); catalog tables are keyed by the location-id form, and `plan.ts` dual-probe already bridges it.
- `bmiLineId` recovery (Redis mining / cancel+rebook) — owner chose refuse-and-age-out.
- Reconstructing `bowling_reservation_lines` from Square orders — only zero-line POS/admin rows need it and they aren't money-editable anyway; backfill reports them.
- Attraction `bmiOrderId`/`bmiBillLineId` recovery — not recoverable; display-only fallback already exists.

## Tests

- `stamp-backfill.test.ts`: derivable per-person row → stamp written; per-lane hourly (qty 3, 8 players → 2 lanes, ×1.5); pizza-bowl slug per-lane; zero-line row skipped with reason; ambiguous multiplier skipped; dryRun writes nothing; additive merge preserves existing `booking_metadata` keys.
- `plan.test.ts`: removal of a heat without `bmiLineId` → `bmi_line_unavailable` at plan time.
- Extend `bmi-sync` coverage if any exists for clientKey selection (v1 Naples code → naples key).

## Verification

1. `cd apps/web && npm run test -- src/features/reservation-edit && npm run typecheck`; `npx turbo run build --filter=fasttrax-web` from root.
2. Push → Vercel preview. Run the backfill **dryRun** against preview (prod DB): inspect `skipped` reasons, sanity-check ~10 proposed stamps by hand against their stored lines.
3. Backfill the single reservation from screenshot IMG_2605 (`neonId` mode), then open its Edit modal on the preview: player/lane/duration controls should now appear and the dry-run should quote a real diff (previously hard-blocked with "no experience resolved").
4. On a legacy race row, toggle a heat removal: modal should show the "booked before line tracking — use Cancel & Rebook" refusal at preview time.
5. Then run the full backfill (`dryRun:false`) in batches of ~200 and report scanned/stamped/skipped counts.
