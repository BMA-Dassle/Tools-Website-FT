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
import { useGatedReload } from "../useGatedReload";
import { feedLiveness } from "../liveness";
import {
  FEED_HEAL_CHECK_MS,
  dropLastAttempt,
  readAttempts,
  recordAttempt,
  shouldHeal,
} from "../feed-heal";
import type { TvFeedHealth } from "../useTvFeed";

/**
 * How far apart the panels of a video wall reload.
 *
 * Long enough that the wall RIPPLES rather than blinks — a guest reads one panel
 * rebooting as one panel rebooting, and five at once as the system going down
 * (which is exactly how it was read: owner 2026-09-01, "the welcome crashed all
 * the screens and they rebooted"). Short enough that the whole wall is on the new
 * build inside twenty seconds.
 */
const WALL_RELOAD_STAGGER_MS = 4_000;

export function TvShell({
  screenLabel,
  /** False while an interrupt is on screen — the reload waits for a calm beat. */
  safeToReload,
  /** Which screen this is, for the per-screen self-heal attempt log. */
  screenId,
  /** Poll-health stamps, for the self-heal below. See feed-heal.ts. */
  health,
  /** True when the viewport is not filling its monitor — see usePanelFill. */
  windowed,
  /**
   * This panel's place on a video wall, or null for a screen standing on its own.
   * The ONLY thing it is used for is spacing planned reloads apart — see below.
   */
  wallPosition,
  children,
}: {
  screenLabel: string;
  safeToReload: boolean;
  screenId: string | null;
  health: TvFeedHealth;
  windowed: boolean;
  wallPosition: number | null;
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
     A mini PC launched with `--kiosk` or `--start-fullscreen` already fills its
     panel and none of this fires. It is for the other case: a board opened by
     hand, or one KNOCKED OUT of fullscreen with Esc or F11.

     THE BUG THIS USED TO HAVE: the listener was one-shot. It removed itself on
     the first pointerdown whether or not the request was granted — and browsers
     reject the request outright unless the gesture is trusted — so a board that
     lost fullscreen could never get back in no matter how many times somebody
     tapped it. The one input a wall panel ever receives was spent on the first
     click of its life, hours or weeks earlier.

     It now stays armed and retries on any gesture while the board is not filling
     its panel, and re-arms on fullscreenchange so leaving fullscreen puts it
     back in play immediately.

     WHY THERE IS NO TIMER HERE, AND WHY THAT IS NOT LAZINESS: requestFullscreen
     is refused without a trusted user gesture, by every engine, deliberately. A
     page cannot put itself full-screen on a schedule — so an unattended board
     that fell out cannot be recovered from JS at all, and pretending otherwise
     with a retry loop would just bury a rejected promise every few seconds. The
     honest options for that board are the two below it: say so where staff and
     the admin page can both see it, and fix it at the launcher. */
  useEffect(() => {
    const tryFill = () => {
      if (document.fullscreenElement) return;
      void document.documentElement.requestFullscreen?.().catch(() => {
        /* refused — untrusted gesture, or a policy that forbids it. The next
           gesture gets another go, which is the whole point of not unbinding. */
      });
    };
    // Keydown as well as pointerdown: the boards have no mouse, and a staff
    // member at a player is holding a keyboard.
    window.addEventListener("pointerdown", tryFill);
    window.addEventListener("keydown", tryFill);
    return () => {
      window.removeEventListener("pointerdown", tryFill);
      window.removeEventListener("keydown", tryFill);
    };
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

  // Identity lives in the canonical URL, so the reload re-provisions from Neon
  // and comes back on the same screen config.
  //
  // AND NEVER INTO AN OUTAGE. This navigation is the one thing on a TV that a
  // network loss cannot be ridden out through: it parks Edge on its own error
  // page, which no timer of ours can come back from and which the launcher's
  // relaunch loop never sees, because Edge did not exit. That matters most for
  // the max-uptime recycle above, which is clock-driven and would happily fire
  // at 3am into a dead network — on every screen of a wall at once, since they
  // share an uptime. The latch stays set and the gate retries, so the reload
  // lands the moment the network does.
  /* ── A VIDEO WALL RELOADS IN A RIPPLE, NEVER IN UNISON ──────────────────
     Five panels share a clock, a config and a scene decision, so they answer
     `safeToReload` identically — and the note above already knew it ("on every
     screen of a wall at once, since they share an uptime"). Every reload path
     therefore fires on all five within a tick of each other: a deploy, the
     nightly recycle, and a staff press alike.

     ON SCATTERED SCREENS THAT IS INVISIBLE, which is why it stood for months. On
     a five-panel wall in the lobby it is the whole fixture going black together
     and coming back through the boot loader, and it reads as a crash — the more
     so because the release instant is usually the END OF AN INTERRUPT. A
     celebration holds the reload on all five panels (`safeToReload` is false for
     an interrupt), so a pending update lands the moment the welcome finishes, and
     what a guest sees is: somebody checks in, the wall says welcome, the wall
     dies. That is the reported fault, and nothing had thrown.

     The stagger is applied AFTER the safety gate, deliberately. Delaying the
     latch instead would be defeated by exactly the case that matters: three
     panels whose offsets expired during a celebration would come off the hold
     together anyway.

     NOT ON THE SELF-HEAL PATH BELOW. A board that has lost its feed is already
     blank to the guest, and holding it dark another sixteen seconds to be tidy
     would be the wrong trade — that one goes back as fast as it can. */
  const wantsReload = updatePending && safeToReload;
  const [staggerCleared, setStaggerCleared] = useState(false);
  useEffect(() => {
    if (!wantsReload || staggerCleared) return;
    // Always through the timer, even at zero: a setState in an effect BODY
    // cascades renders on a page that runs for weeks (see the note further down).
    const t = setTimeout(
      () => setStaggerCleared(true),
      Math.max(0, wallPosition ?? 0) * WALL_RELOAD_STAGGER_MS,
    );
    return () => clearTimeout(t);
  }, [wantsReload, staggerCleared, wallPosition]);

  const heldForNetwork = useGatedReload(wantsReload && staggerCleared);

  /* ── self-heal: a board nobody is hearing from reloads itself ─────────
     Read feed-heal.ts before changing any of this. The three rules that are not
     obvious: it is NOT gated on safeToReload (a wedged feed pins the scene
     decision, so waiting for a calm beat is a deadlock), it is DERIVED rather
     than latched (so a feed that comes back on its own disarms the gate instead
     of spending a blink on the wall), and it is capped in localStorage (so a
     board whose feed stays broken while the origin answers cannot reload every
     five minutes forever). */
  const [shellMountedAtMs] = useState(() => Date.now());
  const [healArmed, setHealArmed] = useState(false);

  /* THE WHOLE DECISION LIVES IN THE INTERVAL CALLBACK, not in an effect body.
     Partly because react-hooks/set-state-in-effect is right — a setState in an
     effect body cascades renders on a page that runs for weeks — and partly
     because it means the shell re-renders only when the ARMED FLAG FLIPS, rather
     than every 15s forever just to re-ask a question whose answer is almost
     always no. The clock and the latest health reach the callback through refs,
     which is exactly what refs are for: read outside render, written in an
     effect. */
  const healthRef = useRef(health);
  useEffect(() => {
    healthRef.current = health;
  }, [health]);
  const armedRef = useRef(false);

  useEffect(() => {
    if (!screenId || typeof window === "undefined") return;
    const evaluate = () => {
      const nowMs = Date.now();
      const live = feedLiveness({
        ...healthRef.current,
        nowMs,
        mountedAtMs: shellMountedAtMs,
      });
      if (live.state !== "stale") {
        // RECOVERED. Disarmed on the STATE, not on the policy — once an attempt
        // is recorded the policy itself may say "no" because the cap is now
        // reached, and reading that as recovery would drop a gate that should
        // still be waiting for the network.
        if (armedRef.current) {
          armedRef.current = false;
          setHealArmed(false);
          // AND HAND THE ATTEMPT BACK. It was recorded when we armed, but the
          // gate never navigated — reaching this line is the proof, since a
          // navigation would have taken the page with it. The cap is there to
          // stop a board reloading in front of guests, not to ration wanting
          // to, and at a 90s threshold an evening of one-minute blips would
          // otherwise spend it before the first real wedge. See dropLastAttempt.
          dropLastAttempt(window.localStorage, screenId);
        }
        return;
      }
      if (armedRef.current) return;
      if (
        !shouldHeal({
          ageMs: live.ageMs,
          attempts: readAttempts(window.localStorage, screenId),
          nowMs,
        })
      ) {
        return;
      }
      // Recorded BEFORE arming: the navigation destroys this page, so anything
      // written after it is never written. See recordAttempt.
      recordAttempt(window.localStorage, screenId, nowMs);
      armedRef.current = true;
      setHealArmed(true);
    };
    const iv = setInterval(evaluate, FEED_HEAL_CHECK_MS);
    return () => clearInterval(iv);
  }, [screenId, shellMountedAtMs]);

  /* THE ONE GATE ALLOWED TO BREAK ITS OWN HOLD. A board this far gone is not
     waiting on a deploy, it is unreachable — and the reason is either the
     network (hold) or this page's own wedged connection (reload, and the manual
     reload that fixed FT:10 on 2026-08-20 is the proof). The escape asks a
     second hostname to tell those apart, and the attempt cap above is what makes
     it safe to hand that power to this path and no other. */
  const heldForHeal = useGatedReload(healArmed, true);

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
        {/* THE SELF-HEAL SAYS SO FIRST. It is the more urgent of the two and the
            one somebody may be standing in front of asking "is it doing
            anything?" — the scores wall's own footer has already gone amber by
            this point, and this line says what the board is doing about it. */}
        {healArmed
          ? heldForHeal
            ? " · no feed · reload held · no network"
            : " · no feed · reloading"
          : updatePending
            ? heldForNetwork
              ? " · reload held · no network"
              : " · update pending"
            : ""}
        {/* Last, and only when true: a windowed board is a cosmetic fault, so it
            must never push a feed problem off the end of this line. It says
            "windowed" rather than anything alarming because the picture itself is
            correct — TvStage scales the canvas to whatever viewport it is given. */}
        {windowed ? " · windowed · press F11" : ""}
      </div>
    </>
  );
}
