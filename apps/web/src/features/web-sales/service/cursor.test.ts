import { describe, expect, it } from "vitest";
import { advanceCursor, decodeCursor, encodeCursor, positionFor, type SaleCursor } from "./cursor";
import { makeSaleRow } from "../test-support";
import type { SaleSourceId, WebSaleRow } from "../types";

const row = (source: SaleSourceId, ref: string, soldAt: string): WebSaleRow =>
  makeSaleRow({ source, ref, soldAt });

describe("cursor codec", () => {
  it("round-trips a position", () => {
    const cursor: SaleCursor = {
      positions: { deals: { soldAt: "2026-08-03T19:18:17.000Z", ref: "412" } },
    };
    const decoded = decodeCursor(encodeCursor(cursor));
    expect(decoded).toEqual(cursor);
  });

  it("encodes the same logical position to the same string regardless of key order", () => {
    const a = encodeCursor({
      positions: {
        deals: { soldAt: "2026-08-03T00:00:00.000Z", ref: "1" },
        "race-pack": { soldAt: "2026-08-02T00:00:00.000Z", ref: "2" },
      },
    });
    const b = encodeCursor({
      positions: {
        "race-pack": { soldAt: "2026-08-02T00:00:00.000Z", ref: "2" },
        deals: { soldAt: "2026-08-03T00:00:00.000Z", ref: "1" },
      },
    });
    expect(a).toBe(b);
  });

  it("returns null rather than throwing for junk, truncation and tampering", () => {
    const good = encodeCursor({ positions: { deals: { soldAt: "2026-08-03", ref: "1" } } });
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not-base64-!!!")).toBeNull();
    expect(decodeCursor(good.slice(0, Math.floor(good.length / 2)))).toBeNull();
    // Valid base64url of valid JSON that is simply the wrong shape.
    expect(decodeCursor(Buffer.from('{"nope":1}').toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from('["array"]').toString("base64url"))).toBeNull();
    // Over the length guard.
    expect(decodeCursor("A".repeat(4096))).toBeNull();
  });

  it("drops unknown source ids and malformed positions instead of failing the page", () => {
    const raw = Buffer.from(
      JSON.stringify({
        p: {
          deals: { soldAt: "2026-08-03T00:00:00.000Z", ref: "9" },
          "ghost-source": { soldAt: "2026-08-03T00:00:00.000Z", ref: "1" },
          "race-pack": { soldAt: 12345, ref: null },
        },
      }),
    ).toString("base64url");
    const decoded = decodeCursor(raw);
    expect(decoded?.positions).toEqual({ deals: { soldAt: "2026-08-03T00:00:00.000Z", ref: "9" } });
  });

  it("treats a cursor with no usable position as no cursor at all", () => {
    const raw = Buffer.from(JSON.stringify({ p: { "ghost-source": { soldAt: "x", ref: "1" } } })).toString(
      "base64url",
    );
    expect(decodeCursor(raw)).toBeNull();
  });

  it("never hands one source's position to another", () => {
    // The structural guarantee the per-source design exists for: a deals cursor
    // must not become a WHERE clause in the race-pack query.
    const cursor = decodeCursor(
      encodeCursor({ positions: { deals: { soldAt: "2026-08-03T00:00:00.000Z", ref: "412" } } }),
    );
    expect(positionFor(cursor, "deals")).toEqual({ soldAt: "2026-08-03T00:00:00.000Z", ref: "412" });
    expect(positionFor(cursor, "race-pack")).toBeNull();
    expect(positionFor(cursor, "game-card-reload")).toBeNull();
    expect(positionFor(null, "deals")).toBeNull();
  });
});

describe("advanceCursor", () => {
  it("advances each source to the oldest row taken from it", () => {
    const taken = [
      row("deals", "10", "2026-08-03T12:00:00.000Z"),
      row("race-pack", "aaa", "2026-08-03T11:00:00.000Z"),
      row("deals", "9", "2026-08-03T10:00:00.000Z"),
    ];
    expect(advanceCursor(null, taken).positions).toEqual({
      deals: { soldAt: "2026-08-03T10:00:00.000Z", ref: "9" },
      "race-pack": { soldAt: "2026-08-03T11:00:00.000Z", ref: "aaa" },
    });
  });

  it("keeps the previous position for a source that contributed nothing", () => {
    // Its rows lost the merge and are still pending — resetting would re-serve them.
    const prev: SaleCursor = {
      positions: {
        deals: { soldAt: "2026-08-03T09:00:00.000Z", ref: "5" },
        "race-pack": { soldAt: "2026-08-03T08:00:00.000Z", ref: "zzz" },
      },
    };
    const next = advanceCursor(prev, [row("deals", "4", "2026-08-03T07:00:00.000Z")]);
    expect(next.positions.deals).toEqual({ soldAt: "2026-08-03T07:00:00.000Z", ref: "4" });
    expect(next.positions["race-pack"]).toEqual({ soldAt: "2026-08-03T08:00:00.000Z", ref: "zzz" });
  });

  it("does not mutate the cursor it was given", () => {
    const prev: SaleCursor = { positions: { deals: { soldAt: "2026-08-03", ref: "5" } } };
    advanceCursor(prev, [row("deals", "4", "2026-08-02")]);
    expect(prev.positions.deals).toEqual({ soldAt: "2026-08-03", ref: "5" });
  });
});
