import { describe, it, expect } from "vitest";
import { findHeadsockCredit } from "../../app/api/admin/checkin/route";

describe("findHeadsockCredit", () => {
  it("detects headsock credit with matching deposit kind ID", () => {
    const result = findHeadsockCredit([
      { OUT_DPK_ID: 48069703, OUT_DPK_NAME: "Credit - Headsock", OUT_DPS_AMOUNT: 2 },
    ]);
    expect(result).toEqual({ depositKindId: "48069703", balance: 2 });
  });

  it("returns null when balance is 0", () => {
    const result = findHeadsockCredit([
      { OUT_DPK_ID: 48069703, OUT_DPK_NAME: "Credit - Headsock", OUT_DPS_AMOUNT: 0 },
    ]);
    expect(result).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(findHeadsockCredit([])).toBeNull();
  });

  it("returns null when no headsock row exists", () => {
    const result = findHeadsockCredit([
      { OUT_DPK_ID: 12744867, OUT_DPK_NAME: "Credit - Race Weekday", OUT_DPS_AMOUNT: 3 },
    ]);
    expect(result).toBeNull();
  });

  it("finds headsock among multiple deposit kinds", () => {
    const result = findHeadsockCredit([
      { OUT_DPK_ID: 12744867, OUT_DPK_NAME: "Credit - Race Weekday", OUT_DPS_AMOUNT: 3 },
      { OUT_DPK_ID: 48069703, OUT_DPK_NAME: "Credit - Headsock", OUT_DPS_AMOUNT: 1 },
      { OUT_DPK_ID: 46322806, OUT_DPK_NAME: "Credit - Viewpoint", OUT_DPS_AMOUNT: 0 },
    ]);
    expect(result).toEqual({ depositKindId: "48069703", balance: 1 });
  });
});
