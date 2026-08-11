"use client";

/**
 * Fixed 1920×1080 LANDSCAPE canvas, uniformly transform-scaled to fit the panel.
 *
 * The landscape twin of KioskStage (which is 1080×1920 portrait). Deliberately a
 * separate component rather than a parameterized KioskStage: that file is 62
 * lines on the kiosk revenue path, its class names and containing-block notes
 * are portrait-specific, and not touching it keeps kiosk deploy risk at zero.
 *
 * Why a fixed canvas at all: every scene is authored in real 1920×1080 pixels,
 * so a 55" wall panel, a 4K panel and a laptop preview are all the SAME picture
 * at different scales. Nothing reflows, nothing drifts, and a designer can
 * reason in absolute px.
 *
 * NOTE: the transform establishes a containing block for descendant
 * position:fixed elements, so overlays rendered inside anchor to the canvas
 * (1920×1080) and scale with it — author them in canvas px, never vh/vw.
 */
import { useEffect, useRef } from "react";
import { TV_W, TV_H } from "../constants";

export function TvStage({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const fitRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const apply = () => {
      const vw = window.visualViewport?.width ?? window.innerWidth;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      const s = Math.min(vh / TV_H, vw / TV_W);
      if (fitRef.current) {
        fitRef.current.style.width = `${TV_W * s}px`;
        fitRef.current.style.height = `${TV_H * s}px`;
      }
      if (canvasRef.current) canvasRef.current.style.transform = `scale(${s})`;
    };
    apply();
    window.addEventListener("resize", apply);
    window.visualViewport?.addEventListener("resize", apply);
    // Fonts loading can shift metrics; re-fit once they settle.
    document.fonts?.ready?.then(apply).catch(() => {});
    return () => {
      window.removeEventListener("resize", apply);
      window.visualViewport?.removeEventListener("resize", apply);
    };
  }, []);

  return (
    <div className="tv-stage">
      <div ref={fitRef} className="tv-fit">
        <div ref={canvasRef} className={`tv-canvas ${className ?? ""}`}>
          {children}
        </div>
      </div>
    </div>
  );
}
