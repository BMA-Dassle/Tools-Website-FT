"use client";

/**
 * Scene type → component, and "does this scene have anything to show?".
 *
 * This map is the ONE place a new scene is wired in. Everything else about
 * which screens run it, how often, and what triggers it lives in per-screen
 * config in Neon — that separation is what makes hanging a differently-purposed
 * TV a form submission rather than a deploy.
 *
 * Scenes not yet built fall back to the ad rotation rather than rendering
 * nothing: a wall must never go blank because a playlist named a scene this
 * deploy doesn't have (a config written by a newer deploy, or rolled back code).
 */
import type { SceneType, TvFeed } from "../types";
import type { SceneProps } from "../director/types";
import { SceneAdRotation } from "./SceneAdRotation";
import { SceneSleep } from "./SceneSleep";
import { SceneRaceCheckin } from "./SceneRaceCheckin";
import { SceneCelebration } from "./SceneCelebration";
import { SceneBirthdayTakeover } from "./SceneBirthdayTakeover";
import { SceneEventWelcome } from "./SceneEventWelcome";
import { SceneVipWelcome } from "./SceneVipWelcome";
import { SceneBriefing } from "./SceneBriefing";

/**
 * Render whichever scene a decision names.
 *
 * A switch over static component references rather than a lookup table that
 * hands a component back to the caller: the table form reads to React as
 * creating a component during render, which risks remounting the whole scene
 * subtree on a tick. Adding a scene means adding a case here and nothing else.
 *
 * The `default` is load-bearing. A playlist may name a scene this deploy does
 * not have — a config written by a newer deploy, or code rolled back under a
 * live screen — and the answer to that is house advertising, never a blank wall.
 */
export function SceneSlot(props: SceneProps) {
  switch (props.decision.scene) {
    case "sleep":
      return <SceneSleep {...props} />;
    case "race-checkin":
      return <SceneRaceCheckin {...props} />;
    case "briefing":
      return <SceneBriefing {...props} />;
    case "event-welcome":
      return <SceneEventWelcome {...props} />;
    case "vip-welcome":
      return <SceneVipWelcome {...props} />;
    case "celebration":
      // A birthday check-in is a different animal from an ordinary scan: it
      // takes over both boards at once and runs for longer. Routed here rather
      // than branched inside SceneCelebration so the two never share layout.
      return props.decision.event?.birthday ? (
        <SceneBirthdayTakeover {...props} />
      ) : (
        <SceneCelebration {...props} />
      );
    // billboard-crown lands in a following PR; until then it falls through.
    case "ads":
    default:
      return <SceneAdRotation {...props} />;
  }
}

/**
 * Which scenes actually EXIST in this deploy.
 *
 * The `default` case below falls through to house ads, which is right for a
 * scene name we have never heard of — a config written by a newer deploy, or
 * code rolled back under a live screen. It is badly wrong for a scene we know
 * about but have not built yet: the scheduler happily selects it, the switch
 * quietly renders something else, and the screen shows ads for a third of every
 * cycle with nothing to explain it.
 *
 * That is exactly what happened to the HeadPinz board — billboard-crown was
 * enabled, preempted the rotation, and painted ads (owner 2026-08-11, "those
 * two options on headpinz still not working"). The scheduler now asks this
 * before selecting anything.
 */
const IMPLEMENTED: ReadonlySet<SceneType> = new Set<SceneType>([
  "ads",
  "sleep",
  "race-checkin",
  "briefing",
  "event-welcome",
  "vip-welcome",
  "celebration",
]);

export function isSceneImplemented(scene: SceneType): boolean {
  return IMPLEMENTED.has(scene);
}

/**
 * Whether a data-gated scene has anything worth showing right now. Used by the
 * rotation builder to close over empty scenes instead of rendering a blank
 * panel — see buildRotation.
 *
 * `ads` is deliberately always true: it needs no server data at all, which is
 * exactly why it is the floor every degraded path falls back to.
 */
export function sceneHasData(scene: SceneType, feed: TvFeed | null): boolean {
  switch (scene) {
    case "ads":
    case "sleep":
      return true;
    case "event-welcome":
      // VIP parties are welcome-board content — the gold slide alternates with
      // the party pages — so either kind of data earns the segment its slot.
      return (feed?.events?.length ?? 0) > 0 || (feed?.vip?.length ?? 0) > 0;
    case "vip-welcome":
      return (feed?.vip?.length ?? 0) > 0;
    case "race-checkin":
      // Always true: the scene fetches its own session and delay from
      // useTrackStatus (the same endpoints the website uses), and it has a
      // designed idle state for "no session checking in yet". A track screen
      // whose whole job is this must not rotate away from it just because the
      // track is between heats.
      return true;
    case "briefing":
      // Always true, for the same reason and more strongly: a briefing room's
      // idle state (helmet sizing) is content the next group actively wants, and
      // rotating away from it between sends would leave the room with ads.
      return true;
    default:
      return true;
  }
}
