import { describe, it, expect, vi, beforeEach } from "vitest";

const order: string[] = [];

// Mock only the DB calls — `gameZoneGrant` / `voucherItemLabel` are pure item
// helpers and their real behaviour is part of what these tests exercise.
vi.mock("../data/vouchers-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/vouchers-db")>();
  return {
    ...actual,
    getVoucher: vi.fn(),
    getVoucherByBillId: vi.fn(async () => null),
    insertVoucher: vi.fn(async () => {
      order.push("insertVoucher");
      return true;
    }),
    logVoucherEvent: vi.fn(async () => {}),
    voidVoucher: vi.fn(async () => {
      order.push("voidVoucher");
    }),
  };
});

vi.mock("../data/voucher-claims-db", () => ({
  spentItemIndexes: vi.fn(async () => new Set<number>()),
  claimVoucher: vi.fn(async () => {
    order.push("claim");
    return { ok: true, claim: {} };
  }),
  releaseVoucherClaim: vi.fn(async () => {
    order.push("release");
  }),
}));

vi.mock("../data/transactions-log", () => ({
  startCompedTxn: vi.fn(async () => {
    order.push("ledger");
  }),
  markChargeFailed: vi.fn(async () => {
    order.push("chargeFailed");
  }),
}));

async function mods() {
  return {
    svc: await import("./native-voucher"),
    db: await import("../data/vouchers-db"),
    claims: await import("../data/voucher-claims-db"),
    log: await import("../data/transactions-log"),
  };
}

const CODE = "HPW4K7M9PQR";
const live = {
  id: 1,
  code: CODE,
  kind: "gamezone" as const,
  items: [{ kind: "gamezone" as const, tokens: 0, bonusTokens: 100, bonusCashDollars: 0 }],
  batchId: "b-1",
  batchLabel: "Service recovery",
  issuedSource: "admin",
  issuedTo: null,
  expiresAt: null,
  voidedAt: null,
  voidedReason: null,
  createdBy: "eric",
  createdAt: new Date().toISOString(),
};

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
});

describe("claimNativeVoucher", () => {
  it("claims BEFORE the ledger row, and grants exactly what was minted", async () => {
    const { svc, db } = await mods();
    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue(live);

    const res = await svc.claimNativeVoucher({ code: CODE, locationCode: 12, source: "kiosk" });

    expect(res.ok).toBe(true);
    if (res.ok) {
      // No name parsing anywhere — the grant is a stored fact.
      expect(res.grant).toEqual({ tokens: 0, bonusTokens: 100, bonusCashDollars: 0 });
      expect(res.packageId).toBe("gzv-100");
    }
    expect(order).toEqual(["claim", "ledger"]);
  });

  it("accepts the hyphenated printed form", async () => {
    const { svc, db } = await mods();
    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue(live);
    const res = await svc.claimNativeVoucher({
      code: "hpw-4k7m-9pqr",
      locationCode: 12,
      source: "kiosk",
    });
    expect(res.ok).toBe(true);
    expect(db.getVoucher).toHaveBeenCalledWith(CODE);
  });

  it("records the WEB leg as voucher_reload so a guest's card is never cleared", async () => {
    // clear-on-encode keys off the kind. Mislabelling a guest's own card as a
    // fresh blank would wipe their existing balance.
    const { svc, db, log } = await mods();
    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue(live);

    await svc.claimNativeVoucher({
      code: CODE,
      locationCode: 12,
      accountNumber: "1063464",
      source: "web",
    });

    expect(log.startCompedTxn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "voucher_reload", accountNumber: "1063464" }),
    );
  });

  it("records the KIOSK leg as voucher with no account yet", async () => {
    const { svc, db, log } = await mods();
    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue(live);
    await svc.claimNativeVoucher({ code: CODE, locationCode: 12, source: "kiosk" });
    expect(log.startCompedTxn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "voucher", accountNumber: "" }),
    );
  });

  it("a SWIPE kiosk's blank rides the claim as a `voucher` row that already knows its card", async () => {
    // No dispenser: the guest swiped the blank BEFORE the claim, so the row is
    // persisted WITH its account (persist-first — a load that never reaches
    // the server still leaves a row the cron can credit). Still a fresh blank
    // (`voucher`, not the web leg's `voucher_reload`): load-card never clears
    // a fresh-blank row that carries its account, and the cron gives `voucher`
    // rows the kiosk's grace window.
    const { svc, db, log } = await mods();
    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue(live);
    await svc.claimNativeVoucher({
      code: CODE,
      locationCode: 12,
      accountNumber: "0000000001037356",
      source: "kiosk",
    });
    expect(log.startCompedTxn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "voucher", accountNumber: "0000000001037356" }),
    );
  });

  it("refuses unknown / voided / expired BEFORE touching the claim", async () => {
    const { svc, db, claims } = await mods();

    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    expect(await svc.claimNativeVoucher({ code: CODE, locationCode: 12, source: "kiosk" })).toEqual(
      {
        ok: false,
        reason: "unknown",
      },
    );

    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...live,
      voidedAt: new Date().toISOString(),
    });
    expect(await svc.claimNativeVoucher({ code: CODE, locationCode: 12, source: "kiosk" })).toEqual(
      {
        ok: false,
        reason: "voided",
      },
    );

    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...live,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await svc.claimNativeVoucher({ code: CODE, locationCode: 12, source: "kiosk" })).toEqual(
      {
        ok: false,
        reason: "expired",
      },
    );

    // A cheap refusal must never burn the code.
    expect(claims.claimVoucher).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("honours a voucher expiring in the future", async () => {
    const { svc, db } = await mods();
    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...live,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const res = await svc.claimNativeVoucher({ code: CODE, locationCode: 12, source: "kiosk" });
    expect(res.ok).toBe(true);
  });

  it("reports a spent code as used and writes no ledger row", async () => {
    const { svc, db, claims } = await mods();
    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue(live);
    // Once: mockResolvedValue persists across clearAllMocks and would make
    // every later test look like a spent voucher.
    (claims.claimVoucher as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "already_claimed",
    });
    const res = await svc.claimNativeVoucher({ code: CODE, locationCode: 12, source: "kiosk" });
    expect(res).toEqual({ ok: false, reason: "used" });
    expect(order).toEqual([]);
  });

  it("releases the claim when the ledger insert fails", async () => {
    const { svc, db, log } = await mods();
    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue(live);
    // Once: a persistent rejection here leaks into every later test (they'd all
    // refuse with `storage`). clearAllMocks resets CALLS, not implementations.
    (log.startCompedTxn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("neon down"));
    const res = await svc.claimNativeVoucher({ code: CODE, locationCode: 12, source: "kiosk" });
    expect(res).toEqual({ ok: false, reason: "storage" });
    expect(order).toEqual(["claim", "release"]);
  });

  it("rejects a BMI-shaped code (wrong registry)", async () => {
    const { svc, db } = await mods();
    const res = await svc.claimNativeVoucher({
      code: "D3X5Q4Z8M5C3Z4D3H6S3T4G3",
      locationCode: 12,
      source: "kiosk",
    });
    expect(res).toEqual({ ok: false, reason: "bad_format" });
    expect(db.getVoucher).not.toHaveBeenCalled();
  });
});

describe("mintVouchers", () => {
  it("mints N codes in one batch, all zero-purchased / all bonus", async () => {
    const { svc, db } = await mods();
    const { batchId, vouchers } = await svc.mintVouchers({
      count: 3,
      items: [svc.gameZoneItem(100)],
    });
    expect(vouchers).toHaveLength(3);
    expect(batchId).toBeTruthy();
    expect(new Set(vouchers.map((v) => v.code)).size).toBe(3);
    for (const v of vouchers) {
      expect(v.items).toEqual([
        { kind: "gamezone", tokens: 0, bonusTokens: 100, bonusCashDollars: 0 },
      ]);
    }
    expect(db.insertVoucher).toHaveBeenCalledTimes(3);
  });

  it("retries a colliding code instead of overwriting a live voucher", async () => {
    const { svc, db } = await mods();
    (db.insertVoucher as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(false) // collision
      .mockResolvedValueOnce(true);
    const { vouchers } = await svc.mintVouchers({ count: 1, items: [svc.gameZoneItem(50)] });
    expect(vouchers).toHaveLength(1);
    expect(db.insertVoucher).toHaveBeenCalledTimes(2);
  });

  it("refuses a denomination we don't sell", async () => {
    const { svc } = await mods();
    await expect(svc.mintVouchers({ count: 1, items: [svc.gameZoneItem(75)] })).rejects.toThrow(
      /unsupported denomination/,
    );
  });
});

describe("multi-item vouchers (one code, several lines of value)", () => {
  const mixed = {
    ...live,
    kind: "mixed" as const,
    items: [
      { kind: "gamezone" as const, tokens: 0, bonusTokens: 100, bonusCashDollars: 0 },
      { kind: "attraction" as const, slug: "laser-tag", qty: 1 },
    ],
  };

  it("spends only the Game Zone ITEM and reports the rest as remaining", async () => {
    // The whole point: redeeming the card must not destroy the laser-tag leg.
    const { svc, db, claims } = await mods();
    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue(mixed);

    const res = await svc.claimNativeVoucher({ code: CODE, locationCode: 12, source: "kiosk" });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.itemIndex).toBe(0);
      expect(res.grant.bonusTokens).toBe(100);
      expect(res.remaining.map((r) => r.item.kind)).toEqual(["attraction"]);
    }
    expect(claims.claimVoucher).toHaveBeenCalledWith(expect.objectContaining({ itemIndex: 0 }));
  });

  it("picks the FIRST UNSPENT Game Zone item when several exist", async () => {
    const { svc, db, claims } = await mods();
    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...live,
      items: [svc.gameZoneItem(100), svc.gameZoneItem(200)],
    });
    (claims.spentItemIndexes as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Set([0]));

    const res = await svc.claimNativeVoucher({ code: CODE, locationCode: 12, source: "kiosk" });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.itemIndex).toBe(1);
      expect(res.grant.bonusTokens).toBe(200);
    }
  });

  it("reports used only when EVERY Game Zone item is spent", async () => {
    const { svc, db, claims } = await mods();
    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue(mixed);
    (claims.spentItemIndexes as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Set([0]));
    const res = await svc.claimNativeVoucher({ code: CODE, locationCode: 12, source: "kiosk" });
    expect(res).toEqual({ ok: false, reason: "used" });
  });

  it("distinguishes 'nothing to redeem HERE' from 'used up'", async () => {
    // A laser-tag-only voucher is live and valuable — the guest just can't spend
    // it on this rail. Saying "used" would be a lie.
    const { svc, db } = await mods();
    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...live,
      kind: "mixed" as const,
      items: [{ kind: "attraction" as const, slug: "laser-tag", qty: 1 }],
    });
    const res = await svc.claimNativeVoucher({ code: CODE, locationCode: 12, source: "kiosk" });
    expect(res).toEqual({ ok: false, reason: "not_redeemable" });
  });

  it("mints a mixed voucher and labels it accordingly", async () => {
    const { svc, db } = await mods();
    const { vouchers } = await svc.mintVouchers({
      count: 1,
      items: [svc.gameZoneItem(100), { kind: "attraction", slug: "laser-tag", qty: 2 }],
    });
    expect(vouchers[0].items).toHaveLength(2);
    expect(db.insertVoucher).toHaveBeenCalledWith(expect.objectContaining({ kind: "mixed" }));
  });

  it("getVoucherStatus reports per-item spend + redeemability", async () => {
    const { svc, db, claims } = await mods();
    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue(mixed);
    (claims.spentItemIndexes as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Set([0]));

    const status = await svc.getVoucherStatus(CODE);

    expect(status?.items).toEqual([
      expect.objectContaining({ index: 0, spent: true, redeemable: true }),
      expect.objectContaining({ index: 1, spent: false, redeemable: false, label: "laser tag" }),
    ]);
    // Every REDEEMABLE item is spent — the unredeemable leg doesn't hold it open.
    expect(status?.fullySpent).toBe(true);
  });
});

describe("attraction-choice items + bill-linked mints", () => {
  const choice = {
    kind: "attraction-choice" as const,
    slugs: ["laser-tag", "gel-blaster"],
    qty: 1,
  };

  it("validates a choice item to the cart rail with an either-keyword coverage name", async () => {
    const { svc, db } = await mods();
    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...live,
      kind: "mixed",
      items: [svc.gameZoneItem(100), choice],
    });
    const res = await svc.validateNativeVoucher(CODE);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const cart = res.items.find((i) => i.index === 1);
      // Must contain BOTH keywords so voucherTarget() covers either attraction.
      expect(cart).toMatchObject({
        redeemVia: "cart",
        coverageName: "Laser Tag or Gel Blaster",
        label: "laser tag or gel blaster",
      });
    }
  });

  it("a choice-only voucher refuses the Game Zone rail as not_redeemable (never 'used')", async () => {
    const { svc, db } = await mods();
    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...live,
      kind: "mixed" as const,
      items: [choice],
    });
    const res = await svc.claimNativeVoucher({ code: CODE, locationCode: 12, source: "kiosk" });
    expect(res).toEqual({ ok: false, reason: "not_redeemable" });
  });

  it("mints mixed kind and threads billId + issuedTo through to the row", async () => {
    const { svc, db } = await mods();
    await svc.mintVouchers({
      count: 1,
      items: [svc.gameZoneItem(100), choice],
      billId: "63000000006397110",
      issuedTo: { email: "guest@example.com", name: "Guest" },
      issuedSource: "booking-combo",
    });
    expect(db.insertVoucher).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "mixed",
        billId: "63000000006397110",
        issuedTo: { email: "guest@example.com", name: "Guest" },
        issuedSource: "booking-combo",
      }),
    );
  });

  it("refuses a choice item with no attractions", async () => {
    const { svc } = await mods();
    await expect(
      svc.mintVouchers({
        count: 1,
        items: [{ kind: "attraction-choice", slugs: [], qty: 1 }],
      }),
    ).rejects.toThrow(/at least one attraction/);
  });

  it("refuses a bill-linked mint of more than one voucher", async () => {
    const { svc } = await mods();
    await expect(
      svc.mintVouchers({ count: 2, items: [svc.gameZoneItem(100)], billId: "63000000006397110" }),
    ).rejects.toThrow(/exactly one voucher/);
  });
});

describe("mintBookingVoucherIfNeeded — the universal booking-grant rail", () => {
  const BILL = "63000000006397110";
  const args = () => ({
    billId: BILL,
    items: [
      { kind: "gamezone" as const, tokens: 0, bonusTokens: 100, bonusCashDollars: 0 },
      { kind: "attraction-choice" as const, slugs: ["laser-tag", "gel-blaster"], qty: 1 },
    ],
    expiresAt: "2027-08-03T04:59:59.000Z",
    issuedSource: "booking-combo",
  });

  it("mints ONE bill-linked voucher and returns its code + items + expiry", async () => {
    const { svc, db } = await mods();
    (db.getVoucherByBillId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await svc.mintBookingVoucherIfNeeded(args());
    expect(res.code).toMatch(/^HPW/);
    expect(res.items).toHaveLength(2);
    expect(res.expiresAt).toBe("2027-08-03T04:59:59.000Z");
    expect(db.insertVoucher).toHaveBeenCalledWith(
      expect.objectContaining({ billId: BILL, kind: "mixed", issuedSource: "booking-combo" }),
    );
  });

  it("is idempotent on the bill — an existing voucher short-circuits the mint", async () => {
    const { svc, db } = await mods();
    (db.getVoucherByBillId as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: "HPWEXISTING",
      items: [svc.gameZoneItem(100)],
      expiresAt: null,
    });
    const res = await svc.mintBookingVoucherIfNeeded(args());
    expect(res.code).toBe("HPWEXISTING");
    expect(db.insertVoucher).not.toHaveBeenCalled();
  });

  it("re-selects the winner when the bill_id unique index loses a race", async () => {
    const { svc, db } = await mods();
    (db.getVoucherByBillId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null) // pre-mint check: nothing yet
      .mockResolvedValueOnce({ code: "HPWWINNER", items: [], expiresAt: null }); // post-conflict
    (db.insertVoucher as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("duplicate key value violates unique constraint"),
    );
    const res = await svc.mintBookingVoucherIfNeeded(args());
    expect(res.code).toBe("HPWWINNER");
  });

  it("rethrows when the mint fails and no winner exists (caller's recovery owns it)", async () => {
    const { svc, db } = await mods();
    (db.getVoucherByBillId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (db.insertVoucher as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("neon down"));
    await expect(svc.mintBookingVoucherIfNeeded(args())).rejects.toThrow("neon down");
  });
});

describe("validateNativeVoucher — per-item routing (auto-split)", () => {
  it("splits a mixed voucher into gamezone + cart items with coverage names", async () => {
    const { svc, db } = await mods();
    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...live,
      kind: "mixed",
      items: [
        { kind: "gamezone", tokens: 0, bonusTokens: 100, bonusCashDollars: 0 },
        { kind: "attraction", slug: "laser-tag", qty: 1 },
        { kind: "race", qty: 1 },
      ],
    });

    const res = await svc.validateNativeVoucher(CODE);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const byVia = Object.fromEntries(res.items.map((i) => [i.index, i]));
      expect(byVia[0].redeemVia).toBe("gamezone");
      expect(byVia[1]).toMatchObject({ redeemVia: "cart", coverageName: "Laser Tag" });
      expect(byVia[2]).toMatchObject({ redeemVia: "cart", coverageName: "Race" });
      // coverageName must satisfy the booking's voucherTarget().
      expect(res.remainingGameZoneItems).toBe(1);
    }
  });

  it("omits already-spent items and reports used when the last one is gone", async () => {
    const { svc, db, claims } = await mods();
    (db.getVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...live,
      items: [{ kind: "attraction", slug: "laser-tag", qty: 1 }],
    });
    (claims.spentItemIndexes as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Set([0]));
    const res = await svc.validateNativeVoucher(CODE);
    expect(res).toEqual({ ok: false, reason: "used" });
  });
});
