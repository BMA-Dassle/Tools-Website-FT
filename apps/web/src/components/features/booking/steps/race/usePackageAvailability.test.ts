import { describe, expect, it } from "vitest";
import { getPackage, primaryTrack } from "~/features/booking/service/packages";
import { LICENSE_PRICE, POV_PRICE } from "~/features/booking/service/race-pricing";
import { livePerRacerPrice, packageBlockedToday } from "./usePackageAvailability";

const UQ = getPackage("ultimate-qualifier-weekday")!;
const ROOKIE = getPackage("rookie-pack-weekday")!;

describe("packageBlockedToday — the multi-race time gate", () => {
  it("no min-gap rule (single-race package) → never blocked", () => {
    expect(packageBlockedToday(ROOKIE, { starter: [] })).toBe(false);
  });

  it("heats not loaded yet (null) → not blocked", () => {
    expect(packageBlockedToday(UQ, null)).toBe(false);
  });

  it("no heats left for either leg → blocked", () => {
    expect(packageBlockedToday(UQ, { starter: [], intermediate: [] })).toBe(true);
    expect(
      packageBlockedToday(UQ, {
        starter: [{ start: "2026-08-12T20:00:00", stop: "2026-08-12T20:10:00" }],
        intermediate: [],
      }),
    ).toBe(true);
  });

  it("a pair that fits at the LOOSEST gap → not blocked", () => {
    expect(
      packageBlockedToday(UQ, {
        starter: [{ start: "2026-08-12T18:00:00", stop: "2026-08-12T18:10:00" }],
        intermediate: [{ start: "2026-08-12T19:30:00", stop: "2026-08-12T19:40:00" }],
      }),
    ).toBe(false);
  });

  it("only pairs tighter than the loosest gap remain → blocked", () => {
    expect(
      packageBlockedToday(UQ, {
        starter: [{ start: "2026-08-12T21:00:00", stop: "2026-08-12T21:10:00" }],
        intermediate: [{ start: "2026-08-12T21:20:00", stop: "2026-08-12T21:30:00" }],
      }),
    ).toBe(true);
  });
});

describe("livePerRacerPrice — one price math for card and pay-mode row", () => {
  it("live component price + bundled license/POV at the SHARED constants (not $5)", () => {
    expect(livePerRacerPrice(ROOKIE, { starter: 18.99 })).toBeCloseTo(
      18.99 + LICENSE_PRICE + POV_PRICE,
      2,
    );
  });

  it("a component missing from the live read falls back to its registry price", () => {
    const starterRegistry = primaryTrack(UQ.races[0]).price;
    const intermediateLive = 24.99;
    expect(livePerRacerPrice(UQ, { intermediate: intermediateLive })).toBeCloseTo(
      starterRegistry + intermediateLive + LICENSE_PRICE + POV_PRICE,
      2,
    );
  });
});
