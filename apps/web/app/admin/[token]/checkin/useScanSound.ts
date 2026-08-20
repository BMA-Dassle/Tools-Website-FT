"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

/**
 * THE DESK HEARS THE VERDICT, SO IT DOES NOT HAVE TO LOOK UP.
 *
 * Two recordings, one per outcome, played the moment the scan resolves. The
 * mapping is deliberately the SAME three-way split the card colour uses
 * (`getFlashColor`): green plays the success tone, and BOTH yellow and error
 * play the negative one. A racer scanning for a heat that has not been called
 * is not an error, but it is also not a check-in — and the one thing the desk
 * must never do is hear "success" and wave through a racer who was never
 * written in. Tone follows colour so the two cannot disagree.
 *
 * WHY FILES, NOT SYNTHESIS. Both are real recordings ops made (192kbps MPEG-1
 * Layer III, 48kHz — 2.06s and 1.06s). They preload once per page and cost
 * nothing per scan, so there is no reason to hand-roll oscillators.
 *
 * RESTART, NEVER STACK. The success recording is 2.06s and the desk can scan
 * again well inside that, so a second scan REWINDS rather than overlapping —
 * two racers' verdicts at once is worse than either alone. `pause()` +
 * `currentTime = 0` is what makes a re-trigger audible; calling `play()` on an
 * already-playing element does nothing.
 *
 * NEVER THROWS INTO THE SCAN. Every audio call is wrapped and swallowed. A
 * blocked autoplay policy, a missing file, a browser with no `Audio` at all —
 * none of them may interfere with checking a racer in.
 */

const SOUNDS = {
  success: "/sounds/scan-success.mp3",
  negative: "/sounds/scan-negative.mp3",
} as const;

export type ScanTone = keyof typeof SOUNDS;

/** Per-station, like the scanner baud rate — not a server setting. */
const STORAGE_KEY = "checkin-scan-sound";

/**
 * KILL SWITCH, NOT AN OPT-IN (house rule): absent, or anything other than the
 * literal string "false", means ON. A desk that wants silence turns it off; a
 * fresh station gets sound without anyone having to find the setting.
 */
function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

/**
 * A MODULE STORE RATHER THAN `useState` + an effect.
 *
 * The setting lives in localStorage, which cannot be read during render without
 * the server-rendered HTML disagreeing with the first client render. Reading it
 * in an effect and calling setState is the obvious fix and is what
 * react-hooks/set-state-in-effect exists to reject — it costs a second render
 * on every mount. `useSyncExternalStore` is the primitive for precisely this:
 * an external value, a server snapshot for hydration, no cascading render. It
 * also means several components would share one answer rather than drifting.
 */
let cached: boolean | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): boolean {
  if (cached === null) cached = readStored();
  return cached;
}

/** Hydration reads this — matches the kill-switch default. */
function getServerSnapshot(): boolean {
  return true;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function store(on: boolean): void {
  cached = on;
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch {
    /* private mode — the setting just does not persist */
  }
  for (const l of listeners) l();
}

export interface ScanSound {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  /** Play the tone for a resolved scan. Safe from any render path. */
  play: (tone: ScanTone) => void;
  /** Play one regardless of the setting, so staff can hear what they changed. */
  preview: (tone: ScanTone) => void;
}

export function useScanSound(): ScanSound {
  const enabled = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const elements = useRef<Partial<Record<ScanTone, HTMLAudioElement>>>({});
  const unlocked = useRef(false);

  // Preload both once. `preload="auto"` plus an explicit load() means the first
  // real scan of the shift is not the one that waits for the network.
  useEffect(() => {
    if (typeof Audio === "undefined") return;
    const made: HTMLAudioElement[] = [];
    for (const tone of Object.keys(SOUNDS) as ScanTone[]) {
      try {
        const el = new Audio(SOUNDS[tone]);
        el.preload = "auto";
        el.load();
        elements.current[tone] = el;
        made.push(el);
      } catch {
        /* no audio support — play() below becomes a no-op */
      }
    }
    return () => {
      for (const el of made) {
        try {
          el.pause();
          el.src = "";
        } catch {
          /* tearing down; nothing to salvage */
        }
      }
      elements.current = {};
    };
  }, []);

  /**
   * AUTOPLAY UNLOCK. Browsers refuse `play()` until the page has seen a real
   * user gesture, and the first scan of a shift can easily arrive before staff
   * click anything — the scanner is a serial device, not a click. One muted
   * play on the first gesture spends that requirement early, so the verdict
   * tone is never the thing that discovers the page is still locked.
   */
  useEffect(() => {
    function unlock() {
      if (unlocked.current) return;
      unlocked.current = true;
      for (const el of Object.values(elements.current)) {
        if (!el) continue;
        try {
          el.muted = true;
          void el
            .play()
            .then(() => {
              el.pause();
              el.currentTime = 0;
              el.muted = false;
            })
            .catch(() => {
              el.muted = false;
            });
        } catch {
          /* ignore */
        }
      }
    }
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const preview = useCallback((tone: ScanTone) => {
    const el = elements.current[tone];
    if (!el) return;
    try {
      // Stop the other verdict outright — only one answer per scan.
      for (const [key, other] of Object.entries(elements.current)) {
        if (!other || key === tone) continue;
        other.pause();
        other.currentTime = 0;
      }
      el.pause();
      el.currentTime = 0;
      void el.play().catch(() => {
        /* autoplay blocked or file missing — silence, never an error */
      });
    } catch {
      /* never let a display cue break a check-in */
    }
  }, []);

  const play = useCallback(
    (tone: ScanTone) => {
      if (!enabled) return;
      preview(tone);
    },
    [enabled, preview],
  );

  const setEnabled = useCallback(
    (on: boolean) => {
      store(on);
      // Turning it on plays one, because a silent toggle gives staff no way to
      // tell the setting took from the speakers being muted.
      if (on) preview("success");
    },
    [preview],
  );

  return { enabled, setEnabled, play, preview };
}
