import { describe, expect, it } from "vitest";
import blue0816 from "./__fixtures__/blue-heats-2026-08-16.json";
import blue0803 from "./__fixtures__/blue-heats-2026-08-03.json";
import {
  adjacencyIsOneSlot,
  gridFor,
  planTrackFences,
  slotForMinutes,
  startForSlot,
  type BmiSessionRow,
  type FencePlan,
} from "./junior-fence";

/**
 * Both fixtures are REAL `GET /bmi/sessions?resourceName=Blue Track` responses
 * captured 2026-08-16, not invented boards:
 *
 *  - 2026-08-16 — a Sunday (open 11:00) mid-service. Numbering offset 0. Carries
 *    the live fence "24 - Adult Only" we placed by hand, which has no junior
 *    beside it, so it is the `remove` case.
 *  - 2026-08-03 — the worst day for junior adjacency in the 30-day audit
 *    (22 junior-junior neighbour relationships). A Monday in the OLD hours era
 *    (open 13:00), numbering offset +10, and three session rows sharing the
 *    20:12 block. This is the ugly case the planner has to survive.
 */
const LIMIT = "Adult Only";

/** Far before either fixture day, so the lead-time cut never fires. */
const beforeDay = (date: string) => new Date(`${date}T00:00:00Z`).getTime() - 86_400_000;

function planFor(date: string, sessions: unknown, nowMs = beforeDay(date)): FencePlan {
  return planTrackFences("Blue", {
    date,
    sessions: sessions as BmiSessionRow[],
    limitName: LIMIT,
    nowMs,
  });
}

describe("grid", () => {
  it("places heat 1 at open and steps by the cadence", () => {
    // Sunday 2026-08-16 opens 11:00; Monday 2026-08-03 is the pre-8/10 era, 13:00.
    expect(startForSlot("2026-08-16", 1)).toBe("2026-08-16T11:00:00");
    expect(startForSlot("2026-08-16", 24)).toBe("2026-08-16T15:36:00");
    expect(startForSlot("2026-08-03", 1)).toBe("2026-08-03T13:00:00");
  });

  it("rejects an off-grid time rather than rounding it", () => {
    expect(slotForMinutes("2026-08-16", 11 * 60)).toBe(1);
    expect(slotForMinutes("2026-08-16", 11 * 60 + 12)).toBe(2);
    expect(slotForMinutes("2026-08-16", 11 * 60 + 7)).toBeNull(); // between slots
    expect(slotForMinutes("2026-08-16", 10 * 60)).toBeNull(); // before open
  });

  it("keeps the ±1-slot adjacency equivalent to the picker rule's gap", () => {
    // If the cadence ever changes without TRACK_ADJACENT_GAP_MIN following,
    // "one slot" stops meaning "within the gap" and this fails.
    expect(adjacencyIsOneSlot("Blue")).toBe(true);
    expect(adjacencyIsOneSlot("Mega")).toBe(true);
  });

  it("sizes the day from the hours registry, not a constant", () => {
    expect(gridFor("2026-08-16")).toEqual({ openMinutes: 660, slots: 60 }); // 11:00–23:00
    expect(gridFor("2026-08-03")).toEqual({ openMinutes: 780, slots: 50 }); // 13:00–23:00
  });
});

describe("2026-08-16 (live board, offset 0, carries a manual fence)", () => {
  const plan = planFor("2026-08-16", blue0816);

  it("parses every row — nothing silently dropped", () => {
    expect(plan.skipped).toEqual([]);
    expect(plan.placed).toHaveLength((blue0816 as unknown[]).length);
  });

  it("has a single consistent numbering offset of 0", () => {
    expect(plan.numberOffsets).toEqual([0]);
  });

  it("fences the one empty slot beside a junior heat", () => {
    // Junior heats sit at slots 3, 8, 10, 14, 16, 18. Every neighbour is
    // occupied except slot 2, which is empty and beside the 11:24 junior.
    expect(plan.add.map((t) => t.startLocal)).toEqual(["2026-08-16T11:12:00"]);
    expect(plan.add[0].becauseOf.map((b) => b.name)).toEqual(["3 - Blue Junior Starter"]);
    expect(plan.add[0].track).toBe("Blue");
  });

  it("flags the hand-placed fence at 15:36 for removal — no junior justifies it", () => {
    expect(plan.remove).toHaveLength(1);
    expect(plan.remove[0].startLocal).toBe("2026-08-16T15:36:00");
    expect(plan.remove[0].slot).toBe(24);
    expect(plan.remove[0].sessionId).toBe("58598953");
  });

  it("reports no back-to-back juniors on this board", () => {
    expect(plan.existingAdjacentJuniorSlots).toEqual([]);
  });

  it("never targets a slot that already has a booking", () => {
    const bookedSlots = plan.placed.filter((h) => !h.fenced).map((h) => h.slot);
    for (const t of plan.add) expect(bookedSlots).not.toContain(t.slot);
  });
});

describe("2026-08-03 (worst adjacency day, offset +10, duplicate rows)", () => {
  const plan = planFor("2026-08-03", blue0803);

  it("survives a numbering origin that is NOT the day's open", () => {
    // Heat "13 - Blue Junior Starter" sits at 13:24 = slot 3 on a 13:00 open.
    // One consistent offset across the whole day proves we never used the
    // number to locate a slot.
    expect(plan.numberOffsets).toEqual([10]);
    const first = plan.placed.find((h) => h.namedNumber === 13);
    expect(first?.slot).toBe(3);
    expect(first?.startLocal).toBe("2026-08-03T13:24:00");
  });

  it("collapses the three session rows sharing the 20:12 block", () => {
    const at2012 = plan.placed.filter((h) => h.startLocal === "2026-08-03T20:12:00");
    expect(at2012).toHaveLength(3);
    expect(plan.duplicateSlots).toContain(at2012[0].slot);
    // …and counts that block once when planning.
    expect(plan.add.filter((t) => t.slot === at2012[0].slot)).toHaveLength(0);
  });

  it("detects the back-to-back junior runs the picker rule never saw", () => {
    // 14:12 + 14:24 are consecutive Junior Starters — booked outside our
    // surfaces, which is the entire reason this feature exists.
    expect(plan.existingAdjacentJuniorSlots.length).toBeGreaterThan(0);
    const adjacentStarts = plan.existingAdjacentJuniorSlots.map((s) =>
      startForSlot("2026-08-03", s),
    );
    expect(adjacentStarts).toContain("2026-08-03T14:12:00");
    expect(adjacentStarts).toContain("2026-08-03T14:24:00");
  });

  it("fences 14:36 — the empty slot wedged against a junior heat", () => {
    expect(plan.add.map((t) => t.startLocal)).toContain("2026-08-03T14:36:00");
  });

  it("only ever proposes empty slots, each justified by a real junior heat", () => {
    const occupiedSlots = new Set(plan.placed.filter((h) => !h.fenced).map((h) => h.slot));
    const juniorSlots = new Set(plan.placed.filter((h) => h.junior).map((h) => h.slot));
    expect(plan.add.length).toBeGreaterThan(0);
    for (const t of plan.add) {
      expect(occupiedSlots.has(t.slot)).toBe(false);
      expect(t.becauseOf.length).toBeGreaterThan(0);
      // Every justification is genuinely one slot away.
      for (const b of t.becauseOf) {
        expect(juniorSlots.has(b.slot)).toBe(true);
        expect(Math.abs(b.slot - t.slot)).toBe(1);
      }
    }
  });

  it("proposes nothing at all once the day is over", () => {
    const dayAfter = new Date("2026-08-04T18:00:00Z").getTime();
    const stale = planFor("2026-08-03", blue0803, dayAfter);
    expect(stale.add).toEqual([]);
    // …but still reports what it saw, so a late run is not silently empty.
    expect(stale.existingAdjacentJuniorSlots.length).toBeGreaterThan(0);
  });
});

describe("same-day live behaviour", () => {
  it("skips slots that have already started or are inside the lead time", () => {
    // 14:00 ET on the 8/3 board = slot 6. With a 20-minute lead, slot 9 (14:36)
    // still qualifies; rewind the clock later and it drops out.
    const at1400 = new Date("2026-08-03T18:00:00Z").getTime(); // 14:00 EDT
    const early = planTrackFences("Blue", {
      date: "2026-08-03",
      sessions: blue0803 as BmiSessionRow[],
      limitName: LIMIT,
      nowMs: at1400,
      minLeadMinutes: 20,
    });
    expect(early.add.map((t) => t.startLocal)).toContain("2026-08-03T14:36:00");

    const at1425 = new Date("2026-08-03T18:25:00Z").getTime(); // 14:25 EDT
    const late = planTrackFences("Blue", {
      date: "2026-08-03",
      sessions: blue0803 as BmiSessionRow[],
      limitName: LIMIT,
      nowMs: at1425,
      minLeadMinutes: 20,
    });
    expect(late.add.map((t) => t.startLocal)).not.toContain("2026-08-03T14:36:00");
  });

  it("is idempotent — a slot already fenced moves to keep, not add", () => {
    const withFence = [
      ...(blue0816 as BmiSessionRow[]),
      {
        sessionId: "99999999",
        name: `2 - ${LIMIT}`,
        scheduledStart: "2026-08-16T15:12:00.000Z", // 11:12 EDT = slot 2
      },
    ];
    const plan = planFor("2026-08-16", withFence);
    expect(plan.add).toEqual([]);
    expect(plan.keep.map((t) => t.startLocal)).toEqual(["2026-08-16T11:12:00"]);
  });

  it("reads the limit name from config, not a literal — it was renamed 3× in one day", () => {
    // The same board planned against the OLD name no longer recognises the
    // fence, so it would be re-added rather than kept. Proves nothing hardcodes
    // "Adult Only".
    const plan = planTrackFences("Blue", {
      date: "2026-08-16",
      sessions: blue0816 as BmiSessionRow[],
      limitName: "Adult",
      nowMs: beforeDay("2026-08-16"),
    });
    expect(plan.remove).toEqual([]); // "24 - Adult Only" no longer reads as ours
    expect(plan.skipped.some((s) => s.name === "24 - Adult Only")).toBe(true);
  });
});
