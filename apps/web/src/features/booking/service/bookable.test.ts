import { describe, expect, it } from "vitest";
import {
  describeDroppedLeg,
  isBookableBowlingLeg,
  partitionBookableLegs,
  unbookableReason,
} from "./bookable";
import { newItem } from "../state/types";
import type { BowlingItem, KbfItem } from "../state/types";

function bowling(patch: Partial<BowlingItem> = {}): BowlingItem {
  return { ...(newItem("bowling") as BowlingItem), ...patch };
}
function kbf(patch: Partial<KbfItem> = {}): KbfItem {
  return { ...(newItem("kbf") as KbfItem), ...patch };
}

describe("unbookableReason", () => {
  it("the 2026-07-28 phantom: a pristine duckpin draft is no-slot", () => {
    // Exactly what bookingrecord:63000000006468566 carried — tile tapped, Back
    // pressed, nothing configured. playerCount/laneCount are newItem defaults.
    const phantom = bowling({ date: "2026-07-28", variant: "hourly", isDuckpin: true });
    expect(phantom.bookedAt).toBeNull();
    expect(phantom.webOfferId).toBeNull();
    expect(phantom.qamfReservationId).toBeNull();
    expect(unbookableReason(phantom)).toBe("no-slot");
    expect(isBookableBowlingLeg(phantom)).toBe(false);
  });

  it("a picked slot (time + offer) is bookable", () => {
    expect(
      unbookableReason(bowling({ bookedAt: "2026-07-28T18:00:00-04:00", webOfferId: 5 })),
    ).toBeNull();
  });

  it("a live hold is bookable even with no time or offer on the item", () => {
    // Hold-first confirm: the hold already carries the slot and the offer.
    expect(unbookableReason(bowling({ qamfReservationId: "X3040" }))).toBeNull();
  });

  it("webOfferId 0 counts as absent — the exact value the old fallback sent", () => {
    expect(
      unbookableReason(bowling({ bookedAt: "2026-07-28T18:00:00-04:00", webOfferId: 0 })),
    ).toBe("no-offer");
  });

  it("distinguishes a missing time from a missing offer", () => {
    expect(unbookableReason(bowling({ webOfferId: 5 }))).toBe("no-time");
    expect(unbookableReason(bowling({ bookedAt: "2026-07-28T18:00:00-04:00" }))).toBe("no-offer");
  });

  it("an empty-string bookedAt is not a time", () => {
    expect(unbookableReason(bowling({ bookedAt: "", webOfferId: 5 }))).toBe("no-time");
  });

  it("applies to KBF items too (same BowlingCommon slot fields)", () => {
    expect(unbookableReason(kbf())).toBe("no-slot");
    expect(
      unbookableReason(kbf({ bookedAt: "2026-07-28T10:00:00-04:00", webOfferId: 152 })),
    ).toBeNull();
  });
});

describe("partitionBookableLegs", () => {
  it("keeps bookable legs in order and reports each dropped leg with its reason", () => {
    const good = bowling({ id: "a", bookedAt: "2026-07-28T18:00:00-04:00", webOfferId: 5 });
    const phantom = bowling({ id: "b", isDuckpin: true });
    const held = bowling({ id: "c", qamfReservationId: "X3041" });
    const { bookable, dropped } = partitionBookableLegs([good, phantom, held]);
    expect(bookable.map((i) => i.id)).toEqual(["a", "c"]);
    expect(dropped).toEqual([{ item: phantom, reason: "no-slot" }]);
  });

  it("an all-bookable cart drops nothing", () => {
    const { bookable, dropped } = partitionBookableLegs([
      bowling({ bookedAt: "2026-07-28T18:00:00-04:00", webOfferId: 5 }),
    ]);
    expect(bookable).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it("an empty cart is not an error", () => {
    expect(partitionBookableLegs([])).toEqual({ bookable: [], dropped: [] });
  });
});

describe("describeDroppedLeg", () => {
  it("names the duckpin marker and every field that decided the drop", () => {
    const line = describeDroppedLeg(
      bowling({ id: "b", date: "2026-07-28", isDuckpin: true, qamfCenterId: 11542 }),
      "no-slot",
    );
    expect(line).toContain("bowling duckpin");
    expect(line).toContain("reason=no-slot");
    expect(line).toContain("bookedAt=-");
    expect(line).toContain("webOfferId=-");
    expect(line).toContain("center=11542");
  });
});
