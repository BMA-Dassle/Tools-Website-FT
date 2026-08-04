import { describe, expect, it, vi } from "vitest";
import { compareRowsDesc, listWebSales, mergeRows } from "./list";
import { decodeCursor } from "./cursor";
import { makeSaleRow } from "../test-support";
import type { SaleListQuery, SaleSourceId, WebSaleAdapter, WebSaleRow } from "../types";

const at = (iso: string, source: SaleSourceId, ref: string) => makeSaleRow({ source, ref, soldAt: iso });

/** A stub adapter that serves a fixed, pre-sorted list with real keyset semantics. */
function stubAdapter(id: SaleSourceId, rows: WebSaleRow[], overrides: Partial<WebSaleAdapter> = {}): WebSaleAdapter {
  return {
    id,
    label: id,
    sublabel: "",
    statusFilters: [],
    venues: [],
    actions: [],
    resendChannels: [],
    async list(q: SaleListQuery) {
      const sorted = [...rows].sort(compareRowsDesc);
      const after = q.before
        ? sorted.filter(
            (r) =>
              r.soldAt < q.before!.soldAt || (r.soldAt === q.before!.soldAt && r.ref < q.before!.ref),
          )
        : sorted;
      return after.slice(0, q.limit);
    },
    async summarize() {
      throw new Error("not used");
    },
    async detail() {
      return null;
    },
    ...overrides,
  };
}

const QUERY = { from: "2026-07-01", to: "2026-08-03" };

describe("compareRowsDesc", () => {
  it("orders newest first", () => {
    const older = at("2026-08-01T00:00:00.000Z", "deals", "1");
    const newer = at("2026-08-03T00:00:00.000Z", "deals", "2");
    expect([older, newer].sort(compareRowsDesc)).toEqual([newer, older]);
  });

  it("breaks ties on the globally unique id, descending", () => {
    // Without a total order a row can straddle a page boundary and be served
    // twice — the tie-break is not cosmetic.
    const a = at("2026-08-03T00:00:00.000Z", "deals", "1");
    const b = at("2026-08-03T00:00:00.000Z", "deals", "2");
    expect([a, b].sort(compareRowsDesc).map((r) => r.ref)).toEqual(["2", "1"]);
  });

  it("is deterministic for a tie across two different sources", () => {
    const d = at("2026-08-03T00:00:00.000Z", "deals", "1");
    const r = at("2026-08-03T00:00:00.000Z", "race-pack", "1");
    const once = [d, r].sort(compareRowsDesc).map((x) => x.id);
    const again = [r, d].sort(compareRowsDesc).map((x) => x.id);
    expect(once).toEqual(again);
  });
});

describe("mergeRows", () => {
  it("interleaves sources strictly by time and honours the limit", () => {
    const merged = mergeRows(
      [
        [at("2026-08-03T12:00:00.000Z", "deals", "a"), at("2026-08-03T09:00:00.000Z", "deals", "b")],
        [at("2026-08-03T11:00:00.000Z", "race-pack", "x"), at("2026-08-03T10:00:00.000Z", "race-pack", "y")],
      ],
      3,
    );
    expect(merged.map((r) => r.id)).toEqual(["deals:a", "race-pack:x", "race-pack:y"]);
  });

  it("returns nothing for a non-positive limit", () => {
    expect(mergeRows([[at("2026-08-03T12:00:00.000Z", "deals", "a")]], 0)).toEqual([]);
  });
});

describe("listWebSales", () => {
  it("returns exactly `limit` rows and a cursor that resumes without gap or repeat", async () => {
    const deals = stubAdapter("deals", [
      at("2026-08-03T12:00:00.000Z", "deals", "5"),
      at("2026-08-03T10:00:00.000Z", "deals", "4"),
      at("2026-08-03T08:00:00.000Z", "deals", "3"),
    ]);
    const packs = stubAdapter("race-pack", [
      at("2026-08-03T11:00:00.000Z", "race-pack", "b"),
      at("2026-08-03T09:00:00.000Z", "race-pack", "a"),
    ]);

    const page1 = await listWebSales({ adapters: [deals, packs], query: QUERY, cursor: null, limit: 2 });
    expect(page1.rows.map((r) => r.id)).toEqual(["deals:5", "race-pack:b"]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listWebSales({
      adapters: [deals, packs],
      query: QUERY,
      cursor: decodeCursor(page1.nextCursor),
      limit: 2,
    });
    expect(page2.rows.map((r) => r.id)).toEqual(["deals:4", "race-pack:a"]);

    const page3 = await listWebSales({
      adapters: [deals, packs],
      query: QUERY,
      cursor: decodeCursor(page2.nextCursor),
      limit: 2,
    });
    expect(page3.rows.map((r) => r.id)).toEqual(["deals:3"]);

    // Every row, exactly once, in order — the property that actually matters.
    const seen = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.id);
    expect(seen).toEqual(["deals:5", "race-pack:b", "deals:4", "race-pack:a", "deals:3"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("stops handing out a cursor on the last page", async () => {
    const deals = stubAdapter("deals", [at("2026-08-03T12:00:00.000Z", "deals", "1")]);
    const page = await listWebSales({ adapters: [deals], query: QUERY, cursor: null, limit: 10 });
    expect(page.rows).toHaveLength(1);
    // A cursor that yields an empty page makes "Load more" look broken.
    expect(page.nextCursor).toBeNull();
  });

  it("over-fetches by one so the last page is detected without a second round trip", async () => {
    const list = vi.fn(async () => [at("2026-08-03T12:00:00.000Z", "deals", "1")]);
    const deals = stubAdapter("deals", [], { list });
    await listWebSales({ adapters: [deals], query: QUERY, cursor: null, limit: 25 });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: 26 }));
  });

  it("passes each adapter only its own keyset position", async () => {
    const dealsList = vi.fn(async () => []);
    const packsList = vi.fn(async () => []);
    const cursor = decodeCursor(
      Buffer.from(
        JSON.stringify({ p: { deals: { soldAt: "2026-08-03T00:00:00.000Z", ref: "9" } } }),
      ).toString("base64url"),
    );
    await listWebSales({
      adapters: [stubAdapter("deals", [], { list: dealsList }), stubAdapter("race-pack", [], { list: packsList })],
      query: QUERY,
      cursor,
      limit: 10,
    });
    expect(dealsList).toHaveBeenCalledWith(
      expect.objectContaining({ before: { soldAt: "2026-08-03T00:00:00.000Z", ref: "9" } }),
    );
    expect(packsList).toHaveBeenCalledWith(expect.objectContaining({ before: null }));
  });

  it("reports a failing source instead of silently shortening the list", async () => {
    const ok = stubAdapter("deals", [at("2026-08-03T12:00:00.000Z", "deals", "1")]);
    const broken = stubAdapter("race-pack", [], {
      list: async () => {
        throw new Error("upstream exploded");
      },
    });
    const page = await listWebSales({ adapters: [ok, broken], query: QUERY, cursor: null, limit: 10 });
    expect(page.rows.map((r) => r.id)).toEqual(["deals:1"]);
    // The whole point: the caller can tell "no race packs" from "race packs failed".
    expect(page.errors).toEqual([{ source: "race-pack", message: "upstream exploded" }]);
  });
});
