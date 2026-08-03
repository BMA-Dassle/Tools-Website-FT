import { describe, expect, it } from "vitest";
import {
  COUNTDOWN_THRESHOLD_MS,
  formatCountdown,
  formatDealDeadline,
  formatDealDeadlineShort,
  money,
  offerFinePrint,
} from "./format";

describe("formatDealDeadline", () => {
  it("names the day we advertised, in Eastern time", () => {
    expect(formatDealDeadline("2026-09-07T23:59:59-04:00")).toBe("Monday, September 7");
    expect(formatDealDeadlineShort("2026-09-07T23:59:59-04:00")).toBe("Sep 7");
  });

  it("formats in ET even when the instant is late-evening UTC-shifted", () => {
    // 2026-09-07T23:59:59-04:00 is 2026-09-08T03:59:59Z. A formatter that fell
    // back to UTC would advertise the sale as ending on the 8th.
    expect(formatDealDeadline("2026-09-08T03:59:59Z")).toBe("Monday, September 7");
  });

  it("handles a winter deadline on the other side of DST", () => {
    expect(formatDealDeadline("2026-01-31T23:59:59-05:00")).toBe("Saturday, January 31");
  });
});

describe("formatCountdown", () => {
  it("shows days and hours above a day", () => {
    expect(formatCountdown(30 * 3600 * 1000)).toBe("1d 6h");
  });

  it("shows hours and minutes above an hour", () => {
    expect(formatCountdown(2 * 3600 * 1000 + 14 * 60 * 1000)).toBe("2h 14m");
  });

  it("shows zero-padded seconds only in the last hour", () => {
    expect(formatCountdown(48 * 60 * 1000 + 7 * 1000)).toBe("48m 07s");
    expect(formatCountdown(9 * 1000)).toBe("0m 09s");
  });

  it("returns null once time is up, so nothing renders 0m 00s", () => {
    expect(formatCountdown(0)).toBeNull();
    expect(formatCountdown(-5000)).toBeNull();
  });

  it("switches to a clock two days out", () => {
    expect(COUNTDOWN_THRESHOLD_MS).toBe(172_800_000);
  });
});

describe("offerFinePrint", () => {
  const live = {
    isOfferLive: true,
    unitPriceCents: 3400,
    bonusLabel: "50 bonus tokens per pack",
    endsAt: "2026-08-06T23:59:59-04:00",
    allocation: null as number | null,
  };

  it("says what ends, when, and that the price is not what changes", () => {
    expect(offerFinePrint(live)).toBe(
      "50 bonus tokens per pack is a limited-time extra, included through Thursday, August 6. " +
        "The pack price stays $34 — after the offer ends, the same pack simply no longer " +
        "includes the bonus.",
    );
  });

  it("only says 'whichever comes first' when there really are two limits", () => {
    expect(offerFinePrint({ ...live, allocation: 200 })).toContain(
      "through Thursday, August 6 or while the first 200 packs last, whichever comes first",
    );
    expect(offerFinePrint(live)).not.toContain("whichever comes first");
    expect(offerFinePrint({ ...live, endsAt: null, allocation: 200 })).not.toContain(
      "whichever comes first",
    );
  });

  it("never states or implies a price increase", () => {
    for (const variant of [live, { ...live, allocation: 200 }, { ...live, endsAt: null, allocation: 5 }]) {
      const text = offerFinePrint(variant)!;
      expect(text).toContain("The pack price stays $34");
      expect(text).not.toMatch(/regular price|goes up|after that it is \$/i);
    }
  });

  it("says nothing when no offer is running", () => {
    expect(offerFinePrint({ ...live, isOfferLive: false })).toBeNull();
    expect(offerFinePrint({ ...live, bonusLabel: null })).toBeNull();
  });
});

describe("money", () => {
  it("drops cents when they are zero and keeps them when they are not", () => {
    expect(money(3400)).toBe("$34");
    expect(money(3621)).toBe("$36.21");
    expect(money(4792)).toBe("$47.92");
  });
});
