import { describe, expect, it } from "vitest";
import { postClipCandidates } from "./post-clip";

describe("postClipCandidates", () => {
  it("leads with the room phrase for a known room", () => {
    expect(postClipCandidates("red")).toEqual(["post-red", "post"]);
    expect(postClipCandidates("blue")).toEqual(["post-blue", "post"]);
  });

  it("an unknown room gets the generic announcement alone", () => {
    expect(postClipCandidates(null)).toEqual(["post"]);
    expect(postClipCandidates(undefined)).toEqual(["post"]);
  });

  it("the generic post is ALWAYS last — a missing room clip can never mute the announcement", () => {
    for (const room of ["red", "blue", null] as const) {
      const candidates = postClipCandidates(room);
      expect(candidates[candidates.length - 1]).toBe("post");
    }
  });
});
