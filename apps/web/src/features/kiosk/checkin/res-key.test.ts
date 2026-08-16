import { describe, expect, it } from "vitest";
import {
  bowlIdFromKey,
  isBowlKey,
  isHpBowlingCenterCode,
  isKioskBowlingRow,
  makeBowlKey,
} from "./res-key";

describe("bowl keys", () => {
  it("round-trips a Neon id", () => {
    const key = makeBowlKey(4821);
    expect(isBowlKey(key)).toBe(true);
    expect(bowlIdFromKey(key)).toBe(4821);
  });

  it("a bare billId is not a bowl key", () => {
    expect(isBowlKey("31415926535897932")).toBe(false);
    expect(bowlIdFromKey("31415926535897932")).toBeNull();
  });

  it("rejects malformed bowl keys instead of guessing", () => {
    expect(bowlIdFromKey("bowl:")).toBeNull();
    expect(bowlIdFromKey("bowl:abc")).toBeNull();
    expect(bowlIdFromKey("bowl:-3")).toBeNull();
    expect(bowlIdFromKey("bowl:1.5")).toBeNull();
  });
});

describe("HP bowling gating (owner rule: never at FastTrax)", () => {
  it("accepts the two HeadPinz centers", () => {
    expect(isHpBowlingCenterCode("TXBSQN0FEKQ11")).toBe(true); // HPFM
    expect(isHpBowlingCenterCode("PPTR5G2N0QXF7")).toBe(true); // HPN
  });

  it("rejects FastTrax duckpin and junk", () => {
    expect(isHpBowlingCenterCode("LAB52GY480CJF")).toBe(false); // FT duckpin
    expect(isHpBowlingCenterCode("fort-myers")).toBe(false); // v2 slug namespace
    expect(isHpBowlingCenterCode(null)).toBe(false);
    expect(isHpBowlingCenterCode(undefined)).toBe(false);
  });

  it("isKioskBowlingRow: open/kbf at HP only — race, attraction, duckpin never", () => {
    expect(isKioskBowlingRow({ productKind: "open", centerCode: "TXBSQN0FEKQ11" })).toBe(true);
    expect(isKioskBowlingRow({ productKind: "kbf", centerCode: "PPTR5G2N0QXF7" })).toBe(true);
    // FT duckpin is an "open" bowling row at the FastTrax center — excluded.
    expect(isKioskBowlingRow({ productKind: "open", centerCode: "LAB52GY480CJF" })).toBe(false);
    expect(isKioskBowlingRow({ productKind: "race", centerCode: "TXBSQN0FEKQ11" })).toBe(false);
    expect(isKioskBowlingRow({ productKind: "attraction", centerCode: "TXBSQN0FEKQ11" })).toBe(
      false,
    );
    expect(isKioskBowlingRow({})).toBe(false);
  });
});
