"use client";

/**
 * ONE TRACK OPS PILL, EVERY SCREEN THAT DRAWS ONE.
 *
 * `[dot] [flag] [count] [first name] [race tag]` — the anatomy is fixed and
 * the only thing that varies between the check-in board and a 55" television
 * is how big it is. That is deliberate (owner 2026-09-07): the same eight
 * people appear on the desk and on two walls within a few feet of each other,
 * and the last time a shared row was drawn by three components they drifted
 * until a colour added to one never reached the other two.
 *
 * ONE KNOB PER DENSITY. Everything inside the pill — the icon, the dot, the
 * padding, the tag — is sized in `em` against the pill's own font-size, so a
 * density is a single number and the parts can never fall out of proportion
 * with each other. On the walls that number is a viewport clamp, never a fixed
 * pixel count: these are 1080p televisions read from across a room, and a size
 * lifted from a windowed screenshot is how the camera boards once rendered at
 * their floor (see StageRailView's SCALE table).
 *
 * THE STATE IS NOT THIS COMPONENT'S DECISION. `crewState` in
 * features/staff/crew-list.ts decides who is available, assigned, on break or
 * not in yet, and in what order; this only paints it. Membership, state, order
 * and the top-briefer mark all arrive on the entry.
 */
import {
  CREW_BREAK_OPACITY,
  CREW_BREAK_ORANGE,
  CREW_DIM_INK,
  CREW_GREEN,
  CREW_GREEN_RING,
  CREW_OUT_GREY,
  CREW_OUT_OPACITY,
  CREW_PILL_BG,
  CREW_PILL_BORDER,
  CREW_PILL_COUNT_INK,
  CREW_PILL_INK,
  CREW_TOP_BORDER,
  CREW_TOP_INK,
} from "~/lib/constants/crew";
import {
  raceTagColors,
  raceTagLabel,
  type CrewEntry,
  type CrewState,
} from "~/features/staff/crew-list";

export type CrewPillDensity = "desk" | "wall" | "compact";

/**
 * The one number per density. Everything else is `em`.
 *
 * `desk` is the check-in board at arm's length; `wall` is a pit sign or a
 * briefing room read across a building; `compact` is a camera board, whose rail
 * is 58% of a small panel — fewer words at type one step down, never small type.
 */
const PILL_FONT: Record<CrewPillDensity, string> = {
  desk: "12px",
  /**
   * THREE ACROSS A WALL PANEL (owner 2026-09-07). A step below the row detail
   * beside it rather than level with it: seven people took four lines at the
   * larger size, which is most of a rail spent on one row.
   */
  wall: "clamp(14px, 1.45vw, 29px)",
  /**
   * COMPACT IS THE ONE THAT IS ACTUALLY NARROW. Every other size in this system
   * steps down by about a fifth from wall to compact, because the camera rail
   * loses type, not structure. The pills lose WIDTH: eight of them wrap across a
   * pane that is 58% of the screen minus a nine-em label column, so at the
   * usual step they took four lines and pushed the stage rows off their own
   * panel (caught on FT:5, 2026-09-07). This is sized to the width available
   * rather than to the other clamps, which is why it is the odd one out.
   */
  compact: "clamp(11px, 1.05vw, 21px)",
};

/** The presence dot, when a state has one. Available and the two dim states do;
 *  "assigned" does not — its signal is the tag it is already wearing. */
const STATE_DOT: Record<CrewState, string | null> = {
  available: CREW_GREEN,
  assigned: null,
  break: CREW_BREAK_ORANGE,
  "not-in": CREW_OUT_GREY,
};

const STATE_OPACITY: Record<CrewState, number | undefined> = {
  available: undefined,
  assigned: undefined,
  break: CREW_BREAK_OPACITY,
  "not-in": CREW_OUT_OPACITY,
};

/**
 * The checkered flag. Inline because it is nine paths used in exactly one
 * component — a sprite or an icon-pack import would cost more than it saves.
 *
 * Sized in `em` so it tracks whatever density the pill is at, and the squares
 * are punched with the pill's own ground rather than a literal, so the flag
 * reads on the desk and on a wall without a second copy.
 */
export function FlagIcon({ hole = CREW_PILL_BG }: { hole?: string }) {
  return (
    <svg
      width="1.05em"
      height="1.05em"
      viewBox="0 0 16 16"
      aria-hidden
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      <path fill="currentColor" d="M2 1h1v14H2z" />
      <path fill="currentColor" d="M3 1h10v7H3z" />
      <path
        fill={hole}
        d="M3 1h2.5v1.75H3zM8 1h2.5v1.75H8zM5.5 2.75H8v1.75H5.5zM10.5 2.75H13v1.75h-2.5zM3 4.5h2.5v1.75H3zM8 4.5h2.5v1.75H8zM5.5 6.25H8V8H5.5zM10.5 6.25H13V8h-2.5z"
      />
    </svg>
  );
}

export function CrewPill({ entry, density }: { entry: CrewEntry; density: CrewPillDensity }) {
  const dim = entry.state === "break" || entry.state === "not-in";
  const dot = STATE_DOT[entry.state];
  /**
   * BORDER PRECEDENCE: green, then the top-briefer tint, then plain.
   *
   * Availability outranks "who is carrying tonight" because it is the
   * actionable fact — the desk reads this strip to find somebody to send, and a
   * blue ring on the one free person would bury the answer. The tint is a
   * desk-only mark in any case: a television is read from thirty feet, where a
   * second border colour is noise rather than information.
   */
  const topMark = entry.top && density === "desk" && !dim;
  const border =
    entry.state === "available" ? CREW_GREEN_RING : topMark ? CREW_TOP_BORDER : CREW_PILL_BORDER;
  const tag = entry.race ? raceTagColors(entry.race) : null;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5em",
        // Tighter across than down: the pills are budgeted by WIDTH — three to
        // a wall panel — and the vertical padding is what keeps them legible.
        padding: "0.33em 0.66em 0.33em 0.56em",
        borderRadius: 999,
        fontSize: PILL_FONT[density],
        fontWeight: 600,
        lineHeight: 1.25,
        whiteSpace: "nowrap",
        backgroundColor: CREW_PILL_BG,
        border: `1px solid ${border}`,
        color: dim ? CREW_DIM_INK : CREW_PILL_INK,
        opacity: STATE_OPACITY[entry.state],
      }}
    >
      {dot && (
        <span
          aria-hidden
          style={{
            width: "0.58em",
            height: "0.58em",
            borderRadius: "50%",
            background: dot,
            flexShrink: 0,
          }}
        />
      )}
      <span style={{ color: dim ? CREW_DIM_INK : "inherit", display: "inline-flex" }}>
        <FlagIcon />
      </span>
      {/* The count sits right after the flag — it is what the flag is counting,
          and the pair reads as one number rather than a decoration and a digit
          at opposite ends of a name. */}
      <b
        style={{
          fontWeight: 800,
          fontVariantNumeric: "tabular-nums",
          color: dim ? CREW_DIM_INK : topMark ? CREW_TOP_INK : CREW_PILL_COUNT_INK,
        }}
      >
        {entry.briefed}
      </b>
      {entry.firstName}
      {/* THE GROUP THEY ARE ON, in that track's colour. Kept on a break pill —
          somebody who stepped away mid-group still holds it, and that is
          precisely what the desk needs to see. */}
      {entry.race && tag && (
        <span
          style={{
            fontWeight: 800,
            fontSize: "0.9em",
            letterSpacing: "0.02em",
            padding: "0.08em 0.5em",
            borderRadius: "0.36em",
            color: tag.ink,
            background: tag.bg,
          }}
        >
          {raceTagLabel(entry.race)}
        </span>
      )}
    </span>
  );
}
