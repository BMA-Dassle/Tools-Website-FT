import { describe, expect, it } from "vitest";
import { ALL_REPS, REPS, makeRep } from "./test-support";
import {
  CENTER_KEY_TO_CENTRE,
  plannerOptions,
  plannerStillOffered,
  plannersForCenterKey,
  requestedPlannerLabel,
} from "./planners";

describe("plannerOptions", () => {
  it("offers people, never the Guest Services bucket, the hold row or a director", () => {
    const slugs = plannerOptions(ALL_REPS).map((p) => p.slug);
    expect(slugs).toEqual(["kelsea", "lori", "stephanie"]);
    expect(slugs).not.toContain("gs");
    expect(slugs).not.toContain("mkt");
    expect(slugs).not.toContain("jacob");
  });

  it("drops a planner who has left the roster", () => {
    const reps = [...ALL_REPS, makeRep({ id: "99", slug: "gone", active: false })];
    expect(plannerOptions(reps).map((p) => p.slug)).not.toContain("gone");
  });

  it("drops a rep who covers no centre", () => {
    const reps = [...ALL_REPS, makeRep({ id: "98", slug: "nowhere", centres: [] })];
    expect(plannerOptions(reps).map((p) => p.slug)).not.toContain("nowhere");
  });

  it("exposes a first name and centres and NOTHING else a guest may not see", () => {
    for (const p of plannerOptions(ALL_REPS)) {
      expect(Object.keys(p).sort()).toEqual(["centres", "firstName", "slug"]);
      expect(JSON.stringify(p)).not.toContain("@headpinz.com");
    }
    // The Office username (Pandora's `agent` substring) never leaves the server.
    expect(JSON.stringify(plannerOptions(ALL_REPS))).not.toContain(REPS.kelsea.bmiUsername!);
  });

  it("keeps roster order", () => {
    const shuffled = [REPS.stephanie, REPS.kelsea, REPS.lori];
    expect(plannerOptions(shuffled).map((p) => p.firstName)).toEqual([
      "Kelsea",
      "Lori",
      "Stephanie",
    ]);
  });
});

describe("plannersForCenterKey", () => {
  const options = plannerOptions(ALL_REPS);

  it("a Naples enquiry cannot request a Fort Myers planner", () => {
    expect(plannersForCenterKey(options, "headpinz-naples").map((p) => p.slug)).toEqual([
      "stephanie",
    ]);
  });

  it("FastTrax offers the planners who cover it", () => {
    expect(plannersForCenterKey(options, "fasttrax-ft-myers").map((p) => p.slug)).toEqual([
      "kelsea",
    ]);
  });

  it("HeadPinz Fort Myers offers both of its planners", () => {
    expect(plannersForCenterKey(options, "headpinz-ft-myers").map((p) => p.slug)).toEqual([
      "kelsea",
      "lori",
    ]);
  });

  it("an unknown centerKey offers nobody rather than everybody", () => {
    expect(plannersForCenterKey(options, "somewhere-else")).toEqual([]);
  });

  it("maps every centerKey the form can send", () => {
    expect(CENTER_KEY_TO_CENTRE).toEqual({
      "fasttrax-ft-myers": "FT",
      "headpinz-ft-myers": "HPFM",
      "headpinz-naples": "HPN",
    });
  });
});

describe("plannerStillOffered", () => {
  const options = plannerOptions(ALL_REPS);

  it("clears a pick that the new centre does not offer", () => {
    expect(plannerStillOffered(options, "headpinz-ft-myers", "lori")).toBe(true);
    expect(plannerStillOffered(options, "headpinz-naples", "lori")).toBe(false);
  });

  it("'First available' (the empty value) is always offered", () => {
    expect(plannerStillOffered(options, "headpinz-naples", "")).toBe(true);
  });
});

describe("requestedPlannerLabel", () => {
  it("is the owner's wording", () => {
    expect(requestedPlannerLabel("Kelsea")).toBe("Guest asked for Kelsea");
  });
});
