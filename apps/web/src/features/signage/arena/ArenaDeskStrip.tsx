"use client";

/**
 * THE BAND THAT MAKES THE ARENA BOARD A CHECK-IN BOARD.
 *
 * WHY THIS EXISTS, AND IT IS A CORRECTION (owner 2026-09-01: "its not showing
 * check in"). The board shipped with adverts as its dead-time rotation, which is
 * what was asked for — and the result was a screen at the arena desk with nothing
 * on it that said so. Between calls it was indistinguishable from any other
 * advertising panel in the building.
 *
 * The karting board never has that problem: its idle state ("No session checking
 * in — the time on your e-ticket is your check-in cut-off") is what makes it a
 * check-in board even between heats. "Mirror what we do for karting check in" and
 * "ads in its dead time" are not in conflict once you notice that the ads can
 * play UNDER the identity rather than instead of it.
 *
 * SO THIS IS CHROME, NOT A SCENE. A rotation entry would only be up for its slice
 * of the loop, and a guest walking to the desk arrives at a random moment — a
 * one-in-four chance of being told where they are is not an improvement. Rendered
 * by the director over whatever is playing, it is always there.
 *
 * IT IS NOT SHOWN OVER A CALL. When a session is actually called, the check-in
 * scene owns the whole wall and says all of this more loudly; a strip repeating
 * it underneath would be clutter over an instruction.
 *
 * NO NEXT-SESSION TIMES WHEN THERE ARE NONE, and that is the common case rather
 * than a degraded one: HP Arena sessions are created when somebody BOOKS one, not
 * published as a fixed timetable (probed 2026-09-01 — both venues had zero
 * sessions on the day and the day after, while the fortnight behind them ran
 * 1–36 a day). A board that reserved space for "Next at…" would sit with a hole
 * in it most of the time, so the times are additive and the line reads correctly
 * without them.
 */
import { withAlpha } from "../color";
import { ARENA_ACTIVITY_LABELS, type ArenaUpcoming } from "./arena-board";

/** The band's own height. Exported so a scene that wants to keep clear of it
 *  can, the way the briefing scenes reserve room for the camera strip. */
export const ARENA_STRIP_H = 104;

/** Neutral, because the strip speaks for the whole arena rather than for one
 *  game. Matches the `either` accent, so a mixed board reads as one family. */
const ACCENT = "#8ab4ff";

export function ArenaDeskStrip({ upcoming }: { upcoming: ArenaUpcoming[] }) {
  // At most two, and one per activity — the desk's question is "when is the next
  // Laser Tag" and "when is the next Gel Blaster", never a timetable.
  const next = upcoming.slice(0, 2);

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: ARENA_STRIP_H,
        // Near-opaque rather than a gradient: this sits over photography and
        // full-bleed film, and the one thing it must never be is hard to read.
        background: "rgba(0,4,24,0.93)",
        borderTop: `4px solid ${ACCENT}`,
        display: "flex",
        alignItems: "center",
        gap: 34,
        padding: "0 96px",
        overflow: "hidden",
        // Above the scene, below the check-in takeover (which is not rendered
        // with this at all) and below the wipe that covers a cut.
        zIndex: 4,
        pointerEvents: "none",
      }}
    >
      {/* THE ARROW POINTS AT THE DESK, and it replaced a blinking dot (owner
          2026-09-01: "the check in here is incorrect, check in is located to the left.
          Show arrow maybe"). The screen does not hang over the desk — it hangs beside
          it — so "check in here" was pointing at itself, which sends a guest to a TV.
          A direction is the whole content of this line, so it gets the glyph and the
          copy says LEFT in words as well: an arrow alone is ambiguous to anyone who
          reads it as "back the way you came".

          Drawn, not a font glyph — the same rule the rest of the estate follows, and
          it lets the head sit on the same optical baseline as 46px type. */}
      <svg
        aria-hidden
        width="76"
        height="52"
        viewBox="0 0 76 52"
        fill="none"
        className="tv-chev-left"
        style={{ flexShrink: 0, filter: `drop-shadow(0 0 16px ${withAlpha(ACCENT, 0.7)})` }}
      >
        <path
          d="M74 26H8M8 26l22-20M8 26l22 20"
          stroke={ACCENT}
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>

      {/* WHAT THIS SCREEN IS FOR, in the words a guest is holding a ticket for. */}
      <span
        className="tv-display"
        style={{
          fontSize: 46,
          color: "#fff",
          whiteSpace: "nowrap",
          textShadow: `0 0 26px ${withAlpha(ACCENT, 0.55)}`,
        }}
      >
        Laser Tag &amp; Gel Blasters — check in to your left
      </span>

      {/* THE PROMISE THAT MAKES A GUEST WAIT HERE rather than wander off, which
          is the actual job of an idle check-in board. */}
      <span
        style={{
          fontSize: 32,
          color: "rgba(245,236,238,0.72)",
          whiteSpace: "nowrap",
        }}
      >
        Your session is called on this screen
      </span>

      {next.length > 0 && (
        <span
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 18,
            flexShrink: 0,
          }}
        >
          <span
            className="tv-eyebrow"
            style={{ color: "rgba(245,236,238,0.5)", fontSize: 22, letterSpacing: "0.22em" }}
          >
            Next
          </span>
          {next.map((u) => (
            <span
              key={`${u.activity}-${u.timeLabel}`}
              className="tv-display"
              style={{
                fontSize: 34,
                color: "#fff",
                padding: "8px 22px",
                borderRadius: 999,
                border: `2px solid ${withAlpha(ACCENT, 0.5)}`,
                background: withAlpha(ACCENT, 0.14),
                whiteSpace: "nowrap",
              }}
            >
              {ARENA_ACTIVITY_LABELS[u.activity]} {u.timeLabel}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
