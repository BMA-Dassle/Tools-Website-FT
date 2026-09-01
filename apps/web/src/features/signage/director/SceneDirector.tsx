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
import { TvBrandLogo } from "../components/TvBrandLogo";
import { frameKey, resolveActiveScene, type SceneDecision } from "./schedule";

/** How often the decision is re-evaluated. Matches AttractBillboard's cadence:
 *  fine enough that a cut lands within a frame or two of its true instant,
 *  coarse enough to be invisible on a CPU budget. */
const TICK_MS = 250;
/** Must match the .tv-frame[data-state="exiting"] animation in tv.css. */
const EXIT_MS = 500;
/**
 * The same, for a panel on a VIDEO WALL — must match `.tv-frame--wall`.
 *
 * Longer because the wall cross-dissolves instead of cutting: five panels each
 * decide on their own 250ms tick, so they can begin the same transition a quarter
 * of a second apart, and a long dissolve is what makes that spread a fraction of
 * the move rather than the whole of it. Retiring the outgoing frame at 500ms would
 * chop the dissolve off two-thirds through and put the hard cut straight back.
 */
const WALL_EXIT_MS = 1100;

/**
 * THE FASTTRAX MARK ON EVERY BOARD (owner 2026-08-14: "need to find a good spot
 * to add our FastTrax logo to all boards. Can be different based on the board or
 * scene").
 *
 * Placed HERE rather than in ten scenes, so it cannot drift out of sync as
 * scenes are edited — but the corner is per scene, because the corners are not
 * equally free. It rides INSIDE `.tv-drift` deliberately: the drift exists to
 * stop any bright element burning into a panel that runs for years, and a logo
 * pinned to a fixed corner all day is exactly what that protects against.
 *
 * QUIET BY DEFAULT — half opacity and small. This is a signature on work the
 * guest is already reading, not a thing competing with it.
 *
 * SOME SCENES OPT OUT, each for its own reason:
 *   sleep       the screen is meant to be dark
 *   celebration, birthday-takeover, event-welcome
 *               full-bleed moments that are already branded, and a corner mark
 *               would just be clutter over somebody's name
 *   ad-rotation the slides carry their own artwork edge to edge
 *   briefing    all four corners are taken (eyebrow, live-session chip, the
 *               camera-return strip) and the video phase is full-bleed film —
 *               it needs a spot chosen against the real wall, not guessed
 */
const LOGO_CORNER: Record<
  string,
  "top-left" | "top-right" | "bottom-left" | "bottom-right" | null
> = {
  // Nothing is enabled yet. The first attempt put the mark bottom-left on the
  // pit board, straight on top of the green "SEAT SESSION NOW" rail (owner
  // 2026-08-14: "that was stupid spot for logo") — which is what guessing at a
  // corner from the code gets you. These boards are dense and authored to the
  // pixel: every corner of the pit board is already doing a job (track name,
  // on-track clock, seat rail, qualifying chip), and the briefing room's four
  // are taken by the eyebrow, the live clock, the helmet art and the camera
  // strip.
  //
  // So this is OPT-IN, one line per board, added only once somebody has looked
  // at that board and pointed at the space. Better a mark on three boards that
  // look right than on ten that look like an accident.
};

/** No mark unless a board opts in above — see the note there. */
const LOGO_DEFAULT = null;

function SceneLogo({ scene, venue }: { scene: string; venue: SignageVenue }) {
  const corner = scene in LOGO_CORNER ? LOGO_CORNER[scene] : LOGO_DEFAULT;
  if (!corner) return null;
  const [vert, horiz] = corner.split("-") as ["top" | "bottom", "left" | "right"];
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        [vert]: 34,
        [horiz]: 40,
        opacity: 0.5,
        pointerEvents: "none",
        zIndex: 5,
      }}
    >
      <TvBrandLogo venue={venue} height={44} />
    </div>
  );
}

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

  // The feed's CURRENT event ids, for pruning `seen` when it grows — a ref so
  // the celebration timer below reads them at fire time without re-arming on
  // every 15s poll. An id no longer in the feed cannot be chosen again
  // (celebrationAt age-discards long before the feed forgets), so remembering
  // it forever bought nothing — and on a lobby board firing on every kiosk
  // booking, "forever" was thousands of retained ids on a page that never
  // unmounts.
  const feedEventIdsRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    feedEventIdsRef.current = new Set((feed?.kioskEvents ?? []).map((e) => e.id));
  }, [feed]);

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
        arenaCalls: feed?.arena?.calls,
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
      // Timer callback, not a sync effect body. Prunes to ids the feed still
      // carries while it adds — see feedEventIdsRef above.
      setSeen((prev) => {
        const live = feedEventIdsRef.current;
        const next = new Set<string>();
        for (const id of prev) if (live.has(id)) next.add(id);
        next.add(celebrationId);
        return next;
      });
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

  // A panel of a video wall dissolves; every other screen keeps the cut it has.
  const onWall = !!config.wall;

  // Retire the outgoing frame once its exit animation has finished.
  useEffect(() => {
    if (!outgoing) return;
    const t = setTimeout(
      () => setFrames((f) => ({ current: f.current, outgoing: null })),
      onWall ? WALL_EXIT_MS : EXIT_MS,
    );
    return () => clearTimeout(t);
  }, [outgoing, onWall]);

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
          <div
            className={onWall ? "tv-frame tv-frame--wall" : "tv-frame"}
            data-state="exiting"
            key={frameKey(outgoing)}
          >
            <SceneSlot {...props} decision={outgoing} />
          </div>
        )}

        <div
          className={onWall ? "tv-frame tv-frame--wall" : "tv-frame"}
          data-state="entering"
          key={frameKey(current)}
        >
          <SceneSlot {...props} decision={current} />
          <SceneLogo scene={String(current.scene)} venue={venue} />
        </div>

        {/* The wipe that covers the cut. Keyed to the incoming scene so it
            replays exactly once per change and unmounts with it.
            NOT ON A WALL: a bright bar crossing five panels, each starting on its
            own 250ms tick, is the one thing that makes the panels' disagreement
            trackable by eye. The wall dissolves instead — see `.tv-frame--wall`. */}
        {outgoing && !onWall && (
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
