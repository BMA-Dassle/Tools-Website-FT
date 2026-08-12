"use client";

/**
 * The conductor: decides what is on screen and choreographs the cut between
 * scenes.
 *
 * It holds almost no state, on purpose. `resolveActiveScene` is a pure function
 * of (shared clock, config, feed), so this component's job is only to (a) tick,
 * (b) keep the outgoing scene mounted long enough to animate away, and (c)
 * re-seek the phase-locked animations whenever something changes. Two screens
 * running the same config therefore agree without ever talking to each other,
 * and a TV that reboots at 3am rejoins mid-show.
 *
 * TICK, DON'T ANIMATE. The 250ms interval only re-evaluates the DECISION. Every
 * moving pixel is a CSS animation on the compositor — there is no
 * requestAnimationFrame LOOP anywhere in this surface, which is what lets it run
 * for weeks on a mini PC without drifting into jank. (The phase-seek below does
 * schedule a one-shot rAF per DOM change to land its seek before paint; it never
 * re-arms itself, so there is still no frame loop.)
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { syncTvPhase } from "../clock";
import type { ResolvedScreenConfig } from "../defaults";
import type { SignageVenue } from "../constants";
import type { TvFeed } from "../types";
import type { DemoMode } from "../demo";
import { SceneSlot, sceneHasData, isSceneImplemented } from "../scenes/registry";
import { frameKey, resolveActiveScene, type SceneDecision } from "./schedule";

/** How often the decision is re-evaluated. Matches AttractBillboard's cadence:
 *  fine enough that a cut lands within a frame or two of its true instant,
 *  coarse enough to be invisible on a CPU budget. */
const TICK_MS = 250;
/** Must match the .tv-frame[data-state="exiting"] animation in tv.css. */
const EXIT_MS = 500;

export function SceneDirector({
  feed,
  offset,
  venue,
  config,
  asleep,
  demo,
  onDecision,
}: {
  feed: TvFeed | null;
  offset: number;
  venue: SignageVenue;
  config: ResolvedScreenConfig;
  asleep: boolean;
  demo: DemoMode;
  /** Lets the shell know whether it is safe to reload for a new deploy. */
  onDecision?: (d: SceneDecision) => void;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now() + offset);
  const rootRef = useRef<HTMLDivElement>(null);

  // Celebrations must never repeat on this screen. State rather than a ref so
  // the decision below can depend on it without reading a ref during render.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const tick = () => setNowMs(Date.now() + offset);
    const iv = setInterval(tick, TICK_MS);
    return () => clearInterval(iv);
  }, [offset]);

  const decision = useMemo(
    () =>
      resolveActiveScene({
        nowMs,
        config,
        hasData: (scene) => sceneHasData(scene, feed),
        events: feed?.kioskEvents ?? [],
        seenEventIds: seen,
        asleep,
        isImplemented: isSceneImplemented,
      }),
    [nowMs, config, feed, asleep, seen],
  );

  // A celebration is spent once its window closes, so the next one can show.
  const celebrationId = decision.scene === "celebration" ? decision.event?.id : undefined;
  const celebrationEndsAt = decision.startedAtMs + (decision.durationMs ?? 8000);
  useEffect(() => {
    if (!celebrationId) return;
    const remaining = Math.max(0, celebrationEndsAt - (Date.now() + offset));
    const t = setTimeout(() => {
      // Timer callback, not a sync effect body.
      setSeen((prev) => new Set(prev).add(celebrationId));
    }, remaining);
    return () => clearTimeout(t);
  }, [celebrationId, celebrationEndsAt, offset]);

  useEffect(() => {
    onDecision?.(decision);
  }, [decision, onDecision]);

  /* ── keep the outgoing scene alive long enough to leave ────────────────
     Adjusted DURING render (React's documented "adjust state when a prop
     changes" pattern) rather than in an effect: doing it in an effect would
     paint one frame of the new scene before the old one starts leaving, which
     is visible as a flicker at the top of every cut. */

  const [frames, setFrames] = useState<{ current: SceneDecision; outgoing: SceneDecision | null }>(
    () => ({ current: decision, outgoing: null }),
  );

  const key = frameKey(decision);
  if (frameKey(frames.current) !== key) {
    setFrames({ current: decision, outgoing: frames.current });
  }
  const { current, outgoing } = frames;

  // Retire the outgoing frame once its exit animation has finished.
  useEffect(() => {
    if (!outgoing) return;
    const t = setTimeout(() => setFrames((f) => ({ current: f.current, outgoing: null })), EXIT_MS);
    return () => clearTimeout(t);
  }, [outgoing]);

  /* ── phase-lock every shared animation ───────────────────────────────
     On mount, on every scene change, and on each clock resync — the same
     discipline the kiosk attract screen follows. Without the re-seek after a
     mount, a freshly-entered scene starts its ken-burns at zero while the
     screen beside it is 40 seconds in. */
  useEffect(() => {
    syncTvPhase(rootRef.current, offset);
  }, [offset, current.scene, current.startedAtMs]);

  /* ── and put mid-scene arrivals on the beat too ────────────────────────
     The seek above fires on a scene change and a clock resync — nothing else.
     Anything that starts flashing BETWEEN those began its cycle at that instant
     and stayed there: a name landing on the check-in rail, a rail flipping to
     "ready to send", a beacon that lights when a heat is called. One board ends
     up with four flashes at four different moments — the 4th of July (owner,
     2026-08-12). Matching durations in the CSS only make things flash at the
     same RATE; this is what makes them flash at the same TIME.

     A MutationObserver rather than another effect because it catches the change
     whichever component committed it — scenes here hold their own data hooks
     (SceneRaceCheckin polls useTrackStatus), so a child can re-render, and mount
     a new flashing element, without the director rendering at all.

     Coalesced into one rAF: at most one seek per frame, scheduled only when the
     DOM actually changed, and it lands before paint so the new element's first
     painted frame is already on the beat. Not a render loop — nothing re-arms
     it, and seeking an animation's currentTime is not itself a DOM mutation. */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let queued = 0;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        syncTvPhase(rootRef.current, offset);
      });
    });
    observer.observe(root, { childList: true, subtree: true, attributeFilter: ["class"] });

    return () => {
      observer.disconnect();
      if (queued) cancelAnimationFrame(queued);
    };
  }, [offset]);

  const props = { feed, nowMs, offset, venue, config, demo };

  return (
    <div ref={rootRef} style={{ position: "absolute", inset: 0 }}>
      {/* Everything rides a slow figure-8 so no pixel holds a bright element
          for hours. Backdrops overdraw the canvas, so this never shows an edge. */}
      <div className="tv-drift">
        {outgoing && (
          <div className="tv-frame" data-state="exiting" key={frameKey(outgoing)}>
            <SceneSlot {...props} decision={outgoing} />
          </div>
        )}

        <div className="tv-frame" data-state="entering" key={frameKey(current)}>
          <SceneSlot {...props} decision={current} />
        </div>

        {/* The wipe that covers the cut. Keyed to the incoming scene so it
            replays exactly once per change and unmounts with it. */}
        {outgoing && (
          <div
            aria-hidden
            key={`wipe-${frameKey(current)}`}
            className="tv-wipe"
            style={{
              left: 0,
              background:
                "linear-gradient(100deg, transparent, rgba(255,255,255,0.22), transparent)",
            }}
          />
        )}
      </div>
    </div>
  );
}
