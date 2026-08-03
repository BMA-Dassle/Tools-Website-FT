import { describe, it, expect, vi } from "vitest";

// credit-plan imports the Intercard SOAP surface for its type/really for the
// live callers; the resolver itself is pure. Mock it so the test never reaches
// for a MAC or a socket.
vi.mock("../data/intercard", () => ({
  creditTokens: vi.fn(),
  creditAccountValues: vi.fn(),
  verifyAccount: vi.fn(),
  clearAccount: vi.fn(),
}));

import { creditPlanForRow, planIsEmpty } from "./credit-plan";
import { COMP_TOKEN_DENOMINATIONS } from "../vouchers/grants";

/**
 * These tests guard the LOAD side of a voucher grant — the half that fails
 * silently. A comp row's value is re-derived from its `gzv-<n>` package id
 * against the denomination allowlist, deliberately NOT from the row's own
 * `tokens`/`bonus_tokens` columns (those are as editable as the id, and this is
 * the free-value path). So every row below is written with ZERO in its columns:
 * if the allowlist stops recognising a denomination, the plan goes empty and the
 * guest gets a dispensed card worth nothing.
 */
describe("creditPlanForRow — voucher grants", () => {
  it("credits 150 bonus tokens for a gzv-150 row (the $15 deal-pack card)", () => {
    expect(
      creditPlanForRow({ kind: "voucher", packageId: "gzv-150", tokens: 0, bonusTokens: 0 }),
    ).toEqual({ tokens: 0, bonusTokens: 150, bonusCashDollars: 0, bridgeable: true });
  });

  it("resolves EVERY allowlisted denomination to a non-empty plan", () => {
    // The guard that would have caught 150 being on the mint allowlist but not
    // this one. Add a denomination anywhere and it must survive the round trip.
    for (const n of COMP_TOKEN_DENOMINATIONS) {
      const plan = creditPlanForRow({
        kind: "voucher",
        packageId: `gzv-${n}`,
        tokens: 0,
        bonusTokens: 0,
      });
      expect(plan, `gzv-${n} resolved to no plan`).not.toBeNull();
      expect(planIsEmpty(plan!), `gzv-${n} resolved to an EMPTY plan`).toBe(false);
      expect(plan!.bonusTokens).toBe(n);
      // Comped value never lands in the purchased bucket.
      expect(plan!.tokens).toBe(0);
    }
  });

  it("credits NOTHING for an off-allowlist gzv row, ignoring the row's own columns", () => {
    // A hand-edited or retired grant id must not fall back to row values —
    // that fallback exists for sellable packages, never for free value.
    expect(
      creditPlanForRow({ kind: "voucher", packageId: "gzv-175", tokens: 0, bonusTokens: 175 }),
    ).toBeNull();
    expect(
      creditPlanForRow({ kind: "voucher", packageId: "gzv-99999", tokens: 0, bonusTokens: 99999 }),
    ).toBeNull();
  });

  it("still resolves sellable packages from TOKEN_PACKAGES", () => {
    expect(
      creditPlanForRow({ kind: "new_card", packageId: "tok-500", tokens: 0, bonusTokens: 0 }),
    ).toEqual({ tokens: 500, bonusTokens: 100, bonusCashDollars: 0, bridgeable: true });
  });

  it("falls back to the row's columns for an UNKNOWN non-voucher package id", () => {
    // Retired sellable package: the row is the only remaining record of what
    // was bought, so honouring it is correct here (and only here).
    expect(
      creditPlanForRow({ kind: "reload", packageId: "tok-retired", tokens: 42, bonusTokens: 7 }),
    ).toEqual({ tokens: 42, bonusTokens: 7, bonusCashDollars: 0, bridgeable: true });
  });
});
