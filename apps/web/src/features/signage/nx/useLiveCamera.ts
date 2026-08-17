"use client";

/**
 * Live camera playback, shared by every surface that shows one.
 *
 * ONE IMPLEMENTATION ON PURPOSE. The desk check-in board and the in-room
 * briefing tablets both play the same streams from the same relay with the same
 * single-use tickets, and a copy of this on each would drift — the ticket
 * budget, the cooldown, the teardown and the standing-down rules are all things
 * that have already been got wrong once and fixed here. A second copy would
 * miss the next fix. See camera-preview.ts for what the streams themselves are.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveResolution } from "./camera-preview";

/** Media teardown for the live-viewer <video>, as a React 19 ref-callback
 *  cleanup. Module-level so its identity never changes: the cleanup must run
 *  only when the element actually leaves (unmount / key change), never on a
 *  re-render. */
export function teardownLiveVideoRef(el: HTMLVideoElement | null) {
  if (!el) return;
  return () => {
    try {
      el.pause();
    } catch {
      /* already torn down */
    }
    el.removeAttribute("src");
    el.load();
  };
}

/**
 * THE LIVE STREAM, played by the browser itself.
 *
 * The still refresh above is a picture a second through our own proxy; this is the
 * actual camera, straight from Nx's relay (owner 2026-08-12: "when we go full
 * screen on camera can we switch to live feed?"). Our functions never touch the
 * video — they only mint the single-use ticket that authorises it, which is why
 * this can exist on serverless at all. See nx/camera.server.ts.
 *
 * IT IS AN UPGRADE, NEVER A REQUIREMENT. Every failure path — no ticket, relay
 * down, a codec the browser will not take, autoplay refused — simply leaves the
 * stills showing underneath. A viewer that went black because live broke would be
 * worse than the thing it replaced.
 *
 * A TICKET IS SPENT ON USE, so a re-mint is needed for every load: opening the
 * viewer, switching rooms, and any recovery after the stream drops. Retries are
 * capped — a camera that keeps dropping should settle on stills rather than mint
 * tickets forever.
 */
export const LIVE_MAX_RETRIES = 2;

/**
 * A LIVE TILE IS OPEN FOR A WHOLE SHIFT, AND A PROGRESSIVE MP4 NEVER ENDS.
 *
 * The viewer's streams were always short — someone opens it, looks, closes it.
 * A room preview is different: it starts when the desk PC loads the board at
 * 10am and is still going at midnight, feeding one `<video>` element a stream
 * with no last byte. Whatever the browser retains of that (and it is not ours to
 * assume), a stream that is never replaced is a number that only goes up.
 *
 * So the tile takes a fresh ticket on a timer and swaps the element for a new
 * one — the same replacement that already happens on every retry, just arriving
 * on purpose instead of after a failure. The stills underneath cover the second
 * it takes to buffer, exactly as they do on first load, so the picture never
 * blanks. This sits INSIDE the estate's 12-24h page recycle (see recycle.ts),
 * not instead of it: that reload is the amnesty for everything else on the page.
 */
export const LIVE_RECYCLE_MS = 10 * 60_000;

/**
 * AND TRY AGAIN AFTER GIVING UP, because "gave up" was too final.
 *
 * The retry budget stops a jittery relay burning tickets in a loop, which is
 * right. But it also meant a tile that failed its three attempts at 10am sat on
 * stills for the rest of the shift even after the cause was fixed — and every
 * trace captured afterwards showed a page doing nothing, which is not evidence
 * of anything.
 *
 * A minute is long enough not to hammer a camera that is genuinely down, and
 * short enough that a fix, a reconnect, or an Nx restart is picked up while
 * somebody is still standing at the desk.
 */
export const LIVE_COOLDOWN_MS = 60_000;

export function useLiveCamera<T extends string>(
  room: T,
  getUrl: (room: T, res?: LiveResolution) => Promise<string | null>,
  opts?: {
    /** False stands the stream down entirely — no ticket, no element, no
     *  connection. The tile uses it while the viewer has the same camera up,
     *  so one room is never two streams. */
    enabled?: boolean;
    /** Frame rate, in disguise — see live-resolution.ts. */
    resolution?: LiveResolution;
    /** Re-mint on this interval, or 0 to stream until something breaks. */
    recycleMs?: number;
  },
) {
  const enabled = opts?.enabled ?? true;
  const resolution = opts?.resolution;
  const recycleMs = opts?.recycleMs ?? 0;
  // Both pieces of state CARRY THE CAMERA they describe, for the same reason the
  // still hook does: switching cameras must not leave the blue room's stream
  // playing under a red heading for the second it takes to mint a new ticket.
  // Derived, so there is no stale frame to blank and no reset effect to run.
  //
  // This matters more, not less, for the holding views: they are the SAME device
  // at two dewarp angles, so a stream that outlived its target would be a picture
  // that looks plausible and is aimed at the other track's seats.
  const [stream, setStream] = useState<{ room: T; url: string } | null>(null);
  const [playingRoom, setPlayingRoom] = useState<T | null>(null);
  const retriesRef = useRef(0);
  /**
   * WHY LIVE GAVE UP, ON THE GLASS — temporary, and it earns its place.
   *
   * Three rounds of diagnosis have now come back as a network trace, which
   * cannot carry the one fact that decides this: a browser that refuses a media
   * source records its reason in MediaError, never on the wire. The console has
   * it, but the artefact that actually reaches me is a screenshot.
   *
   * So the tile says it. Remove this the moment live plays.
   */
  const [failure, setFailure] = useState<string | null>(null);

  // The parent's callback, kept current in a ref so re-creating it cannot restart
  // a healthy stream. Only the room should do that.
  const getUrlRef = useRef(getUrl);
  useEffect(() => {
    getUrlRef.current = getUrl;
  });

  const load = useCallback(
    async (target: T) => {
      const url = await getUrlRef.current(target, resolution);
      setStream(url ? { room: target, url } : null);
    },
    // A literal from the call site, so this is as stable as the empty-deps
    // version it replaces — and honest about what the URL depends on.
    [resolution],
  );

  /**
   * STANDING DOWN DROPS THE ELEMENT, NOT JUST THE PICTURE — a paused tile that
   * kept its stream would hold a second transcode open on the camera the viewer
   * is already watching, which is the one moment the NVR is busiest.
   *
   * Adjusted DURING RENDER, not in an effect (react.dev, "You Might Not Need an
   * Effect" → adjusting state when a prop changes). An effect would leave one
   * committed frame where a spent ticket is still mounted, and the retry it
   * provokes would mint a ticket for a stream nobody is watching. React re-runs
   * this render before committing, so the `<video>` never reaches the DOM.
   */
  if (!enabled && (stream !== null || playingRoom !== null)) {
    setStream(null);
    setPlayingRoom(null);
  }

  useEffect(() => {
    retriesRef.current = 0;
    clearTimeout(cooldownRef.current);
    if (!enabled) return;
    void load(room);
  }, [room, load, enabled]);

  /** THE SCHEDULED SWAP IS NOT A RETRY, so it resets the budget it is not
   *  spending. Leaving retriesRef alone would mean two unlucky drops in an
   *  eight-hour shift permanently demoted a healthy tile to stills. */
  useEffect(() => {
    if (!enabled || recycleMs <= 0) return;
    const id = setInterval(() => {
      retriesRef.current = 0;
      void load(room);
    }, recycleMs);
    return () => clearInterval(id);
  }, [enabled, recycleMs, load, room]);

  /** The stream dropped or was refused — take one more ticket, then stand down
   *  for a cooldown rather than for good. */
  const cooldownRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retry = useCallback(() => {
    setPlayingRoom(null);
    if (retriesRef.current >= LIVE_MAX_RETRIES) {
      setStream(null);
      clearTimeout(cooldownRef.current);
      cooldownRef.current = setTimeout(() => {
        retriesRef.current = 0;
        void load(room);
      }, LIVE_COOLDOWN_MS);
      return;
    }
    retriesRef.current += 1;
    void load(room);
  }, [load, room]);

  // The cooldown must not outlive the tile, or a closed viewer keeps minting.
  useEffect(() => () => clearTimeout(cooldownRef.current), []);

  const url = stream?.room === room ? stream.url : null;
  return {
    url,
    playing: playingRoom === room && !!url,
    /** Diagnostic only — see `failure` above. Null until something fails. */
    failure,
    onPlaying: () => setPlayingRoom(room),
    /**
     * SAY WHY LIVE DIED, don't just fall back.
     *
     * This hook's whole design is that failure is invisible — every path lands
     * softly on the stills, which is right for the desk and wrong for anyone
     * trying to fix it. A CSP rule blocked every stream for four days and the
     * only symptom was a caption that never said LIVE; the HAR could not show
     * it either, because a refused `<video>` leaves its reason in MediaError,
     * not in the network log.
     *
     * So the element's own verdict goes to the console with the event that
     * carried it. `error.code` is the MediaError enum: 1 ABORTED, 2 NETWORK,
     * 3 DECODE, 4 SRC_NOT_SUPPORTED — and 4 is the one that means "the browser
     * refused this source", which is what a policy block looks like from here.
     */
    onFailure: (event: "error" | "ended", el: HTMLVideoElement) => {
      const err = el.error;
      // Short enough for a caption: "ended r4 n3 b0.0" reads as event / readyState
      // / networkState / seconds buffered, with the MediaError code when there is
      // one. Every one of those separates a refused source from a stalled one.
      setFailure(
        `${event}${err ? ` e${err.code}` : ""} r${el.readyState} n${el.networkState}` +
          ` b${el.buffered.length ? el.buffered.end(el.buffered.length - 1).toFixed(1) : "0"}`,
      );
      console.warn(
        `[camera] live stream for ${room} ended on "${event}"` +
          (err ? ` — MediaError code ${err.code}: ${err.message || "(no message)"}` : " — no MediaError (the source simply ended)") +
          ` | readyState=${el.readyState} networkState=${el.networkState}` +
          ` buffered=${el.buffered.length ? `${el.buffered.end(el.buffered.length - 1).toFixed(1)}s` : "nothing"}`,
      );
    },
    /**
     * BUFFERING IS NOT A FAILURE. A stall spends no ticket and remounts nothing —
     * it just stops the board claiming LIVE and lets the still refresh take the
     * picture back until frames resume. Only a dead stream (`error`, `ended`)
     * costs a fresh ticket, which is what keeps a jittery relay from burning
     * through the retry budget in ten seconds.
     */
    onWaiting: () => setPlayingRoom(null),
    retry,
  };
}
