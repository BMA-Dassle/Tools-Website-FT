import { describe, it, expect } from "vitest";
import {
  KBF_GAMES_PER_SESSION,
  KBF_VIP_PER_GAME_CENTS,
  KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS,
  kbfAdultPerGameCents,
  kbfAdultGamesTotalCents,
  kbfVipUpchargeTotalCents,
  isFridayYmd,
  buildKbfExtraSquareLineItems,
  KBF_VIP_CATALOG,
  FBF_VIP_CATALOG,
} from "./kbf-pricing";

describe("kbf-pricing — shared by display + charge", () => {
  it("VIP lane upcharge is $2/person ($1/game × 2 games)", () => {
    expect(KBF_GAMES_PER_SESSION).toBe(2);
    expect(KBF_VIP_PER_GAME_CENTS).toBe(100);
    expect(KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS).toBe(200);
  });

  it("adult per-game: $5 base, +$1 VIP, +$1 Friday", () => {
    expect(kbfAdultPerGameCents(false, false)).toBe(500); // Mon–Thu
    expect(kbfAdultPerGameCents(true, false)).toBe(600); // Mon–Thu VIP
    expect(kbfAdultPerGameCents(false, true)).toBe(600); // Fri
    expect(kbfAdultPerGameCents(true, true)).toBe(700); // Fri VIP
  });

  it("adult games total = count × per-game × 2 games", () => {
    expect(kbfAdultGamesTotalCents(1, false, false)).toBe(1000); // 1 adult, $5×2
    expect(kbfAdultGamesTotalCents(2, true, true)).toBe(2800); // 2 adults, $7×2
    expect(kbfAdultGamesTotalCents(0, true, true)).toBe(0);
  });

  it("VIP upcharge total = free bowlers × $2; zero when not VIP", () => {
    expect(kbfVipUpchargeTotalCents(3, true)).toBe(600); // 3 free bowlers × $2
    expect(kbfVipUpchargeTotalCents(3, false)).toBe(0);
    expect(kbfVipUpchargeTotalCents(0, true)).toBe(0);
  });

  it("isFridayYmd detects Friday from YYYY-MM-DD", () => {
    expect(isFridayYmd("2026-06-12")).toBe(true); // a Friday
    expect(isFridayYmd("2026-06-13")).toBe(false); // Saturday
  });
});

describe("buildKbfExtraSquareLineItems — shared by /quote (display) + reserve (charge)", () => {
  it("non-VIP with only free kids → no extra lines", () => {
    expect(
      buildKbfExtraSquareLineItems({
        isVip: false,
        isFriday: false,
        kbfKidCount: 3,
        fbfAdultCount: 0,
        paidAdultCount: 0,
      }),
    ).toEqual([]);
  });

  it("VIP, 3 free kids → one Kids Bowl Free VIP line at $2 each", () => {
    const lines = buildKbfExtraSquareLineItems({
      isVip: true,
      isFriday: false,
      kbfKidCount: 3,
      fbfAdultCount: 0,
      paidAdultCount: 0,
    });
    expect(lines).toEqual([
      {
        name: "Kids Bowl Free VIP",
        quantity: "3",
        basePriceMoney: { amount: 200, currency: "USD" },
        catalogObjectId: KBF_VIP_CATALOG,
      },
    ]);
  });

  it("VIP Friday with kids + FBF adult + paid adult → adult-game + both VIP lines", () => {
    const lines = buildKbfExtraSquareLineItems({
      isVip: true,
      isFriday: true,
      kbfKidCount: 2,
      fbfAdultCount: 1,
      paidAdultCount: 1,
    });
    // paid adult: 1 adult × 2 games at $7 (VIP Fri); VIP lane: 2 kids + 1 FBF adult at $2
    expect(lines).toEqual([
      {
        name: "Adult Game Fri-Sun VIP",
        quantity: "2",
        basePriceMoney: { amount: 700, currency: "USD" },
        catalogObjectId: expect.any(String),
      },
      {
        name: "Kids Bowl Free VIP",
        quantity: "2",
        basePriceMoney: { amount: 200, currency: "USD" },
        catalogObjectId: KBF_VIP_CATALOG,
      },
      {
        name: "Families Bowl Free VIP",
        quantity: "1",
        basePriceMoney: { amount: 200, currency: "USD" },
        catalogObjectId: FBF_VIP_CATALOG,
      },
    ]);
  });

  it("non-VIP Mon–Thu with 2 paid adults → one adult-game line, no VIP", () => {
    const lines = buildKbfExtraSquareLineItems({
      isVip: false,
      isFriday: false,
      kbfKidCount: 1,
      fbfAdultCount: 0,
      paidAdultCount: 2,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      name: "Adult Game Mon-Thur",
      quantity: "4", // 2 adults × 2 games
      basePriceMoney: { amount: 500, currency: "USD" },
    });
  });
});
