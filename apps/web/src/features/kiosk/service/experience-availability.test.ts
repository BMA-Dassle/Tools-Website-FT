import { describe, expect, it } from "vitest";
import {
  mergeLastKnown,
  type ExperienceAvailability,
  type ExperienceAvailabilityResult,
  type ExperienceComputeResult,
} from "./experience-availability";

const ALL_OPEN: ExperienceAvailability = {
  "race-bowl": true,
  "ultimate-qualifier": true,
  bowling: true,
  kbf: true,
  race: true,
  "duck-pin": true,
  "gel-blaster": true,
  "laser-tag": true,
  "shuffly-fasttrax": true,
  "shuffly-headpinz": true,
};

function computed(overrides: Partial<ExperienceComputeResult>): ExperienceComputeResult {
  return { available: { ...ALL_OPEN }, firstOpen: {}, failed: [], ...overrides };
}

describe("mergeLastKnown", () => {
  it("no failed probes → computed result untouched, failed stripped", () => {
    const last: ExperienceAvailabilityResult = {
      available: { ...ALL_OPEN, "gel-blaster": false },
      firstOpen: {},
    };
    const out = mergeLastKnown(computed({}), last);
    expect(out.available["gel-blaster"]).toBe(true);
    expect("failed" in out).toBe(false);
  });

  it("failed probe re-serves the last known lock (the 11:30 PM gel-blaster flap)", () => {
    const last: ExperienceAvailabilityResult = {
      available: { ...ALL_OPEN, "gel-blaster": false, kbf: false },
      firstOpen: {},
    };
    const out = mergeLastKnown(computed({ failed: ["gel-blaster", "kbf"] }), last);
    expect(out.available["gel-blaster"]).toBe(false);
    expect(out.available.kbf).toBe(false);
    // Non-failed keys keep their computed values.
    expect(out.available["laser-tag"]).toBe(true);
  });

  it("failed probe carries the last known availability line too", () => {
    const last: ExperienceAvailabilityResult = {
      available: { ...ALL_OPEN },
      firstOpen: { "laser-tag": { start: "2026-08-01T23:45:00", freeSpots: 14 } },
    };
    const out = mergeLastKnown(computed({ failed: ["laser-tag"] }), last);
    expect(out.available["laser-tag"]).toBe(true);
    expect(out.firstOpen["laser-tag"]).toEqual({ start: "2026-08-01T23:45:00", freeSpots: 14 });
  });

  it("failed probe with a last-known that has NO line clears the stale line", () => {
    const last: ExperienceAvailabilityResult = {
      available: { ...ALL_OPEN, "duck-pin": false },
      firstOpen: {},
    };
    const out = mergeLastKnown(
      computed({
        failed: ["duck-pin"],
        firstOpen: { "duck-pin": { start: "2026-08-01T20:00:00" } },
      }),
      last,
    );
    expect(out.available["duck-pin"]).toBe(false);
    expect(out.firstOpen["duck-pin"]).toBeUndefined();
  });

  it("no last known → fail-open default survives", () => {
    const out = mergeLastKnown(computed({ failed: ["gel-blaster"] }), null);
    expect(out.available["gel-blaster"]).toBe(true);
    expect(out.firstOpen["gel-blaster"]).toBeUndefined();
  });

  it("last known missing a (newly added) key → fail-open default survives", () => {
    const last = {
      available: { ...ALL_OPEN } as ExperienceAvailability,
      firstOpen: {},
    };
    delete (last.available as unknown as Record<string, boolean>)["gel-blaster"];
    const out = mergeLastKnown(computed({ failed: ["gel-blaster"] }), last);
    expect(out.available["gel-blaster"]).toBe(true);
  });

  it("clean zero-availability (probe resolved null, not thrown) locks immediately — never merged", () => {
    const last: ExperienceAvailabilityResult = {
      available: { ...ALL_OPEN },
      firstOpen: { "gel-blaster": { start: "2026-08-01T22:15:00", freeSpots: 5 } },
    };
    const out = mergeLastKnown(
      computed({ available: { ...ALL_OPEN, "gel-blaster": false } }),
      last,
    );
    expect(out.available["gel-blaster"]).toBe(false);
  });
});
