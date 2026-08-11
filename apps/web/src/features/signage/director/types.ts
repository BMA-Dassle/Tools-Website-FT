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
 * Where a screen stands in a choreographed group, for scenes that span more
 * than one physical display.
 *
 * The whole trick: a paired scene lays itself out on ONE virtual canvas
 * `count × 1920` wide and each screen shows its own 1920px window of it. Text
 * can then run across the gap between two TVs, and a confetti particle that
 * leaves the right edge of screen 0 arrives on screen 1 — with no messaging
 * between them at all, because both are drawing the same picture from the same
 * shared clock.
 */
export interface PairedLayout {
  position: number;
  count: number;
  /** Total virtual width in canvas px. */
  spanW: number;
  /** How far to shift the virtual canvas left for this screen. */
  offsetX: number;
}

export function pairedLayout(
  pairing: { position: number; count: number } | null,
  tvWidth: number,
): PairedLayout | null {
  if (!pairing || pairing.count < 2) return null;
  const position = Math.min(Math.max(0, pairing.position), pairing.count - 1);
  return {
    position,
    count: pairing.count,
    spanW: tvWidth * pairing.count,
    offsetX: -position * tvWidth,
  };
}
