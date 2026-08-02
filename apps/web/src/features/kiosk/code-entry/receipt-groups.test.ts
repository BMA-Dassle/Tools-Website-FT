import { describe, expect, it } from "vitest";
import {
  ghostCartGroups,
  ghostGzGroups,
  groupCartLegs,
  groupGzCards,
  groupUsedLegs,
  type UnspentItem,
} from "./receipt-groups";

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

describe("ghost rows (stepped to zero stays visible as 0 of M)", () => {
  const UNSPENT: Record<string, UnspentItem[]> = {
    HPWA: [
      { index: 0, redeemVia: "cart", label: "Laser Tag comp", coverageName: "Laser Tag" },
      { index: 1, redeemVia: "cart", label: "Laser Tag comp", coverageName: "Laser Tag" },
      { index: 2, redeemVia: "cart", label: "Shuffly comp", coverageName: "Shuffly" },
      { index: 3, redeemVia: "gamezone", label: "100 bonus tokens", tokens: 100 },
    ],
  };

  it("ghostCartGroups: a kind with zero applied legs becomes one qty-0 row; applied kinds don't", () => {
    const out = ghostCartGroups(UNSPENT, [
      { code: "HPWA", label: "Laser Tag comp", name: "Laser Tag", itemIndex: 0 },
    ]);
    expect(out).toEqual([
      {
        code: "HPWA",
        label: "Shuffly comp",
        name: "Shuffly",
        error: null,
        itemIndexes: [],
        qty: 0,
        native: true,
      },
    ]);
    expect(ghostCartGroups(UNSPENT, [])).toHaveLength(2); // both kinds ghost, deduped per kind
  });

  it("ghostGzGroups: unspent gz legs with nothing pending ghost at qty 0; pending suppresses", () => {
    expect(ghostGzGroups(UNSPENT, [])).toEqual([{ code: "HPWA", tokens: 100, qty: 0 }]);
    expect(ghostGzGroups(UNSPENT, [{ code: "HPWA", tokens: 100 }])).toEqual([]);
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
