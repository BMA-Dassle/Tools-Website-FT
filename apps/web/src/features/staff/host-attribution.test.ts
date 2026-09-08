import { describe, expect, it } from "vitest";

import { hostAttribution } from "./host-attribution";

/**
 * THE MODAL'S TRIGGER, pinned. Every one of these cases is a press a staff
 * member actually makes on a Saturday, and three of the five must NOT raise a
 * "change the assignment?" question — a modal that fires when there is nothing
 * to change is a modal staff learn to dismiss without reading.
 */
const ADA = { userId: 77, firstName: "Ada" };
const GRACE = { userId: 88, firstName: "Grace" };
const heldBy = (s: { userId: number; firstName: string }) => ({
  ...s,
  assignedAt: "2026-09-07T22:00:00.000Z",
});

describe("hostAttribution", () => {
  it("flags a press made against somebody else's group", () => {
    const a = hostAttribution(heldBy(ADA), GRACE);
    expect(a.hostConflict).toBe(true);
    expect(a.host).toMatchObject({ userId: 77, firstName: "Ada" });
    expect(a.acting).toEqual({ userId: 88, firstName: "Grace" });
  });

  it("does NOT flag the host pressing their own group", () => {
    expect(hostAttribution(heldBy(ADA), ADA).hostConflict).toBe(false);
  });

  it("does NOT flag an unattributed press — there is nobody to hand it to", () => {
    const a = hostAttribution(heldBy(ADA), null);
    expect(a.hostConflict).toBe(false);
    expect(a.acting).toBeNull();
    // The host still travels: the receipt says whose group it is either way.
    expect(a.host).toMatchObject({ firstName: "Ada" });
  });

  it("does NOT flag a group nobody holds — the claim just landed", () => {
    expect(hostAttribution(null, GRACE).hostConflict).toBe(false);
    expect(hostAttribution(undefined, GRACE).host).toBeNull();
  });

  it("does NOT flag when neither side is known", () => {
    expect(hostAttribution(null, null)).toEqual({ host: null, acting: null, hostConflict: false });
  });

  it("compares user ids, never first names — two Adas are two people", () => {
    const otherAda = { userId: 99, firstName: "Ada" };
    expect(hostAttribution(heldBy(ADA), otherAda).hostConflict).toBe(true);
  });

  it("never lets a last name or a punch ID reach a wall tablet", () => {
    const full = { userId: 88, punchId: "555", firstName: "Grace", lastName: "Hopper" };
    expect(hostAttribution(heldBy(ADA), full).acting).toEqual({ userId: 88, firstName: "Grace" });
  });

  /**
   * "Play it again" (owner 2026-09-07). The press that must stay quiet: it does
   * not take the group, so it must not ask to.
   */
  it("never flags a non-claiming press, however wrong the name looks", () => {
    const a = hostAttribution(heldBy(ADA), GRACE, { claims: false });
    expect(a.hostConflict).toBe(false);
    // The names still travel — the receipt says whose group it is.
    expect(a.host).toMatchObject({ firstName: "Ada" });
    expect(a.acting).toEqual({ userId: 88, firstName: "Grace" });
  });

  it("claims by default — every action but restart", () => {
    expect(hostAttribution(heldBy(ADA), GRACE, {}).hostConflict).toBe(true);
    expect(hostAttribution(heldBy(ADA), GRACE, { claims: true }).hostConflict).toBe(true);
  });
});
