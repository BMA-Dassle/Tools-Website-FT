"use client";

/**
 * WHAT A WALL PANEL DOES WHEN ITS OWN JAVASCRIPT THROWS.
 *
 * Until now: nothing. There was no error boundary anywhere in this app, so an
 * exception escaping a scene handed the panel to Next's built-in fallback —
 * "Application error: a client-side exception has occurred", black text on
 * white, in front of guests, until somebody drove out. That is the same dead end
 * as Edge's offline page: a screen nobody is standing at, with nothing left
 * running that could ever bring it back.
 *
 * So the boundary does the two things a signage page actually needs.
 *
 *   IT LOOKS LIKE A SCREEN COMING UP, not a screen that is broken. The venue
 *   ground colour and the house loader — the same one a booting board shows —
 *   because for the ten seconds this is on the wall a guest should read "starting"
 *   and not "out of order".
 *
 *   IT PUTS ITSELF BACK. A reload re-boots the board from its cached feed and
 *   config, so a transient throw costs a blink. The reload goes through the same
 *   gate every other TV reload uses, so a crash during a network outage cannot
 *   turn a recoverable page into Edge's unrecoverable one (reload-gate.ts).
 *
 * WITH A CIRCUIT BREAKER, because a DETERMINISTIC crash — a bad build, a feed
 * shape no scene can render — would otherwise put nineteen screens into a reload
 * loop against our own origin forever. Three crashes inside ten minutes and the
 * panel stops trying and just sits on the branded ground: still not an error
 * page, still fixed by the next deploy or a power cycle, but no longer hammering.
 */
import { useEffect } from "react";
import { BrandedLoader } from "~/features/kiosk/components/BrandedLoader";
import { parseScreenKey } from "~/features/signage/constants";
import { originReachable, startGatedReload } from "~/features/signage/reload-gate";
import { browserCrashStore, noteCrashAndShouldRecover } from "~/features/signage/crash-breaker";

/** Long enough that a guest reads the loader as a boot, short enough to be a blink. */
const RECOVER_AFTER_MS = 8_000;

export default function TvError({ error }: { error: Error & { digest?: string } }) {
  // Read during render, the same way TvApp reads its `?debug` flag. The screen
  // id is in the canonical URL (TvApp rewrites it there at boot), so even a
  // panel that crashed before resolving its identity is branded correctly.
  const brand =
    typeof window !== "undefined" &&
    parseScreenKey(new URLSearchParams(window.location.search).get("screen"))?.venue === "FT"
      ? "fasttrax"
      : "headpinz";

  useEffect(() => {
    // Nobody is at the wall to read a console, and the boundary itself is the
    // only place this exception is ever observable.
    console.error("[tv] scene crashed", error?.digest ?? "", error);

    if (!noteCrashAndShouldRecover(Date.now(), browserCrashStore())) return;

    let handle: { cancel(): void } | null = null;
    const timer = setTimeout(() => {
      handle = startGatedReload({
        probe: () => originReachable(),
        reload: () => window.location.reload(),
      });
    }, RECOVER_AFTER_MS);

    return () => {
      clearTimeout(timer);
      handle?.cancel();
    };
  }, [error]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000418",
        display: "grid",
        placeItems: "center",
        color: "#fff",
      }}
    >
      <BrandedLoader brand={brand} size={360} />
    </div>
  );
}
