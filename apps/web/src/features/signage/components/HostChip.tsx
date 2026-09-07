"use client";

/**
 * WHO IS RUNNING THIS GROUP — one chip, every screen that names a marshal.
 *
 * THE PROBLEM IT SOLVES (owner 2026-09-07). The name used to be a dim
 * letter-spaced caps span sitting immediately after the race type, so a row
 * read "35 STARTER PEDRO" and the person's name looked like the third word of
 * the level. It also appeared on some rows and not others — the four lane
 * stages had it, the Briefing row never did — which made it look like a
 * property of certain stages rather than a fact about every group.
 *
 * So it becomes a chip, in the SAME slot on every row: after the level, before
 * the status text. Amber, because that row already spends white on the session
 * number, the track's own colour on the room pill and the tone colours on the
 * detail — a name in any of those reads as another piece of race state. This is
 * the one warm thing on the panel and it is always a person.
 *
 * "NO HOST YET" IS A REAL ANSWER, not an empty slot. A session is claimed when
 * a staff member types their punch ID at the tablet, which is when the film
 * starts — so a heat that is still checking in genuinely has nobody, and the
 * dim placeholder says that rather than leaving a hole the eye has to interpret.
 * A caller with no slot to fill (the corner clock) passes `placeholder={false}`
 * and gets nothing at all.
 *
 * SIZED BY THE CALLER, in whatever unit that surface thinks in: the panels hand
 * it a viewport clamp from their own scale table, the pit rail hands it pixels
 * from a fixed 1080p layout. Everything inside is `em`, so one number is enough.
 */
import {
  HOST_CHIP_BG,
  HOST_CHIP_BORDER,
  HOST_CHIP_EMPTY_BORDER,
  HOST_CHIP_EMPTY_INK,
  HOST_CHIP_INK,
} from "~/lib/constants/crew";

/** Head and shoulders. Nine words of SVG rather than an icon-pack import for a
 *  glyph that appears on six rows of one panel. */
function PersonIcon() {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 16 16"
      aria-hidden
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      <circle cx="8" cy="5" r="3" fill="currentColor" />
      <path d="M2 14c0-3 2.7-5 6-5s6 2 6 5" fill="currentColor" />
    </svg>
  );
}

export function HostChip({
  name,
  fontSize,
  placeholder = true,
}: {
  name: string | null | undefined;
  /** Any CSS length — a clamp on the walls, pixels on the pit rail. */
  fontSize: string | number;
  /** Render the dim "no host yet" when nobody has claimed the group. Off for
   *  callers whose slot may simply be absent. */
  placeholder?: boolean;
}) {
  if (!name && !placeholder) return null;
  const empty = !name;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5em",
        padding: "0.16em 0.72em 0.16em 0.56em",
        borderRadius: 999,
        fontSize,
        fontWeight: empty ? 600 : 700,
        fontStyle: empty ? "italic" : "normal",
        letterSpacing: "0.04em",
        // The panels set caps on their rows; a name is not an abbreviation.
        textTransform: "none",
        whiteSpace: "nowrap",
        lineHeight: 1.25,
        color: empty ? HOST_CHIP_EMPTY_INK : HOST_CHIP_INK,
        background: empty ? "transparent" : HOST_CHIP_BG,
        border: `1px solid ${empty ? HOST_CHIP_EMPTY_BORDER : HOST_CHIP_BORDER}`,
      }}
    >
      {!empty && <PersonIcon />}
      {name ?? "no host yet"}
    </span>
  );
}
