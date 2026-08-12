"use client";

/**
 * THE CAMERA RETURN STRIP — the bottom 104 px of a briefing room TV.
 *
 * WHY IT IS HERE (owner 2026-08-12): "when a race finishes we would turn those
 * camera numbers RED. They would not turn green till we see them check into one
 * of the systems… otherwise we would have trouble if we put them out to next
 * race." Which cameras, and what the colours mean, is decided by the pure module
 * (briefing/camera-return.ts) — this file only paints it.
 *
 * FOUR THINGS ABOUT IT THAT ARE DELIBERATE:
 *
 *  1. IT NEVER MOVES. No blink, no pulse, no transition, and no `flex: 1` on a
 *     box (a box that grows as its neighbours come and go is animation by another
 *     name). Owner asked for no blinking: "no motion on a guest-facing screen."
 *     The minutes-out figure under each red number is what carries urgency
 *     instead. This is also why the strip is not in the tv.css motion table.
 *  2. THE 104 px IS RESERVED IN EVERY PHASE, clear or not — see SceneBriefing.
 *     A strip that appeared when a camera went red would shove the safety film
 *     and the welcome-back board upward mid-briefing, in front of a room full of
 *     people. Fixed reserve, no reflow, ever.
 *  3. AN ALL-CLEAR LINE, NOT A BLANK. `boxes: []` paints "All in" (owner's
 *     choice) because a blank bottom edge cannot be told apart from a broken
 *     feature or a pulled kill switch. Absent data — the flag off, or a failed
 *     read — renders nothing at all, and that difference is the whole point.
 *  4. IT IS STAFF INFORMATION ON A GUEST-FACING BOARD, so it holds camera
 *     numbers and nothing else: no names, no heat rosters, no PII. A guest
 *     reading it learns that camera 23 is not back, which is harmless and
 *     occasionally useful.
 */
import { formatSinceFlag } from "../briefing/camera-return";
import { LiveSessionChip } from "../live-session";
import type { TrackKey } from "~/features/reservations-admin/race-live-state";

/**
 * TWO HEIGHTS, because the strip should only take the room it has earned.
 *
 * With cameras out it needs 104 px for a 72 px box plus its minutes line. With
 * nothing to say it collapses to a 44 px whisper (owner 2026-08-12: "I think I
 * want the all cameras in to be very small and less noticeable") — the first cut
 * gave the all-clear the same big italic treatment as a problem and spent a
 * sixth of the helmet poster saying nothing was wrong.
 *
 * THE ONE REFLOW THIS ALLOWS is the strip growing when a camera actually goes
 * red, and it is worth it: it happens at a moment that deserves attention, the
 * film is `objectFit: cover` so it re-crops rather than letterboxing, and it is
 * one transition rather than a flicker (which is what `stale` exists to prevent —
 * a failed read holds the height it already had).
 */
const BAR_H = 104;
const BAR_CLEAR_H = 44;

/** The height the scene must reserve for a given strip. ONE definition, so the
 *  wrapper's bottom inset and the bar itself can never disagree. */
export function cameraBarHeight(strip: { boxes: unknown[] } | null | undefined): number {
  if (!strip) return 0;
  return strip.boxes.length > 0 ? BAR_H : BAR_CLEAR_H;
}

/** Fixed, not flex: see note 1. Wide enough for three digits (the fleet runs
 *  1–96, and the barcode API accepts up to 999). */
const BOX_W = 84;
const BOX_H = 72;

/** The one hue pair on the strip. Both come straight from tv.css tokens — the
 *  same red as a track accent, the same green as a qualifying pill — so the
 *  strip reads as part of the estate rather than a bolted-on warning light. */
const RED = "#e53935";
const RED_EDGE = "#ff5a53";
const GREEN = "#46d68c";
/** Ink on the green fill. Dark, because #fff on #46d68c fails contrast at a
 *  glance from across a room. */
const GREEN_INK = "#04231a";

export interface CameraReturnBox {
  camera: string;
  state: "out" | "back";
  heatNumber: number | null;
  sinceFlagMs: number;
  /** Past the overdue mark with no sighting — solid, and grouped left of the
   *  divider. See the note on the divider in CameraReturnBar. */
  overdue: boolean;
  assignedAtMs: number;
}

export function CameraReturnBar({
  boxes,
  outCount,
  stale,
  padX,
  clockTrack,
  accent,
}: {
  boxes: CameraReturnBox[];
  outCount: number;
  /** Could not read the facts this poll — hold the space, claim nothing. */
  stale?: boolean;
  /** The scene's horizontal padding, so the caption lines up with the eyebrow
   *  above it rather than floating at its own inset. */
  padX: number;
  /**
   * THE ON-TRACK CLOCK NOW LIVES HERE, at the right end of the strip (owner
   * 2026-08-12: "the on track timing on the briefing screens could make it to the
   * bottom right on the new camera bar that way its out of the way").
   *
   * This SUPERSEDES the 2026-08-11 decision that put it top-right on every board
   * — that was the right answer when the only alternative was the bottom edge of
   * a film, which is where subtitles burn in. The strip changes the arithmetic:
   * there is now a permanent chrome band down there that already belongs to
   * staff, so the clock stops floating over the artwork. Do not "restore" it to
   * the corner.
   *
   * Null track, or no heat running, renders nothing.
   */
  clockTrack: TrackKey | null;
  accent: string;
}) {
  const quiet = boxes.length === 0;

  /**
   * NOTHING TO SAY, SAID QUIETLY. One small dim line, no display type, no
   * sentence — a room full of guests should not be reading an inventory notice,
   * and staff only need to be able to tell the strip is alive rather than
   * switched off. `stale` shares this treatment but not its wording: it must not
   * claim an all-clear it cannot stand behind.
   */
  if (quiet) {
    return (
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: BAR_CLEAR_H,
          zIndex: 7,
          display: "flex",
          alignItems: "center",
          // Right of the version stamp in the corner, aligned with the boards above.
          padding: `0 ${Math.max(24, padX - 66)}px`,
          background: "rgba(0, 4, 24, 0.72)",
          borderTop: "1px solid rgba(245, 236, 238, 0.07)",
        }}
      >
        <span
          style={{
            fontSize: 20,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "rgba(245, 236, 238, 0.28)",
          }}
        >
          {stale ? "Cameras — list unavailable" : "Cameras all in"}
        </span>
        <div style={{ marginLeft: "auto" }}>
          <LiveSessionChip track={clockTrack} accent={accent} compact />
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: BAR_H,
        zIndex: 7,
        display: "flex",
        alignItems: "center",
        gap: 24,
        // Slightly less than the scene padding: the boxes are a dense row and
        // giving them the full 96px inset wastes width the numbers want.
        padding: `0 ${Math.max(24, padX - 66)}px`,
        background: "linear-gradient(to top, rgba(0, 4, 24, 0.98), rgba(0, 4, 24, 0.86))",
        borderTop: "2px solid rgba(245, 236, 238, 0.16)",
      }}
    >
      <div style={{ flex: "0 0 auto", minWidth: 210, display: "flex", flexDirection: "column" }}>
        <span
          className="tv-eyebrow"
          style={{ fontSize: 19, letterSpacing: "0.24em", color: "rgba(245, 236, 238, 0.5)" }}
        >
          Cameras
        </span>
        <span className="tv-display tv-num" style={{ fontSize: 38, color: "#ff4b45" }}>
          {outCount} still out
        </span>
      </div>

      {/* THE SEPARATION (owner 2026-08-12: "I like having separation show on
          bottom"). Everything left of the rule is overdue — go and find it.
          Everything right of it is a group still handing kit in. Without the
          split, three dead units and two cameras four minutes old read as five
          equal alarms, and the real ones get diluted. The rule is only drawn when
          both sides exist. */}
      <div style={{ display: "flex", flex: "0 1 auto", alignItems: "center", overflow: "hidden" }}>
        {boxes.map((b, i) => {
          const dividerBefore = i > 0 && boxes[i - 1].overdue && !b.overdue;
          return (
            <div key={b.camera} style={{ display: "flex", alignItems: "center" }}>
              {dividerBefore && (
                <div
                  aria-hidden
                  style={{
                    width: 2,
                    height: 56,
                    margin: "0 20px",
                    borderRadius: 1,
                    background: "rgba(245, 236, 238, 0.22)",
                    flex: "0 0 auto",
                  }}
                />
              )}
              <div style={{ marginLeft: i === 0 || dividerBefore ? 0 : 9 }}>
                <CameraBox box={b} />
              </div>
            </div>
          );
        })}
      </div>

      {/* The on-track clock, out of the way at the far right — see clockTrack. */}
      <div style={{ marginLeft: "auto", flex: "0 0 auto" }}>
        <LiveSessionChip track={clockTrack} accent={accent} />
      </div>
    </div>
  );
}

/**
 * One camera.
 *
 * The minutes line only appears on a red box: on a green one it would be
 * answering a question nobody has any more, and an empty line would make the two
 * states different heights.
 */
function CameraBox({ box }: { box: CameraReturnBox }) {
  const out = box.state === "out";
  /**
   * TWO WEIGHTS OF RED, so the wall does not shout equally at everything.
   *
   * SOLID is the chase list — past OVERDUE_MS with no sighting. OUTLINE is a
   * camera whose race has just finished and whose group is still walking back;
   * present and countable, but not an alarm. Escalating from outline to solid at
   * the ten-minute mark is the only thing on this strip that changes appearance
   * over time, and it does so once.
   */
  const solid = out && box.overdue;
  return (
    <div
      // Staff read the colour; a screen reader would get "23" with no meaning.
      // Signage is a wall panel with no assistive path, but the label costs
      // nothing and makes the intent legible to the next developer too.
      aria-label={
        out
          ? `Camera ${box.camera} ${box.overdue ? "overdue" : "not back"}${box.heatNumber != null ? ` from session ${box.heatNumber}` : ""}, ${formatSinceFlag(box.sinceFlagMs)}`
          : `Camera ${box.camera} back`
      }
      style={{
        width: BOX_W,
        height: BOX_H,
        flex: "0 0 auto",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        border: `2px solid ${out ? RED_EDGE : GREEN}`,
        background: out ? (solid ? RED : "rgba(229, 57, 53, 0.14)") : GREEN,
        color: out ? (solid ? "#fff" : RED_EDGE) : GREEN_INK,
        // Painted once and never animated — the 24/7 rulebook in tv.css bans
        // animating box-shadow, and this one is static so it is free. Only the
        // chase list gets the glow; the calm ones would fight it for attention.
        boxShadow: solid ? `0 0 18px rgba(229, 57, 53, 0.7)` : "none",
      }}
    >
      <span className="tv-num" style={{ fontSize: 40, fontWeight: 700, lineHeight: 1 }}>
        {box.camera}
      </span>
      {out && (
        <span
          className="tv-num"
          style={{
            fontSize: 18,
            lineHeight: 1,
            color: solid ? "rgba(255, 255, 255, 0.82)" : "rgba(255, 122, 116, 0.85)",
          }}
        >
          {formatSinceFlag(box.sinceFlagMs)}
        </span>
      )}
    </div>
  );
}

export { BAR_H as CAMERA_BAR_H, BAR_CLEAR_H as CAMERA_BAR_CLEAR_H };
