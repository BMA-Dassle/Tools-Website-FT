import { beforeEach, describe, expect, it, vi } from "vitest";

const addDeposit = vi.fn();
const enqueueDepositFailure = vi.fn();
const redisSet = vi.fn();
const markAddonGranted = vi.fn();
const markAddonGrantFailed = vi.fn();
const markAddonAwaitingPerson = vi.fn();

vi.mock("@/lib/pandora-deposits", () => ({
  addDeposit: (...args: unknown[]) => addDeposit(...args),
}));
vi.mock("@/lib/bmi-deposit-retry", () => ({
  enqueueDepositFailure: (...args: unknown[]) => enqueueDepositFailure(...args),
}));
vi.mock("@/lib/redis", () => ({
  default: { set: (...args: unknown[]) => redisSet(...args) },
}));
vi.mock("../data/addon-purchases-db", () => ({
  markAddonGranted: (...args: unknown[]) => markAddonGranted(...args),
  markAddonGrantFailed: (...args: unknown[]) => markAddonGrantFailed(...args),
  markAddonAwaitingPerson: (...args: unknown[]) => markAddonAwaitingPerson(...args),
}));

import { grantAddonCredits } from "./addon-grant.server";
import type { AddonPurchaseIntent } from "../data/addon-purchases-db";

const intent = (over: Partial<AddonPurchaseIntent> = {}): AddonPurchaseIntent => ({
  memberId: "m1",
  addonSlug: "headsock",
  personId: "16045822052840512",
  memberName: "Dana Ng",
  depositKindId: "48069703",
  grantAmount: 1,
  priceCents: 300,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  redisSet.mockResolvedValue("OK");
  addDeposit.mockResolvedValue("dep-1");
  markAddonGranted.mockResolvedValue(undefined);
  markAddonGrantFailed.mockResolvedValue(undefined);
  markAddonAwaitingPerson.mockResolvedValue(undefined);
  enqueueDepositFailure.mockResolvedValue(undefined);
});

describe("grantAddonCredits", () => {
  it("grants +1 headsock credit on the racer's Pandora account and marks the ledger", async () => {
    const out = await grantAddonCredits({ purchaseKey: "pk1", intents: [intent()] });
    expect(addDeposit).toHaveBeenCalledWith({
      personId: "16045822052840512", // raw string, never Number()'d
      depositKindId: "48069703",
      amount: 1,
      locationId: "LAB52GY480CJF",
    });
    expect(markAddonGranted).toHaveBeenCalledWith("pk1", "m1", "headsock");
    expect(out).toEqual([{ slug: "headsock", memberId: "m1", granted: true }]);
  });

  it("NX guard: an already-granted key skips addDeposit entirely (retried reserve)", async () => {
    redisSet.mockResolvedValue(null); // NX says the key exists
    const out = await grantAddonCredits({ purchaseKey: "pk1", intents: [intent()] });
    expect(addDeposit).not.toHaveBeenCalled();
    expect(out[0].granted).toBe(true);
  });

  it("Redis down: proceeds to grant (double-grant beats never-grant)", async () => {
    redisSet.mockRejectedValue(new Error("redis down"));
    await grantAddonCredits({ purchaseKey: "pk1", intents: [intent()] });
    expect(addDeposit).toHaveBeenCalledTimes(1);
  });

  it("addDeposit failure: marks grant-failed + enqueues to the retry sweep, never throws", async () => {
    addDeposit.mockRejectedValue(new Error("BMA 500"));
    const out = await grantAddonCredits({ purchaseKey: "pk1", intents: [intent()] });
    expect(markAddonGrantFailed).toHaveBeenCalledWith("pk1", "m1", "headsock", "BMA 500");
    expect(enqueueDepositFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "addon-headsock",
        personId: "16045822052840512",
        depositKindId: "48069703",
        amount: 1,
      }),
    );
    expect(out[0].granted).toBe(false);
  });

  it("no person id (brand-new racer): parks as awaiting-person, no deposit call", async () => {
    const out = await grantAddonCredits({
      purchaseKey: "pk1",
      intents: [intent({ personId: null })],
    });
    expect(addDeposit).not.toHaveBeenCalled();
    expect(markAddonAwaitingPerson).toHaveBeenCalledWith("pk1", "m1", "headsock");
    expect(out[0].granted).toBe(false);
  });

  it("line-item-only intents (no grant config) fulfill trivially", async () => {
    const out = await grantAddonCredits({
      purchaseKey: "pk1",
      intents: [intent({ depositKindId: null, grantAmount: 0 })],
    });
    expect(addDeposit).not.toHaveBeenCalled();
    expect(out[0].granted).toBe(true);
  });
});
