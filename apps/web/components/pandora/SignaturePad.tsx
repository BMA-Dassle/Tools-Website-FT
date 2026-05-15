"use client";

import { useRef, useEffect, useCallback, useState } from "react";

/**
 * Reusable signature pad component — renders an HTML5 Canvas that captures
 * mouse and touch drawing input.
 *
 * Used by: group event waiver flow, future express check-in, kiosk mode.
 *
 * Usage:
 *   const padRef = useRef<SignaturePadRef>(null);
 *   <SignaturePad ref={padRef} onSign={() => setHasSigned(true)} />
 *   // Later:
 *   const dataUrl = padRef.current?.toDataURL();
 *   padRef.current?.clear();
 */

export interface SignaturePadRef {
  /** Export the signature as a PNG data URL (base64). */
  toDataURL: () => string;
  /** Clear the canvas. */
  clear: () => void;
  /** Whether the user has drawn anything. */
  isEmpty: () => boolean;
}

export interface SignaturePadProps {
  /** Fires when the user starts drawing (first stroke). */
  onSign?: () => void;
  /** Fires after clear() is called. */
  onClear?: () => void;
  /** Canvas height in CSS pixels. Default: 140. */
  height?: number;
  /** Stroke color. Default: "#ffffff". */
  strokeColor?: string;
  /** Stroke width. Default: 2. */
  strokeWidth?: number;
  /** Additional class names on the outer wrapper. */
  className?: string;
}

/**
 * Imperative ref-based signature pad.
 *
 * We use useImperativeHandle-style via a callback ref so the parent can
 * call .toDataURL() and .clear() without prop drilling.
 */
export default function SignaturePad({
  onSign,
  onClear,
  height = 140,
  strokeColor = "#ffffff",
  strokeWidth = 2,
  className = "",
}: SignaturePadProps & { padRef?: React.MutableRefObject<SignaturePadRef | null> }) {
  // This is intentionally not using forwardRef — the padRef prop pattern
  // is simpler for our use case and avoids the generic type gymnastics.
  return (
    <SignaturePadInner
      onSign={onSign}
      onClear={onClear}
      height={height}
      strokeColor={strokeColor}
      strokeWidth={strokeWidth}
      className={className}
    />
  );
}

// Re-export a version that exposes the ref via a prop (easier to consume).
export function SignaturePadWithRef({
  padRef,
  ...props
}: SignaturePadProps & { padRef: React.MutableRefObject<SignaturePadRef | null> }) {
  return <SignaturePadInner {...props} padRef={padRef} />;
}

function SignaturePadInner({
  onSign,
  onClear,
  height = 140,
  strokeColor = "#ffffff",
  strokeWidth = 2,
  className = "",
  padRef,
}: SignaturePadProps & { padRef?: React.MutableRefObject<SignaturePadRef | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hasDrawn, setHasDrawn] = useState(false);
  const hasDrawnRef = useRef(false);

  // Track drawing state in a ref so event listeners can access it
  const drawingRef = useRef(false);
  const lastPosRef = useRef({ x: 0, y: 0 });

  const initCanvas = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Scale for high-DPI displays
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    },
    [strokeColor, strokeWidth],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    initCanvas(canvas);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    function getPos(e: MouseEvent | Touch): { x: number; y: number } {
      const r = canvas!.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function startDraw(e: MouseEvent | TouchEvent) {
      drawingRef.current = true;
      const pos = getPos("touches" in e ? e.touches[0] : (e as MouseEvent));
      lastPosRef.current = pos;
    }

    function draw(e: MouseEvent | TouchEvent) {
      if (!drawingRef.current) return;
      e.preventDefault();
      const pos = getPos("touches" in e ? e.touches[0] : (e as MouseEvent));
      ctx!.beginPath();
      ctx!.moveTo(lastPosRef.current.x, lastPosRef.current.y);
      ctx!.lineTo(pos.x, pos.y);
      ctx!.stroke();
      lastPosRef.current = pos;

      if (!hasDrawnRef.current) {
        hasDrawnRef.current = true;
        setHasDrawn(true);
        onSign?.();
      }
    }

    function stopDraw() {
      drawingRef.current = false;
    }

    canvas.addEventListener("mousedown", startDraw);
    canvas.addEventListener("mousemove", draw);
    canvas.addEventListener("mouseup", stopDraw);
    canvas.addEventListener("mouseleave", stopDraw);
    canvas.addEventListener("touchstart", startDraw, { passive: false });
    canvas.addEventListener("touchmove", draw, { passive: false });
    canvas.addEventListener("touchend", stopDraw);

    return () => {
      canvas.removeEventListener("mousedown", startDraw);
      canvas.removeEventListener("mousemove", draw);
      canvas.removeEventListener("mouseup", stopDraw);
      canvas.removeEventListener("mouseleave", stopDraw);
      canvas.removeEventListener("touchstart", startDraw);
      canvas.removeEventListener("touchmove", draw);
      canvas.removeEventListener("touchend", stopDraw);
    };
  }, [initCanvas, onSign]);

  // Expose imperative methods via padRef
  useEffect(() => {
    if (!padRef) return;
    padRef.current = {
      toDataURL: () => canvasRef.current?.toDataURL("image/png") || "",
      clear: () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        hasDrawnRef.current = false;
        setHasDrawn(false);
        onClear?.();
      },
      isEmpty: () => !hasDrawnRef.current,
    };
  }, [padRef, onClear]);

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-white/40 text-xs">Sign below</span>
        {hasDrawn && (
          <button
            type="button"
            onClick={() => padRef?.current?.clear()}
            className="text-xs text-white/30 hover:text-white/60 transition-colors"
          >
            Clear
          </button>
        )}
      </div>
      <div
        className="rounded-xl border border-white/20 bg-white/5 overflow-hidden"
        style={{ touchAction: "none" }}
      >
        <canvas
          ref={canvasRef}
          className="w-full"
          style={{ height: `${height}px`, cursor: "crosshair" }}
        />
      </div>
    </div>
  );
}
