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
 *
 * OVERSCAN: some panels crop their own input, so a canvas that fills the
 * viewport perfectly still loses its bottom edge behind the bezel. `overscanPct`
 * shrinks the picture inside the same letterbox so the panel's crop eats black
 * instead of content. It is applied HERE, in a style write, rather than by
 * re-rendering anything: a screen whose inset changes mid-briefing must not
 * remount the video that a room full of guests is watching.
 */
import { useEffect, useRef } from "react";
import { TV_W, TV_H, tvFitScale } from "../constants";

export function TvStage({
  className,
  overscanPct = 0,
  children,
}: {
  className?: string;
  /** Percent inset per edge, for a panel that crops its own input. 0 (the
   *  default) fills the viewport exactly, as every screen did before this
   *  existed. See ScreenConfig.overscanPct. */
  overscanPct?: number;
  children: React.ReactNode;
}) {
  const fitRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const apply = () => {
      const vw = window.visualViewport?.width ?? window.innerWidth;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      const s = tvFitScale(vw, vh, overscanPct);
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
    // Re-fits when the inset changes, which is the whole live-rollout story: the
    // config arrives from the feed a moment after boot, and an admin edit lands
    // on the next poll. Both are a style write on an element that is already
    // mounted — no reload, so nothing playing on the wall is interrupted.
  }, [overscanPct]);

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
