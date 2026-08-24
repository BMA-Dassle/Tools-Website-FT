import { describe, expect, it } from "vitest";

import { emptySession, newItem } from "~/features/booking/state/types";

import { planComboEntry } from "./combo-entry";

const VIP = "race-bowl-v2";

function session(overrides: Partial<ReturnType<typeof emptySession>> = {}) {
  return { ...emptySession({ entryBrand: "fasttrax" }), ...overrides };
}

describe("planComboEntry", () => {
  it("seeds on a clean cart with nothing to release", () => {
    expect(planComboEntry(session(), VIP)).toEqual({ kind: "seed", release: [] });
  });

  it("resumes when the session already carries THIS combo", () => {
    const race = newItem("race");
    const bowling = newItem("bowling");
    const s = session({ comboSpecialId: VIP, items: [race, bowling], activeItemId: race.id });
    expect(planComboEntry(s, VIP)).toEqual({ kind: "resume" });
  });

  it("replaces a stale plain race cart (the vipexpissue.mp4 case)", () => {
    // /book/race/v2 seeds an empty race item the moment it opens; the guest then
    // clicked the VIP card. The old code left this item alone and showed the
    // race wizard under the VIP title.
    const race = newItem("race");
    const s = session({ items: [race], activeItemId: race.id });
    expect(planComboEntry(s, VIP)).toEqual({ kind: "seed", release: [race] });
  });

  it("replaces a cart copied from a bowling tab", () => {
    const bowling = newItem("bowling");
    const s = session({ items: [bowling], activeItemId: bowling.id });
    expect(planComboEntry(s, VIP)).toEqual({ kind: "seed", release: [bowling] });
  });

  it("replaces a DIFFERENT combo's session rather than resuming it", () => {
    const race = newItem("race");
    const bowling = newItem("bowling");
    const s = session({ comboSpecialId: "race-bowl", items: [race, bowling] });
    expect(planComboEntry(s, VIP)).toEqual({ kind: "seed", release: [race, bowling] });
  });

  it("re-seeds a combo id left behind with an emptied cart", () => {
    const s = session({ comboSpecialId: VIP, items: [] });
    expect(planComboEntry(s, VIP)).toEqual({ kind: "seed", release: [] });
  });
});
