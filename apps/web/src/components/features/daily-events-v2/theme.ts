/**
 * Daily Events v2 skin — the employee portal's design system, hand-ported
 * (owner request 2026-07-13: v2 must look like the portal, not a new theme).
 * Token values come from Tools-Team-Member-Portal `src/index.css` (shadcn
 * zinc + HeadPinz brand layer: Navy #14223b · Blue #3B82F6, navy gradient
 * dark body, Poppins type). No shadcn here — repo hard rule — just tokens.
 */

/** Poppins is loaded by the page via next/font and exposed as --font-v2. */
export const SANS_V2 = 'var(--font-v2), "Segoe UI", system-ui, -apple-system, sans-serif';

export const MONO_V2 = '"Cascadia Mono", Consolas, ui-monospace, SFMono-Regular, Menlo, monospace';

/** Portal blue (tailwind blue-500 — the portal's --primary). */
export const BLUE_V2 = "#3b82f6";
/** blue-400 — "today" text on dark navy (portal uses it for emphasis). */
export const BLUE_SOFT_V2 = "#60a5fa";

/**
 * Overrides the reservations-admin --ba-* variables with the portal palette.
 * More specific than baThemeCss's [data-ba-theme] selectors, so it wins.
 * Dark = portal .dark tokens (cards hsl(218 42% 17%), borders hsl(218 25% 26%),
 * muted text hsl(218 15% 65%)) over the fixed navy gradient body.
 * Light = portal light tokens (white cards, gray-200 borders, navy text).
 */
export const V2_SKIN_CSS = `
  .v2-skin[data-ba-theme="dark"] {
    --ba-bg: #0e1729;
    --ba-fg: #f9fafb;
    --ba-bg2: #19273e;
    --ba-border: #323e53;
    --ba-muted: #98a2b3;
    --ba-muted2: #223452;
    --ba-hover: #22345e;
    --ba-input-bg: #2d3b53;
    --ba-input-border: #3c4b66;
    --ba-shadow: rgba(0,0,0,0.4);
    --ba-modal-bg: #19273e;
    --ba-modal-border: #323e53;
    --ba-overlay: rgba(0,0,0,0.7);
    background: linear-gradient(135deg, #0e1729 0%, #14223b 50%, #1a3052 100%) fixed;
  }
  .v2-skin[data-ba-theme="light"] {
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
