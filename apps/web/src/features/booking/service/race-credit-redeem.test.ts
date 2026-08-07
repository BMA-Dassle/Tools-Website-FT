/**
 * Race-credit deduction idempotency guard — the W58352 lesson (2026-08-06).
 *
 * Every racer in a party SHARES one heatId (`RaceItem.heats`: "multiple racers
 * on the same heat share heatId but have distinct entries"). The Redis NX guard
 * key was `{billId}:{ref}:{kind}` with no personId, so a party's redemptions for
 * one heat all hashed to the SAME key: the first racer got a credit deducted and
 * the rest were skipped as "already applied" — racing free on credits they'd
 * paid for.
 *
 * Live evidence: bill 63000000007527876, 4 racers × 3 heats, 4 × 3-race Weekday
 * packs granted (12 credits). 12 redemptions computed, 3 deducted (all from
 * Brett Conlon), 9 skipped. These tests lock the key shape so it can't regress.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { deductCreditRedemptions } from "./race-credit-redeem";
import { addDeposit } from "@/lib/pandora-deposits";
import { enqueueDepositFailure } from "@/lib/bmi-deposit-retry";
import redis from "@/lib/redis";

vi.mock("@/lib/pandora-deposits", () => ({
  getDepositBalances: vi.fn(),
  addDeposit: vi.fn(async () => "dep-1"),
}));
vi.mock("@/lib/bmi-deposit-retry", () => ({
  enqueueDepositFailure: vi.fn(async () => undefined),
}));
// Real SET NX semantics — a mock that always returns "OK" makes the collision
// tests vacuous (the guard would never skip, so the bug wouldn't reproduce).
const nxStore = new Set<string>();
vi.mock("@/lib/redis", () => ({
  default: {
    set: vi.fn(async (key: string) => {
      if (nxStore.has(key)) return null;
      nxStore.add(key);
      return "OK";
    }),
  },
}));

const BILL = "63000000007527876";
const WEEKDAY = "12744867";
/** The three heat blocks W58352 booked — heatId is the block start ISO. */
const HEATS = ["2026-08-06T20:24:00", "2026-08-06T21:12:00", "2026-08-06T21:36:00"];
/** The four racers, each holding their own 3-race Weekday pack. */
const RACERS = ["63000000006517986", "57968585", "56086252", "56086176"];

/** The exact 12 redemptions the pack-coverage walk produced for W58352. */
function w58352Redemptions() {
  return HEATS.flatMap((ref) =>
    RACERS.map((personId) => ({ personId, depositKindId: WEEKDAY, ref })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  nxStore.clear();
  // Restore NX behaviour — a test that swaps in mockRejectedValue would otherwise leak.
  vi.mocked(redis.set).mockImplementation((async (key: string) => {
    if (nxStore.has(key)) return null;
    nxStore.add(key);
    return "OK";
  }) as unknown as typeof redis.set);
  vi.mocked(addDeposit).mockResolvedValue("dep-1");
});

describe("deductCreditRedemptions — guard key", () => {
  it("deducts once per RACER per heat, not once per heat (W58352)", async () => {
    await deductCreditRedemptions(w58352Redemptions(), { billId: BILL });

    // 4 racers × 3 heats = 12 credits off, not 3.
    expect(vi.mocked(addDeposit)).toHaveBeenCalledTimes(12);
    for (const personId of RACERS) {
      const forRacer = vi.mocked(addDeposit).mock.calls.filter(([a]) => a.personId === personId);
      expect(forRacer).toHaveLength(3);
      expect(forRacer.every(([a]) => a.amount === -1)).toBe(true);
    }
  });

  it("scopes the guard key by personId so racers can't collide", async () => {
    await deductCreditRedemptions(w58352Redemptions(), { billId: BILL });

    const keys = vi.mocked(redis.set).mock.calls.map(([k]) => k);
    expect(new Set(keys).size).toBe(12);
    expect(keys).toContain(`race-credit-redeemed:${BILL}:${RACERS[0]}:${HEATS[0]}:${WEEKDAY}`);
    expect(keys).toContain(`race-credit-redeemed:${BILL}:${RACERS[3]}:${HEATS[2]}:${WEEKDAY}`);
    // The pre-fix key shape must be gone entirely.
    expect(keys).not.toContain(`race-credit-redeemed:${BILL}:${HEATS[0]}:${WEEKDAY}`);
  });

  it("still blocks a genuine double-deduct (same racer, same heat, retried reserve)", async () => {
    const one = [{ personId: RACERS[0], depositKindId: WEEKDAY, ref: HEATS[0] }];
    await deductCreditRedemptions(one, { billId: BILL });
    // A retried reserve re-runs the same redemption; the NX guard refuses it.
    await deductCreditRedemptions(one, { billId: BILL });

    expect(vi.mocked(addDeposit)).toHaveBeenCalledTimes(1);
  });

  it("enqueues a per-racer retry row when a deduct fails", async () => {
    vi.mocked(addDeposit).mockRejectedValueOnce(new Error("Pandora 500"));
    await deductCreditRedemptions(
      RACERS.slice(0, 2).map((personId) => ({
        personId,
        depositKindId: WEEKDAY,
        ref: HEATS[0],
      })),
      { billId: BILL },
    );

    expect(vi.mocked(enqueueDepositFailure)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueDepositFailure)).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "race-credit-redeem",
        personId: RACERS[0],
        depositKindId: WEEKDAY,
        amount: -1,
      }),
    );
    // The second racer's deduct still went through — one failure never blocks the party.
    expect(vi.mocked(addDeposit)).toHaveBeenCalledTimes(2);
  });

  it("deducts even when Redis is down rather than giving away a free race", async () => {
    vi.mocked(redis.set).mockRejectedValue(new Error("ECONNREFUSED"));
    await deductCreditRedemptions(w58352Redemptions(), { billId: BILL });
    expect(vi.mocked(addDeposit)).toHaveBeenCalledTimes(12);
  });
});
