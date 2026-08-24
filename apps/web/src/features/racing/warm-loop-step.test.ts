import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * The loop's cadence is now a decision, and it is the safety net for the whole
 * WS-writes-the-carry change. It has to fail SAFE — back to 1-second stepping —
 * in every case where nothing else might be writing the carry, because a
 * half-open bridge socket looks exactly like a quiet venue from our side. Proven
 * necessary: on 8/17 15:07-15:19 the ingest buffer holds zero frames and four
 * called heats went unseen by the wire.
 */
vi.mock("@/lib/redis", () => ({ default: { get: vi.fn(), set: vi.fn(), del: vi.fn() } }));

const { warmLoopStepMs } = await import("../../../app/api/cron/races-current-warm/route");

const NOW = Date.parse("2026-08-19T03:00:00Z");

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("warmLoopStepMs", () => {
  it("relaxes to 30s while the bridge is feeding us", () => {
    expect(
      warmLoopStepMs({ fastPathEnabled: true, bridgeLastEventMs: NOW - 30_000, nowMs: NOW }),
    ).toBe(30_000);
  });

  it("snaps back to 1s when the bridge heartbeat is stale", () => {
    // The venue sends BcTime every ~30s even on a dead night, so 2+ minutes of
    // silence is death, not calm.
    expect(
      warmLoopStepMs({ fastPathEnabled: true, bridgeLastEventMs: NOW - 121_000, nowMs: NOW }),
    ).toBe(1_000);
  });

  it("snaps back to 1s when there is no heartbeat at all", () => {
    expect(warmLoopStepMs({ fastPathEnabled: true, bridgeLastEventMs: null, nowMs: NOW })).toBe(
      1_000,
    );
  });

  it("snaps back to 1s when the kill switch is off", () => {
    expect(
      warmLoopStepMs({ fastPathEnabled: false, bridgeLastEventMs: NOW - 5_000, nowMs: NOW }),
    ).toBe(1_000);
  });

  it("treats an unparseable heartbeat as no heartbeat", () => {
    expect(warmLoopStepMs({ fastPathEnabled: true, bridgeLastEventMs: NaN, nowMs: NOW })).toBe(
      1_000,
    );
  });

  it("tolerates a heartbeat stamped slightly in the future (clock skew)", () => {
    expect(
      warmLoopStepMs({ fastPathEnabled: true, bridgeLastEventMs: NOW + 2_000, nowMs: NOW }),
    ).toBe(30_000);
  });
});
