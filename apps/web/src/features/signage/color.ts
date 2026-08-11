/**
 * Colour helpers for the TV canvas.
 *
 * `withAlpha` exists as a private copy in AttractScreen.tsx and again in
 * AttractHeadline.tsx. Rather than make it three, it is lifted here — the
 * signage surface is the natural home for a shared display helper, and the two
 * kiosk copies can import from here whenever either file is next touched.
 */

/** `#rrggbb` + alpha → `rgba(...)`. Non-hex input is returned unchanged, so a
 *  token or CSS variable that slips through renders instead of throwing. */
export function withAlpha(hex: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
