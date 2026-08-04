import { describe, expect, it } from "vitest";
import { EMPTY_SUMMARY, combineSummaries, summarizeWebSales } from "./summary";
import type { SaleSourceId, SaleSummary, WebSaleAdapter } from "../types";

function summary(patch: Partial<SaleSummary> = {}): SaleSummary {
  return { ...EMPTY_SUMMARY, ...patch };
}

function stub(id: SaleSourceId, result: SaleSummary | Error): WebSaleAdapter {
  return {
    id,
    label: id,
    sublabel: "",
    statusFilters: [],
    venues: [],
    actions: [],
    resendChannels: [],
    async list() {
      return [];
    },
    async summarize() {
      if (result instanceof Error) throw result;
      return result;
    },
    async detail() {
      return null;
    },
  };
}

const QUERY = { from: "2026-07-01", to: "2026-08-03" };

describe("combineSummaries", () => {
  it("sums the shared figures", () => {
    const total = combineSummaries([
      summary({ grossCents: 3621, saleCount: 1, unitCount: 1, problemCount: 1 }),
      summary({ grossCents: 2500, saleCount: 2, unitCount: 3, refundedCents: 500 }),
    ]);
    expect(total).toEqual({
      grossCents: 6121,
      refundedCents: 500,
      saleCount: 3,
      unitCount: 4,
      problemCount: 1,
      extra: [],
    });
  });

  it("keeps the bespoke cards for a single source", () => {
    const extra = [{ label: "Laser Tag Pack", value: "5", sublabel: "packs", tone: "ok" as const }];
    expect(combineSummaries([summary({ extra })]).extra).toEqual(extra);
  });

  it("drops bespoke cards once two sources are mixed", () => {
    // Two products' bespoke cards side by side have no shared meaning, and
    // stacking them makes the header taller than the data.
    const a = summary({ extra: [{ label: "A", value: "1", sublabel: null, tone: "ok" }] });
    const b = summary({ extra: [{ label: "B", value: "2", sublabel: null, tone: "ok" }] });
    expect(combineSummaries([a, b]).extra).toEqual([]);
  });

  it("is the empty summary for no sources at all", () => {
    expect(combineSummaries([])).toEqual(EMPTY_SUMMARY);
  });
});

describe("summarizeWebSales", () => {
  it("returns per-source figures alongside the total", async () => {
    const result = await summarizeWebSales({
      adapters: [
        stub("deals", summary({ grossCents: 3621, saleCount: 1, unitCount: 1 })),
        stub("race-pack", summary({ grossCents: 8900, saleCount: 1, unitCount: 1 })),
      ],
      query: QUERY,
    });
    expect(result.total.grossCents).toBe(12521);
    expect(result.bySource.map((s) => s.source)).toEqual(["deals", "race-pack"]);
    expect(result.bySource[1].summary.grossCents).toBe(8900);
  });

  it("keeps a failing source in the breakdown at zero and reports the error", async () => {
    // Omitting it would make a broken source look like a source with no sales.
    const result = await summarizeWebSales({
      adapters: [
        stub("deals", summary({ grossCents: 3621, saleCount: 1 })),
        stub("race-pack", new Error("neon timeout")),
      ],
      query: QUERY,
    });
    expect(result.total.grossCents).toBe(3621);
    expect(result.bySource.find((s) => s.source === "race-pack")?.summary).toEqual(EMPTY_SUMMARY);
    expect(result.errors).toEqual([{ source: "race-pack", message: "neon timeout" }]);
  });

  it("does not surface a single source's bespoke cards once a second source is present", async () => {
    const result = await summarizeWebSales({
      adapters: [
        stub("deals", summary({ extra: [{ label: "Laser", value: "5", sublabel: null, tone: "ok" }] })),
        stub("race-pack", summary()),
      ],
      query: QUERY,
    });
    expect(result.total.extra).toEqual([]);
  });
});
