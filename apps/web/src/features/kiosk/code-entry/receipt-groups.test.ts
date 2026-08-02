import { describe, expect, it } from "vitest";
import { groupCartLegs, groupGzCards, groupUsedLegs } from "./receipt-groups";

describe("groupCartLegs", () => {
  it("collapses identical native legs into one qty row with sorted indexes", () => {
    const legs = [3, 1, 2].map((itemIndex) => ({
      code: "HPWAAAAAAAA",
      label: "Laser Tag / Gel Blaster comp",
      name: "Laser Tag / Gel Blaster",
      itemIndex,
    }));
    const out = groupCartLegs(legs);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ qty: 3, native: true, itemIndexes: [1, 2, 3] });
  });

  it("keeps different labels, errored legs, and BMI rows as separate rows", () => {
    const out = groupCartLegs([
      { code: "HPWA", label: "Laser Tag comp", itemIndex: 0 },
      { code: "HPWA", label: "Shuffly comp", itemIndex: 1 },
      { code: "HPWA", label: "Laser Tag comp", itemIndex: 2, error: "conflict" },
      { code: "B2C2D2E2F2G2H2J2K2M2N2P2", label: "Comp Game Card", itemIndex: null },
    ]);
    expect(out).toHaveLength(4);
    expect(out.filter((g) => g.native)).toHaveLength(3);
    expect(out.find((g) => g.error)?.qty).toBe(1);
    expect(out.find((g) => !g.native)?.itemIndexes).toEqual([]);
  });

  it("groups per code — two vouchers with the same label stay separate rows", () => {
    const out = groupCartLegs([
      { code: "HPWA", label: "Laser Tag comp", itemIndex: 0 },
      { code: "HPWB", label: "Laser Tag comp", itemIndex: 0 },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("groupUsedLegs", () => {
  it("collapses used legs by code+label", () => {
    const out = groupUsedLegs({
      HPWA: [
        { index: 0, label: "100 bonus tokens" },
        { index: 1, label: "100 bonus tokens" },
        { index: 5, label: "Shuffly comp" },
      ],
    });
    expect(out).toEqual([
      { code: "HPWA", label: "100 bonus tokens", qty: 2 },
      { code: "HPWA", label: "Shuffly comp", qty: 1 },
    ]);
  });
});

describe("groupGzCards", () => {
  it("collapses by code + token value", () => {
    const out = groupGzCards([
      { code: "HPWA", tokens: 100 },
      { code: "HPWA", tokens: 100 },
      { code: "HPWA", tokens: 250 },
      { code: "HPWB", tokens: 100 },
    ]);
    expect(out).toEqual([
      { code: "HPWA", tokens: 100, qty: 2 },
      { code: "HPWA", tokens: 250, qty: 1 },
      { code: "HPWB", tokens: 100, qty: 1 },
    ]);
  });
});
