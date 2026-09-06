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
 *               never came back. Their TRACK'S colour, solid, with how long they
 *               have been missing.
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
 *  2. EVERY BOX WEARS ITS TRACK'S COLOUR so staff know which way to walk —
 *     including the still-out ones (owner 2026-08-13: keep them the colour we
 *     expected them back in, not red). LOUDNESS IS THE FILL, NOT THE HUE: a
 *     waiting box is a 12% tint of its track, a still-out box is the same track
 *     colour gone solid, glowing, counting. That reads as escalation of the same
 *     camera rather than a different one, and it keeps the one fact a chase list
 *     needs — where to walk — on the box the whole time. The earlier rule
 *     ("solid red is reserved for the chase list") is retired; red now means
 *     Red Track, plus one fallback, see CameraBox.
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

/**
 * The height the scene must reserve. ONE definition, so the wrapper's bottom inset
 * and the bar itself can never disagree.
 *
 * TOTAL BY DESIGN. This exact function white-screened every briefing TV on
 * 2026-08-13: it read `strip.stillOut.length` on a feed restored from localStorage
 * that a previous build had written in the old `{ boxes }` shape, threw, and took
 * the whole app down on every reload. Callers are expected to pass
 * `normaliseCameraReturn` output and the scene does — but a wall that runs
 * unattended for weeks must not depend on a caller remembering, so this reads
 * defensively too.
 */
export function cameraBarHeight(strip: unknown): number {
  if (!strip || typeof strip !== "object") return 0;
  const s = strip as { stillOut?: unknown; incoming?: unknown };
  const n =
    (Array.isArray(s.stillOut) ? s.stillOut.length : 0) +
    (Array.isArray(s.incoming) ? s.incoming.length : 0);
  return n > 0 ? BAR_H : BAR_CLEAR_H;
}

/** Fixed, not flex: see note 1. Wide enough for three digits (the fleet runs
 *  1–96, and the barcode API accepts up to 999). */
const BOX_W = 84;
const BOX_H = 72;
const BOX_GAP = 9;

/* ── HOW MANY BOXES FIT, and what gives when they do not ──────────────────
 *
 * The 1920 px canvas ran out of width on a full grid: three still-out plus nine
 * incoming clipped the last box against the edge and the clock sat on top of it
 * (owner 2026-08-12, live board). Silent clipping is the one failure an
 * accountability board cannot have — a box cut off the edge is an invisible
 * camera, which is worse than no board at all.
 *
 * So the width is BUDGETED, in fixed units, and the budget decides what to show.
 * Box size never changes: boxes that resize as cameras come and go would be the
 * reflow this design spent three revisions removing.
 */
const INSET = 30;
/** Fixed so the arithmetic below is deterministic rather than text-dependent. */
const CAPTION_W = 196;
/** Reserve for the compact on-track chip at the right end. */
const CLOCK_W = 200;
const SECTION_GAP = 22;
const CANVAS_W = 1920;

/**
 * The most boxes that fit with BOTH captions and the clock present. Derived, not
 * guessed, so a change to any constant above cannot silently start clipping.
 */
export const MAX_BOXES = Math.floor(
  (CANVAS_W - INSET * 2 - CAPTION_W * 2 - CLOCK_W - SECTION_GAP * 3) / (BOX_W + BOX_GAP),
);

/**
 * Above this many incoming, the GREEN ones stop being drawn.
 *
 * Once a heat is big, the green boxes are pure reassurance: the caption already
 * says "7 of 9 back", and the two that are still DUE are the only actionable
 * information (owner 2026-08-12, picking this over shrinking the boxes). Below the
 * threshold they stay, because watching a camera turn green is the confirmation
 * the whole state exists for.
 */
export const INCOMING_SHOW_ALL_MAX = 4;

export interface StripPlan {
  stillOut: CameraReturnBox[];
  incoming: CameraReturnBox[];
  /** How many boxes were dropped for want of width. Rendered as a "+N" chip so
   *  the board never silently hides a camera. */
  hidden: number;
  /** True when greens were collapsed into the caption's ratio. */
  greensCollapsed: boolean;
}

/**
 * Decide what actually gets drawn.
 *
 * PRIORITY IS THE POINT. A still-out box is the chase list and is never dropped to
 * make room for anything else; then the DUE ones, which are the group currently
 * being waited on; greens last, because they are the only boxes whose absence costs
 * nothing. Anything that still does not fit is COUNTED, never silently cut.
 */
export function planCameraStrip(
  stillOut: CameraReturnBox[],
  incoming: CameraReturnBox[],
  maxBoxes: number = MAX_BOXES,
): StripPlan {
  const greensCollapsed = incoming.length > INCOMING_SHOW_ALL_MAX;
  const wanted = greensCollapsed ? incoming.filter((b) => b.state !== "back") : incoming;

  const fit = (budget: number) => {
    // Still out first, and it keeps every box it has: a camera nobody can find
    // outranks the group walking back, however many of them there are.
    const outRoom = Math.min(stillOut.length, budget);
    const inRoom = Math.max(0, Math.min(wanted.length, budget - outRoom));
    return {
      outRoom,
      inRoom,
      hidden: stillOut.length - outRoom + (wanted.length - inRoom),
    };
  };

  // THE "+N" CHIP COSTS A BOX SLOT, so once we know something is hidden the budget
  // has to be re-run one narrower. Skipping this pass is how the fix for clipping
  // would itself have clipped — the chip would sit exactly where the box it was
  // reporting used to be, one past the edge.
  let f = fit(maxBoxes);
  if (f.hidden > 0) f = fit(Math.max(0, maxBoxes - 1));

  return {
    stillOut: stillOut.slice(0, f.outRoom),
    incoming: wanted.slice(0, f.inRoom),
    hidden: f.hidden,
    greensCollapsed,
  };
}

/** THE NO-TRACK FALLBACK for a still-out box, not the still-out colour — a
 *  camera we cannot attribute to a circuit has no track colour to keep. Distinct
 *  from Red Track's own #ff3b30 on purpose. */
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
   * WHAT FITS, decided before anything is drawn. The caption ratios below are
   * computed from the FULL incoming list, not the plan, so "7 of 9 back" stays
   * true even when the seven green boxes are not drawn — the number is the whole
   * reason collapsing them is safe.
   */
  const plan = planCameraStrip(stillOut, incoming);
  const backCount = incoming.filter((b) => b.state === "back").length;

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
      {plan.stillOut.length > 0 && (
        <Section
          label="Cameras"
          value={`${stillOut.length} still out`}
          valueColor="#ff4b45"
          boxes={plan.stillOut}
        />
      )}

      {plan.stillOut.length > 0 && plan.incoming.length > 0 && (
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

      {plan.incoming.length > 0 && (
        <Section
          label="Incoming"
          value={`${backCount} of ${incoming.length} back`}
          valueColor="rgba(245, 236, 238, 0.62)"
          boxes={plan.incoming}
        />
      )}

      {/* NEVER SILENTLY CLIP. A box cut off the edge is an invisible camera, so
          anything that did not fit is counted here instead. */}
      {plan.hidden > 0 && <MoreChip n={plan.hidden} />}

      {/* The on-track clock, COMPACT even here (owner 2026-08-12: it was eating
          300 px of the row and colliding with the last box on a full grid). It is
          secondary information on this band — the boards' own clocks are big. */}
      <div style={{ marginLeft: "auto", flex: "0 0 auto" }}>
        <LiveSessionChip track={clockTrack} accent={accent} compact />
      </div>
    </div>
  );
}

/**
 * "+3" — the boxes that did not fit.
 *
 * Deliberately drawn as a box so the row reads as one continuous set, and
 * deliberately dim so it never competes with a red. Its only job is to stop the
 * board lying: the count above it is always the true total, and this says how much
 * of it you are not looking at.
 */
function MoreChip({ n }: { n: number }) {
  return (
    <div
      aria-label={`${n} more camera${n === 1 ? "" : "s"} not shown`}
      style={{
        width: BOX_W,
        height: BOX_H,
        flex: "0 0 auto",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        border: `2px dashed ${GREY_EDGE}`,
        color: GREY_INK,
      }}
    >
      <span className="tv-num" style={{ fontSize: 34, fontWeight: 700, lineHeight: 1 }}>
        +{n}
      </span>
      <span style={{ fontSize: 15, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        more
      </span>
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
      {/* FIXED WIDTH, because MAX_BOXES is arithmetic and text-dependent captions
          would make it a guess. */}
      <div style={{ flex: "0 0 auto", width: CAPTION_W, display: "flex", flexDirection: "column" }}>
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
   * A BOX WEARS ITS TRACK'S COLOUR (owner 2026-08-12: "if we're not showing green
   * or red colors as status why don't we make those the color of the track they
   * were on last?"). A bare number says nothing about where to walk; the circuit
   * does.
   */
  const trackAccent = box.track ? TRACK_ACCENTS[box.track] : null;

  /**
   * A STILL-OUT BOX KEEPS THE COLOUR WE WERE EXPECTING IT BACK IN (owner
   * 2026-08-13). It used to flip to one generic alarm red the moment the next
   * race was called, which threw away the only thing on the box that tells staff
   * where to go and look — exactly when they need it. It still shouts, through
   * the solid fill, the glow and the running clock; it just shouts in its own
   * track's voice.
   *
   * RED IS THE FALLBACK, not the rule: a camera we cannot attribute to a track
   * has no colour we expected it in, and an uncoloured box on the chase list
   * would read as calm. GREEN stays status-only — it means "accounted for" and
   * no track owns it.
   */
  const chase = trackAccent ?? RED;

  /** Calm = still expected. Tinted, never solid, so the two never trade places. */
  const calmAccent = box.state === "waiting" ? trackAccent : null;

  const border = missing ? (trackAccent ?? RED_EDGE) : back ? GREEN : (calmAccent ?? GREY_EDGE);
  const background = missing
    ? chase
    : back
      ? GREEN
      : calmAccent
        ? withAlpha(calmAccent, 0.12)
        : GREY_FILL;
  const ink = missing ? "#fff" : back ? GREEN_INK : (calmAccent ?? GREY_INK);

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
        // boxes would fight it for attention. The glow follows the box's own
        // colour, so it reads as that camera being loud rather than a second,
        // competing status colour laid over it.
        boxShadow: missing ? `0 0 18px ${withAlpha(chase, 0.7)}` : "none",
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
