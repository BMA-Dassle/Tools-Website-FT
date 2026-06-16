# GAN Prefix Unification — Web vs Contracts

**Status:** Planned (not started). Owner-approved scheme 2026-06-16.
**Goal:** Make every internal deposit gift-card GAN say, at a glance, whether it came
from a **contract (GF)** or a **web** booking, and which **center** — so Square reporting
can split web vs contracts.

## Approved prefix scheme

Channel + existing center tag (no product letter). Center tags: `HPFM` = HeadPinz Fort
Myers, `FT` = FastTrax, `HPN` = HeadPinz Naples.

| Channel        | Center               | Prefix    | Example GAN        |
| -------------- | -------------------- | --------- | ------------------ |
| Contract (GF)  | HeadPinz Fort Myers  | `GFHPFM`  | `GFHPFM12345678`   |
| Contract (GF)  | FastTrax             | `GFFT`    | `GFFT12345678`     |
| Contract (GF)  | HeadPinz Naples      | `GFHPN`   | `GFHPN12345678`    |
| Web            | HeadPinz Fort Myers  | `WEBHPFM` | `WEBHPFM12345678`  |
| Web            | FastTrax             | `WEBFT`   | `WEBFT12345678`    |
| Web            | HeadPinz Naples      | `WEBHPN`  | `WEBHPN12345678`   |

Suffix unchanged per flow: GF & web race/attr = `billId.slice(-8)`; bowling = QAMF
reservation id. Multi-card GF chunks keep the trailing `B`, `C`, … letter.

## Hard constraints (verified 2026-06-16)

1. **GANs are immutable once minted.** Forward-only change — existing
   `HPFM…/GRPF…/RACE…/ATTR…/HPN…/DEPX…` cards keep their GANs. No data migration.
2. **`isInternalDepositGan()` is the only prefix parser** — [lib/square-gift-card.ts:59](../apps/web/lib/square-gift-card.ts#L59),
   regex `^(HPFM|HPN|DEPX|RACE|ATTR|GRPF)`. It blocks internal deposit cards from being
   redeemed as customer payment (callers: from-nonce L87, balance endpoint L390).
   **Must be updated in the SAME PR** as the generators, as a union of legacy ∪ new
   prefixes. Legacy prefixes stay forever (immutable old cards must keep matching).
3. **20-char ceiling money-hazard.** Custom GANs must be 8–20 alphanumeric or Square
   auto-generates a **numeric** GAN — which `isInternalDepositGan` does NOT match, making
   that deposit card **redeemable as payment**. Longest case: `WEBHPFM`(7) + QAMF id.
   The new `composeGan` helper MUST guarantee ≤20 (trim suffix tail) so a custom GAN is
   always used. This also closes a latent risk that exists today.

## Implementation steps

- [ ] **`apps/web/lib/gan.ts` (new) — single source of truth**
  - `buildGanPrefix({ channel: "GF" | "WEB", centerCode })` → prefix from the table.
  - `composeGan(prefix, suffix)` → strips non-alphanumerics, **trims suffix tail to keep
    total ≤ 20**, returns `{ gan, useCustom }` (custom always usable by construction).
  - `KNOWN_DEPOSIT_GAN_PREFIXES` — legacy ∪ new, exported for the guardrail + tests.
- [ ] **Point all 5 generators at the helper:**
  - GF deposit — [group-function/deposit/route.ts:227](../apps/web/app/api/group-function/deposit/route.ts#L227)
    (reads `quote.gan_prefix`); set new prefix on `gan_prefix` at quote insert in
    [cron/group-quote-dispatch/route.ts:657](../apps/web/app/api/cron/group-quote-dispatch/route.ts#L657)
    and [admin/group-function/ingest-legacy/route.ts:261](../apps/web/app/api/admin/group-function/ingest-legacy/route.ts#L261).
    Replace the GF center map prefixes in [hermes-client.ts:77-101](../apps/web/lib/hermes-client.ts#L77).
  - Web bowling — `CENTER_GAN_PREFIX` [bowling/v2/reserve:90](../apps/web/app/api/bowling/v2/reserve/route.ts#L90) (FM→WEBHPFM, Naples→WEBHPN).
  - Web race/attr — [booking/v2/reserve:462](../apps/web/app/api/booking/v2/reserve/route.ts#L462) (race→WEBFT; **verify attractions center tag** — likely WEBHPFM).
  - Unified cart — [unified-reserve.ts:619](../apps/web/src/features/booking/service/unified-reserve.ts#L619).
  - Race reconcile cron — [race-confirm-reconcile:138](../apps/web/app/api/cron/race-confirm-reconcile/route.ts#L138).
- [ ] **Update guardrail** — `isInternalDepositGan` regex → legacy ∪ `GFHPFM|GFFT|GFHPN|WEB`.
- [ ] **Property test (money-bug backstop):** for every prefix `buildGanPrefix` can emit,
  assert `isInternalDepositGan` returns true; assert `composeGan` output is always ≤20.
- [ ] **Fix existing tests** — `src/features/booking/service/deposit.test.ts` (RACE → new
  prefixes + note strings).
- [ ] **Docs** — prefix list in [square-gift-card.ts:51-57](../apps/web/lib/square-gift-card.ts#L51)
  and GAN examples in `docs/group-function-training-guide.md`.

## Cutover

- **One atomic PR** — generators + guardrail together. Never deploy generators first, or
  there is a window where new GF/WEB cards are redeemable as payment.
- No data migration (immutable GANs).
- Post-deploy: dry-run a deposit in each flow (GF, web race, web bowling), confirm the new
  GAN format and that `isInternalDepositGan` blocks the resulting card.

## Open detail to confirm during implementation

- **Attractions center tag** — race is FastTrax (`WEBFT`); confirm whether attractions
  (gel blaster, shuffly, etc.) report as FastTrax (`WEBFT`) or HeadPinz FM (`WEBHPFM`).
