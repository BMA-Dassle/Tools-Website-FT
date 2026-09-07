/**
 * THE TRACK OPS PALETTE — one file, every surface that paints a crew pill.
 *
 * WHY IT IS A MODULE AND NOT THREE COPIES (owner 2026-09-07: "exactly one place
 * for each concern"). The same eight people are drawn in three places on a race
 * night — the check-in board's strip, the session-status panels on the camera
 * TVs, and the pit-assign idle wall — and the last time a shared thing was
 * drawn in three places (the stage rail, before StageRailView) the three
 * renderers drifted until a colour added to one never reached the other two.
 *
 * GREEN MEANS ONE THING EVERYWHERE. `CREW_GREEN` is the available pill's ring
 * AND the session panel's ON TIME chip AND its ON TRACK dot, deliberately: a
 * marshal glancing at that panel should not have to decide whether two greens
 * a hand's width apart are saying the same thing. It is the estate's
 * `#4ade80`, not the older `#46d68c` the walls carried — those two sat side by
 * side on one screen and read as a rendering fault.
 *
 * The track tag colours are the SAME three the boards already use for track
 * identity, one step lighter so they read as a label on a dark pill rather
 * than as the track's own furniture.
 */

/** Available: clocked in, hosting nobody. The one green. */
export const CREW_GREEN = "#4ade80";
/** The available pill's ring — the same green at ring weight. */
export const CREW_GREEN_RING = "rgba(74,222,128,.55)";
/** On break. Matches the portal pit board's own break dot. */
export const CREW_BREAK_ORANGE = "#fb923c";
/** On the roster, no punch today. The pit board's "out" dot. */
export const CREW_OUT_GREY = "#4b5563";

/** The pill itself — one ground and one border for the desk and the walls
 *  alike, so the same person looks like the same person on both. */
export const CREW_PILL_BG = "#121c33";
export const CREW_PILL_BORDER = "#263252";
export const CREW_PILL_INK = "#cbd5e1";
/** The count, which is the number the pill exists to carry. */
export const CREW_PILL_COUNT_INK = "#e5e7eb";
/** Break and out pills lose their ink as well as their opacity — dimming
 *  alone left white text that still pulled the eye first. */
export const CREW_DIM_INK = "#94a3b8";
/** How far each state is dimmed. On break is legible-but-quiet; a person with
 *  no punch yet is a placeholder and sits behind everything. */
export const CREW_BREAK_OPACITY = 0.55;
export const CREW_OUT_OPACITY = 0.4;

/** The blue the check-in board already uses to mark the top briefer. */
export const CREW_TOP_BORDER = "rgba(96,165,250,.45)";
export const CREW_TOP_INK = "#93c5fd";

/** The race tag, per track: the letter's ink and the chip behind it. */
export const TRACK_TAG: Record<"blue" | "red" | "mega", { ink: string; bg: string }> = {
  blue: { ink: "#93c5fd", bg: "rgba(59,130,246,.18)" },
  red: { ink: "#fca5a5", bg: "rgba(239,68,68,.18)" },
  mega: { ink: "#d8b4fe", bg: "rgba(168,85,247,.18)" },
};

/**
 * THE HOST CHIP — amber, on every stage row of the session panel, in the
 * corner status, and on the pit-assign idle line (owner 2026-09-07).
 *
 * Amber because the row already spends white on the session number, the
 * track's own colour on the room pill and the tone colours on the detail; a
 * name in any of those would read as another piece of race state. It is the
 * one warm thing on the panel, and it is always a person.
 */
export const HOST_CHIP_BG = "rgba(245,158,11,.14)";
export const HOST_CHIP_BORDER = "rgba(245,158,11,.45)";
export const HOST_CHIP_INK = "#fcd34d";
/** "no host yet" — a slot nobody has claimed, not a person. */
export const HOST_CHIP_EMPTY_INK = "#64748b";
export const HOST_CHIP_EMPTY_BORDER = "rgba(255,255,255,.12)";
