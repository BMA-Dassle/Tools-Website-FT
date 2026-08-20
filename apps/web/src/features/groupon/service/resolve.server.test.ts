import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GrouponUnit } from "../types";
import type { GrouponUnitRow } from "../data/groupon-units-db";

const order: string[] = [];

/** The unit as PRODUCTION really returns it (fetched 2026-08-20). The `price`
 *  is the field a reconstructed unit gets wrong, so it is the assertion. */
const PROD_UNIT: GrouponUnit = {
  id: "23cc45c6-b538-44d6-912e-ae823ccd71ce",
  status: "available",
  grouponCode: "VS-GCMV-VNXS-4YN4-2V4X",
  redemptionCode: "89895632",
  redeemedAt: null,
  value: { amount: 6500, currencyCode: "USD" },
  price: { amount: 3060, currencyCode: "USD" },
  attributes: null,
};

const ROW: GrouponUnitRow = {
  redemptionCode: "89895632",
  unitId: PROD_UNIT.id,
  grouponCode: PROD_UNIT.grouponCode,
  dealKey: "arcade25-laser4",
  items: [],
  // The ledger stores value but NOT price — which is exactly why the unit
  // cannot be rebuilt from this row.
  valueAmount: 6500,
  currencyCode: "USD",
  fetchedAt: "2026-08-20T15:00:00Z",
  redeemState: "pending",
  redeemedAt: null,
  redeemAttempts: 0,
  lastError: null,
};

const ok = <T>(data: T) => ({ status: 200, ok: true, data, errorCodes: [], raw: "{}" });

const fetchUnit = vi.fn();
const redeemUnit = vi.fn();
const markGrouponRedeemed = vi.fn(async () => {
  order.push("markRedeemed");
});
const markGrouponRedeemFailure = vi.fn(async () => {
  order.push("markFailure");
});
// Explicit type: "never seen this code" is `null`, which the happy-path
// implementation's inferred return type would make untypeable.
const findGrouponUnit = vi.fn<(code: string) => Promise<GrouponUnitRow | null>>(async () => ROW);

vi.mock("../client.server", () => ({
  fetchUnit: (...a: unknown[]) => {
    order.push("fetch");
    return fetchUnit(...a);
  },
  redeemUnit: (...a: unknown[]) => {
    order.push("redeem");
    return redeemUnit(...a);
  },
  isGrouponConfigured: () => true,
  // REAL implementation, not a stub: which error codes count as "not our
  // voucher" is the logic these tests exist to pin.
  isNotOurVoucher: (codes: string[]) =>
    codes.includes("UNIT_NOT_FOUND") || codes.includes("FORBIDDEN"),
}));

vi.mock("../data/groupon-units-db", () => ({
  findGrouponUnit: (code: string) => findGrouponUnit(code),
  upsertGrouponUnit: vi.fn(async () => {
    order.push("persist");
    return ROW;
  }),
  markGrouponRedeemed: (...a: unknown[]) => markGrouponRedeemed(...(a as [])),
  markGrouponRedeemFailure: (...a: unknown[]) => markGrouponRedeemFailure(...(a as [])),
}));

vi.mock("~/features/game-cards/data/voucher-claims-db", () => ({
  spentItemIndexes: vi.fn(async () => new Set<number>()),
}));

async function redeemGrouponUnit(code: string) {
  const m = await import("./resolve.server");
  return m.redeemGrouponUnit(code);
}

async function resolveGrouponCode(code: string) {
  const m = await import("./resolve.server");
  return m.resolveGrouponCode(code);
}

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
  findGrouponUnit.mockResolvedValue(ROW);
});

/**
 * The bug these cover: `redeemGrouponUnit` used to BUILD a unit out of ledger
 * columns instead of re-fetching it. Groupon's PATCH only works when the whole
 * unit from the GET is echoed back, and the ledger has no `price` column — so
 * the fabricated unit sent price 0 against the real 3060. Groupon answers a
 * mutated echo with UNIT_NOT_FOUND / MALFORMED_REQUEST, which the failure path
 * marks TERMINAL, permanently stranding a row the cron would never retry.
 */
describe("redeemGrouponUnit — re-fetch, never reconstruct", () => {
  it("GETs before it PATCHes", async () => {
    fetchUnit.mockResolvedValue(ok([PROD_UNIT]));
    redeemUnit.mockResolvedValue(ok([PROD_UNIT]));

    await redeemGrouponUnit("89895632");

    expect(order).toEqual(["fetch", "redeem", "markRedeemed"]);
  });

  it("echoes the FETCHED unit, price included — not one rebuilt from the ledger", async () => {
    fetchUnit.mockResolvedValue(ok([PROD_UNIT]));
    redeemUnit.mockResolvedValue(ok([PROD_UNIT]));

    await redeemGrouponUnit("89895632");

    // The regression assertion. A reconstructed unit sends price 0 here.
    expect(redeemUnit).toHaveBeenCalledWith(PROD_UNIT);
    expect(redeemUnit.mock.calls[0][0].price).toEqual({ amount: 3060, currencyCode: "USD" });
  });

  it("sends NOTHING when Groupon already considers it redeemed", async () => {
    // Covers a crash between a successful PATCH and our ledger write.
    fetchUnit.mockResolvedValue(ok([{ ...PROD_UNIT, status: "redeemed" }]));

    const res = await redeemGrouponUnit("89895632");

    expect(res).toEqual({ redeemed: true });
    expect(redeemUnit).not.toHaveBeenCalled();
    expect(order).toEqual(["fetch", "markRedeemed"]);
  });

  it("does no network at all for a row already sent", async () => {
    findGrouponUnit.mockResolvedValue({ ...ROW, redeemState: "sent" });

    expect(await redeemGrouponUnit("89895632")).toEqual({ redeemed: true });
    expect(order).toEqual([]);
  });

  it("keeps a re-fetch FLAKE pending so the cron retries it", async () => {
    // The voucher is already converted into our tables and honoured, so a 500
    // is a bookkeeping debt for the sweep — never a terminal verdict.
    fetchUnit.mockResolvedValue({
      status: 500,
      ok: false,
      data: null,
      errorCodes: [],
      raw: "upstream boom",
    });

    const res = await redeemGrouponUnit("89895632");

    expect(res).toEqual({ redeemed: false });
    expect(redeemUnit).not.toHaveBeenCalled();
    expect(markGrouponRedeemFailure).toHaveBeenCalledWith(
      "89895632",
      expect.stringContaining("refetch:"),
      false, // NOT terminal
    );
  });

  it("treats production's FORBIDDEN on the re-fetch as terminal too", async () => {
    // Prod says FORBIDDEN where staging says UNIT_NOT_FOUND. Without this the
    // row retries 12 times and then stalls as a stuck `pending` debt.
    fetchUnit.mockResolvedValue({
      status: 400,
      ok: false,
      data: null,
      errorCodes: ["FORBIDDEN"],
      raw: '{"errors":[{"code":"FORBIDDEN"}]}',
    });

    await redeemGrouponUnit("89895632");

    expect(markGrouponRedeemFailure).toHaveBeenCalledWith(
      "89895632",
      expect.stringContaining("refetch:"),
      true,
    );
  });

  it("treats UNIT_NOT_FOUND on the re-fetch as terminal", async () => {
    fetchUnit.mockResolvedValue({
      status: 400,
      ok: false,
      data: null,
      errorCodes: ["UNIT_NOT_FOUND"],
      raw: '{"errors":[{"code":"UNIT_NOT_FOUND"}]}',
    });

    await redeemGrouponUnit("89895632");

    expect(markGrouponRedeemFailure).toHaveBeenCalledWith(
      "89895632",
      expect.stringContaining("refetch:"),
      true,
    );
  });

  it("refuses to PATCH a status it does not understand", async () => {
    // `refunded` / `expired` / whatever Groupon adds next. We do not know what a
    // redeem means against it, so a human looks instead of us guessing.
    fetchUnit.mockResolvedValue(ok([{ ...PROD_UNIT, status: "refunded" }]));

    const res = await redeemGrouponUnit("89895632");

    expect(res).toEqual({ redeemed: false });
    expect(redeemUnit).not.toHaveBeenCalled();
    expect(markGrouponRedeemFailure).toHaveBeenCalledWith(
      "89895632",
      expect.stringContaining("refunded"),
      true,
    );
  });

  it("counts INVALID_STATE_TRANSITION on the PATCH as success", async () => {
    fetchUnit.mockResolvedValue(ok([PROD_UNIT]));
    redeemUnit.mockResolvedValue({
      status: 400,
      ok: false,
      data: null,
      errorCodes: ["INVALID_STATE_TRANSITION"],
      raw: "{}",
    });

    expect(await redeemGrouponUnit("89895632")).toEqual({ redeemed: true });
    expect(markGrouponRedeemed).toHaveBeenCalled();
  });
});

/**
 * REDEEM AT SCAN (owner 2026-08-20, not negotiable). The voucher is converted
 * into our tables and reported to Groupon in one go, so from the first scan
 * onward the guest's legs are ours to honour and Groupon's opinion stops
 * mattering. These tests pin the two halves of that.
 */
describe("resolveGrouponCode — redeem at scan", () => {
  it("PERSISTS before it redeems, on a first scan", async () => {
    // Order is the whole point: the row IS the entitlement. Telling Groupon
    // `redeemed` before writing it risks a voucher Groupon calls spent and we
    // have never heard of.
    findGrouponUnit.mockResolvedValue(null);
    fetchUnit.mockResolvedValue(ok([PROD_UNIT]));
    redeemUnit.mockResolvedValue(ok([PROD_UNIT]));

    const res = await resolveGrouponCode("89895632");

    expect(res.ok).toBe(true);
    // ONE fetch, not two: the scan path passes both the row it just wrote and
    // the unit it just fetched straight into the redeem, so the guest standing
    // at the kiosk waits for GET + PATCH rather than GET + GET + PATCH.
    expect(order).toEqual(["fetch", "persist", "redeem", "markRedeemed"]);
  });

  it("does NOT redeem again when the code is rescanned on another kiosk", async () => {
    // "If they scan again on another kiosk it's redeemed with groupon but we
    // still have it available to them" — answered entirely from the ledger,
    // with no network call of any kind.
    findGrouponUnit.mockResolvedValue({ ...ROW, redeemState: "sent" });

    const res = await resolveGrouponCode("89895632");

    expect(res.ok).toBe(true);
    expect(order).toEqual([]);
    expect(fetchUnit).not.toHaveBeenCalled();
    expect(redeemUnit).not.toHaveBeenCalled();
  });

  it("still grants the legs when the redeem PATCH fails", async () => {
    // A failed PATCH is OUR bookkeeping problem, never a reason to show the
    // guest less than they are owed.
    findGrouponUnit.mockResolvedValue(null);
    fetchUnit.mockResolvedValue(ok([PROD_UNIT]));
    redeemUnit.mockResolvedValue({
      status: 500,
      ok: false,
      data: null,
      errorCodes: [],
      raw: "boom",
    });

    const res = await resolveGrouponCode("89895632");

    expect(res.ok).toBe(true);
    expect(markGrouponRedeemFailure).toHaveBeenCalled();
  });
});
