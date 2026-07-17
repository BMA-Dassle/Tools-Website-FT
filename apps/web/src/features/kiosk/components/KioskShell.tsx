"use client";

/**
 * The kiosk chrome shell — wraps every /kiosk route.
 *
 * Responsibilities (all device-level, none booking-related):
 * - Provides KioskConfigProvider (device config from localStorage).
 * - Fullscreen: first tap enters fullscreen; if the guest (or Windows) exits,
 *   the next tap re-enters. Pattern from the camera-assign admin page
 *   (app/admin/[token]/camera-assign/CameraAssignClient.tsx) — the ESC/back
 *   gesture is defeated by the very next interaction. Skipped on localhost
 *   so dev isn't fighting fullscreen on every click.
 * - Wake lock: keeps the screen on; re-acquired on visibilitychange
 *   (pattern from app/t/[id]/FullScreenTicket.tsx).
 * - Anchor guard: reused web step components contain stray <a href> links —
 *   any navigation outside /kiosk is swallowed (capture phase) so a guest
 *   can never wander into the marketing site.
 * - Kills text selection / context menu / pinch artifacts.
 *
 * Brand class: the wrapper applies .brand-{fasttrax|headpinz} from device
 * config so font-heading/font-body resolve per venue regardless of which
 * hostname the kiosk happens to load.
 */
import { useEffect, useRef } from "react";
import { KioskConfigProvider, useKioskConfig } from "../KioskConfigContext";

function KioskChrome({ children }: { children: React.ReactNode }) {
  const { config } = useKioskConfig();
  const rootRef = useRef<HTMLDivElement>(null);
  const wantsFullscreenRef = useRef(false);

  useEffect(() => {
    const isLocal =
      typeof window !== "undefined" &&
      (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

    let wakeLock: { release: () => Promise<void>; addEventListener?: unknown } | null = null;

    const acquireWakeLock = async () => {
      try {
        const nav = navigator as Navigator & {
          wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
        };
        if (!nav.wakeLock) return;
        wakeLock = await nav.wakeLock.request("screen");
      } catch {
        /* unsupported / denied — non-fatal, Windows power settings are the backstop */
      }
    };

    const enterFullscreen = () => {
      if (isLocal) return;
      const el = document.documentElement;
      if (document.fullscreenElement) return;
      el.requestFullscreen?.().catch(() => {
        /* needs a user gesture or blocked — try again on the next tap */
      });
    };

    const onPointerDown = () => {
      // First tap is the user gesture fullscreen + wake lock both need.
      wantsFullscreenRef.current = true;
      enterFullscreen();
      if (!wakeLock) void acquireWakeLock();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        wakeLock = null;
        void acquireWakeLock();
      }
    };

    // Swallow navigation to anywhere outside /kiosk (stray links inside
    // reused web components). Capture phase so it wins before React handlers.
    const onClickCapture = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith("/kiosk") && !href.startsWith("#")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const onContextMenu = (e: Event) => e.preventDefault();

    document.addEventListener("pointerdown", onPointerDown, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("click", onClickCapture, true);
    document.addEventListener("contextmenu", onContextMenu);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("click", onClickCapture, true);
      document.removeEventListener("contextmenu", onContextMenu);
      void wakeLock?.release().catch(() => {});
    };
  }, []);

  const brandClass = config?.brand === "headpinz" ? "brand-headpinz" : "brand-fasttrax";

  return (
    <div
      ref={rootRef}
      className={`${brandClass} kiosk-root min-h-screen select-none bg-[#000418] text-[#f5ecee]`}
      style={{ touchAction: "manipulation" }}
    >
      {children}
    </div>
  );
}

export function KioskShell({ children }: { children: React.ReactNode }) {
  return (
    <KioskConfigProvider>
      <KioskChrome>{children}</KioskChrome>
    </KioskConfigProvider>
  );
}
