/**
 * Colour helpers for the TV canvas.
 *
 * `withAlpha` exists as a private copy in AttractScreen.tsx and again in
 * AttractHeadline.tsx. Rather than make it three, it is lifted here — the
 * signage surface is the natural home for a shared display helper, and the two
 * kiosk copies can import from here whenever either file is next touched.
 */

/**
 * `#rrggbb` or `rgb()/rgba()` + alpha → `rgba(...)`.
 *
 * BOTH INPUT FORMS, because the silent passthrough below is dangerous when it
 * fires. The signage palette is hex, but the shared race-records catalog spells
 * its tier colours `rgb(228,28,29)` — and a top-times board tinting a header
 * with `withAlpha(color, 0.16)` and then writing the label in `color` got the
 * colour back UNCHANGED for both, i.e. red text on a solid red bar. The labels
 * were simply invisible on the wall (2026-08-18). Anything that still cannot be
 * parsed is returned unchanged, so a CSS variable or token renders rather than
 * throwing — but the two formats we actually use are now both handled.
 */
export function withAlpha(color: string, alpha: number): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const m = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*[0-9.]+\s*)?\)$/i.exec(
    color,
  );
  if (m) {
    // The incoming alpha, if any, is deliberately replaced rather than
    // multiplied: every caller passes the opacity it wants to end up with.
    return `rgba(${Math.round(Number(m[1]))}, ${Math.round(Number(m[2]))}, ${Math.round(Number(m[3]))}, ${alpha})`;
  }
  return color;
}
