"use client";

import { IconDeviceMobile, IconShare2, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { ICON } from "../primitives/icon-props";

/**
 * "Add this to your home screen."
 *
 * Owner, 2026-09-14: "create the pwa app on my list with icon recommend
 * installing it when going into the page." Reps work from phones and the
 * browser chrome costs about a third of a screen that is already columns in a
 * row — so this asks, rather than waiting to be discovered.
 *
 * INSISTENT, NOT NAGGING. It appears on the second visit rather than the
 * first (somebody opening a link once should not be sold an app), stays until
 * it is answered, and once dismissed does not come back for 30 days. A banner
 * that reappears every load is one people learn to swipe away without reading.
 *
 * TWO PLATFORMS, TWO TRUTHS:
 *   - Chrome / Edge / Android fire `beforeinstallprompt`, which we keep and
 *     replay on the button. That is the real install.
 *   - iOS Safari fires nothing and has no API. The only route is Share →
 *     Add to Home Screen, so on iOS this shows those words instead of a
 *     button that could not work. Telling somebody to press a button that
 *     does nothing is worse than telling them where the menu is.
 *
 * Already installed → nothing. `display-mode: standalone` is true inside the
 * installed app, and iOS sets `navigator.standalone`.
 *
 * Every `localStorage` touch is wrapped: it throws outright in a private
 * window and in some embedded browsers, and a storage failure must not cost
 * the CRM its shell.
 */

const KEY = "crm.install.prompt";
const DISMISS_DAYS = 30;
const VISIT_BEFORE_ASKING = 2;

interface Stored {
  visits: number;
  dismissedAt: number | null;
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { visits: 0, dismissedAt: null };
    const v = JSON.parse(raw) as Partial<Stored>;
    return {
      visits: typeof v.visits === "number" ? v.visits : 0,
      dismissedAt: typeof v.dismissedAt === "number" ? v.dismissedAt : null,
    };
  } catch {
    return { visits: 0, dismissedAt: null };
  }
}

function write(v: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // A private window cannot remember; the banner simply asks again.
  }
}

/** The event Chromium fires; not in lib.dom yet. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia("(display-mode: standalone)").matches;
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function InstallPrompt() {
  const [show, setShow] = useState(false);
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    if (isStandalone()) return;

    const stored = read();
    const dismissedRecently =
      stored.dismissedAt !== null &&
      Date.now() - stored.dismissedAt < DISMISS_DAYS * 24 * 60 * 60 * 1000;
    const visits = stored.visits + 1;
    write({ ...stored, visits });
    if (dismissedRecently || visits < VISIT_BEFORE_ASKING) return;

    if (isIos()) {
      setIos(true);
      setShow(true);
      return;
    }

    const onPrompt = (e: Event) => {
      // Without this Chrome shows its own mini-infobar and our banner never
      // gets the chance; keeping the event is what lets the button work.
      e.preventDefault();
      setDeferred(e as InstallPromptEvent);
      setShow(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    const onInstalled = () => setShow(false);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!show) return null;

  const dismiss = () => {
    setShow(false);
    write({ ...read(), dismissedAt: Date.now() });
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    setShow(false);
    // A refusal is a dismissal: do not ask again tomorrow.
    if (outcome === "dismissed") write({ ...read(), dismissedAt: Date.now() });
  };

  return (
    <div className="install-prompt" role="region" aria-label="Install the Sales CRM">
      <span className="ip-ico" aria-hidden>
        <IconDeviceMobile {...ICON} />
      </span>
      <div className="ip-body">
        <div className="ip-title">Put the CRM on your home screen</div>
        <div className="ip-sub">
          {ios ? (
            <>
              Tap <IconShare2 size={14} stroke={2} aria-label="Share" /> Share, then{" "}
              <b>Add to Home Screen</b>.
            </>
          ) : (
            "Opens full screen, no browser bars — the board fits."
          )}
        </div>
      </div>
      {ios ? null : (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void install()}>
          Install
        </button>
      )}
      <button type="button" className="ip-x" aria-label="Not now" onClick={dismiss}>
        <IconX {...ICON} />
      </button>
    </div>
  );
}
