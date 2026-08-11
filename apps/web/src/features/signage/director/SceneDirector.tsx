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
 * requestAnimationFrame loop anywhere in this surface, which is what lets it run
 * for weeks on a mini PC without drifting into jank.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { syncTvPhase } from "../clock";
import type { ResolvedScreenConfig } from "../defaults";
import type { SignageVenue } from "../constants";
import type { TvFeed } from "../types";
import type { DemoMode } from "../demo";
import { SceneSlot, sceneHasData, isSceneImplemented } from "../scenes/registry";
import { resolveActiveScene, type SceneDecision } from "./schedule";

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

/**
 * When does a decision count as a NEW frame (remount + entrance replay)?
 *
 * IDENTITY FIRST, timestamp only as a fallback. A decision that carries an
 * intrinsic identity — which celebration, which VIP party — is the same frame
 * for as long as that identity holds, however its timestamps wobble. Keying on
 * startedAtMs alongside the id is what made the VIP takeover remount and replay
 * its entrance every beat ("the screen is freaking out", owner 2026-08-11):
 * the preview fixture's times drift a little with every poll, and the old key
 * treated each drift as a brand-new takeover.
 *
 * Rotation segments and the crown have no identity of their own, so their
 * (stable, slot-derived) start time is the right key — it is what makes an
 * 80-second welcome segment enter once, not once per slot.
 */
function frameKey(d: SceneDecision): string {
  const identity = d.event?.id;
  return identity ? `${d.scene}:${identity}` : `${d.scene}:${d.startedAtMs}`;
}
