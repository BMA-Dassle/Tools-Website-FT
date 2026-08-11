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
    // event-welcome, vip-welcome, celebration, billboard-crown and race-checkin
    // land in the following PRs; until then they fall through to ads.
    case "ads":
    default:
      return <SceneAdRotation {...props} />;
  }
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
      return (feed?.events?.length ?? 0) > 0;
    case "vip-welcome":
      return (feed?.vip?.length ?? 0) > 0;
    case "race-checkin":
      // Ships with the racing-TV PR; until it can render, keep it out of any
      // rotation that names it rather than showing an empty track panel.
      return false;
    default:
      return true;
  }
}
