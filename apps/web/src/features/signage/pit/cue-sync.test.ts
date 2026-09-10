import { describe, expect, it } from "vitest";
import {
  CUE_SYNC_RESULT_WAIT_MS,
  CUE_SYNC_WINDOW_MS,
  syncPartner,
  syncedZoneFor,
} from "./cue-sync";

describe("syncPartner", () => {
  it("pairs the two pits and leaves Mega alone", () => {
    expect(syncPartner("blue")).toBe("red");
    expect(syncPartner("red")).toBe("blue");
    expect(syncPartner("mega")).toBeNull();
  });
});

describe("syncedZoneFor", () => {
  it("both pits claimed → the mega zone, which is both speakers", () => {
    expect(syncedZoneFor(["blue", "red"])).toBe("mega");
    expect(syncedZoneFor(["red", "blue"])).toBe("mega");
  });

  it("one pit claimed → its own zone; the other's cue already sounded", () => {
    expect(syncedZoneFor(["red"])).toBe("red");
    expect(syncedZoneFor(["blue"])).toBe("blue");
  });

  it("nothing claimed → nothing to play", () => {
    expect(syncedZoneFor([])).toBeNull();
  });
});

describe("the window", () => {
  it("is the owner's five seconds, and a joiner outwaits it plus a play", () => {
    expect(CUE_SYNC_WINDOW_MS).toBe(5_000);
    expect(CUE_SYNC_RESULT_WAIT_MS).toBeGreaterThan(CUE_SYNC_WINDOW_MS + 8_000);
  });
});
