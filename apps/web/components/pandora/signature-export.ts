/**
 * Flatten a signature canvas to DARK INK ON OPAQUE WHITE.
 *
 * ── The bug this exists to prevent (W57821, 2026-08-08) ─────────────────────
 * The signature pad draws white strokes (`strokeColor` default #ffffff) on a
 * dark panel — correct on screen, catastrophic off it. An untouched canvas
 * pixel is rgba(0,0,0,0), so a bare `canvas.toDataURL("image/png")` yields
 * WHITE INK ON A TRANSPARENT BACKGROUND. BMI Office composites the signature
 * over the white waiver document, so every such upload rendered white-on-white
 * and staff saw a blank signature line — while the POST returned 201 with a
 * waiverID and the PNG carried 19–46 KB of real strokes. The signature was
 * always there; it was never visible.
 *
 * `renderDigitallyAcceptedPng` in lib/waiver-digital.tsx already forced
 * dark-on-white ("so it reads in BMI's waiver viewer"); the interactive pad
 * never got the same treatment.
 *
 * Lives outside the component so the compositing ORDER — the part that can
 * silently regress into an invisible signature — is unit-testable in node.
 */

/** Ink colour of the EXPORTED signature. Never the on-screen stroke colour. */
export const SIGNATURE_INK = "#0a0a0a";
/** Opaque page the signature is flattened onto. Transparency is the bug. */
export const SIGNATURE_PAGE = "#ffffff";

/** The slice of CanvasRenderingContext2D this needs — keeps it testable. */
export interface SignatureCtxLike {
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalCompositeOperation: GlobalCompositeOperation;
  drawImage(image: CanvasImageSource, dx: number, dy: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
}

/** The slice of HTMLCanvasElement this needs. */
export interface SignatureCanvasLike {
  width: number;
  height: number;
  getContext(contextId: "2d"): SignatureCtxLike | null;
  toDataURL(type?: string): string;
}

/**
 * Return a PNG data URL of `src` recoloured to dark ink on an opaque white
 * page. Returns "" when it cannot flatten — callers treat that as a failed
 * signature, which is strictly better than uploading an invisible one.
 *
 * Recolours via the ALPHA channel rather than redrawing, so antialiased stroke
 * edges survive and the geometry is untouched:
 *   1. draw the strokes           → original ink, alpha 0 everywhere else
 *   2. `source-in` + ink fill     → keep only drawn pixels, repainted dark
 *   3. `destination-over` + page  → an opaque white page behind the ink
 */
export function flattenSignatureToPng(
  src: SignatureCanvasLike | null | undefined,
  createCanvas: () => SignatureCanvasLike,
): string {
  if (!src || !src.width || !src.height) return "";
  const out = createCanvas();
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext("2d");
  // No 2D context means no flattening. Falling back to the raw canvas here
  // would silently reintroduce the invisible signature, so fail instead.
  if (!ctx) return "";
  ctx.drawImage(src as unknown as CanvasImageSource, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = SIGNATURE_INK;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = SIGNATURE_PAGE;
  ctx.fillRect(0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}
