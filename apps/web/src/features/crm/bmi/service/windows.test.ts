import { describe, expect, it } from "vitest";
import {
  BACKFILL_WINDOW_DAYS,
  backfillJobKey,
  backfillWindows,
  deltaJobKey,
  deltaWindow,
  detailSlice,
  etWallClock,
  fiveMinuteBucket,
  lastYearWindow,
  nextBucketStart,
  nextWindow,
  parseBackfillPayload,
  planAfterRun,
  shiftYears,
  type BackfillCursor,
} from "./windows";

/** Window arithmetic + cursor re-enqueue + delta overlap (brief B1 "Tests"). */

describe("backfill windows", () => {
  it("cuts a span into inclusive 30-day windows, the last one clipped", () => {
    expect(BACKFILL_WINDOW_DAYS).toBe(30);
    expect(backfillWindows("2025-09-01", "2025-11-30")).toEqual([
      { from: "2025-09-01", till: "2025-09-30" },
      { from: "2025-10-01", till: "2025-10-30" },
      { from: "2025-10-31", till: "2025-11-29" },
      { from: "2025-11-30", till: "2025-11-30" },
    ]);
    expect(backfillWindows("2025-09-01", "2025-09-30")).toEqual([
      { from: "2025-09-01", till: "2025-09-30" },
    ]);
    expect(backfillWindows("2025-09-30", "2025-09-01")).toEqual([]);
    expect(backfillWindows("nope", "2025-09-01")).toEqual([]);
  });

  it("nextWindow follows the previous one and stops at the span's end", () => {
    expect(nextWindow("2025-09-30", "2025-11-30")).toEqual({
      from: "2025-10-01",
      till: "2025-10-30",
    });
    expect(nextWindow("2025-11-29", "2025-11-30")).toEqual({
      from: "2025-11-30",
      till: "2025-11-30",
    });
    expect(nextWindow("2025-11-30", "2025-11-30")).toBeNull();
  });

  it("windows cross a DST change without losing or repeating a day", () => {
    const w = backfillWindows("2025-10-15", "2025-12-15");
    expect(w[0]).toEqual({ from: "2025-10-15", till: "2025-11-13" });
    expect(w[1]).toEqual({ from: "2025-11-14", till: "2025-12-13" });
    expect(w[2]).toEqual({ from: "2025-12-14", till: "2025-12-15" });
  });
});

describe("the cursor", () => {
  it("a fresh {clientKey, from, until} starts at the first window with the job id as chain", () => {
    const r = parseBackfillPayload(
      { clientKey: "headpinznaples", from: "2025-09-01", until: "2025-11-30" },
      "77",
    );
    expect(r).toEqual({
      ok: true,
      cursor: {
        clientKey: "headpinznaples",
        from: "2025-09-01",
        until: "2025-11-30",
        windowFrom: "2025-09-01",
        windowUntil: "2025-09-30",
        detailOffset: 0,
        projectIds: null,
        scheduleResources: null,
        chain: "77",
      },
    });
  });

  it("a continuation carries its window, offset, ids and chain through", () => {
    const r = parseBackfillPayload(
      {
        clientKey: "headpinznaples",
        from: "2025-09-01",
        until: "2025-11-30",
        windowFrom: "2025-10-01",
        windowUntil: "2025-10-30",
        detailOffset: 80,
        projectIds: ["1", "2"],
        scheduleResources: { "1": ["305133"] },
        chain: "abc",
      },
      "ignored",
    );
    expect(r.ok && r.cursor.windowFrom).toBe("2025-10-01");
    expect(r.ok && r.cursor.detailOffset).toBe(80);
    expect(r.ok && r.cursor.projectIds).toEqual(["1", "2"]);
    expect(r.ok && r.cursor.chain).toBe("abc");
  });

  it("refuses a missing tenant, a bad date, a reversed span, a window outside the span, a five-year span", () => {
    expect(parseBackfillPayload({}, "1")).toMatchObject({ ok: false });
    expect(
      parseBackfillPayload({ clientKey: "x", from: "2025-9-1", until: "2025-09-30" }, "1"),
    ).toMatchObject({
      ok: false,
    });
    expect(
      parseBackfillPayload({ clientKey: "x", from: "2025-09-30", until: "2025-09-01" }, "1"),
    ).toMatchObject({
      ok: false,
    });
    expect(
      parseBackfillPayload(
        {
          clientKey: "x",
          from: "2025-09-01",
          until: "2025-09-30",
          windowFrom: "2025-10-01",
          windowUntil: "2025-10-02",
        },
        "1",
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseBackfillPayload({ clientKey: "x", from: "2019-01-01", until: "2026-01-01" }, "1"),
    ).toMatchObject({
      ok: false,
    });
  });

  const cursor: BackfillCursor = {
    clientKey: "headpinznaples",
    from: "2025-09-01",
    until: "2025-11-30",
    windowFrom: "2025-09-01",
    windowUntil: "2025-09-30",
    detailOffset: 0,
    projectIds: ["a", "b", "c"],
    scheduleResources: {},
    chain: "77",
  };

  it("keys are derived from the cursor — never a clock — and carry the chain", () => {
    expect(backfillJobKey(cursor)).toBe("bmi-mirror-backfill:headpinznaples:2025-09-01#77");
    expect(backfillJobKey({ ...cursor, detailOffset: 80 })).toBe(
      "bmi-mirror-backfill:headpinznaples:2025-09-01:d80#77",
    );
    expect(backfillJobKey({ ...cursor, chain: "78" })).not.toBe(backfillJobKey(cursor));
  });

  it("planAfterRun: continue the window, then the next window, then finished", () => {
    expect(planAfterRun(cursor, 2, 3)).toEqual({
      kind: "continue",
      cursor: { ...cursor, detailOffset: 2 },
    });
    const next = planAfterRun({ ...cursor, detailOffset: 2 }, 1, 3);
    expect(next.kind).toBe("next-window");
    expect(next.kind === "next-window" && next.cursor).toEqual({
      ...cursor,
      windowFrom: "2025-10-01",
      windowUntil: "2025-10-30",
      detailOffset: 0,
      projectIds: null,
      scheduleResources: null,
    });
    expect(
      planAfterRun({ ...cursor, windowFrom: "2025-11-30", windowUntil: "2025-11-30" }, 3, 3),
    ).toEqual({
      kind: "finished",
    });
    // An empty window (no projects) moves straight on.
    expect(planAfterRun({ ...cursor, projectIds: [] }, 0, 0).kind).toBe("next-window");
  });

  it("detailSlice reads from the offset, at most the batch", () => {
    expect(detailSlice(cursor, 2)).toEqual(["a", "b"]);
    expect(detailSlice({ ...cursor, detailOffset: 2 }, 2)).toEqual(["c"]);
    expect(detailSlice({ ...cursor, projectIds: null })).toEqual([]);
  });
});

describe("delta windows", () => {
  const now = new Date("2026-09-12T23:32:10.000Z");

  it("overlaps the last successful run by ten minutes", () => {
    const w = deltaWindow(new Date("2026-09-12T23:20:00.000Z"), now);
    expect(w.from.toISOString()).toBe("2026-09-12T23:10:00.000Z");
    expect(w.until).toBe(now);
  });

  it("a tenant with no successful run looks back 24 hours", () => {
    expect(deltaWindow(null, now).from.toISOString()).toBe("2026-09-11T23:32:10.000Z");
  });

  it("a watermark in the future (clock skew) still yields a window ending now", () => {
    const w = deltaWindow(new Date("2026-09-13T01:00:00.000Z"), now);
    expect(w.from.getTime()).toBeLessThan(now.getTime());
  });

  it("5-minute buckets and the scheduled key", () => {
    expect(fiveMinuteBucket(now)).toBe("2026-09-12T23:30:00.000Z");
    expect(nextBucketStart(now).toISOString()).toBe("2026-09-12T23:35:00.000Z");
    expect(deltaJobKey("headpinznaples", fiveMinuteBucket(now))).toBe(
      "bmi-mirror-delta:headpinznaples:2026-09-12T23:30:00.000Z",
    );
  });

  it("etWallClock renders an instant as Office's zone-less Eastern stamp, DST aware", () => {
    expect(etWallClock(new Date("2026-09-12T23:32:10.000Z"))).toBe("2026-09-12T19:32:10");
    expect(etWallClock(new Date("2026-12-13T04:30:00.000Z"))).toBe("2026-12-12T23:30:00");
    expect(etWallClock(new Date("2026-12-13T05:00:00.000Z"))).toBe("2026-12-13T00:00:00");
  });
});

describe("this time last year", () => {
  it("at the prototype's clock the window is 3–8 weeks ahead, one year back", () => {
    // NOW = 2026-09-12T19:30-04:00 (crm-data.js:5); the prototype's pill reads "Oct 5 – Nov 7, 2025".
    expect(lastYearWindow(new Date("2026-09-12T23:30:00.000Z"))).toEqual({
      from: "2025-10-03",
      till: "2025-11-07",
    });
  });

  it("is an ET calendar day even late at night UTC", () => {
    // 03:00Z on the 13th is still the 12th in Fort Myers.
    expect(lastYearWindow(new Date("2026-09-13T03:00:00.000Z"))).toEqual({
      from: "2025-10-03",
      till: "2025-11-07",
    });
  });

  it("shiftYears clamps Feb 29", () => {
    expect(shiftYears("2028-02-29", -1)).toBe("2027-02-28");
    expect(shiftYears("2026-03-01", -1)).toBe("2025-03-01");
  });
});
