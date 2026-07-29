# Split-tender live probes — run guide + findings (PR-1)

> Plan: split payments (N gift cards + M cards) on kiosk + web. These five probes gate the
> design; run them BEFORE any flag flips. **All of them talk to PRODUCTION Square** — amounts
> are $1–$11, every script is dry-run by default, cleans up after itself, and prints a
> VERDICT line. Run from `apps/web/`: `npx tsx scripts/<name>.mts [--live] [args]`.

## Run order & what each decides

| # | Script | Needs | Decides | Verdict → action |
|---|--------|-------|---------|------------------|
| 1 | `probe-terminal-split.mts --device <readerId> --live` | Square Terminal + a human with a card (2 taps, $2, refunded) | **GO/NO-GO for kiosk multi-card**: partial-amount checkouts against one order, captured together via PayOrder | exit 0 = full design; exit 1 = kiosk scope falls back to *N gift cards + 1 tap* (web unaffected) |
| 2 | `probe-gc-id-tender-payorder.mts --live` | nothing (headless, $0 net) | gift-card **ID** as `source_id` with `autocomplete:false` + multi-auth PayOrder capture | exit 1 = kiosk GC rail must mint nonces another way (blocker — re-plan) |
| 3 | `probe-payorder-cap.mts --live` | nothing (headless, $0 net) | the real per-order tender cap → `SQUARE_MAX_TENDERS_PER_ORDER` | record the cap below; if <10, lower the constant + UI caps |
| 4 | `probe-from-gan.mts --gan <physical> --gan <egift> --raw "<scan/swipe capture>" --live` | one physical GC + one eGift GAN; raw captures from the kiosk admin scanner/MSR tabs | from-gan works for both card types; scanner/MSR payload normalization rules | paste observations below; locks `extractGanCandidate` / `parseSquareGiftSwipe` allowlists |
| 5 | `probe-approved-cancel.mts --live [--device <readerId>]` | Part A headless; Part B one tap ($1, canceled — nothing settles) | cancel semantics for APPROVED auths (GC + terminal) → sweep/abandon design | exit 2 on terminal part = sweep must use checkout-cancel instead of payment-cancel |

Getting raw captures for #4: kiosk `/kiosk/admin` → qrscanner tab (scan the eGift QR, copy the
line from the live feed) and the MSR test card (swipe the plastic GC). Do this before running
the probe so the normalization rules are tested against real payloads.

## Findings (fill in as probes run)

- [x] **#1 terminal-split: GO** (2026-07-29, owner-run at FastTrax FM, device 436CS149B8003019).
      Two $1.00 checkouts against a $2.00 order both ACCEPTED with `amount_money` honored
      exactly (no coercion to net due); payments APPROVED at 100¢ each; `PayOrder` with both
      ids (no order_version) → order COMPLETED. **Kiosk multi-card ships as designed.**
      Extra API facts learned (fold into PR-2/PR-6 + the sweep design):
      1. **Post-PayOrder, payments CANNOT be canceled** — Square 400s with "Payment is attached
         to the order and guaranteed to complete." Reversal after capture is refund-only.
      2. **Payment status lags order state**: immediately after PayOrder the order reads
         COMPLETED while the payments still read APPROVED for a short window. The ORDER state
         is authoritative — capture-verification and cleanup must key off it (probe cleanup
         patched accordingly; original run's auto-refund missed, order was canceled from the
         dashboard which auto-refunded both payments — reason "Canceled order").
      3. Terminal `autocomplete:false` auths carry `delay_action=CANCEL, delayed_until≈+36h` —
         Square self-voids abandoned reader auths in ~1.5 days (not 6); our sweep still wants
         minutes-scale release, but the backstop is shorter than assumed.
- [ ] **#2 gc-id-tender:** VERDICT __________
- [ ] **#3 payorder-cap:** auth-time limit ____, PayOrder cap ____, capture-at-cap ____
- [ ] **#4 from-gan:** physical → __________; eGift → __________; eGift QR payload shape → __________; MSR track shape / IIN prefix → __________
- [ ] **#5 approved-cancel:** GC balance held during auth? ____; payment-cancel on GC auth ____; on terminal auth ____; checkout-cancel ____

## After all five

1. Set `SQUARE_MAX_TENDERS_PER_ORDER` (+ GC/card sub-caps) in `tenders.ts` from #3.
2. Lock the scanner/MSR parser rules from #4's payload shapes.
3. If #1 failed: strike the kiosk multi-card PRs (terminal split fork) down to single-remainder-tap scope.
4. Owner sign-off recorded here → PR-2 (server engine) proceeds.
