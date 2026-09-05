"use client";

/**
 * "Put it on your home screen" — for the TRACKER, not the site.
 *
 * Installed, this opens on the kart-number screen as "FT Kart Tracker" with its
 * own icon (see app/kart/layout.tsx and app.webmanifest). The win is the
 * address bar: gone, which on a phone held sideways is most of the screen back,
 * and it is one tap next time instead of typing a URL at the counter.
 *
 * THREE PATHS, BECAUSE THE PLATFORMS DIFFER:
 *   Android Chromium  a real Install button, from `beforeinstallprompt`.
 *   Android otherwise instructions — Firefox never fires that event.
 *   iOS               instructions only. Apple has never shipped the API, so
 *                     no amount of feature detection produces a button here.
 *
 * IT NEVER SHOWS TWICE. Dismissed is remembered, and once installed the
 * standalone check hides it for good — a prompt that keeps reappearing after
 * you have done what it asked is worse than no prompt.
 *
 * RENDERS NOTHING UNTIL MOUNTED. The decision needs a user-agent and a media
 * query, and guessing server-side means a flash of the wrong instructions.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  detectInstallTarget,
  mayPromptToInstall,
  type InstallTarget,
} from "~/features/racing/driver-view/install-target";
import { t, type Locale } from "~/features/racing/driver-view/copy";
import { c, fluid, font, label } from "./tokens";

const DISMISSED_KEY = "ft-kart-tracker-a2hs-dismissed";

/** The slice of Chrome's install event we use. Not in lib.dom yet. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Whether to offer the tip at all, as ONE primitive.
 *
 * `localStorage`, the user-agent and `display-mode` are all external state, so
 * this is a real external store rather than something to copy into React state
 * in an effect — which is both the lint rule and the correct shape. Folding
 * "dismissed" into the same snapshot keeps it a plain string, and
 * `useSyncExternalStore` compares snapshots with `Object.is`: returning a fresh
 * object here would re-render forever.
 */
type Offer = InstallTarget | "dismissed";

const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function subscribeToOffer(cb: () => void): () => void {
  listeners.add(cb);
  // Installing while the page is open should retract the tip immediately.
  window.addEventListener("appinstalled", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("appinstalled", cb);
  };
}

function readOffer(): Offer {
  try {
    if (window.localStorage.getItem(DISMISSED_KEY) === "1") return "dismissed";
  } catch {
    // Private mode, or site data blocked. Showing the tip is the safe default.
  }
  return detectInstallTarget({
    userAgent: navigator.userAgent,
    standalone: window.matchMedia("(display-mode: standalone)").matches,
    iosStandalone: (navigator as Navigator & { standalone?: boolean }).standalone,
    maxTouchPoints: navigator.maxTouchPoints,
  });
}

/** There is no user-agent on the server, and guessing means a flash of the
 *  wrong instructions. "none" renders nothing until hydration says otherwise. */
const serverOffer = (): Offer => "none";

export function AddToHomeScreen({ locale }: { locale: Locale }) {
  const offer = useSyncExternalStore(subscribeToOffer, readOffer, serverOffer);
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  // Set only when localStorage is unavailable, so a dismissal still sticks for
  // the visit in a private window.
  const [dismissedHere, setDismissedHere] = useState(false);

  useEffect(() => {
    function onPrompt(e: Event) {
      // Chrome shows its own mini-infobar unless we take the event.
      e.preventDefault();
      setPrompt(e as InstallPromptEvent);
    }
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const target = offer as InstallTarget;
  if (offer === "dismissed" || dismissedHere) return null;
  if (target === "installed" || target === "none") return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
      notify();
    } catch {
      setDismissedHere(true);
    }
  };

  const install = async () => {
    if (!prompt) return;
    try {
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      // Declining is an answer. Do not ask again on the next visit.
      if (outcome === "dismissed") dismiss();
    } catch {
      /* the instructions below still stand */
    } finally {
      setPrompt(null);
    }
  };

  const canPrompt = prompt !== null && mayPromptToInstall(target, navigator.userAgent);
  const how = target === "ios" ? t(locale, "a2hsIos") : t(locale, "a2hsAndroid");

  return (
    <aside
      style={{
        border: `1px solid ${c.hairline}`,
        background: c.panel,
        borderLeft: `3px solid ${c.cyan}`,
        padding: `${fluid(9, 1.5, 14)} ${fluid(11, 1.8, 16)}`,
        display: "flex",
        alignItems: "center",
        gap: fluid(9, 1.5, 14),
        fontFamily: font.body,
      }}
    >
      <PhoneGlyph />

      <div style={{ minWidth: 0, flexGrow: 1 }}>
        <div
          style={{
            fontFamily: font.display,
            fontSize: fluid(12, 1.9, 16),
            fontWeight: 800,
            lineHeight: 1.15,
          }}
        >
          {t(locale, "a2hsTitle")}
        </div>
        <div
          style={{
            fontSize: fluid(10.5, 1.5, 13),
            color: "rgba(245,236,238,0.66)",
            marginTop: 3,
            lineHeight: 1.35,
            textWrap: "pretty",
          }}
        >
          {t(locale, "a2hsWhy")}
          {!canPrompt ? ` ${how}` : ""}
        </div>
      </div>

      {canPrompt ? (
        <button
          type="button"
          onClick={install}
          style={{
            ...label,
            flexShrink: 0,
            minHeight: 44,
            padding: "0 16px",
            background: c.cyan,
            color: c.ground,
            border: "none",
            fontSize: fluid(10, 1.4, 13),
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {t(locale, "a2hsInstall")}
        </button>
      ) : null}

      <button
        type="button"
        onClick={dismiss}
        aria-label={t(locale, "a2hsDismiss")}
        style={{
          flexShrink: 0,
          width: 44,
          height: 44,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: "none",
          color: c.inkFaint,
          cursor: "pointer",
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        >
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </button>
    </aside>
  );
}

/** A phone with a chequered strip — the tracker's mark, small. */
function PhoneGlyph() {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      style={{ flexShrink: 0 }}
      aria-hidden
    >
      <rect x="6" y="2" width="12" height="20" rx="2.5" stroke={c.cyan} strokeWidth="1.8" />
      <rect x="6.9" y="15.5" width="2.6" height="2.6" fill={c.cyan} />
      <rect x="12.1" y="15.5" width="2.6" height="2.6" fill={c.cyan} />
      <rect x="9.5" y="18.1" width="2.6" height="2.6" fill={c.cyan} />
      <rect x="14.7" y="18.1" width="2.4" height="2.6" fill={c.cyan} />
    </svg>
  );
}
