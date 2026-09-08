/**
 * Admin "portal skin" — the employee portal's design system, hand-ported for
 * ALL FastTrax admin surfaces (owner directive 2026-07-13: admin pages must
 * look like the Team Member Portal, not their own themes).
 *
 * Token source of truth: Tools-Team-Member-Portal `src/index.css` +
 * `tailwind.config.js` (shadcn zinc + HeadPinz brand layer — Navy #14223b ·
 * Blue #3B82F6, navy gradient dark body, Poppins type). No shadcn here —
 * repo hard rule — just the tokens.
 *
 * Usage: page.tsx wraps the client in `adminPoppins.variable` (see ./font.ts),
 * the client root gets className="portal-skin" + data-ba-theme + injects
 * PORTAL_SKIN_CSS, and styles reference the --ba-* variables or the
 * constants below.
 */

/** Poppins is loaded by the page via next/font (./font.ts) as --font-v2. */
export const ADMIN_SANS = 'var(--font-v2), "Segoe UI", system-ui, -apple-system, sans-serif';

export const ADMIN_MONO =
  '"Cascadia Mono", Consolas, ui-monospace, SFMono-Regular, Menlo, monospace';

/** Portal blue (tailwind blue-500 — the portal's --primary). */
export const PORTAL_BLUE = "#3b82f6";
/** blue-400 — emphasis text on dark navy (portal's dark-context accent). */
export const PORTAL_BLUE_SOFT = "#60a5fa";

/** Dark-theme surface tokens, for pages that hardcode colors inline. */
export const PORTAL_DARK = {
  /** Fixed navy gradient page background (portal .dark body). */
  bodyGradient: "linear-gradient(135deg, #0e1729 0%, #14223b 50%, #1a3052 100%) fixed",
  card: "#19273e",
  border: "#323e53",
  fg: "#f9fafb",
  muted: "#98a2b3",
  /** Band headers / progress tracks — slightly lighter navy. */
  muted2: "#223452",
  hover: "#22345e",
  inputBg: "#2d3b53",
  inputBorder: "#3c4b66",
} as const;

/**
 * Overrides the reservations-admin --ba-* variables with the portal palette.
 * More specific than baThemeCss's [data-ba-theme] selectors, so it wins.
 * Dark = portal .dark tokens (cards hsl(218 42% 17%), borders hsl(218 25% 26%),
 * muted text hsl(218 15% 65%)) over the fixed navy gradient body.
 * Light = portal light tokens (white cards, gray-200 borders, navy text).
 */
export const PORTAL_SKIN_CSS = `
  .portal-skin[data-ba-theme="dark"] {
    --ba-bg: #0e1729;
    --ba-fg: ${PORTAL_DARK.fg};
    --ba-bg2: ${PORTAL_DARK.card};
    --ba-border: ${PORTAL_DARK.border};
    --ba-muted: ${PORTAL_DARK.muted};
    --ba-muted2: ${PORTAL_DARK.muted2};
    --ba-hover: ${PORTAL_DARK.hover};
    --ba-input-bg: ${PORTAL_DARK.inputBg};
    --ba-input-border: ${PORTAL_DARK.inputBorder};
    --ba-shadow: rgba(0,0,0,0.4);
    --ba-modal-bg: ${PORTAL_DARK.card};
    --ba-modal-border: ${PORTAL_DARK.border};
    --ba-overlay: rgba(0,0,0,0.7);
    background: ${PORTAL_DARK.bodyGradient};
  }
  .portal-skin[data-ba-theme="light"] {
    --ba-bg: #ffffff;
    --ba-fg: #14223b;
    --ba-bg2: #ffffff;
    --ba-border: #e5e7eb;
    --ba-muted: #6b7280;
    --ba-muted2: #eef1f5;
    --ba-hover: #f3f4f6;
    --ba-input-bg: #ffffff;
    --ba-input-border: #d1d5db;
    --ba-shadow: rgba(16,24,40,0.08);
    --ba-modal-bg: #ffffff;
    --ba-modal-border: #e5e7eb;
    --ba-overlay: rgba(0,0,0,0.4);
    background: #ffffff;
  }
`;

/**
 * THE PIT BOARD TV'S PALETTE — a SECOND dark skin, beside PORTAL_DARK, not a
 * replacement for it (owner 2026-09-07: "green light on making changes to check
 * in board color GUI scheme").
 *
 * WHY A SECOND BLOCK. The check-in board and the pit board TV are read in the
 * same room, minutes apart, by the same people: the desk calls a heat, the wall
 * announces it. They were painted in two different languages — the desk in the
 * portal's navy gradient with solid buttons and 3px room edges, the wall in flat
 * gray-950 with tinted track panels and pill chips — and a marshal crossing
 * between them had to re-learn which red meant "the Red room" twice a night.
 * These are the wall's values, so the desk can speak the wall's language.
 *
 * IT IS ADDITIVE ON PURPOSE. Seventeen other admin surfaces are on PORTAL_DARK
 * and none of them sit beside a television; changing PORTAL_DARK to fix the
 * check-in board would repaint the whole estate to fix one screen.
 *
 * Source of truth: Tools-Team-Member-Portal `src/pages/tv/PitBoardTVPage.tsx`
 * plus its `.dark` tokens — the `.pb-*` class names in the comments below are
 * that file's.
 */
/**
 * The TV's mono face — every clock, every count, every live number.
 *
 * Shorter than ADMIN_MONO on purpose: `ui-monospace` first lets the platform
 * pick its own UI mono (SF Mono, Cascadia, Roboto Mono) rather than naming one
 * vendor's face and falling through a five-deep stack when it is absent, which
 * is how the desk and the wall ended up rendering the same clock in two
 * different widths.
 */
export const TV_MONO = 'ui-monospace, Consolas, "Cascadia Mono", monospace';

export const TV_DARK = {
  /** The root ground. FLAT, not a gradient: two tinted track panels over a
   *  diagonal navy wash put a different blue behind each room. `bg-gray-950`. */
  body: "#030712",
  /** The header band — `bg-background/80` over the ground. */
  band: "rgba(14,23,41,.8)",
  /** Unchanged from PORTAL_DARK: the TV's `--border` is the same hairline,
   *  hsl(218 25% 26%). The one token the two skins already agreed on. */
  border: PORTAL_DARK.border,
  /** The hairline inside a box (`.pb-line`'s edge) — quieter than `border`. */
  hairSoft: "rgba(255,255,255,.05)",
  /** The hairline around a stage row (`.pb-row`). */
  hairRow: "#1e293b",
  /** A box's ground. A SLOT, not a raised card: the TV never lifts a surface
   *  off the page, it recesses it. `.pb-line`. */
  card: "rgba(2,6,23,.5)",
  /** One stage row's ground. `.pb-row`. */
  row: "rgba(15,23,42,.5)",
  /** Body ink. */
  fg: "#f8fafc",
  /** Numerals, clocks and second-rank ink — the TV writes a live number one
   *  step below white so the white is left for names. `.pb-flag`. */
  ink2: "#e5e7eb",
  /** Labels and eyebrows. `.pb-rng`. */
  muted: "#94a3b8",
  /**
   * Sublines — one step quieter than `muted`.
   *
   * NOTE THE COLLISION: `PORTAL_DARK.muted2` is a navy BAND colour (#223452),
   * a background. Here it is ink, as it is on the TV. Nothing may be moved
   * between the two skins by name alone.
   */
  muted2: "#64748b",
  /** The chip vocabulary — one ground and one border behind every header pill,
   *  with the tone carried by the ink rather than by a fill. `.pb-flag`. */
  chipBg: "rgba(255,255,255,.08)",
  chipBorder: "rgba(255,255,255,.14)",
  /** The count inside a chip. */
  chipCountBg: "rgba(255,255,255,.10)",
  /** The one control that LEAVES the page. `.pb-move`. */
  moveInk: "#7dd3fc",
  moveBg: "rgba(14,165,233,.12)",
  moveBorder: "rgba(14,165,233,.45)",
  /** Text fields in the settings sheet keep the portal's field colours — the
   *  TV has no inputs to copy, and a form is not what this restyle is about. */
  inputBg: PORTAL_DARK.inputBg,
  inputBorder: PORTAL_DARK.inputBorder,
} as const;

/**
 * TRACK IDENTITY, THE TV'S WAY — a whole tinted panel per room, and two inks.
 *
 * `head` is the room's name and its furniture (tailwind's -400); `name` is a
 * person or a session inside that room (-300), which must read as content
 * rather than as more of the room's chrome. `bg`/`border` are the panel itself:
 * a 10 percent track tint at a 30 percent edge, so the two tracks separate
 * from across the desk without either becoming a coloured box.
 *
 * The tint base is the -500 (red-500 / blue-500), NOT the -400 identity — a
 * tint mixed from the heading colour reads as a faded heading.
 */
export const TV_ROOM = {
  red: {
    head: "#f87171",
    name: "#fca5a5",
    bg: "rgba(239,68,68,.10)",
    border: "rgba(239,68,68,.30)",
  },
  blue: {
    head: "#60a5fa",
    name: "#93c5fd",
    bg: "rgba(59,130,246,.10)",
    border: "rgba(59,130,246,.30)",
  },
} as const;
