/**
 * The prototype's own seeded lane grid, ported so the engine can be tested
 * against the acceptance spec instead of against a sentence copied out of it.
 *
 * `protoOccupancy` is `crm-data.js:426-438` line for line — the ONE deviation
 * is the day-of-week expression: the prototype wrote
 * `new Date(dateStr + "T12:00:00").getDay()`, which reads the RUNNER's zone;
 * here it is parsed as noon UTC and read with `getUTCDay()`, which is the same
 * weekday everywhere on earth and cannot make a CI box disagree with a
 * developer's laptop. Nothing else changed: same lanes, same hours, same
 * arithmetic, same labels.
 *
 * Tests build the fixture from this generator and DERIVE what they expect from
 * it (walk the free lanes themselves, then assert the engine agrees). No test
 * in this sub asserts a "Fits: lanes 13-22" string copied from the brief or the
 * mockup — that sentence is an output, not an input.
 *
 * Not a deliverable surface: nothing outside `*.test.ts` imports this file.
 */

import {
  LANE_SECTIONS,
  SLOT_MINUTES,
  mergeAdjacent,
  type LaneBlock,
  type LaneOccupancy,
  type OccupancyKind,
} from "./service/engine";

/** The prototype's slot list: 4:00 PM … 9:30 PM (`crm-data.js:425`). */
export const PROTO_SLOTS: number[] = Array.from(
  { length: 12 },
  (_, i) => 16 * 60 + i * SLOT_MINUTES,
);

export type ProtoKey = "HPFM" | "HPN";

/** `crm-data.js:426-438`, verbatim apart from the documented weekday read. */
export function protoOccupancy(
  lane: number,
  slotMin: number,
  key: ProtoKey = "HPFM",
  dateStr = "2026-10-17",
): { kind: OccupancyKind; label: string } | null {
  const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  const league = key === "HPN" ? [17, 24] : [13, 20];
  if (
    (dow === 2 || dow === 4) &&
    lane >= league[0] &&
    lane <= league[1] &&
    slotMin >= 18 * 60 + 30 &&
    slotMin < 21 * 60
  ) {
    return { kind: "league", label: dow === 2 ? "Tues Nite Mixed" : "Thursday Classic" };
  }
  if (
    (dow === 6 || dow === 0) &&
    lane >= 5 &&
    lane <= 8 &&
    slotMin >= 17 * 60 &&
    slotMin < 19 * 60
  ) {
    return { kind: "party", label: key === "HPN" ? "Nguyen birthday" : "Patel birthday" };
  }
  if (key === "HPFM" && (lane === 27 || lane === 28))
    return { kind: "maint", label: "Maintenance" };
  const walkinMax = key === "HPN" ? 8 : 12;
  const v = (lane * 7 + slotMin / 30 + dow) % 13;
  if (lane <= walkinMax && v === 3) return { kind: "walkin", label: "Walk-in" };
  if (lane > walkinMax && v === 5 && slotMin < 17 * 60)
    return { kind: "walkin", label: "Web booking" };
  return null;
}

/** Every lane the centre has, in section order. */
export function protoLanes(key: ProtoKey): number[] {
  return LANE_SECTIONS[key].flatMap((s) => s.lanes);
}

/** Slot occupancy → merged `LaneBlock[]`, the shape the engine consumes. */
export function protoLaneBlocks(lane: number, key: ProtoKey, dateStr: string): LaneBlock[] {
  const raw: LaneBlock[] = [];
  for (const slot of PROTO_SLOTS) {
    const o = protoOccupancy(lane, slot, key, dateStr);
    if (o) raw.push({ kind: o.kind, label: o.label, start: slot, end: slot + SLOT_MINUTES });
  }
  return mergeAdjacent(raw);
}

/** The whole seeded grid for one centre and date. */
export function protoOccupancyMap(key: ProtoKey, dateStr: string): Map<number, LaneBlock[]> {
  const map = new Map<number, LaneBlock[]>();
  for (const lane of protoLanes(key)) map.set(lane, protoLaneBlocks(lane, key, dateStr));
  return map;
}

export function protoLaneOccupancy(key: ProtoKey, dateStr: string): LaneOccupancy[] {
  return protoLanes(key).map((lane) => ({ lane, blocks: protoLaneBlocks(lane, key, dateStr) }));
}
