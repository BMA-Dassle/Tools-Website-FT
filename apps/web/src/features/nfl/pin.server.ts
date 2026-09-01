/**
 * Seat an NFL booking inside the block its game was claimed on — SERVER ONLY.
 *
 * QAMF auto-assigns from the VIP lane group and roams the whole of 5-12 (probe,
 * 2026-08-25: four holds landed on lanes 5, 8 and 9). The ledger has already
 * decided WHICH GAME each block shows, so a party seated on the wrong block
 * would sit under a screen playing someone else's game. This moves them.
 *
 * WHY A MOVE AND NOT A PIN AT CREATE. `createReservation` accepts
 * `Lanes:[{LaneNumber}]`, but it does not fail loudly when the lane is taken —
 * it quietly assigns a different one, which the FastTrax QR flow has to defend
 * against by re-reading. `PATCH /reservations/{id}/lanes` answers with a real
 * 409 instead, and the reason distinguishes the two failures that matter.
 *
 * THE TWO 409s, and why the difference is load-bearing:
 *   LanesNotAvailable   — the lane is occupied. Ordinary. Try the next
 *                         arrangement within the block.
 *   LanesNotCompatible  — the lane is outside the offer's lane group. That is a
 *                         BUG in our block config, not a busy Sunday, and
 *                         retrying would paper over it. Stop and report.
 *
 * NON-FATAL BY CONSTRUCTION. The guest has paid and QAMF has confirmed before
 * this runs. A failed move leaves a perfectly valid booking sitting on the
 * wrong block, which the ops board surfaces and front desk fixes in seconds —
 * infinitely better than throwing and stranding a paid reservation. And never
 * delete-and-recreate to force it: lane moves are PATCH-only.
 */

import { moveReservationLanes, getReservation } from "@/lib/qamf-bowling";
import type { NflLaneBlock } from "./blocks";

/** ET wall-clock with the true offset — Conqueror reads PATCH times as
 *  center-local and ignores the offset, so this is correct under either
 *  interpretation (mirrors toCenterLocalIso in qamf-reschedule). */
function toCenterLocalIso(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const offset = /GMT([+-]\d{2}:\d{2})/.exec(get("timeZoneName"))?.[1] ?? "+00:00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset}`;
}

export interface BookedLaneLike {
  Id: string;
  LaneNumber: number;
  StartTime?: string | null;
  EndTime?: string | null;
}

export type PinOutcome =
  | { pinned: true; lanes: number[]; moved: boolean }
  | {
      pinned: false;
      lanes: number[];
      reason: "block-full" | "incompatible" | "error";
      detail: string;
    };

/** Every size-n selection of `lanes`, ascending — few enough to enumerate. */
function combinations(lanes: readonly number[], n: number): number[][] {
  if (n <= 0) return [[]];
  if (n > lanes.length) return [];
  const out: number[][] = [];
  const walk = (start: number, picked: number[]) => {
    if (picked.length === n) return void out.push([...picked]);
    for (let i = start; i < lanes.length; i++) {
      picked.push(lanes[i]);
      walk(i + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return out;
}

function reasonFrom(err: unknown): "block-full" | "incompatible" | "error" {
  const msg = err instanceof Error ? err.message : String(err);
  if (/LanesNotCompatible/i.test(msg)) return "incompatible";
  if (/LanesNotAvailable|Not enough resources/i.test(msg)) return "block-full";
  return "error";
}

/**
 * Move `reservationId` onto lanes inside `block`.
 *
 * Already inside? Nothing is sent — the common case on a quiet day, since QAMF
 * may well have picked block lanes on its own.
 *
 * Otherwise each arrangement of the block's lanes is tried in ascending order
 * (at most C(4,n) ≤ 6 attempts for a 4-lane block) until one is accepted. The
 * whole lane array goes in every request because QAMF requires it, and the
 * times are echoed unchanged — this reassigns lanes, it never reschedules.
 */
export async function pinReservationToBlock(args: {
  centerId: number;
  reservationId: string;
  lanes: readonly BookedLaneLike[];
  block: NflLaneBlock;
}): Promise<PinOutcome> {
  const { centerId, reservationId, lanes, block } = args;
  const current = lanes.map((l) => Number(l.LaneNumber)).filter(Number.isFinite);

  if (current.length === 0) {
    return { pinned: false, lanes: [], reason: "error", detail: "reservation reported no lanes" };
  }
  if (current.every((n) => block.lanes.includes(n))) {
    return { pinned: true, lanes: current, moved: false };
  }
  if (current.length > block.lanes.length) {
    // Should be unreachable — validateNflBooking caps a booking at one block.
    return {
      pinned: false,
      lanes: current,
      reason: "block-full",
      detail: `${current.length} lanes booked but ${block.id} only has ${block.lanes.length}`,
    };
  }

  let lastDetail = "no arrangement attempted";
  for (const target of combinations(block.lanes, current.length)) {
    // Keep a lane where it is when it is already in the block and in this
    // arrangement — moving a lane onto itself is a needless way to fail.
    const payload = lanes.map((l, i) => ({
      Id: l.Id,
      LaneNumber: target[i],
      StartTime: l.StartTime ? toCenterLocalIso(Date.parse(l.StartTime)) : "",
      EndTime: l.EndTime ? toCenterLocalIso(Date.parse(l.EndTime)) : "",
    }));
    if (payload.some((p) => !p.StartTime || !p.EndTime)) {
      return {
        pinned: false,
        lanes: current,
        reason: "error",
        detail: "reservation lanes carried no start/end time",
      };
    }
    try {
      await moveReservationLanes(centerId, reservationId, payload);
      // Trust but verify: read the reservation back rather than assuming the
      // PATCH did what it said. Cheap, and a silent no-op would otherwise look
      // like success and put the party under the wrong screen.
      const after = await getReservation(centerId, reservationId).catch(() => null);
      const seated = (after?.Lanes ?? []).map((l) => Number(l.LaneNumber)).filter(Number.isFinite);
      const landed = seated.length > 0 ? seated : target;
      if (!landed.every((n) => block.lanes.includes(n))) {
        lastDetail = `PATCH reported success but landed on ${landed.join(",")}`;
        continue;
      }
      return { pinned: true, lanes: landed, moved: true };
    } catch (err) {
      const reason = reasonFrom(err);
      lastDetail = err instanceof Error ? err.message : String(err);
      // A lane outside the group is a config bug, not a busy lane. Retrying the
      // other arrangements would just fail the same way and hide it.
      if (reason === "incompatible") {
        return { pinned: false, lanes: current, reason, detail: lastDetail };
      }
    }
  }

  return { pinned: false, lanes: current, reason: "block-full", detail: lastDetail };
}
