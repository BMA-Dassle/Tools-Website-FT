/**
 * The physical lane sections of each house. GIVEN, not inferred.
 *
 * Owner, 2026-09-01:
 *   HeadPinz Fort Myers   1-4 Old Time · 5-12 VIP · 13-28 Regular
 *   HeadPinz Naples       1-24 Regular · 25-32 VIP
 *   FastTrax duckpin      one product across all eight lanes
 *
 * WHY THIS FILE EXISTS. QAMF exposes lane groups nowhere — proven against all three read
 * paths on 2026-08-31 (`GET /lanes`, `GET /weboffers`, `POST availability/search` all carry
 * zero section data, each checked against a query that DOES return rows). So the engine
 * inferred them from sixty days of history, and that inference was wrong at the edges: it
 * counted any lane an offer had ever been SEEN on, including bookings staff had moved by
 * hand inside Conqueror, which put offer 154 on lane 6 and earned a live 409
 * `LanesNotCompatible`.
 *
 * Frequency thresholds patched the symptom. Being told the answer removes it.
 *
 * History still has one job — deciding WHICH section an offer belongs to — because nobody
 * has to maintain an offer-id list by hand, and offer ids change more often than walls do.
 * But the BOUNDARIES are now fixed, so a stray observation can only lose a vote; it can
 * never widen a section onto a lane the offer cannot be sold on.
 */
import { FASTTRAX_QAMF_CENTER_ID } from "@/lib/qamf-centers";

export interface LaneSection {
  name: string;
  lanes: readonly number[];
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

export const HEADPINZ_FM_CENTER_ID = 9172;
export const HEADPINZ_NAPLES_CENTER_ID = 3148;

export const CENTER_SECTIONS: Readonly<Record<number, readonly LaneSection[]>> = {
  [HEADPINZ_FM_CENTER_ID]: [
    { name: "Old Time", lanes: range(1, 4) },
    { name: "VIP", lanes: range(5, 12) },
    { name: "Regular", lanes: range(13, 28) },
  ],
  [HEADPINZ_NAPLES_CENTER_ID]: [
    { name: "Regular", lanes: range(1, 24) },
    { name: "VIP", lanes: range(25, 32) },
  ],
  // One offer across the whole house — the section IS the house, which is why the pilot
  // could never surface a section bug.
  [FASTTRAX_QAMF_CENTER_ID]: [{ name: "House", lanes: range(1, 8) }],
};

export function sectionsFor(centerId: number): readonly LaneSection[] {
  return CENTER_SECTIONS[centerId] ?? [];
}

/**
 * Which section does this offer belong to, judged by where it has actually been sold?
 *
 * Returns the section holding the most observations. `null` when the centre has no section
 * map, or when nothing was observed — callers then fall back to the derived group, and a
 * null `allowedLanes` still means "any lane", so an unknown offer is never refused a lane.
 *
 * A tie cannot silently pick a side: it returns null and lets the evidence-based path
 * answer, because two sections equally represented means we genuinely do not know.
 */
export function sectionForObservedLanes(
  centerId: number,
  laneCounts: ReadonlyMap<number, number>,
): LaneSection | null {
  const sections = sectionsFor(centerId);
  if (!sections.length || laneCounts.size === 0) return null;

  let best: LaneSection | null = null;
  let bestScore = 0;
  let tied = false;

  for (const section of sections) {
    let score = 0;
    for (const lane of section.lanes) score += laneCounts.get(lane) ?? 0;
    if (score > bestScore) {
      best = section;
      bestScore = score;
      tied = false;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }

  return bestScore > 0 && !tied ? best : null;
}

/** Every lane the centre has a section for — useful for sanity-checking a grid. */
export function knownSectionLanes(centerId: number): number[] {
  return sectionsFor(centerId).flatMap((s) => [...s.lanes]);
}
