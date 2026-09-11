"use client";

/**
 * ONE TRACK OPS PILL, EVERY SCREEN THAT DRAWS ONE.
 *
 * `[dot] [flag] [count] [idle clock] [first name] [race tag]` — the anatomy is
 * fixed and the only thing that varies between the check-in board and a 55"
 * television is how big it is. That is deliberate (owner 2026-09-07): the same eight
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
 *
 * NOR IS THE CLOCK. `freeSinceMs` arrives on the entry and `formatIdle` — the
 * same pure fold — turns it into `38m`. What this file decides is only WHERE
 * the chip sits and WHO wears one (available pills; see `idle` below).
 */
import {
  CREW_BREAK_OPACITY,
  CREW_BREAK_ORANGE,
  CREW_DIM_INK,
  CREW_GREEN,
  CREW_GREEN_RING,
  CREW_IDLE_BG,
  CREW_IDLE_BORDER,
  CREW_IDLE_INK,
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
  formatIdle,
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
  /** One step up from 12px (2026-09-07): the desk strip now sits under a header
   *  whose own chips are 12.5px, and a pill smaller than the buttons above it
   *  read as a caption rather than as the roster. */
  desk: "13px",
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
 * The checkered flag. Inline because it is three paths used in exactly one
 * component — a sprite or an icon-pack import would cost more than it saves.
 *
 * Sized in `em` so it tracks whatever density the pill is at.
 *
 * THE LIGHT SQUARES ARE TRANSPARENCY, NOT PAINT (2026-09-07). They used to be
 * filled with the pill's own ground colour, which worked only while that
 * ground was an opaque navy: the moment `CREW_PILL_BG` became a white wash
 * (see ~/lib/constants/crew) an 8-percent fill over the flag's ink stopped
 * being a hole and the flag went solid. Drawing the field at 35 percent and
 * the dark squares at full instead makes the checker come from the ink alone,
 * so it reads on any ground — the desk's flat gray-950, a tinted track panel,
 * or a briefing wall.
 */
export function FlagIcon() {
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
      <path fill="currentColor" opacity="0.35" d="M3 1h10v7H3z" />
      <path
        fill="currentColor"
        d="M3 1h2.5v1.75H3zM8 1h2.5v1.75H8zM5.5 2.75H8v1.75H5.5zM10.5 2.75H13v1.75h-2.5zM3 4.5h2.5v1.75H3zM8 4.5h2.5v1.75H8zM5.5 6.25H8V8H5.5zM10.5 6.25H13V8h-2.5z"
      />
    </svg>
  );
}

/**
 * The idle clock's face. A ring and two hands, same `em` sizing and same
 * inline reasoning as FlagIcon above — two icons in one component is still
 * cheaper than reaching for an icon pack.
 *
 * STROKED, WHERE THE FLAG IS FILLED, so the pair never reads as one blob at
 * camera-board size: the flag is a solid checker and this is an outline, which
 * is the difference the eye catches first at 11px.
 */
function ClockIcon() {
  return (
    <svg
      width="1.02em"
      height="1.02em"
      viewBox="0 0 16 16"
      aria-hidden
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      <circle
        cx="8"
        cy="8"
        r="6.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.75"
      />
      <path
        d="M8 4.25V8l2.5 1.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CrewPill({
  entry,
  density,
  nowMs,
}: {
  entry: CrewEntry;
  density: CrewPillDensity;
  /**
   * The clock to measure the idle chip against — REQUIRED, and never read
   * inside this component.
   *
   * Every wall scene is handed the director's `nowMs`, which is `Date.now()`
   * plus the venue's correction, and no screen in this estate formats a time
   * for itself (a player's own locale once put a wall clock four hours out).
   * Required rather than defaulted so a new caller has to decide which clock
   * it is on instead of silently getting the browser's.
   */
  nowMs: number;
}) {
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
  /**
   * HOW LONG THEY HAVE BEEN FREE — on available pills only, and that is the
   * whole rule (owner 2026-09-10).
   *
   * A clock on this pill means "you are in the queue", and the number is your
   * place in it — the same set `nextUp` names on the check-in board's NEXT and
   * QUEUED line. Somebody out on a group, on a break, or not yet clocked in
   * cannot be sent anywhere, so a duration beside their name would be a fact
   * with nothing to do: it would invite the desk to compare it against the
   * numbers that DO mean "send me", which is how a board stops being read.
   *
   * It also happens to be the narrow choice, which the camera rail needs —
   * one to three chips on a row of eight rather than eight.
   */
  const idle = entry.state === "available" ? formatIdle(entry.freeSinceMs, nowMs) : null;

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
        // 700, matching the TV's own chips: at 8 percent white the ground gives
        // the name almost no contrast of its own, and the weight is what puts
        // it back (2026-09-07).
        fontWeight: 700,
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
      {/* THE IDLE CLOCK, between the count and the name. It sits here because
          the two numbers belong together — "one group, free 38 minutes" is a
          single sentence about this person's night, and splitting them around
          the name would make the eye read the pill twice. A chip rather than
          bare text so it cannot be mistaken for part of the count beside it. */}
      {idle && (
        <span
          title={`Free for ${idle} — since their last group's karts came back`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.28em",
            fontWeight: 800,
            fontSize: "0.9em",
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "0.01em",
            padding: "0.08em 0.46em 0.08em 0.38em",
            borderRadius: 999,
            color: CREW_IDLE_INK,
            background: CREW_IDLE_BG,
            border: `1px solid ${CREW_IDLE_BORDER}`,
          }}
        >
          <ClockIcon />
          {idle}
        </span>
      )}
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
            borderRadius: 999,
            color: tag.ink,
            background: tag.bg,
            border: `1px solid ${tag.border}`,
          }}
        >
          {raceTagLabel(entry.race)}
        </span>
      )}
    </span>
  );
}
