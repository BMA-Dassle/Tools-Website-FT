"use client";

/**
 * THE CAMERA RETURN STRIP — the bottom band of a briefing room TV.
 *
 * WHY IT IS HERE (owner 2026-08-12): "when a race finishes we would turn those
 * camera numbers RED. They would not turn green till we see them check into one
 * of the systems… otherwise we would have trouble if we put them out to next
 * race." Which cameras and what each means is decided by the pure module
 * (briefing/camera-return.ts); this file only paints it.
 *
 * TWO LABELLED SECTIONS, because one row of red and green did not read — the
 * owner watched six green boxes on the wall and asked what they meant, which is
 * the only review that counts:
 *
 *   STILL OUT   left. Their race is over, the NEXT race has been called, and they
 *               never came back. Red, with how long they have been missing.
 *   INCOMING    right. The group that has just come off track. GREY until the
 *               camera registers, GREEN once it does. When the next race is
 *               called this section settles: green ones have been accounted for
 *               and leave, grey ones move left into STILL OUT.
 *
 * FOUR THINGS THAT ARE DELIBERATE:
 *
 *  1. NOTHING BLINKS, PULSES OR SLIDES, and no box is `flex: 1` (a box that grows
 *     as its neighbours come and go is animation by another name). Owner: no
 *     motion on a guest-facing screen. This is why the strip appears nowhere in
 *     tv.css's motion table.
 *  2. A CALM BOX WEARS ITS TRACK'S COLOUR so staff know which way to walk. Only
 *     the calm ones: solid red is reserved for the chase list, because Red
 *     Track's own accent IS red and a still-incoming Red camera painted the same
 *     way would make the one colour that means "go and find it" also mean
 *     "everything is normal".
 *  3. AN ALL-CLEAR WHISPER, NOT A BLANK. Nothing outstanding collapses the band
 *     to a 44px dim line, because a blank bottom edge cannot be told apart from a
 *     broken feature or a pulled kill switch. Absent data renders nothing at all,
 *     and that difference is the point.
 *  4. IT IS STAFF INFORMATION ON A GUEST-FACING BOARD, so it carries camera
 *     numbers and nothing else — no names, no rosters, no PII.
 */
import { formatSinceFlag } from "../briefing/camera-return";
import { LiveSessionChip } from "../live-session";
import { TRACK_ACCENTS } from "../track";
import { withAlpha } from "../color";
import type { TrackKey } from "~/features/reservations-admin/race-live-state";

/**
 * TWO HEIGHTS, because the strip should only take the room it has earned. With
 * anything to show it needs 104 px for a 72 px box plus its label line; with
 * nothing it collapses to a 44 px whisper (owner: "I want the all cameras in to
 * be very small and less noticeable").
 *
 * THE ONE REFLOW THIS ALLOWS is the band growing when something appears. It
 * happens at a moment that deserves attention, the film is `objectFit: cover` so
 * it re-crops rather than letterboxing, and it is a single transition rather than
 * a flicker — which is what `stale` exists to prevent.
 */
const BAR_H = 104;
const BAR_CLEAR_H = 44;

/** The height the scene must reserve. ONE definition, so the wrapper's bottom
 *  inset and the bar itself can never disagree. */
export function cameraBarHeight(
  strip: { stillOut: unknown[]; incoming: unknown[] } | null | undefined,
): number {
  if (!strip) return 0;
  return strip.stillOut.length + strip.incoming.length > 0 ? BAR_H : BAR_CLEAR_H;
}

/** Fixed, not flex: see note 1. Wide enough for three digits (the fleet runs
 *  1–96, and the barcode API accepts up to 999). */
const BOX_W = 84;
const BOX_H = 72;

const RED = "#e53935";
const RED_EDGE = "#ff5a53";
const GREEN = "#46d68c";
/** Ink on the green fill. Dark, because #fff on #46d68c fails contrast at a
 *  glance from across a room. */
const GREEN_INK = "#04231a";
/** GREY = expected back, nothing seen yet. Deliberately inert: this is the state
 *  that should read as "normal, in progress", not as a problem. */
const GREY_EDGE = "rgba(245, 236, 238, 0.34)";
const GREY_FILL = "rgba(245, 236, 238, 0.07)";
const GREY_INK = "rgba(245, 236, 238, 0.72)";

export interface CameraReturnBox {
  camera: string;
  state: "still-out" | "waiting" | "back";
  heatNumber: number | null;
  /** Circuit it went out on — painted on the calm boxes only. */
  track: "blue" | "red" | "mega" | null;
  sinceFlagMs: number;
  assignedAtMs: number;
}

export function CameraReturnBar({
  stillOut,
  incoming,
  stale,
  padX,
  clockTrack,
  accent,
}: {
  stillOut: CameraReturnBox[];
  incoming: CameraReturnBox[];
  /** Could not read the facts this poll — hold the space, claim nothing. */
  stale?: boolean;
  /** The scene's horizontal padding, so the strip lines up with the boards. */
  padX: number;
  /**
   * THE ON-TRACK CLOCK LIVES HERE, at the right end (owner 2026-08-12: "the on
   * track timing on the briefing screens could make it to the bottom right on the
   * new camera bar that way its out of the way").
   *
   * This SUPERSEDES the 2026-08-11 decision that put it top-right on every board
   * — that corner was the right answer only while the alternative was floating
   * over a film, where subtitles burn in. The strip is permanent staff chrome, so
   * the clock stops sitting on the artwork. Do not "restore" it to the corner.
   */
  clockTrack: TrackKey | null;
  accent: string;
}) {
  const empty = stillOut.length + incoming.length === 0;
  const inset = Math.max(24, padX - 66);

  /**
   * NOTHING TO SAY, SAID QUIETLY. One small dim line, no display type, no
   * sentence — a room full of guests should not be reading an inventory notice,
   * and staff only need to see that the strip is alive rather than switched off.
   * `stale` shares the treatment but not the wording: it must not claim an
   * all-clear it cannot stand behind.
   */
  if (empty) {
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
          padding: `0 ${inset}px`,
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
        gap: 22,
        padding: `0 ${inset}px`,
        background: "linear-gradient(to top, rgba(0, 4, 24, 0.98), rgba(0, 4, 24, 0.86))",
        borderTop: "2px solid rgba(245, 236, 238, 0.16)",
        overflow: "hidden",
      }}
    >
      {stillOut.length > 0 && (
        <Section
          label="Cameras"
          value={`${stillOut.length} still out`}
          valueColor="#ff4b45"
          boxes={stillOut}
        />
      )}

      {stillOut.length > 0 && incoming.length > 0 && (
        <div
          aria-hidden
          style={{
            width: 2,
            height: 60,
            borderRadius: 1,
            background: "rgba(245, 236, 238, 0.2)",
            flex: "0 0 auto",
          }}
        />
      )}

      {incoming.length > 0 && (
        <Section
          label="Incoming"
          value={`${incoming.filter((b) => b.state === "back").length} of ${incoming.length} back`}
          valueColor="rgba(245, 236, 238, 0.62)"
          boxes={incoming}
        />
      )}

      {/* The on-track clock, out of the way at the far right — see clockTrack. */}
      <div style={{ marginLeft: "auto", flex: "0 0 auto" }}>
        <LiveSessionChip track={clockTrack} accent={accent} />
      </div>
    </div>
  );
}

/** A captioned run of boxes. Both sections are the same object, which is what
 *  keeps them reading as one strip rather than two competing widgets. */
function Section({
  label,
  value,
  valueColor,
  boxes,
}: {
  label: string;
  value: string;
  valueColor: string;
  boxes: CameraReturnBox[];
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18, flex: "0 1 auto", minWidth: 0 }}>
      <div style={{ flex: "0 0 auto", display: "flex", flexDirection: "column" }}>
        <span
          className="tv-eyebrow"
          style={{ fontSize: 18, letterSpacing: "0.22em", color: "rgba(245, 236, 238, 0.45)" }}
        >
          {label}
        </span>
        <span className="tv-display tv-num" style={{ fontSize: 30, color: valueColor }}>
          {value}
        </span>
      </div>
      <div style={{ display: "flex", gap: 9, flex: "0 1 auto", minWidth: 0, overflow: "hidden" }}>
        {boxes.map((b) => (
          <CameraBox key={b.camera} box={b} />
        ))}
      </div>
    </div>
  );
}

/** One camera: its number, and one line saying what its colour means. */
function CameraBox({ box }: { box: CameraReturnBox }) {
  const missing = box.state === "still-out";
  const back = box.state === "back";

  /**
   * A CALM BOX WEARS ITS TRACK'S COLOUR (owner 2026-08-12: "if we're not showing
   * green or red colors as status why don't we make those the color of the track
   * they were on last?"). A bare number says nothing about where to walk; the
   * circuit does. Only the WAITING boxes take it — see note 2 in the header for
   * why solid red and green stay reserved for status.
   */
  const trackAccent = box.state === "waiting" && box.track ? TRACK_ACCENTS[box.track] : null;

  const border = missing ? RED_EDGE : back ? GREEN : (trackAccent ?? GREY_EDGE);
  const background = missing
    ? RED
    : back
      ? GREEN
      : trackAccent
        ? withAlpha(trackAccent, 0.12)
        : GREY_FILL;
  const ink = missing ? "#fff" : back ? GREEN_INK : (trackAccent ?? GREY_INK);

  return (
    <div
      // Staff read the colour; the label makes the intent legible to the next
      // developer, and costs nothing on a panel with no assistive path.
      aria-label={
        missing
          ? `Camera ${box.camera} still out${box.heatNumber != null ? ` from session ${box.heatNumber}` : ""}, ${formatSinceFlag(box.sinceFlagMs)}`
          : back
            ? `Camera ${box.camera} back`
            : `Camera ${box.camera} incoming`
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
        border: `2px solid ${border}`,
        background,
        color: ink,
        // Painted once and never animated — the 24/7 rulebook in tv.css bans
        // animating box-shadow, and only the chase list gets a glow: the calm
        // boxes would fight it for attention.
        boxShadow: missing ? "0 0 18px rgba(229, 57, 53, 0.7)" : "none",
      }}
    >
      <span className="tv-num" style={{ fontSize: 40, fontWeight: 700, lineHeight: 1 }}>
        {box.camera}
      </span>
      {/* EVERY BOX SAYS WHAT IT MEANS — green alone did not read (owner asked
          "what does green mean?"). It also keeps all three states the same
          height. */}
      <span
        className={missing ? "tv-num" : undefined}
        style={{
          fontSize: 17,
          lineHeight: 1,
          letterSpacing: missing ? undefined : "0.08em",
          textTransform: missing ? undefined : "uppercase",
          opacity: 0.82,
        }}
      >
        {missing ? formatSinceFlag(box.sinceFlagMs) : back ? "back" : "due"}
      </span>
    </div>
  );
}

export { BAR_H as CAMERA_BAR_H, BAR_CLEAR_H as CAMERA_BAR_CLEAR_H };
