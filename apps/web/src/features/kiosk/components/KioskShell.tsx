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
import { LocaleProvider, useLocale, LOCALE_BCP47 } from "../i18n";
import { captureKioskBootVersion, KIOSK_VERSION } from "../version";
import { OnScreenKeyboardHost } from "./OnScreenKeyboard";
import { KioskStage } from "./KioskStage";

function KioskChrome({ children }: { children: React.ReactNode }) {
  const { config } = useKioskConfig();
  const { locale } = useLocale();
  const wantsFullscreenRef = useRef(false);

  // Record the deploy this tab booted on, so a between-guest reset can detect a
  // newer deploy and self-update (see version.ts / handleStartOver).
  useEffect(() => {
    void captureKioskBootVersion();
  }, []);

  useEffect(() => {
    const isLocal =
      typeof window !== "undefined" &&
      (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
    // The staff admin screen must NOT auto-fullscreen on tap: requestFullscreen()
    // consumes the click's transient activation, which then starves the Web
    // Serial chooser (requestPort → SecurityError "browser blocked access").
    // Admin also legitimately needs browser dialogs (the serial port picker),
    // so the guest lockdown doesn't apply here.
    const isAdmin =
      typeof window !== "undefined" && window.location.pathname.startsWith("/kiosk/admin");
    const noFullscreen = isLocal || isAdmin;

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
      if (noFullscreen) return;
      const el = document.documentElement;
      if (document.fullscreenElement) return;
      el.requestFullscreen?.().catch(() => {
        /* needs a user gesture or blocked — try again on the next tap */
      });
    };

    const onPointerDown = () => {
      // First tap is the user gesture fullscreen + wake lock both need. On the
      // admin screen we do neither, so a button's click keeps its transient
      // activation for APIs that need it (Web Serial requestPort).
      if (noFullscreen) return;
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

    // Kill browser autofill/autocomplete on EVERY kiosk field — a shared public
    // device must never surface a previous guest's saved name/phone/email/card
    // suggestions. Applied to all inputs (kiosk-native AND reused web ones) here
    // so shared web components keep their normal autofill off-kiosk.
    // NOT autocomplete="off": Chrome ignores "off" on fields it classifies as
    // contact/address/payment data (names, type=tel/email, card numbers) and
    // keeps offering the profile's saved entries. A concrete token beats
    // Chrome's heuristics, and desktop Chrome never has one-time-code data to
    // suggest (nor does it retain what's typed into one), so the dropdown
    // stays closed on exactly the fields "off" fails on.
    const killAutofill = (el: Element) => {
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;
      el.setAttribute("autocomplete", "one-time-code");
      el.setAttribute("autocorrect", "off");
      el.setAttribute("autocapitalize", "off");
      el.setAttribute("spellcheck", "false");
    };
    const scan = (root: ParentNode) => {
      if (root instanceof Element) killAutofill(root);
      root.querySelectorAll?.("input, textarea").forEach(killAutofill);
    };
    scan(document.body);
    const autofillObserver = new MutationObserver((muts) => {
      for (const m of muts) m.addedNodes.forEach((n) => scan(n as ParentNode));
    });
    autofillObserver.observe(document.body, { childList: true, subtree: true });

    document.addEventListener("pointerdown", onPointerDown, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("click", onClickCapture, true);
    document.addEventListener("contextmenu", onContextMenu);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("click", onClickCapture, true);
      document.removeEventListener("contextmenu", onContextMenu);
      autofillObserver.disconnect();
      void wakeLock?.release().catch(() => {});
    };
  }, []);

  const brandClass = config?.brand === "headpinz" ? "brand-headpinz" : "brand-fasttrax";

  return (
    <div
      className="select-none"
      lang={LOCALE_BCP47[locale]}
      style={{ touchAction: "manipulation" }}
    >
      <KioskStage className={brandClass}>
        {children}
        {/* The language switcher is NOT global — it renders only on the attract
            screen and the "What are we doing today?" category chooser (owner
            2026-07-25: don't show it mid-flow where it overlaps content). It's
            position:fixed, so those screens mount it into this same top-right
            spot. */}
        <OnScreenKeyboardHost />
        {/* Version tag, every screen (owner 2026-07-20): staff confirm what a
            kiosk runs without opening admin. `fixed` anchors to the 1080×1920
            canvas (the stage transform is its containing block) — author in
            canvas px. Non-interactive; sits under nothing important. */}
        <div
          aria-hidden="true"
          className="pointer-events-none fixed bottom-[6px] right-[12px] z-[300] text-[15px] font-semibold tabular-nums text-white/25"
        >
          v{KIOSK_VERSION}
        </div>
      </KioskStage>
    </div>
  );
}

export function KioskShell({ children }: { children: React.ReactNode }) {
  return (
    <KioskConfigProvider>
      <LocaleProvider>
        <KioskChrome>{children}</KioskChrome>
      </LocaleProvider>
    </KioskConfigProvider>
  );
}
