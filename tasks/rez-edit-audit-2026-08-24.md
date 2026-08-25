# Reservation admin edit / refund / card-on-file — audit + fix plan (2026-08-24)

Owner ask: "edit and refunds work for some but not others; card on file isn't saving; if we
can't update QAMF or BMI due to a limitation, tell staff and make them acknowledge it."

Branch `fix/rez-edit-audit` (worktree `.claude/worktrees/rez-edit-audit`, off origin/main
e2a472d0f + cherry-pick a9ff4d1b5 `feat/pre-checkin-reduction`).

## What the audit established (54-agent verified sweep + 147 live read-only dry-runs)

1. **Prod `RESERVATION_EDIT_V2="false"`** (verified via `vercel env pull`). Every non-refund
   plan previews, then Execute is dead (`edit_not_enabled`). Only `refund_dayof_payment`
   plans run (`_MID_DECREASE`/`_POST` = "true"). 57 ledger rows in 45d, all `{orderLines}`
   refunds. The master is enforced in the route + preview only — never in the executor.
2. **Multi-leg groups** (bowling + attraction/race sharing ONE day-of order; 76 in 60d):
   only the bowling leg carries `dayof_payment_id`. Anchoring from the other leg → plan OK,
   executor `no lane-open payment id on the row` (edit-24493 a1/a2, 8/23). MID refunds on
   such groups are impossible from EITHER leg (`phase_conflict` on the un-stamped sibling).
   134 rows in 90d have a COMPLETED tendered order and NULL `dayof_payment_id` ($17.4k).
3. **655 of 690 upcoming bowling rows are Conqueror-originated** (no deposit / customer /
   lines / stamp) — Edit renders, every count edit fails with engineer jargon.
4. **Hourly rentals are stamped `per_person`** (route derives pricingMode from `body.kind`,
   the PRODUCT kind, not the experience kind) → `primary quantity N does not reconcile` on
   13 of 26 upcoming web bowling rows. Slug `center_code` rows (naples/fort-myers/duckpin)
   find NO catalog (products keyed by Square location id) → no shoes, no primary.
5. **KBF** rows can never change player count (no priced primary; modal never drives spec.kbf).
6. **Acknowledgment exists only for post_complete.** PRE increase w/o lane change never
   reaches Conqueror (same-count PUT; only the Title changes). PRE/MID decrease → Conqueror
   per-player DELETE 409s (price-key identity; Conqueror config). Combo racer changes push a
   roster built from the CLICKED leg's zero player rows → would DELETE-ALL / "(0p)" title.
   Unlinked rows (no QAMF id / BMI bill) silently skip sync. Post-exec failures are shown as
   0.7rem amber text under a green "Reservation updated." and never persisted.
7. **Race PRE heat removal** runs BMI removeItem AFTER refund + neon_commit with no
   try/catch (`fatal:false` is never honoured by the executor).
8. **Money-retry bugs:** day-of netting counts COMPLETED events (a 2nd refund can silently
   skip the day-of leg); executor ignores `guestOwedCents` cap; store credit has no netting
   and its gift-card id is never written to the event (cancel planner guard is dead code).
9. **Card on file:** capture is 99.4% reliable when it runs, but ~75% of deposit bookings
   never get a vault row: ~40% of web deposits are Apple/Google Pay (Square cannot vault —
   correct skip, but invisible), race/attraction/combo web checkouts create NO Square
   customer for first-timers (470/775 race rows), gift-card tenders tagged `card` →
   `Invalid card data`, `Source was used before` retried futilely, pay-link page drops
   sourceKind/consent and offers wallets/GC the executor can't settle.
10. Payment link is never shown (success screen prints the editId) nor sent.

## Fix plan (this branch)

### A. Engine (plan.ts / service.ts / guards.ts / types.ts / qamf-sync / bmi-sync / reprice / edit-log)
- [ ] Money-group resolution at PLAN time: per-day-of-order phase (any leg's sent_at), paying
      leg → `plan.money.{dayofPaymentId, giftCardId, depositOrderId, storeCredit*, legId}`;
      single-tender GC fallback; `dayof_payment_unresolved` 409 before ack. Executor reads the plan.
- [ ] Acknowledgment contract: manager warnings for every non-sync case (count increase
      w/o lane change, decrease, combo, unlinked QAMF/BMI, MID engine-owned lines, closed-
      unpaid, dashboard-refund shortfall); executor refuses `ack_required` unless every code
      acknowledged; ack + manual steps persisted (`acknowledged`, `manual_steps` JSONB);
      capabilities in the `no_changes` payload.
- [ ] Master switch enforced in the executor; blocked guard codes logged server-side.
- [ ] Conqueror-originated rows → `conqueror_origin` 409 before any Square read.
- [ ] Hourly stamp self-heal (per_person stamp on an hourly/pizza-bowl experience → derive)
      + fix the writer in bowling/v2/reserve; slug center_code catalog fallback; KBF count
      changes without a priced primary; per_person `laneCount` no longer emits qamf_rebook;
      0-player mount probe returns no_changes.
- [ ] Race: `bmi_remove_lines` fatal BEFORE money; heats metadata persisted in commitNeon;
      removeItem idempotent for already-absent lines; legacy heats non-removable in `current`.
- [ ] Combo: bowling leg `newPlayerCount` follows racer delta; qamf-sync refuses desired=0 /
      keeps live names; `spec.orderLines` honoured on combos; `combo_phase_split` has copy.
- [ ] Post-complete INCREASE refused at plan time (rebuild path violates itemized-refund rule).
- [ ] Money retry correctness: net only stranded (non-completed) day-of refunds; cap
      `refund_tender`/store credit at `guestOwedCents`; skip return order when prior ≥ asked;
      store credit recorded on the event immediately + stranded netting; cancel guard matches
      any state / GAN.
- [ ] `edit_refund_cents` on the row (board shows "Refunded"); refund plans don't auto-resend
      the confirmation; race rows never point at Resend.
- [ ] Payment link: URL returned + shown; best-effort SMS/email to the guest with expiry.
- [ ] Route: status mapping by code (capacity/config → 409 blocked); execute failures carry
      editId/failedStep.
### B. Card vault (agent, disjoint files)
- [ ] Skip provenance rows (wallet / gift card / untagged) + Payments-tab copy.
- [ ] Gift-card tender detection server-side; terminal Square error classes stop retrying.
- [ ] Square customer resolved server-side for race/attraction/combo web checkouts (never kiosk).
- [ ] Pay-link page forwards sourceKind/consent; hides wallets + gift card.
- [ ] `getChargeableCard` distinguishes none / lookup_failed / not-storable.
### C. Admin UI (agent, disjoint files)
- [ ] Per-warning acknowledgment checkboxes + initials; server codes → plain copy; kill-switch
      banner + "Preview only"; success screen "Not updated automatically — do this by hand";
      History shows manual steps + who acknowledged; payment link shown/copied/opened; Edit
      hidden on Conqueror rows; Refund reachable from the non-paying leg.

## Decisions for the owner (not made here)
- Turn `RESERVATION_EDIT_V2` back on (delete the Vercel row + redeploy) once this ships.
- Conqueror config: sell the web offers' bowling rows under ONE price key so the per-player
  DELETE works; until then every decrease needs the by-hand Conqueror step (now acknowledged).
- Card retention policy: silent-72h (status quo) vs default-permanent (needs clickwrap
  version bump + guest self-removal) vs longer window.
- One-off backfills (owner-approved, SELECT→verify→UPDATE): `dayof_payment_id` for the 92
  shared-order siblings + 42 single-leg rows; `pricingMode` for hourly stamps (self-heals on
  first edit otherwise).
