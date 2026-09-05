/**
 * The driver view's palette and type, in one place.
 *
 * Lifted from `app/globals.css` (the FastTrax brand pair — Exo 2 headings,
 * Barlow body) plus the track accents from `lib/constants/race-records.ts`, so
 * these screens look like the rest of the estate rather than like a new product.
 *
 * FLAG COLOURS ARE NOT BRAND COLOURS. Green is green (`#00B84E`) and not the
 * brand cyan, because a flag colour is the flag's colour — the owner's call,
 * 2026-09-05, and the right one for a screen that tells someone whether to stay
 * in their kart. Cyan keeps its own job as "positive data": a place gained, a
 * gap closing. The two never mean the same thing.
 *
 * SIZES ARE VIEWPORT-RELATIVE. The endpoint for this screen is a panel bolted to
 * a kart, not a phone in a hand, and the panel is not a size we know yet. `clamp`
 * against `vw` is the house rule for anything read at a distance.
 */

export const c = {
  ground: "#000418",
  navy: "#010a20",
  panel: "#071027",
  hairline: "rgba(245,236,238,0.10)",
  ink: "#f5ecee",
  inkDim: "rgba(245,236,238,0.55)",
  inkFaint: "rgba(245,236,238,0.35)",
  cyan: "#00e2e5",
  violet: "#8652ff",
  magenta: "#f800c6",
  red: "#e53935",
  redDeep: "#6d0f0d",
  amber: "#FFD400",
  amberDeep: "#D9A400",
  green: "#00B84E",
  blueFlag: "#004AAD",
} as const;

export const track = {
  blue: "#004AAD",
  red: "#e41c1d",
  mega: "#8652ff",
} as const;

export const font = {
  display: "'Exo 2', system-ui, sans-serif",
  body: "'Barlow', system-ui, sans-serif",
} as const;

/** Tabular figures, so a changing lap time does not jiggle the layout. */
export const numeral = {
  fontFamily: font.display,
  fontVariantNumeric: "tabular-nums",
  fontFeatureSettings: "'tnum' 1",
} as const;

export const label = {
  fontFamily: font.body,
  textTransform: "uppercase",
  letterSpacing: "0.14em",
} as const;

/** A size that holds up on a phone in the hand and a panel on a kart. */
export function fluid(minPx: number, vw: number, maxPx: number): string {
  return `clamp(${minPx}px, ${vw}vw, ${maxPx}px)`;
}
