/**
 * Theme system for the admin reservations board (portal-embedded, light/dark).
 *
 * The board styles itself with inline style objects referencing `--ba-*` CSS
 * variables scoped to `[data-ba-theme="light" | "dark"]` on the page root.
 * NEVER rename a `--ba-*` variable — every board component and modal
 * (including the manage-reservation modal) consumes them, and they must render
 * inside the `[data-ba-theme]` root so the variables inherit through the DOM.
 *
 * Accent colors (status badges, pills) stay hardcoded hex since they work on
 * both backgrounds.
 */
import type { CSSProperties } from "react";

export const BA_THEME_CSS_LIGHT = `
    [data-ba-theme="light"] { --ba-bg: #f8f9fb; --ba-fg: #1a1a2e; --ba-bg2: #ffffff; --ba-border: rgba(0,0,0,0.1); --ba-muted: rgba(0,0,0,0.45); --ba-muted2: rgba(0,0,0,0.08); --ba-hover: rgba(0,0,0,0.04); --ba-input-bg: #ffffff; --ba-input-border: rgba(0,0,0,0.15); --ba-shadow: rgba(0,0,0,0.08); --ba-modal-bg: #ffffff; --ba-modal-border: rgba(0,0,0,0.12); --ba-overlay: rgba(0,0,0,0.4); }
  `;

export const BA_THEME_CSS_DARK = `
    [data-ba-theme="dark"] { --ba-bg: #0a1628; --ba-fg: #fff; --ba-bg2: rgba(255,255,255,0.03); --ba-border: rgba(255,255,255,0.06); --ba-muted: rgba(255,255,255,0.35); --ba-muted2: rgba(255,255,255,0.06); --ba-hover: rgba(255,255,255,0.04); --ba-input-bg: rgba(255,255,255,0.05); --ba-input-border: rgba(255,255,255,0.1); --ba-shadow: rgba(0,0,0,0.5); --ba-modal-bg: #111827; --ba-modal-border: rgba(255,255,255,0.08); --ba-overlay: rgba(0,0,0,0.7); }
  `;

export function baThemeCss(theme: "light" | "dark"): string {
  return theme === "light" ? BA_THEME_CSS_LIGHT : BA_THEME_CSS_DARK;
}

/**
 * Board interaction styles — row hover highlight + the "Manage →" hint.
 * Inline styles can't express :hover, so this rides in the same <style>
 * block as the theme variables.
 */
export const BOARD_CSS = `
    .ba-row:hover td { background-color: var(--ba-hover); }
    .ba-row .ba-row-hint { opacity: 0; transition: opacity 0.12s; }
    .ba-row:hover .ba-row-hint, .ba-row:focus-visible .ba-row-hint { opacity: 1; }
    @media (prefers-reduced-motion: reduce) { .ba-row .ba-row-hint { transition: none; } }
  `;

export const INPUT_STYLE: CSSProperties = {
  backgroundColor: "var(--ba-input-bg)",
  border: "1px solid var(--ba-input-border)",
  borderRadius: 8,
  color: "var(--ba-fg)",
  padding: "0.5rem 0.75rem",
  fontSize: "0.875rem",
};

export const NAV_BTN: CSSProperties = {
  backgroundColor: "var(--ba-input-bg)",
  border: "1px solid var(--ba-input-border)",
  borderRadius: 8,
  color: "var(--ba-muted)",
  padding: "0.5rem 0.75rem",
  fontSize: "0.875rem",
  cursor: "pointer",
};
