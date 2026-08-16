import { describe, expect, it } from "vitest";
import { nextCameraDelayMs } from "./useCameraStill";

/**
 * The retry POLICY, tested without a browser — the hook itself is thin wiring
 * around it. The invariant that matters: every outcome yields a NEXT delay.
 * (The freeze this replaced came from a path with no next tick at all.)
 */
describe("nextCameraDelayMs", () => {
  it("keeps the caller's cadence while frames are landing", () => {
    expect(nextCameraDelayMs(true, 1_000)).toBe(1_000);
    expect(nextCameraDelayMs(true, 2_000)).toBe(2_000);
  });

  it("backs a failing camera off to at least 2s, whatever the cadence", () => {
    // A camera that is down must not be hammered at viewer speed.
    expect(nextCameraDelayMs(false, 1_000)).toBe(2_000);
    expect(nextCameraDelayMs(false, 500)).toBe(2_000);
  });

  it("never shortens a slower cadence on failure", () => {
    expect(nextCameraDelayMs(false, 5_000)).toBe(5_000);
  });
});
