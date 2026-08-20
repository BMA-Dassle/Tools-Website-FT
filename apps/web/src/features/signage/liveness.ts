/**
 * IS THIS WALL STILL LISTENING? — the pure half.
 *
 * THE PROBLEM THIS EXISTS FOR. A scores wall in its `last-race` face has no
 * motion of any kind (that is deliberate — see the note at the top of
 * SceneRaceResults) and the last good feed is the floor, so it holds its last
 * picture forever rather than going blank. Those two facts together mean a
 * DEAD board and a QUIET board are pixel-identical: red heats run 9-14 minutes,
 * so a perfectly healthy wall shows one motionless image for a quarter of an
 * hour at a stretch, and from the last race of the night to the 2am rollover it
 * is motionless for hours. Every "the results screen froze again" report was
 * therefore unfalsifiable at the glass, and three separate real faults
 * (`81ba375ae`, `74042a683`, `659507205`) were each reported the same way as a
 * board that was working perfectly.
 *
 * WHAT MAKES A STAMP TRUSTWORTHY. Both operands must come from ONE clock, and
 * it has to be the CLIENT's raw `Date.now()`:
 *
 *   - Not the feed's server `now`. That is the thing that stops arriving, so
 *     measuring its age against itself always reads zero — a frozen display
 *     freezing its own age reads as healthy, which is the exact trap the
 *     ?debug=1 overlay gives itself a private clock to avoid.
 *   - Not the shared corrected clock (`nowMs` = Date.now() + offset) against a
 *     raw stamp. The player PCs are documented to carry a wrong local clock,
 *     which is what the offset is for — so mixing a corrected instant with an
 *     uncorrected one puts the whole correction into the answer and a healthy
 *     board reads minutes stale.
 *
 * So the caller feeds in a raw `Date.now()` and the stamps from TvFeedHealth,
 * which are raw `Date.now()` by the same reasoning (see useTvFeed).
 *
 * PURE — no clock read, no React, no I/O. The component is LiveStamp.tsx.
 */
import { toEtWallClock } from "~/features/kiosk/checkin/itinerary";

/**
 * How quiet is too quiet.
 *
 * The pulse lane polls every 2s with an 8s deadline, so the worst healthy gap
 * is ~10s and one dropped cycle is ~20s. 90s is about nine consecutive misses:
 * far enough out that ordinary venue wifi cannot reach it, so the amber state
 * means "this is broken" rather than "the network hiccuped" — a footer that
 * cries wolf on a hiccup is a footer staff learn to ignore.
 */
export const LIVENESS_STALE_MS = 90_000;

export type LivenessState =
  /** No poll has ever succeeded — a booting board. Shows nothing. */
  | "warming"
  /** Heard from the server within the window. */
  | "live"
  /** Nothing has landed for LIVENESS_STALE_MS. */
  | "stale";

export interface Liveness {
  state: LivenessState;
  /** Client stamp of the newest successful poll, or null before the first. */
  lastOkMs: number | null;
  /** How long ago that was, ms. Null before the first success. */
  ageMs: number | null;
}

export function feedLiveness(args: {
  lastFullOkMs: number | null;
  lastPulseOkMs: number | null;
  /** Raw `Date.now()` — NOT the offset-corrected shared clock. See above. */
  nowMs: number;
  staleAfterMs?: number;
}): Liveness {
  const { lastFullOkMs, lastPulseOkMs, nowMs } = args;
  const staleAfterMs = args.staleAfterMs ?? LIVENESS_STALE_MS;

  // EITHER LANE COUNTS. The pulse is the frequent one, but a full feed landing
  // is just as much proof the connection is alive, and the two lanes fail
  // independently — so the newest of the two is the honest answer. Taking only
  // the pulse would paint a board amber while its full feed was arriving fine.
  const lastOkMs =
    lastFullOkMs === null
      ? lastPulseOkMs
      : lastPulseOkMs === null
        ? lastFullOkMs
        : Math.max(lastFullOkMs, lastPulseOkMs);

  if (lastOkMs === null) return { state: "warming", lastOkMs: null, ageMs: null };

  // Clamped at zero: a device clock that steps BACKWARD (an NTP correction on a
  // player PC, which is a documented condition here) would otherwise produce a
  // negative age and a nonsense label. A stamp from the future is treated as
  // "just heard from it", which is the safe reading — the next tick corrects it.
  const ageMs = Math.max(0, nowMs - lastOkMs);
  return { state: ageMs > staleAfterMs ? "stale" : "live", lastOkMs, ageMs };
}

/**
 * "4 min" / "1 hr 12 min" — how long the board has been quiet.
 *
 * Only ever shown in the stale state, so it starts at minutes: seconds would be
 * a countdown nobody can act on, and by the time this appears the number is
 * already past a minute. Whole units, no decimals — this is read from across a
 * room, and "1 hr 12 min" is the sentence a marshal repeats down the radio.
 */
export function staleAgeLabel(ageMs: number): string {
  const mins = Math.floor(Math.max(0, ageMs) / 60_000);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hrs} hr` : `${hrs} hr ${rem} min`;
}

/**
 * THE EXACT WORDS ON THE WALL, decided here rather than in the component.
 *
 * The component is a hook-bearing leaf, so it cannot be called in this test
 * environment (node, no DOM — see the note in scenes/checkin-feed.test.tsx).
 * Keeping the sentence out here means the thing that actually matters — what a
 * marshal reads at the kart return — is pinned by a test instead of being the
 * one part nothing covers.
 *
 * Null means render nothing: a booting board says nothing at all, because the
 * branded loader is already telling that story and a wall has no error state.
 */
export function livenessLine(live: Liveness): { text: string; stale: boolean } | null {
  if (live.state === "warming" || live.lastOkMs === null) return null;
  const clock = fmtClockWithSeconds(live.lastOkMs);
  if (!clock) return null;
  if (live.state === "stale") {
    // NAMES THE LAST TIME IT HEARD ANYTHING, not just how long ago. The
    // absolute time is what staff can match against a phone, and it is what
    // gets read out when somebody calls this in.
    return { text: `No update since ${clock} · ${staleAgeLabel(live.ageMs ?? 0)}`, stale: true };
  }
  // "Updated" so it can never be read as the finish time already printed at the
  // other end of this same footer.
  return { text: `Updated ${clock}`, stale: false };
}

/**
 * "10:54:07 PM" in venue time, from an epoch.
 *
 * SECONDS, unlike every other time on this wall. Everywhere else a wall reads
 * to the minute because that is what a guest needs; here the seconds ARE the
 * signal — a readout that only moved once a minute would take two looks and a
 * memory to interpret, and the whole point is that one glance settles it.
 *
 * Goes through toEtWallClock rather than a `new Date` + timeZone read, per the
 * wall TIME RULE (lesson 51a47370): the zone conversion happens in the one
 * helper that gets it right, and this function only formats what comes back.
 */
export function fmtClockWithSeconds(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return "";
  const naiveEt = toEtWallClock(new Date(epochMs).toISOString());
  const m = /T(\d{2}):(\d{2}):(\d{2})/.exec(naiveEt);
  if (!m) return "";
  const h24 = Number(m[1]);
  const suffix = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${m[2]}:${m[3]} ${suffix}`;
}
