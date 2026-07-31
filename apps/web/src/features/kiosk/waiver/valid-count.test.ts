import { describe, expect, it } from "vitest";
import { pendingRegisteredCount, unionValidWithJoins } from "./valid-count";

const reg = (personId: string, displayName: string) => ({ personId, displayName });

describe("pendingRegisteredCount (the /kiosk/waiver 'still pending' banner)", () => {
  it("walk-in joins never subtract from pending (4 registered, none signed, 3 walk-ups)", () => {
    const registered = [
      reg("1", "Ann A."),
      reg("2", "Bob B."),
      reg("3", "Cid C."),
      reg("4", "Dee D."),
    ];
    const joins = [reg("90", "Wal K."), reg("91", "Wal L."), reg("92", "Wal M.")];
    // The union-length arithmetic this replaces reported 4 - 7 = -3 → banner hidden.
    expect(pendingRegisteredCount(registered, [false, false, false, false], joins)).toBe(4);
  });

  it("never goes negative (1 registered, 3 walk-in joins)", () => {
    const registered = [reg("1", "Ann A.")];
    const joins = [reg("90", "Wal K."), reg("91", "Wal L."), reg("92", "Wal M.")];
    expect(pendingRegisteredCount(registered, [false], joins)).toBe(1);
  });

  it("a join matching a registered person DOES cover them (id, then name — the union's rule)", () => {
    const registered = [reg("1", "Ann A."), reg("17600000000000001", "Bob B.")];
    // Ann joined under her own id; Bob joined under his SHORT Pandora id, so only
    // his display name matches the 17-digit registration row.
    const joins = [reg("1", "Ann A."), reg("555", "Bob B.")];
    expect(pendingRegisteredCount(registered, [false, false], joins)).toBe(0);
  });

  it("Pandora-valid registered people are not pending", () => {
    const registered = [reg("1", "Ann A."), reg("2", "Bob B.")];
    expect(pendingRegisteredCount(registered, [true, false], [])).toBe(1);
  });

  it("agrees with the union on a mixed booking", () => {
    // 3 registered: Ann valid via Pandora, Bob covered by a join, Cid unsigned.
    // Plus one walk-in. Union = Ann + Bob's join + walk-in; pending = Cid alone.
    const registered = [reg("1", "Ann A."), reg("2", "Bob B."), reg("3", "Cid C.")];
    const joins = [reg("2", "Bob B."), reg("90", "Wal K.")];
    const flags = [true, false, false];
    expect(unionValidWithJoins(registered, flags, joins)).toHaveLength(3);
    expect(pendingRegisteredCount(registered, flags, joins)).toBe(1);
  });
});
