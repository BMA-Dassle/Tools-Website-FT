import { describe, expect, it } from "vitest";
import {
  countTouches,
  emptyTouchCounts,
  isNewTouch,
  touchChannelOf,
  touchDayEt,
  touchKey,
  type TouchLike,
} from "./touches";

/**
 * The prototype's accountability rule (crm-shared.js:418), made executable:
 *
 *   "A touch counts once per lead per channel per day. Auto-replies and
 *    delivery receipts never count."
 *
 * The ET day is the load-bearing part. A 9 PM ET call on Sep 12 is
 * `2026-09-13T01:00Z` — a UTC-day tally would credit it to the wrong day and
 * let a rep count the same call twice across the boundary. Memory
 * `project_bookedat_utc_wallclock_sweep` is the same bug in another table.
 */

const out = (kind: string, occurredAt: string): TouchLike => ({
  kind,
  direction: "out",
  occurredAt,
});

describe("touchDayEt", () => {
  it("puts a 9 PM ET instant on the ET day, not the UTC one", () => {
    // 2026-09-12 21:00 ET === 2026-09-13 01:00 UTC.
    expect(touchDayEt("2026-09-13T01:00:00.000Z")).toBe("2026-09-12");
    expect(new Date("2026-09-13T01:00:00.000Z").toISOString().slice(0, 10)).toBe("2026-09-13");
  });

  it("handles the winter offset too", () => {
    // 2026-01-05 20:00 ET === 2026-01-06 01:00 UTC (EST, -05:00).
    expect(touchDayEt("2026-01-06T01:00:00.000Z")).toBe("2026-01-05");
  });
});

describe("touchChannelOf", () => {
  it("counts outbound calls, texts, emails and last-year reach-outs", () => {
    expect(touchChannelOf(out("call", "2026-09-12T18:00:00Z"))).toBe("call");
    expect(touchChannelOf(out("sms", "2026-09-12T18:00:00Z"))).toBe("sms");
    expect(touchChannelOf(out("email", "2026-09-12T18:00:00Z"))).toBe("email");
    expect(touchChannelOf(out("reachout", "2026-09-12T18:00:00Z"))).toBe("reachout");
  });

  it("counts nothing inbound, and nothing that is not a channel", () => {
    expect(
      touchChannelOf({ kind: "sms", direction: "in", occurredAt: "2026-09-12T18:00:00Z" }),
    ).toBeNull();
    expect(touchChannelOf(out("note", "2026-09-12T18:00:00Z"))).toBeNull();
    expect(touchChannelOf(out("status", "2026-09-12T18:00:00Z"))).toBeNull();
    expect(touchChannelOf(out("assign", "2026-09-12T18:00:00Z"))).toBeNull();
    // A delivery receipt is not an activity at all (C1 stores it on
    // crm_sms_messages.delivery_status), so it can never arrive here — and if
    // it somehow did, it has no direction of its own.
    expect(
      touchChannelOf({ kind: "sms", direction: null, occurredAt: "2026-09-12T18:00Z" }),
    ).toBeNull();
  });
});

describe("countTouches", () => {
  it("counts one per channel per ET day, however many rows there are", () => {
    const counts = countTouches([
      out("call", "2026-09-12T14:00:00Z"),
      out("call", "2026-09-12T16:00:00Z"),
      out("call", "2026-09-12T18:00:00Z"),
      out("sms", "2026-09-12T18:05:00Z"),
    ]);
    expect(counts).toEqual({ call: 1, sms: 1, email: 0, reachout: 0 });
  });

  it("counts the SAME channel again on the next ET day", () => {
    const counts = countTouches([
      out("call", "2026-09-12T14:00:00Z"),
      out("call", "2026-09-13T14:00:00Z"),
    ]);
    expect(counts.call).toBe(2);
  });

  it("does NOT double-count across a UTC midnight that is the same ET day", () => {
    const counts = countTouches([
      // 8 PM ET and 9 PM ET on Sep 12 — 00:00Z and 01:00Z on Sep 13.
      out("call", "2026-09-13T00:00:00.000Z"),
      out("call", "2026-09-13T01:00:00.000Z"),
    ]);
    expect(counts.call).toBe(1);
  });

  it("an empty history is all zeroes", () => {
    expect(countTouches([])).toEqual(emptyTouchCounts());
  });
});

describe("isNewTouch / touchKey", () => {
  it("a second call on the same ET day is not a new touch; a text is", () => {
    const existing = [out("call", "2026-09-12T14:00:00Z")];
    expect(isNewTouch(existing, out("call", "2026-09-12T18:00:00Z"))).toBe(false);
    expect(isNewTouch(existing, out("sms", "2026-09-12T18:00:00Z"))).toBe(true);
    expect(isNewTouch(existing, out("call", "2026-09-13T18:00:00Z"))).toBe(true);
  });

  it("a non-touch is never a new touch", () => {
    expect(isNewTouch([], out("note", "2026-09-12T14:00:00Z"))).toBe(false);
    expect(touchKey(out("note", "2026-09-12T14:00:00Z"))).toBeNull();
    expect(touchKey(out("call", "2026-09-12T14:00:00Z"))).toBe("call|2026-09-12");
  });
});
