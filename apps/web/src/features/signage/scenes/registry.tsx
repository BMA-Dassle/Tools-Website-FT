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
import { SceneCameraMonitor } from "./SceneCameraMonitor";
import { ScenePitBoard } from "./ScenePitBoard";
import { SceneRaceResults } from "./SceneRaceResults";
import { SceneRaceGuide } from "./SceneRaceGuide";
import { SceneVipShowcase } from "./SceneVipShowcase";
import { SceneOpenNow } from "./SceneOpenNow";
import { SceneKioskHowto } from "./SceneKioskHowto";
import { raceGuideEnabled } from "../flags";

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
    case "camera":
      return <SceneCameraMonitor {...props} />;
    case "pit-board":
      return <ScenePitBoard {...props} />;
    case "race-results":
      return <SceneRaceResults {...props} />;
    case "race-guide":
      // The kill switch is checked HERE rather than inside the scene, so
      // flipping it falls all the way through to house ads (the default below)
      // instead of leaving a screen on a setup notice.
      return raceGuideEnabled() ? <SceneRaceGuide {...props} /> : <SceneAdRotation {...props} />;
    // THE FRONT-DESK WALL. All three read their panel position through choreo()
    // and render one fifth of a composition. None of them may ever be given
    // `requiresData` — see the tear invariant in defaults.ts FRONT_DESK_CONFIG.
    case "vip-showcase":
      return <SceneVipShowcase {...props} />;
    case "open-now":
      return <SceneOpenNow {...props} />;
    case "kiosk-howto":
      return <SceneKioskHowto {...props} />;
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
  "camera",
  "pit-board",
  "race-results",
  "race-guide",
  "event-welcome",
  "vip-welcome",
  "celebration",
  "vip-showcase",
  "open-now",
  "kiosk-howto",
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
    case "camera":
      // Always true: a monitor's whole job is the live picture, and it has its
      // own designed states for "connecting" and "no camera picked". It must
      // never rotate away to ads.
      return true;
    case "pit-board":
      // Always true: this screen is ALWAYS assignment (owner 2026-08-13) and
      // has a designed idle state for "no session staged". Rotating a pit
      // board away to ads would be exactly the vendor-TV behaviour it
      // replaces at its worst.
      return true;
    case "race-guide":
      // Always true: the rotation needs no server data at all — the cards are
      // copy and the qualifying numbers are constants — and the takeover is the
      // reason the screen exists. Rotating it away to ads would mean the arrow
      // is not up at the one moment it matters.
      return true;
    case "vip-showcase":
    case "kiosk-howto":
      // Always true, and it MUST be. These are copy and live prices, not a feed
      // selector — but more importantly, a data-gated entry that closes changes
      // `totalSlots` on ONE panel, and scene selection is `slot % totalSlots`. Five
      // players poll on independent 15s phases, so they can briefly disagree about
      // emptiness and the wall visibly tears. Nothing on a wall may be gated.
      return true;
    case "open-now":
      // Always true for the same reason. The menu board degrades WITHIN itself
      // when the availability cache is cold — tiles keep their names and prices
      // and simply carry no times — rather than dropping out of the rotation.
      return true;
    case "race-results":
      // Always true: the last race's result HOLDS until the next one lands, so
      // "no data" only ever means the first race of the day has not finished —
      // and the board has a designed card for exactly that. Rotating a scores
      // wall away to ads because a heat is still running would empty it at the
      // one moment a group is walking towards it.
      return true;
    default:
      return true;
  }
}
