/**
 * runStampBackfill — derivation matrix (per-person, per-lane hourly,
 * pizza-bowl, duration overrides), skip-and-report discipline, dryRun
 * write-nothing, and the additive-merge / re-check shape of the UPDATE.
 * DB is a recording tagged-template mock; catalog/experience tables are
 * fixture-backed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const state = {
    queries: [] as Array<{ text: string; values: unknown[] }>,
    scan: [] as unknown[],
    linesByRes: {} as Record<number, unknown[]>,
    zeroLineCount: 0,
  };
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("$?");
    state.queries.push({ text, values });
    if (text.includes("SELECT square_product_id")) {
      return Promise.resolve(state.linesByRes[values[0] as number] ?? []);
    }
    if (text.includes("COUNT(*)")) {
      return Promise.resolve([{ n: state.zeroLineCount }]);
    }
    if (/^\s*SELECT id, center_code/.test(text)) {
      return Promise.resolve(state.scan);
    }
    return Promise.resolve([]);
  };
  return { state, tag };
});

vi.mock("@/lib/db", () => ({
  isDbConfigured: () => true,
  sql: () => db.tag,
}));
vi.mock("@/lib/bowling-db", () => ({
  ensureBowlingSchema: vi.fn(async () => {}),
  getBowlingSquareProducts: vi.fn(async () => PRODUCTS),
  getBowlingExperiences: vi.fn(async () => EXPERIENCES),
}));

import { getBowlingSquareProducts } from "@/lib/bowling-db";
import { runStampBackfill } from "./stamp-backfill";

const PRODUCTS = [
  { id: 1, productKind: "open", label: "Fun 4 All", priceCents: 1999, squareCatalogObjectId: "C1" },
  {
    id: 2,
    productKind: "hourly",
    label: "Lane Rental",
    priceCents: 3999,
    squareCatalogObjectId: "C2",
  },
  {
    id: 3,
    productKind: "open",
    label: "Pizza Bowl",
    priceCents: 8999,
    squareCatalogObjectId: "C3",
  },
  {
    id: 5,
    productKind: "hourly",
    label: "Lane Rental 2h",
    priceCents: 6999,
    squareCatalogObjectId: "C5",
  },
  {
    id: 7,
    productKind: "addon_shoe",
    label: "Shoes",
    priceCents: 500,
    squareCatalogObjectId: "C7",
  },
];

const EXPERIENCES = [
  {
    slug: "fun-4-all",
    kind: "open",
    items: [{ squareProductId: 1 }],
    durationOptions: [],
  },
  {
    slug: "lane-rental",
    kind: "hourly",
    items: [{ squareProductId: 2 }],
    durationOptions: [{ overrideSquareProductId: 5 }],
  },
  {
    slug: "pizza-bowl-package",
    kind: "open",
    items: [{ squareProductId: 3 }],
    durationOptions: [],
  },
];

const scanRow = (over: Record<string, unknown> = {}) => ({
  id: 42,
  center_code: "fort-myers",
  product_kind: "open",
  player_count: 4,
  guest_name: "Ann Guest",
  booked_at: "2026-07-01T14:00:00-04:00",
  ...over,
});

const line = (squareProductId: number, quantity: number, label = "Line") => ({
  square_product_id: squareProductId,
  label,
  quantity,
  unit_price_cents: 1000,
});

const updates = () =>
  db.state.queries.filter((q) => q.text.includes("UPDATE bowling_reservations"));

beforeEach(() => {
  db.state.queries = [];
  db.state.scan = [];
  db.state.linesByRes = {};
  db.state.zeroLineCount = 0;
  vi.clearAllMocks();
});

describe("runStampBackfill — derivation", () => {
  it("stamps a per-person row (Fun 4 All, qty == players)", async () => {
    db.state.scan = [scanRow()];
    db.state.linesByRes[42] = [line(1, 4, "Fun 4 All"), line(7, 4, "Shoes")];

    const result = await runStampBackfill({ dryRun: false, limit: 200, neonId: null });

    expect(result.skipped).toEqual([]);
    expect(result.stamped).toEqual([
      expect.objectContaining({
        neonId: 42,
        stamp: {
          experienceSlug: "fun-4-all",
          laneCount: 1,
          durationMultiplier: 1,
          pricingMode: "per_person",
        },
      }),
    ]);
    expect(updates()).toHaveLength(1);
    expect(updates()[0].values).toContain(
      JSON.stringify({
        experienceSlug: "fun-4-all",
        laneCount: 1,
        durationMultiplier: 1,
        pricingMode: "per_person",
      }),
    );
  });

  it("stamps a per-lane hourly row (qty 3, 8 players → 2 lanes × 1.5h)", async () => {
    db.state.scan = [scanRow({ player_count: 8 })];
    db.state.linesByRes[42] = [line(2, 3, "Lane Rental")];

    const result = await runStampBackfill({ dryRun: false, limit: 200, neonId: null });

    expect(result.stamped[0].stamp).toEqual({
      experienceSlug: "lane-rental",
      laneCount: 2,
      durationMultiplier: 1.5,
      pricingMode: "per_lane",
    });
  });

  it("pizza-bowl slug prices per lane even though its kind is open", async () => {
    db.state.scan = [scanRow({ player_count: 10 })];
    db.state.linesByRes[42] = [line(3, 2, "Pizza Bowl")];

    const result = await runStampBackfill({ dryRun: false, limit: 200, neonId: null });

    expect(result.stamped[0].stamp).toEqual({
      experienceSlug: "pizza-bowl-package",
      laneCount: 2,
      durationMultiplier: 1,
      pricingMode: "per_lane",
    });
  });

  it("resolves the experience through a duration-option OVERRIDE product (2h bookings)", async () => {
    db.state.scan = [scanRow()];
    db.state.linesByRes[42] = [line(5, 2, "Lane Rental 2h")];

    const result = await runStampBackfill({ dryRun: false, limit: 200, neonId: null });

    expect(result.stamped[0].stamp).toEqual({
      experienceSlug: "lane-rental",
      laneCount: 1,
      durationMultiplier: 2,
      pricingMode: "per_lane",
    });
  });
});

describe("runStampBackfill — skip-and-report", () => {
  it("skips zero-line rows with the reason", async () => {
    db.state.scan = [scanRow()];
    db.state.linesByRes[42] = [];

    const result = await runStampBackfill({ dryRun: false, limit: 200, neonId: null });

    expect(result.stamped).toEqual([]);
    expect(result.skipped).toEqual([
      { neonId: 42, reason: expect.stringContaining("expected exactly one primary lane line") },
    ]);
    expect(updates()).toHaveLength(0);
  });

  it("skips a non-sane derived multiplier instead of guessing", async () => {
    // 5 units / 4 players = 1.25 — not a multiplier we sell.
    db.state.scan = [scanRow({ player_count: 4 })];
    db.state.linesByRes[42] = [line(1, 5, "Fun 4 All")];

    const result = await runStampBackfill({ dryRun: false, limit: 200, neonId: null });

    expect(result.skipped).toEqual([
      { neonId: 42, reason: expect.stringContaining("is not a known option") },
    ]);
    expect(updates()).toHaveLength(0);
  });

  it("one bad row doesn't stop the batch", async () => {
    db.state.scan = [scanRow({ id: 42 }), scanRow({ id: 43 })];
    db.state.linesByRes[42] = [];
    db.state.linesByRes[43] = [line(1, 4, "Fun 4 All")];

    const result = await runStampBackfill({ dryRun: false, limit: 200, neonId: null });

    expect(result.scanned).toBe(2);
    expect(result.skipped.map((s) => s.neonId)).toEqual([42]);
    expect(result.stamped.map((s) => s.neonId)).toEqual([43]);
  });
});

describe("runStampBackfill — write discipline", () => {
  it("dryRun reports the proposed stamp but writes NOTHING", async () => {
    db.state.scan = [scanRow()];
    db.state.linesByRes[42] = [line(1, 4, "Fun 4 All")];

    const result = await runStampBackfill({ dryRun: true, limit: 200, neonId: null });

    expect(result.dryRun).toBe(true);
    expect(result.stamped).toHaveLength(1);
    expect(updates()).toHaveLength(0);
  });

  it("the UPDATE merges additively and re-checks the stamp is still absent", async () => {
    db.state.scan = [scanRow()];
    db.state.linesByRes[42] = [line(1, 4, "Fun 4 All")];

    await runStampBackfill({ dryRun: false, limit: 200, neonId: null });

    const [update] = updates();
    expect(update.text).toContain("COALESCE(booking_metadata, '{}'::jsonb)");
    expect(update.text).toContain("jsonb_build_object('bowling'");
    expect(update.text).toContain("booking_metadata -> 'bowling' IS NULL");
  });

  it("neonId mode scans exactly that row", async () => {
    db.state.scan = [scanRow()];
    db.state.linesByRes[42] = [line(1, 4, "Fun 4 All")];

    await runStampBackfill({ dryRun: true, limit: 200, neonId: 42 });

    const scan = db.state.queries.find((q) => q.text.includes("FROM bowling_reservations"));
    expect(scan?.text).toContain("WHERE id = $?");
    expect(scan?.values[0]).toBe(42);
  });
});

describe("runStampBackfill — pagination (skips must not pin the window)", () => {
  it("excludes zero-line rows in SQL, orders by id DESC, and threads beforeId", async () => {
    db.state.scan = [scanRow()];
    db.state.linesByRes[42] = [line(1, 4, "Fun 4 All")];

    await runStampBackfill({ dryRun: true, limit: 200, neonId: null, beforeId: 99 });

    const scan = db.state.queries.find((q) => /^\s*SELECT id, center_code/.test(q.text));
    expect(scan?.text).toContain("EXISTS");
    expect(scan?.text).toContain("id < $?");
    expect(scan?.text).toContain("ORDER BY id DESC");
    expect(scan?.values).toContain(99);
  });

  it("hands back a cursor while the batch is full, null once exhausted", async () => {
    db.state.scan = [scanRow({ id: 43 }), scanRow({ id: 42 })];
    db.state.linesByRes[43] = [line(1, 4, "Fun 4 All")];
    db.state.linesByRes[42] = [line(1, 4, "Fun 4 All")];

    const full = await runStampBackfill({ dryRun: true, limit: 2, neonId: null });
    expect(full.nextBeforeId).toBe(42);

    const exhausted = await runStampBackfill({ dryRun: true, limit: 200, neonId: null });
    expect(exhausted.nextBeforeId).toBeNull();
  });

  it("resolves products INCLUDING inactive ones (deactivated-product rows must still derive)", async () => {
    db.state.scan = [scanRow()];
    db.state.linesByRes[42] = [line(1, 4, "Fun 4 All")];

    await runStampBackfill({ dryRun: true, limit: 200, neonId: null });

    expect(vi.mocked(getBowlingSquareProducts)).toHaveBeenCalledWith("fort-myers", undefined, true);
  });

  it("reports the zero-line population instead of scanning it", async () => {
    db.state.zeroLineCount = 4709;
    db.state.scan = [scanRow()];
    db.state.linesByRes[42] = [line(1, 4, "Fun 4 All")];

    const r = await runStampBackfill({ dryRun: true, limit: 200, neonId: null });
    expect(r.zeroLineRows).toBe(4709);
  });
});
