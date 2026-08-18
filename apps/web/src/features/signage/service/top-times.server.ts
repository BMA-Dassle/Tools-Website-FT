import "server-only";

/**
 * Resolve the top-times wall for one track: the fastest laps in each window it
 * cycles through, by tier and class.
 *
 * WHY SERVER-SIDE, when /leaderboards fetches the same records from the
 * browser. Three reasons, in order of how much they matter:
 *
 *   1. A wall asks for up to eighteen categories (three windows × six
 *      tier/class pairs). Doing that from every screen, every rebuild, would
 *      put the upstream under N× the traffic for one answer.
 *   2. Two boards on the same track MUST agree. One cache entry per
 *      venue+track+windows means they cannot show different names.
 *   3. The token lives server-side already (best-times.server), so this path
 *      never pays the proxy hop.
 *
 * Fails to null throughout — a wall has no error state. Null means "nothing
 * worth putting up", and the scene shows its idle card.
 */
import redis from "@/lib/redis";
import { fetchBestTimeRecords } from "~/features/racing/best-times.server";
import {
  RECORD_TRACKS,
  recordsStartDate,
  formatRecordTime,
  type RecordCategory,
} from "~/lib/constants/race-records";
import {
  prunePanels,
  TOP_N,
  type TopTimesClass,
  type TopTimesPanel,
  type TopTimesRange,
  type TopTimesView,
} from "../top-times";
import type { TrackKey } from "../track";
import type { SignageVenue } from "../constants";

/**
 * One build per track per this many seconds, however many screens ask.
 *
 * Far longer than the results board's 12s, because the two answer different
 * questions: that board is about the race that just ended and is racing the
 * group walking past it, while a hall of fame only changes when somebody beats
 * a time. Three minutes keeps an eighteen-call rebuild rare.
 */
const CACHE_TTL_SECONDS = 180;

const CLASSES: TopTimesClass[] = ["adult", "junior"];

function cacheKey(venue: SignageVenue, track: TrackKey, ranges: TopTimesRange[]): string {
  // The windows are part of the key: two boards on one track with different
  // rotations are genuinely different answers, and must not share an entry.
  return `signage:top-times:${venue}:${track}:${ranges.join(",")}`;
}

/**
 * The wall for one track, cached per venue+track+windows.
 *
 * MEGA IS ALREADY DECIDED BY THE TIME WE GET HERE. The feed swaps a blue- or
 * red-configured results screen onto `mega` via megaModeActive() before calling
 * either resolver, so this one just reports on the track it is handed — the
 * same contract resolveResultsBoard has. Repeating the switch here would be a
 * second rail answering the same question, which is how the per-builder
 * `?? currentSession("mega")` fallbacks that mega-mode.server replaced went
 * wrong in the first place.
 *
 * It matters as much for this board as for the last-race one: on a Mega day
 * nobody races Blue or Red at all, so a Blue "today's fastest laps" wall would
 * be reporting on a track that has been closed since morning.
 */
export async function resolveTopTimes(
  venue: SignageVenue,
  track: TrackKey,
  ranges: TopTimesRange[],
): Promise<TopTimesView | null> {
  const key = cacheKey(venue, track, ranges);

  try {
    const cached = await redis.get(key);
    // A cached MISS is the empty string — see resolveResultsBoard for why that
    // is worth storing.
    if (cached === "") return null;
    if (cached) return JSON.parse(cached) as TopTimesView;
  } catch {
    /* unreadable cache → rebuild below */
  }

  let view: TopTimesView | null = null;
  try {
    view = await buildTopTimes(track, ranges);
  } catch {
    // An upstream having a bad moment must not be cached as "no records" —
    // return without writing so the next poll tries again.
    return null;
  }

  try {
    await redis.set(key, view ? JSON.stringify(view) : "", "EX", CACHE_TTL_SECONDS);
  } catch {
    /* served this one from memory; the next poll rebuilds */
  }
  return view;
}

/** Adult or junior categories for a track, from the shared catalog. */
function categoriesFor(track: TrackKey, cls: TopTimesClass): RecordCategory[] {
  const cfg = RECORD_TRACKS.find((t) => t.key === track);
  if (!cfg) return [];
  return cls === "adult" ? cfg.adult : cfg.junior;
}

async function buildTopTimes(
  track: TrackKey,
  ranges: TopTimesRange[],
): Promise<TopTimesView | null> {
  // Every category of every window at once. They are independent reads against
  // one upstream and the wall needs all of them before it can render anything,
  // so serialising would only make the rebuild slower.
  const jobs: Array<{
    range: TopTimesRange;
    cls: TopTimesClass;
    category: RecordCategory;
  }> = [];
  for (const range of ranges) {
    for (const cls of CLASSES) {
      for (const category of categoriesFor(track, cls)) {
        jobs.push({ range, cls, category });
      }
    }
  }
  if (jobs.length === 0) return null;

  const rows = await Promise.all(
    jobs.map((j) =>
      fetchBestTimeRecords({
        rscId: j.category.rscId,
        scgId: j.category.scgId,
        startDate: recordsStartDate(j.range),
        maxResult: String(TOP_N),
      })
        // One category failing must not take the whole wall down with it: the
        // other eleven columns are still worth showing, and an empty one is
        // pruned exactly like a category nobody raced.
        .catch(() => []),
    ),
  );

  // Results come back positionally, so pair them with their job once and look
  // up by identity afterwards.
  const byJob = new Map(jobs.map((j, i) => [j, rows[i] ?? []]));

  const panels: TopTimesPanel[] = jobs.length
    ? ranges.flatMap((range) =>
        CLASSES.map((cls) => ({
          range,
          cls,
          columns: jobs
            .filter((j) => j.range === range && j.cls === cls)
            .map((j) => ({
              label: j.category.label,
              color: j.category.color,
              rows: (byJob.get(j) ?? []).slice(0, TOP_N).map((r, idx) => ({
                // The upstream ranks within the category already, but a gap in
                // its numbering would print "1, 2, 4" on a wall; the row's own
                // place in the list is the honest position.
                position: idx + 1,
                name: r.participant,
                score: formatRecordTime(r.score),
              })),
            })),
        })),
      )
    : [];

  const pruned = prunePanels(panels);
  return pruned.length > 0 ? { track, panels: pruned } : null;
}
