import { describe, expect, it } from "vitest";
import { matchGateKey, matchGateVerdict } from "./match-gate";
import type { LicenseMatch } from "./types";

function match(fullName: string, personId = "63000000000000001"): LicenseMatch {
  return {
    personId,
    fullName,
    email: "",
    phone: "",
    loginCode: "",
    lastSeen: "",
    lastSeenAt: 0,
    races: 0,
    memberships: [],
    birthDate: "2001-03-14",
    creditBalances: [],
  };
}

const PICKABLE = { pickable: true };
const NO_PICKER = { pickable: false };

describe("matchGateVerdict", () => {
  it("creates when the lookup is unavailable or empty (never blocks)", () => {
    expect(matchGateVerdict("Jane", null, PICKABLE)).toEqual({ kind: "create" });
    expect(matchGateVerdict("Jane", [], PICKABLE)).toEqual({ kind: "create" });
    expect(matchGateVerdict("Jane", null, NO_PICKER)).toEqual({ kind: "create" });
  });

  it("attaches a single match whose first name agrees (exact or prefix)", () => {
    const m = match("Jane Doe");
    expect(matchGateVerdict("Jane", [m], PICKABLE)).toEqual({ kind: "attach", match: m });
    expect(matchGateVerdict("JANEY", [m], PICKABLE)).toEqual({ kind: "attach", match: m });
    const prefix = match("Alexander Doe");
    expect(matchGateVerdict("Alex", [prefix], PICKABLE)).toEqual({ kind: "attach", match: prefix });
  });

  it("a lone match with a FOREIGN first name (sibling/twin) is never auto-attached", () => {
    const twin = match("Sam Doe");
    expect(matchGateVerdict("Jane", [twin], PICKABLE)).toEqual({ kind: "pick", matches: [twin] });
    expect(matchGateVerdict("Jane", [twin], NO_PICKER)).toEqual({ kind: "create" });
  });

  it("several matches → picker where one can mount (duplicates stay visible)", () => {
    const dupes = [match("Jane Doe", "1"), match("Jane Doe", "2")];
    expect(matchGateVerdict("Jane", dupes, PICKABLE)).toEqual({ kind: "pick", matches: dupes });
  });

  it("several matches with no picker → adopt the top only when its name agrees", () => {
    const dupes = [match("Jane Doe", "1"), match("Jane Doe", "2")];
    expect(matchGateVerdict("Jane", dupes, NO_PICKER)).toEqual({
      kind: "attach",
      match: dupes[0],
    });
    const foreign = [match("Sam Doe", "1"), match("Pat Doe", "2")];
    expect(matchGateVerdict("Jane", foreign, NO_PICKER)).toEqual({ kind: "create" });
  });
});

describe("matchGateKey", () => {
  it("normalizes case and whitespace so retypes hit the cache", () => {
    expect(matchGateKey(" Jane", "DOE ", "2001-03-14")).toBe("jane|doe|2001-03-14");
  });
});
