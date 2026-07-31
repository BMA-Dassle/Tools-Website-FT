import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@ft/db", () => ({
  sql: vi.fn(),
  isDbConfigured: vi.fn(() => false),
}));

vi.mock("~/features/game-cards/data/vouchers-db", () => ({
  getVoucherByBillId: vi.fn(async () => null),
}));

vi.mock("~/features/game-cards/service/native-voucher", () => ({
  mintVouchers: vi.fn(async (args: { items: unknown[] }) => ({
    batchId: "b-1",
    vouchers: [{ code: "HPW4K7M9PQR", items: args.items }],
  })),
}));

vi.mock("~/features/game-cards/service/voucher-mail", () => ({
  sendVoucherToGuest: vi.fn(async () => ({ emailOk: true })),
}));

import { comboVoucherExpiry, comboVoucherItems, mintComboVoucherIfNeeded } from "./combo-voucher";
import { getVoucherByBillId } from "~/features/game-cards/data/vouchers-db";
import { mintVouchers } from "~/features/game-cards/service/native-voucher";
import type { ComboSpecial } from "./combo-specials";

const BILL = "63000000006397110";

const gz = { kind: "gamezone" as const, tokens: 0, bonusTokens: 100, bonusCashDollars: 0 };
const choice = {
  kind: "attraction-choice" as const,
  slugs: ["laser-tag", "gel-blaster"],
  qty: 1,
};
const shuffly = { kind: "attraction" as const, slug: "shuffly", qty: 1 };

const combo = {
  id: "race-bowl-v2",
  name: "Ultimate VIP Experience",
  voucherGrant: {
    perGuest: [gz, choice],
    perBooking: [shuffly],
    expiresMonthsFromVisit: 12,
  },
} as unknown as ComboSpecial;

beforeEach(() => {
  vi.clearAllMocks();
  (getVoucherByBillId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

describe("comboVoucherItems", () => {
  it("multiplies perGuest by racer count and appends perBooking once", () => {
    const items = comboVoucherItems(combo, 3);
    // 3 racers × [gamezone, choice] + one shared shuffly = 7 items.
    expect(items).toHaveLength(7);
    expect(items.filter((i) => i.kind === "gamezone")).toHaveLength(3);
    expect(items.filter((i) => i.kind === "attraction-choice")).toHaveLength(3);
    expect(items.filter((i) => i.kind === "attraction")).toHaveLength(1);
    // perBooking rides at the END so gamezone dispensing (first-unspent order)
    // is never blocked behind it.
    expect(items[items.length - 1]).toEqual(shuffly);
  });

  it("floors a nonsense racer count at 1 and returns [] without a grant", () => {
    expect(comboVoucherItems(combo, 0)).toHaveLength(3);
    expect(comboVoucherItems({ ...combo, voucherGrant: undefined } as ComboSpecial, 3)).toEqual([]);
  });
});

describe("comboVoucherExpiry", () => {
  it("expires 12 months after the VISIT date (owner: '1 year from race date')", () => {
    const iso = comboVoucherExpiry("2026-08-02", 12);
    // 2026-08-02T23:59:59-05:00 + 12 months = 2027-08-03T04:59:59Z.
    expect(iso).toBe("2027-08-03T04:59:59.000Z");
  });

  it("throws on a malformed visit date instead of minting never-expiring", () => {
    expect(() => comboVoucherExpiry("not-a-date", 12)).toThrow(/bad visit date/);
  });
});

describe("mintComboVoucherIfNeeded", () => {
  const args = {
    combo,
    billId: BILL,
    racerCount: 2,
    visitDateYmd: "2026-08-02",
    contact: { email: "guest@example.com", name: "Guest" },
  };

  it("returns null when the combo grants nothing", async () => {
    const res = await mintComboVoucherIfNeeded({
      ...args,
      combo: { ...combo, voucherGrant: undefined } as ComboSpecial,
    });
    expect(res).toBeNull();
    expect(mintVouchers).not.toHaveBeenCalled();
  });

  it("is idempotent on the bill — an existing voucher short-circuits the mint", async () => {
    (getVoucherByBillId as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: "HPWEXISTING",
      items: [gz],
      expiresAt: "2027-08-03T04:59:59.000Z",
    });
    const res = await mintComboVoucherIfNeeded(args);
    expect(res?.code).toBe("HPWEXISTING");
    expect(mintVouchers).not.toHaveBeenCalled();
  });

  it("mints ONE bill-linked voucher with per-guest items × racers", async () => {
    const res = await mintComboVoucherIfNeeded(args);
    expect(res?.code).toBe("HPW4K7M9PQR");
    expect(mintVouchers).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        billId: BILL,
        issuedSource: "booking-combo",
        issuedTo: { email: "guest@example.com", name: "Guest" },
        expiresAt: "2027-08-03T04:59:59.000Z",
      }),
    );
    const items = (mintVouchers as ReturnType<typeof vi.fn>).mock.calls[0][0].items;
    expect(items).toHaveLength(5); // 2×(gz+choice) + shuffly
  });

  it("re-selects the winner when the bill_id unique index loses a race", async () => {
    (mintVouchers as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("duplicate key value violates unique constraint"),
    );
    (getVoucherByBillId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null) // pre-mint check: nothing yet
      .mockResolvedValueOnce({
        code: "HPWWINNER",
        items: [gz],
        expiresAt: null,
      }); // post-conflict re-select: the other writer's voucher
    const res = await mintComboVoucherIfNeeded(args);
    expect(res?.code).toBe("HPWWINNER");
  });

  it("rethrows when the mint fails and no winner exists (cron recovers)", async () => {
    (mintVouchers as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("neon down"));
    await expect(mintComboVoucherIfNeeded(args)).rejects.toThrow("neon down");
  });
});
