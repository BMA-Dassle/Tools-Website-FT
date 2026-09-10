/**
 * IS PANDORA'S CACHED PICTURE OF THE PA STILL TRUE? PURE.
 *
 * THE INCIDENT (2026-09-10). Every pit control sat struck through reading
 * "PA busy · mega" for the better part of an hour. Reboots and redeploys of
 * OUR app changed nothing, because the busy verdict is not our state: it is
 * read off Pandora's cache of the Core's WebSocket push feed
 * (GET /qsys/audio/live). That cache said the mega zone was playing the
 * pre-race clip — started 19:34:26Z, 1:16 long, clock frozen at 0:06 — with
 * `connected: true`, and it kept saying so at 20:20Z. The Core itself
 * (GET /qsys/audio/status, a direct read) reported every zone Idle the whole
 * time. Pandora's socket to the Core had gone zombie: open as far as Pandora
 * could tell, delivering nothing. Even a /stop the Core acknowledged produced
 * no cached event.
 *
 * WHY THIS IS DETECTABLE. While a clip plays the Core pushes a state frame
 * about ten times a second (docs/qsys-audio-websocket.md), and Pandora stamps
 * `stateUpdatedAt` on each one. A zone that claims to be playing while its
 * last frame is SECONDS old is therefore not a clip — it is a cache that has
 * stopped hearing from the Core. Idle is different: the feed is silent while
 * every zone is idle, by design, so an old timestamp on an idle picture means
 * nothing.
 *
 * The verdicts here are pure so the reconciliation policy can be tested
 * without Redis or Pandora; qsys-truth.server.ts applies them.
 */

export interface QsysZoneSnapshot {
  zone: string;
  playing: boolean;
  file: string;
  timing?: { remaining?: number };
}

export interface QsysLiveSnapshot {
  /** Pandora's own report of its socket to the Core. */
  connected: boolean;
  zones: QsysZoneSnapshot[];
  /** When Pandora last received a state frame — null when the response
   *  carried no `stateUpdatedAt` at all. */
  stateUpdatedAtMs: number | null;
}

/**
 * How long a PLAYING zone may go without a state frame before the cache is
 * presumed frozen. Frames come ~10/second during playback; a few seconds is
 * already two orders of magnitude of silence, and the cost of a false alarm is
 * one direct /status read — not a refused press.
 */
export const PLAYING_TICK_STALE_MS = 5_000;

/**
 * Why the cached picture cannot be taken at its word, or null when it can.
 *
 * Only two things make it suspect: Pandora admitting its Core link is down
 * (the doc's own "treat your last state as stale"), or a zone that says
 * playing while the frames that would prove it have stopped arriving.
 */
export function liveSuspicion(live: QsysLiveSnapshot, nowMs: number): string | null {
  if (!live.connected) return "Pandora reports its link to the Core is down";
  for (const z of live.zones) {
    if (!z.playing) continue;
    if (live.stateUpdatedAtMs == null) {
      return `${z.zone} reports playing but the cache carries no state timestamp`;
    }
    const silentMs = nowMs - live.stateUpdatedAtMs;
    if (silentMs > PLAYING_TICK_STALE_MS) {
      return `${z.zone} reports playing "${z.file}" but the last state frame was ${Math.round(
        silentMs / 1000,
      )}s ago`;
    }
  }
  return null;
}

/**
 * Do two pictures of the PA tell different stories? A one-line account of the
 * first difference, or null when they agree on what matters — which zones are
 * playing, and what. Timing is not compared: the two reads are never taken at
 * the same instant, so their countdowns legitimately differ by a beat.
 */
export function zonesDisagree(
  cached: QsysZoneSnapshot[],
  direct: QsysZoneSnapshot[],
): string | null {
  const byZone = new Map(direct.map((z) => [z.zone, z]));
  for (const c of cached) {
    const d = byZone.get(c.zone);
    if (!d) continue;
    if (c.playing !== d.playing) {
      return `${c.zone}: cache says ${c.playing ? `playing "${c.file}"` : "idle"}, Core says ${
        d.playing ? `playing "${d.file}"` : "idle"
      }`;
    }
    if (c.playing && c.file !== d.file) {
      return `${c.zone}: cache says "${c.file}", Core says "${d.file}"`;
    }
  }
  return null;
}
