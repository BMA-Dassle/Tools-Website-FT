"use client";

/**
 * Fixed 1080×1920 portrait canvas, uniformly transform-scaled to fit the
 * viewport — ported 1:1 from the approved prototype's fit() (public/
 * cbddeb12307c42c18960250de34673d6.html). This is THE fix for "scaling weird"
 * / black side-margins: every screen is authored to a locked 1080×1920 space
 * and the whole canvas is scaled by min(vh/1920, vw/1080), so it fills the
 * portrait display edge-to-edge on the real device and centers cleanly (navy
 * letterbox) on a landscape preview monitor. Proportions never drift.
 *
 * NOTE: the transform establishes a containing block for descendant
 * position:fixed elements, so the OSK/overlays rendered inside anchor to the
 * canvas (1080×1920) and scale with it — author them in canvas px, not vh.
 */
import { useEffect, useRef } from "react";

const KIOSK_W = 1080;
const KIOSK_H = 1920;

export function KioskStage({
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
      const s = Math.min(vh / KIOSK_H, vw / KIOSK_W);
      if (fitRef.current) {
        fitRef.current.style.width = `${KIOSK_W * s}px`;
        fitRef.current.style.height = `${KIOSK_H * s}px`;
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
    <div className="kiosk-stage">
      <div ref={fitRef} className="kiosk-fit">
        <div ref={canvasRef} className={`kiosk-canvas ${className ?? ""}`}>
          {children}
        </div>
      </div>
    </div>
  );
}
