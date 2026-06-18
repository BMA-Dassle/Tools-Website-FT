/**
 * Schedule-conflict detection for the Health Net Team Day.
 *
 * Rule (per owner): a guest's race and their gel-blaster/laser-tag are too tight if
 *   - the activity is AFTER the race and < 45 min apart (race + travel eats time), or
 *   - the activity is BEFORE the race and < 30 min apart.
 *
 * Computed live from the RSVP (never stale). The guest's chosen resolution +
 * "who I'm trying to stay with" note are stored back on the RSVP.
 */
import type { GroupEventRsvp } from "@/app/api/group-event/rsvp/route";

const AFTER_MIN = 45;
const BEFORE_MIN = 30;

const ATTRACTIONS: { type: string; label: string }[] = [
  { type: "gel-blaster", label: "Gel Blaster" },
  { type: "laser-tag", label: "Laser Tag" },
];

export interface SchedConflict {
  direction: "after" | "before"; // activity after the race / before the race
  attractionType: string;
  attractionLabel: string;
  attractionTime: string;
  raceTrack?: string;
  raceTime: string;
  gapMin: number;
}

export interface ConflictBundle {
  summary: string;
  options: { value: string; label: string }[];
  resolution: string | null;
  stayWith: string | null;
}

function toMins(iso?: string): number | null {
  if (!iso) return null;
  const tp = iso.replace(/Z$/, "").split("T")[1];
  if (!tp) return null;
  const [h, m] = tp.split(":").map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (Number.isNaN(m) ? 0 : m);
}

function fmt(iso: string): string {
  const tp = iso.replace(/Z$/, "").split("T")[1] || "";
  const [h, m] = tp.split(":").map(Number);
  if (Number.isNaN(h)) return "";
  return `${((h + 11) % 12) + 1}:${String(Number.isNaN(m) ? 0 : m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export function detectConflicts(rsvp: GroupEventRsvp): SchedConflict[] {
  const resv = rsvp.reservations || [];
  const race = resv.find((r) => r.type === "racing");
  const rM = toMins(race?.time);
  if (!race?.time || rM == null) return [];

  const out: SchedConflict[] = [];
  for (const { type, label } of ATTRACTIONS) {
    const a = resv.find((r) => r.type === type);
    const aM = toMins(a?.time);
    if (!a?.time || aM == null) continue;
    if (aM <= rM) {
      const gap = rM - aM;
      if (gap < BEFORE_MIN)
        out.push({
          direction: "before",
          attractionType: type,
          attractionLabel: label,
          attractionTime: a.time,
          raceTrack: race.track,
          raceTime: race.time,
          gapMin: gap,
        });
    } else {
      const gap = aM - rM;
      if (gap < AFTER_MIN)
        out.push({
          direction: "after",
          attractionType: type,
          attractionLabel: label,
          attractionTime: a.time,
          raceTrack: race.track,
          raceTime: race.time,
          gapMin: gap,
        });
    }
  }
  return out;
}

/** Guest-facing one-liner describing the tight pairing. */
export function conflictSummary(conflicts: SchedConflict[]): string {
  if (!conflicts.length) return "";
  if (conflicts.length === 1) {
    const c = conflicts[0];
    const racePart = c.raceTrack
      ? `your race (${c.raceTrack} Track, ${fmt(c.raceTime)})`
      : `your race (${fmt(c.raceTime)})`;
    return `${racePart} and ${c.attractionLabel} (${fmt(c.attractionTime)}) are only ${c.gapMin} minutes apart`;
  }
  const acts = [...new Set(conflicts.map((c) => c.attractionLabel))].join(" and ");
  return `your race and your ${acts} are scheduled close together`;
}

/** Direction-aware resolution choices. */
export function resolutionOptions(conflicts: SchedConflict[]): { value: string; label: string }[] {
  if (!conflicts.length) return [];
  const acts = [...new Set(conflicts.map((c) => c.attractionLabel))];
  const actName = acts.length === 1 ? acts[0] : "gel blaster / laser tag";
  const hasAfter = conflicts.some((c) => c.direction === "after");
  const hasBefore = conflicts.some((c) => c.direction === "before");

  const opts: { value: string; label: string }[] = [];
  if (hasAfter && !hasBefore) {
    opts.push({ value: "earlier-race", label: "Give me an earlier race" });
    opts.push({ value: "later-activity", label: `Move my ${actName} later` });
  } else if (hasBefore && !hasAfter) {
    opts.push({ value: "later-race", label: "Give me a later race" });
    opts.push({ value: "earlier-activity", label: `Move my ${actName} earlier` });
  } else {
    opts.push({ value: "adjust-race", label: "Adjust my race time" });
    opts.push({ value: "adjust-activity", label: `Adjust my ${actName}` });
  }
  return opts;
}

/** Bundle for the confirm page / lookup API. Null when there's no conflict. */
export function conflictBundle(rsvp: GroupEventRsvp): ConflictBundle | null {
  const cs = detectConflicts(rsvp);
  if (!cs.length) return null;
  return {
    summary: conflictSummary(cs),
    options: resolutionOptions(cs),
    resolution: rsvp.conflictResolution ?? null,
    stayWith: rsvp.conflictStayWith ?? null,
  };
}

/** Short admin label for a guest's conflict (e.g. "Race ↔ Laser Tag, 30m after"). */
export function conflictAdminLabel(conflicts: SchedConflict[]): string {
  return conflicts
    .map((c) => `Race ↔ ${c.attractionLabel} (${c.gapMin}m ${c.direction})`)
    .join("; ");
}
