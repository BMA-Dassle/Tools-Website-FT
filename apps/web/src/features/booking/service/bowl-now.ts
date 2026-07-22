/**
 * Pure core of the FastTrax duckpin "Bowl Now" (per-lane QR) availability +
 * scan-time hold logic. No I/O, no React — so it unit-tests without live QAMF
 * and is shared by the bowl-now availability route and the pinned-hold route.
 *
 * The vendor calls (listLanes, createReservation with a lane pin, the
 * downgrade attempts) live in the routes; the DECISIONS — which lanes are open,
 * which durations still fit before close, and the order to try them — live
 * here. Duration truth comes from OUR seeded config, never QAMF's Minutes
 * field (the hard rule in duration-feasibility.ts).
 */
import type { Lane } from "@/lib/qamf-bowling";
import { slotExceedsClose } from "./duration-feasibility";

/** A bookable duration: minutes (our config) + the QAMF Time option id. */
export type DurationOption = { minutes: number; optionId: number };

/**
 * Physical lanes free to start a walk-up right now. "Closed" = hardware off /
 * no live session — the same predicate the self-service check-in trusts as
 * "free to start" (checkin/route.ts). "Open"/"Running" = occupied; "Error"/
 * "None" = skip. Sorted ascending for a stable swap list.
 */
export function openLanesFrom(lanes: Lane[]): number[] {
  return lanes
    .filter((l) => l.Status === "Closed")
    .map((l) => l.LaneNumber)
    .sort((a, b) => a - b);
}

/** Is this specific physical lane free to start now? */
export function laneIsFree(lanes: Lane[], laneNumber: number): boolean {
  const l = lanes.find((x) => x.LaneNumber === laneNumber);
  return !!l && l.Status === "Closed";
}

/**
 * Durations that still fit before the center closes for a start at `bookedAt`,
 * LONGEST FIRST — which is exactly the order the scan-time hold tries them
 * (90 → 60 → 30) so the guest is auto-offered the most time the lane allows.
 * End == close is allowed (slotExceedsClose is strict). The lane-pinned hold
 * remains the final authority; this only trims what's obviously past close.
 */
export function fittingDurations(
  durations: DurationOption[],
  bookedAt: string,
  closeHour24: number,
): DurationOption[] {
  return durations
    .filter((d) => !slotExceedsClose(bookedAt, d.minutes, closeHour24))
    .sort((a, b) => b.minutes - a.minutes);
}

/**
 * `now` floored to a 5-minute multiple (QAMF requires BookedAt minutes % 5 == 0,
 * seconds/ms = 0), rendered with the true America/New_York offset. Flooring
 * keeps the instant in the immediate past, correct for a PlayNow walk-up.
 * `now` is injectable for tests.
 */
export function nowRounded5EtIso(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((a, p) => ((a[p.type] = p.value), a), {});
  const asUtc = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour,
    +parts.minute,
    +parts.second,
  );
  const offMin = Math.round((asUtc - now.getTime()) / 60000); // ET behind UTC → negative
  const sign = offMin <= 0 ? "-" : "+";
  const abs = Math.abs(offMin);
  const offStr = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const min5 = String(Math.floor(+parts.minute / 5) * 5).padStart(2, "0");
  // Hour uses "24" for midnight under hour12:false in some environments — normalize.
  const hh = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hh}:${min5}:00${offStr}`;
}
