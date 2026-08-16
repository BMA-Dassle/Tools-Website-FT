import { describe, it, expect } from "vitest";
import { partitionByCloudRoster } from "../bmi-cloud-roster";

/**
 * The decision half of the cloud-roster guard (2026-08-16 WSync FK jam).
 *
 * What must hold, in order of how badly getting it wrong would hurt:
 *  1. A racer the cloud no longer carries is held back — that is the jam.
 *  2. A racer identified by EITHER id form is kept — the same human is a short
 *     Pandora id or a 17-digit Office id depending on the minting rail, and
 *     matching only one form would hold back half the grid.
 *  3. A racer we cannot identify at all is KEPT — absence of evidence is not
 *     evidence of removal, and stranding a real racer is the worse failure.
 */
type R = { personId: string | null; altPersonId?: string | null; name: string };
const ids = (r: R) => [r.personId, r.altPersonId];

describe("partitionByCloudRoster", () => {
  it("holds back a racer the cloud roster no longer carries", () => {
    const racers: R[] = [
      { name: "on", personId: "111", altPersonId: null },
      { name: "removed", personId: "222", altPersonId: null },
    ];
    const { onRoster, offRoster } = partitionByCloudRoster(racers, new Set(["111"]), ids);
    expect(onRoster.map((r) => r.name)).toEqual(["on"]);
    expect(offRoster.map((r) => r.name)).toEqual(["removed"]);
  });

  it("keeps a racer whose roster row uses the OTHER id form (17-digit vs short)", () => {
    const racers: R[] = [
      { name: "short-posted", personId: "16153393", altPersonId: "63000000008534711" },
      { name: "office-posted", personId: "63000000008486055", altPersonId: "713365" },
    ];
    // Roster carries one under its Office id, the other under its short id.
    const roster = new Set(["63000000008534711", "713365"]);
    const { onRoster, offRoster } = partitionByCloudRoster(racers, roster, ids);
    expect(offRoster).toHaveLength(0);
    expect(onRoster).toHaveLength(2);
  });

  it("keeps a racer carrying no usable id — never invent a removal", () => {
    const racers: R[] = [{ name: "unknown", personId: null, altPersonId: null }];
    const { onRoster, offRoster } = partitionByCloudRoster(racers, new Set(["111"]), ids);
    expect(onRoster).toHaveLength(1);
    expect(offRoster).toHaveLength(0);
  });

  it("an EMPTY roster holds everyone back — the emptied-roster state W61030 was in", () => {
    const racers: R[] = [
      { name: "a", personId: "111" },
      { name: "b", personId: "222" },
    ];
    const { onRoster, offRoster } = partitionByCloudRoster(racers, new Set<string>(), ids);
    expect(onRoster).toHaveLength(0);
    expect(offRoster).toHaveLength(2);
  });

  it("trims whitespace before matching (roster ids arrive as raw JSON text)", () => {
    const racers: R[] = [{ name: "a", personId: " 111 " }];
    const { onRoster } = partitionByCloudRoster(racers, new Set(["111"]), ids);
    expect(onRoster).toHaveLength(1);
  });
});
