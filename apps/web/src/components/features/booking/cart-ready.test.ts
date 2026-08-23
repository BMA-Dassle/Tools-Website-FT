/**
 * The cart's checkout gate. Race and attraction items were always gated; bowling
 * and KBF returned a hardcoded `true`, which is how an unconfigured duckpin leg
 * reached the pay screen on 2026-07-28 and 400'd QAMF after the card was
 * captured. These cases pin the gate closed.
 */
import { describe, expect, it } from "vitest";
import { allItemsReady, firstUnreadyItem } from "./CartView";
import { newItem } from "~/features/booking";
import type { BookingSession, BowlingItem, RaceItem, SessionItem } from "~/features/booking";

function session(items: SessionItem[]): BookingSession {
  return {
    items,
    party: [],
    cursors: {},
    activeItemId: null,
    contact: {},
    center: "fort-myers",
    entryBrand: "fasttrax",
  } as unknown as BookingSession;
}

function bowling(patch: Partial<BowlingItem> = {}): BowlingItem {
  return { ...(newItem("bowling") as BowlingItem), ...patch };
}
function race(patch: Partial<RaceItem> = {}): RaceItem {
  return { ...(newItem("race") as RaceItem), ...patch };
}
const bookedRace = () =>
  race({
    heats: [
      {
        productId: "24965505",
        track: "Mega",
        tier: "starter",
        category: "adult",
        heatId: "2026-07-28T14:00:00",
        bmiLineId: null,
        assignedTo: "m1",
      },
    ],
  } as Partial<RaceItem>);

describe("allItemsReady — bowling", () => {
  it("blocks checkout on an unconfigured bowling leg (the 2026-07-28 phantom)", () => {
    expect(allItemsReady(session([bowling({ isDuckpin: true, date: "2026-07-28" })]))).toBe(false);
  });

  it("blocks a mixed cart when only the bowling leg is unconfigured", () => {
    // Exactly Paul Chung's cart: a bookable race + a phantom duckpin.
    const cart = session([bookedRace(), bowling({ isDuckpin: true, date: "2026-07-28" })]);
    expect(allItemsReady(cart)).toBe(false);
    expect(firstUnreadyItem(cart)?.kind).toBe("bowling");
  });

  it("allows a picked slot (bookedAt + webOfferId)", () => {
    expect(
      allItemsReady(session([bowling({ bookedAt: "2026-07-28T18:00:00-04:00", webOfferId: 5 })])),
    ).toBe(true);
  });

  it("allows a live lane hold with no slot fields on the item", () => {
    expect(allItemsReady(session([bowling({ qamfReservationId: "X3040" })]))).toBe(true);
  });

  it("blocks a time with no offer, and an offer with no time", () => {
    expect(allItemsReady(session([bowling({ bookedAt: "2026-07-28T18:00:00-04:00" })]))).toBe(
      false,
    );
    expect(allItemsReady(session([bowling({ webOfferId: 5 })]))).toBe(false);
  });
});

describe("allItemsReady — unchanged for the other kinds", () => {
  it("a race with no picked heat is still not ready", () => {
    expect(allItemsReady(session([race()]))).toBe(false);
  });

  it("a race with a heat is ready", () => {
    expect(allItemsReady(session([bookedRace()]))).toBe(true);
  });

  it("an empty cart is vacuously ready (the button is hidden anyway)", () => {
    expect(allItemsReady(session([]))).toBe(true);
    expect(firstUnreadyItem(session([]))).toBeNull();
  });
});

describe("allItemsReady — racesim (placeholder phase)", () => {
  const sim = (patch: Partial<import("~/features/booking").RaceSimItem> = {}) => ({
    ...(newItem("racesim") as import("~/features/booking").RaceSimItem),
    ...patch,
  });

  it("blocks a fresh draft, and each half-configured state", () => {
    expect(allItemsReady(session([sim()]))).toBe(false);
    expect(allItemsReady(session([sim({ productSlug: "sim-single" })]))).toBe(false);
    expect(allItemsReady(session([sim({ trackKey: "a" })]))).toBe(false);
    expect(
      allItemsReady(session([sim({ productSlug: "sim-single", trackKey: "a", racerCount: 0 })])),
    ).toBe(false);
  });

  it("ready with product + track + racers, and surfaces as firstUnready otherwise", () => {
    expect(
      allItemsReady(session([sim({ productSlug: "sim-single", trackKey: "a", racerCount: 2 })])),
    ).toBe(true);
    const cart = session([bookedRace(), sim({ id: "rs1" })]);
    expect(firstUnreadyItem(cart)?.id).toBe("rs1");
  });
});

describe("firstUnreadyItem", () => {
  it("returns null when everything is ready", () => {
    expect(
      firstUnreadyItem(
        session([bookedRace(), bowling({ bookedAt: "2026-07-28T18:00:00-04:00", webOfferId: 5 })]),
      ),
    ).toBeNull();
  });

  it("returns the first unready item in cart order", () => {
    const phantom = bowling({ id: "b1" });
    expect(firstUnreadyItem(session([phantom, race()]))?.id).toBe("b1");
  });
});
