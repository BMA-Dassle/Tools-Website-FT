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
    .ba-gerow { background-color: var(--ba-bg2); }
    .ba-gerow:hover, .ba-gerow:focus-visible { background-color: var(--ba-hover); }
    /* Fat, grabbable modal scrollbar (owner 2026-07-13 — the default was
       too thin to hit). Firefox gets the default-width themed bar. */
    .ba-scroll { scrollbar-color: var(--ba-input-border) transparent; }
    .ba-scroll::-webkit-scrollbar { width: 14px; }
    .ba-scroll::-webkit-scrollbar-track { background: transparent; }
    .ba-scroll::-webkit-scrollbar-thumb {
      background-color: var(--ba-input-border);
      border-radius: 8px;
      border: 3px solid var(--ba-modal-bg);
      min-height: 48px;
    }
    .ba-scroll::-webkit-scrollbar-thumb:hover { background-color: var(--ba-muted); }
  `;

/**
 * Grid-view styles — the lane / track timeline.
 *
 * Written against the board's own `--ba-*` tokens rather than imported from the
 * CRM availability screen's `.gantt` rules: that CSS is scoped to the CRM skin,
 * and the two boards live in different themes (this one also re-skins to the
 * employee portal's palette through PORTAL_SKIN_CSS). Sharing the class names
 * would make a CRM restyle silently repaint an ops board inside the portal.
 *
 * `--ba-grid-lab` is the label gutter; every row and the axis share it so the
 * lane numbers and the hour ticks line up exactly.
 */
export const GRID_CSS = `
    .ba-grid { --ba-grid-lab: 92px; position: relative; }
    .ba-grid-scroll { overflow-x: auto; }
    /* Below this the bars are unreadable, so the grid scrolls sideways rather
       than squeezing an 8-hour evening into a phone's width. */
    .ba-grid-inner { min-width: 640px; }
    .ba-grid-axis { display: flex; align-items: flex-end; height: 22px; position: relative; }
    .ba-grid-axis .ba-grid-lab { width: var(--ba-grid-lab); flex: none; }
    .ba-grid-track { position: relative; flex: 1 1 auto; height: 100%; }
    .ba-grid-axis .ba-grid-track span {
      position: absolute; transform: translateX(-50%); white-space: nowrap;
      font-size: 0.6rem; color: var(--ba-muted); letter-spacing: 0.03em;
    }
    .ba-grid-row { display: flex; align-items: stretch; height: 26px; margin-bottom: 2px; }
    .ba-grid-row .ba-grid-lab {
      width: var(--ba-grid-lab); flex: none; display: flex; align-items: center;
      font-size: 0.7rem; font-weight: 600; color: var(--ba-muted);
      padding-right: 8px; justify-content: flex-end; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    .ba-grid-row .ba-grid-track {
      background-color: var(--ba-muted2); border-radius: 5px;
    }
    .ba-grid-empty .ba-grid-track {
      display: flex; align-items: center; justify-content: center;
      font-size: 0.62rem; color: var(--ba-muted); letter-spacing: 0.04em;
    }
    .ba-grid-bar {
      position: absolute; top: 2px; bottom: 2px; border-radius: 4px;
      display: flex; align-items: center; gap: 5px; padding: 0 6px;
      font-size: 0.66rem; font-weight: 600; overflow: hidden; white-space: nowrap;
      border: 1px solid transparent;
      /* A 7-minute race heat is under 1% of a 14-hour evening — invisible, and
         far too small to hit. The floor is a legibility/target-size minimum;
         the bar's LEFT edge is always the true start time. */
      min-width: 30px;
    }
    .ba-grid-bar > span { overflow: hidden; text-overflow: ellipsis; }
    .ba-grid-bar.is-ours { cursor: pointer; }
    .ba-grid-bar.is-ours:hover, .ba-grid-bar.is-ours:focus-visible {
      filter: brightness(1.18); outline: none;
    }
    .ba-grid-bar.is-ours:focus-visible { box-shadow: 0 0 0 2px var(--ba-fg); }
    .ba-grid-sec { margin-bottom: 14px; }
    .ba-grid-sec-h {
      display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px;
      font-size: 0.68rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.06em; color: var(--ba-muted);
    }
    .ba-grid-now {
      position: absolute; top: 0; bottom: 0; width: 2px; pointer-events: none;
      background-color: #ef4444; z-index: 3;
    }
    .ba-grid-now::before {
      content: ""; position: absolute; top: -3px; left: -3px;
      width: 8px; height: 8px; border-radius: 50%; background-color: #ef4444;
    }
    .ba-grid-legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 0.62rem; color: var(--ba-muted); }
    .ba-grid-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 3px; margin-right: 4px; vertical-align: -1px; }
    @media (prefers-reduced-motion: reduce) { .ba-grid-bar.is-ours:hover { filter: none; } }
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
