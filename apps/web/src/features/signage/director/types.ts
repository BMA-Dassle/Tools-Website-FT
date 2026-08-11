/**
 * The contract every scene implements.
 *
 * A scene is a full-screen visual that receives the feed and the shared clock
 * and renders. It owns no timers of its own for anything that must agree with
 * another screen — it derives from `nowMs`, which the director recomputes on a
 * tick. That is what keeps two TVs with the same playlist in lockstep.
 */
import type { ResolvedScreenConfig } from "../defaults";
import type { SignageVenue } from "../constants";
import type { SceneDecision } from "./schedule";
import type { TvFeed } from "../types";

export interface SceneProps {
  /** Latest good feed. Never null once the screen has ever loaded one. */
  feed: TvFeed | null;
  /** Corrected shared clock: Date.now() + offset. */
  nowMs: number;
  /** Clock offset, for scenes that need to seek their own animations. */
  offset: number;
  venue: SignageVenue;
  config: ResolvedScreenConfig;
  /** Why this scene is on screen — carries the celebration event / VIP party. */
  decision: SceneDecision;
}

/**
 * NOTE ON PAIRED SCREENS — read before adding a spanning layout.
 *
 * The two karting boards are ~4 FEET APART (owner 2026-08-11), not a
 * bezel-to-bezel video wall. A single virtual canvas spanning both, with each
 * screen showing its own window, is therefore the WRONG model for anything
 * readable: a name split across four feet of wall is two broken halves, not a
 * wide name.
 *
 * Pairing is expressed in TIME instead — see SceneBirthdayTakeover. Each board
 * renders a complete composition; `pairing.position` drives when it takes its
 * turn in a clock-derived relay, and only abstract things (light, confetti)
 * play across the gap. `ScreenPairing` lives in ../types.
 */
