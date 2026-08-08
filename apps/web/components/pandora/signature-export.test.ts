import { describe, it, expect } from "vitest";
import {
  flattenSignatureToPng,
  SIGNATURE_INK,
  SIGNATURE_PAGE,
  type SignatureCanvasLike,
  type SignatureCtxLike,
} from "@/components/pandora/signature-export";

/**
 * The signature pad draws WHITE strokes on a transparent canvas. Uploaded raw,
 * BMI Office composited them over the white waiver document and staff saw a
 * blank signature line — with a 201 + waiverID and 19–46 KB of real strokes in
 * the PNG (W57821, 2026-08-08). These tests pin the compositing ORDER, because
 * getting it wrong reintroduces an invisible signature that every other signal
 * — HTTP status, waiverID, byte count, waiverExpiry — still reports as healthy.
 */

type Op =
  | { op: "drawImage" }
  | { op: "fillRect"; fillStyle: string; composite: string; w: number; h: number };

function stubCanvas(): { canvas: SignatureCanvasLike; ops: Op[]; hasCtx: boolean } {
  const ops: Op[] = [];
  const state = { fillStyle: "", composite: "source-over" as string };
  const ctx: SignatureCtxLike = {
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string | CanvasGradient | CanvasPattern) {
      state.fillStyle = String(v);
    },
    get globalCompositeOperation() {
      return state.composite as GlobalCompositeOperation;
    },
    set globalCompositeOperation(v: GlobalCompositeOperation) {
      state.composite = String(v);
    },
    drawImage: () => ops.push({ op: "drawImage" }),
    fillRect: (_x, _y, w, h) =>
      ops.push({ op: "fillRect", fillStyle: state.fillStyle, composite: state.composite, w, h }),
  };
  const canvas: SignatureCanvasLike = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toDataURL: () => "data:image/png;base64,FLATTENED",
  };
  return { canvas, ops, hasCtx: true };
}

const source = (w = 600, h = 280): SignatureCanvasLike => ({
  width: w,
  height: h,
  getContext: () => null,
  toDataURL: () => "data:image/png;base64,RAW_TRANSPARENT",
});

describe("flattenSignatureToPng", () => {
  it("returns the FLATTENED canvas, never the raw one", () => {
    const { canvas } = stubCanvas();
    const url = flattenSignatureToPng(source(), () => canvas);
    expect(url).toBe("data:image/png;base64,FLATTENED");
    // The raw canvas is the transparent, white-on-white one. If it ever comes
    // back out of here, signatures are invisible in BMI again.
    expect(url).not.toContain("RAW_TRANSPARENT");
  });

  it("copies the source dimensions so geometry is untouched", () => {
    const { canvas } = stubCanvas();
    flattenSignatureToPng(source(812, 191), () => canvas);
    expect(canvas.width).toBe(812);
    expect(canvas.height).toBe(191);
  });

  it("recolours the ink via source-in, then lays an opaque page behind it", () => {
    const { canvas, ops } = stubCanvas();
    flattenSignatureToPng(source(600, 280), () => canvas);

    expect(ops.map((o) => o.op)).toEqual(["drawImage", "fillRect", "fillRect"]);

    // 1. ink pass: keeps ONLY already-drawn pixels, repainted dark. Using
    //    anything but source-in floods the whole canvas with ink.
    const ink = ops[1] as Extract<Op, { op: "fillRect" }>;
    expect(ink.composite).toBe("source-in");
    expect(ink.fillStyle).toBe(SIGNATURE_INK);
    expect([ink.w, ink.h]).toEqual([600, 280]);

    // 2. page pass: goes BEHIND the ink. source-over here would paint white
    //    over the signature and erase it entirely.
    const page = ops[2] as Extract<Op, { op: "fillRect" }>;
    expect(page.composite).toBe("destination-over");
    expect(page.fillStyle).toBe(SIGNATURE_PAGE);
  });

  it("uses dark ink on a light page — the combination BMI can render", () => {
    // A light-on-light export is the exact defect; assert the contrast directly
    // rather than trusting the constants to stay sensible.
    const luma = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    };
    expect(luma(SIGNATURE_INK)).toBeLessThan(0.3);
    expect(luma(SIGNATURE_PAGE)).toBeGreaterThan(0.9);
  });

  it("fails closed rather than exporting an unflattened signature", () => {
    const noCtx: SignatureCanvasLike = {
      width: 0,
      height: 0,
      getContext: () => null,
      toDataURL: () => "data:image/png;base64,RAW_TRANSPARENT",
    };
    expect(flattenSignatureToPng(source(), () => noCtx)).toBe("");
    expect(flattenSignatureToPng(null, () => stubCanvas().canvas)).toBe("");
    // A zero-sized pad has nothing to flatten and must not report success.
    expect(flattenSignatureToPng(source(0, 0), () => stubCanvas().canvas)).toBe("");
  });
});
