import { describe, expect, it } from "vitest";
import { pickFirstSlot, slotLabel, slotStartMs, todayYmd } from "./first-available";

const now = slotStartMs("2026-07-17T16:00:00");

describe("pickFirstSlot", () => {
  const slots = [
    { start: "2026-07-17T15:30:00", freeSpots: 6 }, // past
    { start: "2026-07-17T16:15:00", freeSpots: 1 }, // capacity short for qty 2
    { start: "2026-07-17T16:30:00", freeSpots: 4 },
    { start: "2026-07-17T17:00:00", freeSpots: 8 },
  ];

  it("skips past + under-capacity slots, no artificial lead time (ASAP)", () => {
    expect(pickFirstSlot(slots, { nowMs: now, quantity: 2 })?.start).toBe("2026-07-17T16:30:00");
  });

  it("qty 1 can take the tight slot", () => {
    expect(pickFirstSlot(slots, { nowMs: now, quantity: 1 })?.start).toBe("2026-07-17T16:15:00");
  });

  it("honors the blocked predicate (cart conflicts / restriction rules)", () => {
    const pick = pickFirstSlot(slots, {
      nowMs: now,
      quantity: 2,
      blocked: (s) => s === "2026-07-17T16:30:00",
    });
    expect(pick?.start).toBe("2026-07-17T17:00:00");
  });

  it("returns null when nothing qualifies", () => {
    expect(
      pickFirstSlot(slots, { nowMs: slotStartMs("2026-07-17T22:00:00"), quantity: 2 }),
    ).toBeNull();
  });

  it("sorts unordered input", () => {
    const shuffled = [slots[3], slots[0], slots[2], slots[1]];
    expect(pickFirstSlot(shuffled, { nowMs: now, quantity: 2 })?.start).toBe("2026-07-17T16:30:00");
  });
});

describe("labels", () => {
  it("formats slot labels", () => {
    expect(slotLabel("2026-07-17T16:15:00")).toBe("4:15 PM");
  });
  it("formats today's ymd", () => {
    expect(todayYmd(new Date(2026, 6, 17, 9, 0, 0))).toBe("2026-07-17");
  });
});
