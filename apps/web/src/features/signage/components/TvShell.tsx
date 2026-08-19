"use client";

/**
 * The hardware shell around every TV screen: keep the panel awake, stay
 * full-screen, and pick up new deploys without anyone driving out to the venue.
 *
 * FORKED FROM KioskShell — cross-link, and fix BOTH. The wake-lock and
 * fullscreen logic here is the same idea as
 * features/kiosk/components/KioskShell.tsx; if you fix a wake-lock bug in one,
 * fix it in the other. It is forked rather than shared because a kiosk shell
 * also carries an on-screen keyboard, an autofill killer, an anchor guard and a
 * locale provider — none of which a display with no input device should pay
 * for, and all of which would need kiosk-shaped conditionals to skip.
 *
 * SELF-UPDATE, THE DIFFERENCE THAT MATTERS: a kiosk updates at a between-guest
 * reset. A TV has no such boundary — it runs for weeks — so it checks on a
 * timer and reloads at the NEXT SCENE BOUNDARY, never mid-VIP-takeover and
 * never mid-celebration. The reload doubles as memory amnesty for a page that
 * is never otherwise torn down.
 */
import { useEffect, useRef, useState } from "react";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { captureKioskBootVersion, kioskUpdateAvailable } from "~/features/kiosk/version";
import { SIGNAGE_VERSION, TV_UPDATE_CHECK_MS } from "../constants";
import { etHourNow, shouldRecycle } from "../recycle";

export function TvShell({
  screenLabel,
  /** False while an interrupt is on screen — the reload waits for a calm beat. */
  safeToReload,
  children,
}: {
  screenLabel: string;
  safeToReload: boolean;
  children: React.ReactNode;
}) {
  const [updatePending, setUpdatePending] = useState(false);

  /* ── screen wake lock ────────────────────────────────────────────────
     Without this the panel's host OS can blank a "idle" browser. Re-acquired
     on visibilitychange because the lock is dropped whenever the document is
     hidden (an OS screen blank, a staff alt-tab). */
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        if (document.visibilityState !== "visible") return;
        lock = await navigator.wakeLock?.request("screen");
      } catch {
        /* unsupported or denied — the panel's own power settings take over */
      }
    };

    void acquire();
    const onVisible = () => {
      if (!cancelled && document.visibilityState === "visible") void acquire();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => {});
    };
  }, []);

  /* ── fullscreen ──────────────────────────────────────────────────────
     A mini PC launched with `chrome --kiosk` is already full-screen and this
     never fires. It exists for the other case: staff opening the URL in a
     normal window to check a screen, where one click makes it fill the panel.
     Browsers only allow the request from a user gesture. */
  useEffect(() => {
    const onFirstPointer = () => {
      if (!document.fullscreenElement) {
        void document.documentElement.requestFullscreen?.().catch(() => {});
      }
      window.removeEventListener("pointerdown", onFirstPointer);
    };
    window.addEventListener("pointerdown", onFirstPointer);
    return () => window.removeEventListener("pointerdown", onFirstPointer);
  }, []);

  /* ── no right-click menu on a public wall ───────────────────────────── */
  useEffect(() => {
    const kill = (e: Event) => e.preventDefault();
    document.addEventListener("contextmenu", kill);
    return () => document.removeEventListener("contextmenu", kill);
  }, []);

  /* ── self-update ─────────────────────────────────────────────────────
     Latch "a newer deploy is live" on a timer; act on it only when the screen
     is between scenes. useVisibleInterval gives us no-overlap + abort, which
     matters far more here than its pause-on-hidden — this page runs for weeks.
     The pause itself no longer applies: TvApp marks this document never-hidden,
     because Edge calls an occluded wall panel hidden and a screen that stopped
     checking for deploys is a screen that never takes one (2026-08-19). */
  useEffect(() => {
    void captureKioskBootVersion();
  }, []);

  /** When this tab booted — the uptime the nightly recycle measures. */
  const bootedAtRef = useRef(Date.now());

  useVisibleInterval(async () => {
    if (updatePending) return;
    if (await kioskUpdateAvailable()) {
      setUpdatePending(true);
      return;
    }
    // MAX-UPTIME RECYCLE: the reload below is the page's only memory amnesty,
    // and gating it on "a deploy shipped" meant a quiet week never reloaded at
    // all. Latching the SAME flag inherits every safety for free — the reload
    // still waits for a scene boundary, never cuts an interrupt, and never
    // lands while a briefing or check-in owns the glass. Nightly in the small
    // hours (venue time — see recycle.ts), hard-capped at 24h; uptime resets
    // on reload, so it can never loop.
    if (shouldRecycle(Date.now() - bootedAtRef.current, etHourNow())) setUpdatePending(true);
  }, TV_UPDATE_CHECK_MS);

  useEffect(() => {
    if (!updatePending) return;
    if (!safeToReload) return;
    // Identity lives in the canonical URL, so the reload re-provisions from
    // Neon and comes back on the same screen config.
    window.location.reload();
  }, [updatePending, safeToReload]);

  return (
    <>
      {children}
      {/* Staff-readable stamp: which screen this is and what it's running.
          Small, dim, and it rides the burn-in drift with everything else. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          right: 18,
          bottom: 14,
          fontSize: 15,
          letterSpacing: "0.08em",
          color: "rgba(245,236,238,0.28)",
          fontVariantNumeric: "tabular-nums",
          pointerEvents: "none",
        }}
      >
        {screenLabel} · v{SIGNAGE_VERSION}
        {updatePending ? " · update pending" : ""}
      </div>
    </>
  );
}
