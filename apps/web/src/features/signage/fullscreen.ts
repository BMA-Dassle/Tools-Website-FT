/**
 * IS THIS BOARD ACTUALLY FILLING ITS PANEL? — the pure half.
 *
 * ── DO NOT USE `document.fullscreenElement` FOR THIS. IT WOULD FLAG ALL 19.
 *
 * Both launchers put a board full-screen through EDGE, not through the
 * Fullscreen API: the single-screen script uses `--kiosk
 * --edge-kiosk-type=fullscreen`, and the two-monitor script uses
 * `--start-fullscreen` (it cannot use kiosk mode — kiosk claims the primary
 * display and both boards land on one monitor; see the launch-line comment in
 * startup-script.ts). Neither puts an element into Fullscreen-API fullscreen, so
 * `document.fullscreenElement` is NULL on every correctly-launched screen in the
 * estate. A check built on it reports the entire wall as broken and is worse
 * than no check at all.
 *
 * WHAT IS ACTUALLY TRUE of a board filling its panel: its viewport is the size
 * of its monitor. Windowed Edge spends 80-120px vertically on the tab strip and
 * address bar before anything else, so the viewport falls visibly short. That
 * comparison holds for kiosk mode, for --start-fullscreen, for F11, and for a
 * staff laptop — because it asks about the OUTCOME rather than the mechanism.
 *
 * Both operands are CSS pixels (`window.innerWidth` and `window.screen.width`
 * both are), so OS display scaling cancels out and no devicePixelRatio maths is
 * needed. On a two-monitor player `window.screen` reports the monitor the window
 * is on, which is what makes this work per board rather than per PC.
 *
 * WHAT THIS IS NOT: a claim that anything is broken. TvStage transform-scales the
 * 1920×1080 canvas to whatever viewport it is given, so a windowed board shows a
 * complete, correct, smaller picture with Edge's chrome above it. That is an
 * ops problem — a visible address bar on a guest-facing wall, and a panel not
 * being used — not a broken screen. The wording everywhere says "windowed",
 * never "error".
 *
 * PURE — no DOM read, no React. Measured in TvShell.
 */

/**
 * How much shortfall still counts as filling the panel.
 *
 * 24px. It has to clear rounding and a fractional device pixel ratio (a 150%
 * scaled display can report a viewport half a pixel short) while staying well
 * under the ~80px minimum that Edge's tab strip plus address bar costs. Anything
 * near the chrome height would make the check a coin toss on exactly the case it
 * exists to catch; anything near zero would cry wolf on healthy boards, which is
 * the failure mode that gets a signal ignored.
 */
export const PANEL_FILL_TOLERANCE_PX = 24;

/**
 * Does the viewport fill the monitor?
 *
 * Returns TRUE when it cannot tell. A missing or nonsensical `screen` reading —
 * an old engine, a headless run, a preview harness — must not paint a healthy
 * wall as windowed: this signal only earns its keep if a human can trust it,
 * and the cost of a false positive is that somebody drives to a venue.
 */
export function fillsPanel(args: {
  innerW: number;
  innerH: number;
  screenW: number;
  screenH: number;
  tolerancePx?: number;
}): boolean {
  const { innerW, innerH, screenW, screenH } = args;
  const tolerance = args.tolerancePx ?? PANEL_FILL_TOLERANCE_PX;
  for (const n of [innerW, innerH, screenW, screenH]) {
    if (!Number.isFinite(n) || n <= 0) return true;
  }
  // A viewport LARGER than the reported screen is not a problem — some engines
  // report the primary monitor for `screen` while the window sits on a bigger
  // secondary. Only a shortfall counts.
  return innerH >= screenH - tolerance && innerW >= screenW - tolerance;
}
