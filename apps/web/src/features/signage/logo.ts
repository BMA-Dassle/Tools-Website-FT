/**
 * The brand marks a `venue-logo` screen can wear.
 *
 * PURE — a table and a resolver, no I/O and no React, so both the config
 * resolver (defaults.ts, server) and the scene (client) read the SAME definition
 * of what a mark is. That is the whole reason this is its own module: without it
 * the asset table would live in the scene and `resolveScreenConfig` would have
 * to import a client component to validate a string.
 *
 * ADDING A MARK is two things and nothing else: put the file in
 * `apps/web/public/promo/` and add a row below. The union is derived from the
 * table, so a mark with no asset cannot be named in config — which is the point.
 * There are deliberately no rows for marks we do not yet hold artwork for: a
 * pickable option that renders nothing is worse than no option at all.
 *
 * WHY public/promo AND NOT THE BLOB. Everything else on a TV comes through
 * `tvImg` from Vercel Blob, for two reasons that both stop applying here — the
 * blob host sits behind a firewall challenge a CSS background cannot solve, and
 * Fast Data Transfer bills every client egress. A same-origin file under
 * `public/` faces no challenge, and this one is 74KB fetched once per page load
 * on a screen that then paints the same pixels for hours. It is also the
 * committable-static-image convention already in this repo (`public/images/` is
 * gitignored and blob-backed; `public/promo/` is not). It still goes through
 * next/image at render, which is what buys the long-lived cache headers.
 */

export interface LogoMarkAsset {
  /** Path under `public/`, as next/image wants it. */
  src: string;
  /** Intrinsic pixel size — required by next/image, and the ceiling on how big
   *  this mark can be drawn before it visibly softens. */
  width: number;
  height: number;
  /** Staff-facing name, for the admin picker. */
  label: string;
  /**
   * What the artwork sits on. `light` means the mark was drawn for a white page
   * and carries its own light field (an opaque disc, a plate) — so it reads on a
   * black screen. A mark that is dark ink on transparency would NOT, and this
   * field is here so the next person adding one has to answer the question
   * rather than discover it on a wall.
   */
  ground: "light" | "dark";
}

/**
 * Every mark we hold artwork for.
 *
 * PinBoyz: the 2015 sepia photo mark from `Z:\Marketing\Logos\PinBoyz Logo.png`,
 * converted to webp at its native 576×636 (the source resolution is the ceiling —
 * upscaling the asset would add bytes and no detail). Its circle interior is
 * OPAQUE WHITE, which is what makes it work on black: the disc reads as a white
 * medallion and only the "PINBOYZ" arc, which overhangs the disc onto
 * transparency, drops to its cream outline. That reads as a deliberate outlined
 * treatment rather than as a fault — checked on a composite before shipping.
 *
 * NOT `Z:\Marketing\Logos\Pin Boyz Logo.jpg`, despite the near-identical name and
 * being 2.4x the resolution: it is a DIFFERENT logo — black-and-white line art,
 * not this photo mark — and it has no alpha at all.
 */
export const LOGO_MARKS = {
  pinboyz: {
    src: "/promo/pinboyz-logo.webp",
    width: 576,
    height: 636,
    label: "PinBoyz — Back in Time",
    ground: "light",
  },
} as const satisfies Record<string, LogoMarkAsset>;

export type LogoMark = keyof typeof LOGO_MARKS;

/** Every mark, for the admin picker. */
export const LOGO_MARK_KEYS = Object.keys(LOGO_MARKS) as LogoMark[];

/**
 * The mark a screen falls back to.
 *
 * PinBoyz because it is the only one, and because the screens this scene was
 * built for wear it. When a second mark lands, this stays whatever the majority
 * of logo screens run — an unconfigured logo screen showing the WRONG brand is
 * recoverable in ten seconds from the admin page, whereas one showing nothing is
 * a call-out.
 */
export const DEFAULT_LOGO_MARK: LogoMark = "pinboyz";

export function isLogoMark(value: unknown): value is LogoMark {
  return typeof value === "string" && Object.hasOwn(LOGO_MARKS, value);
}

/**
 * A stored mark, made safe. Follows the CONFIG_VERSION contract the rest of this
 * feature follows: never reject, always resolve. An absent, misspelt, or
 * newer-deploy mark becomes the default, because the alternative on a screen
 * whose ONLY content is one image is a black panel with nothing to explain it.
 */
export function resolveLogoMark(value: unknown): LogoMark {
  return isLogoMark(value) ? value : DEFAULT_LOGO_MARK;
}

export function logoAsset(mark: LogoMark): LogoMarkAsset {
  return LOGO_MARKS[mark];
}
