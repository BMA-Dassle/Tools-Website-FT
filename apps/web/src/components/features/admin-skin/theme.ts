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
