"use client";

/**
 * Puts a full-canvas sheet where it can actually cover the canvas.
 *
 * THE TRAP (owner caught it on glass 2026-09-05, twice in one screen): a flow
 * page is four siblings — `.k-flow-head`, `.k-flow-body`, `.k-z-actions`,
 * `.k-z-util` — and kiosk.css gives ALL of them `position: relative;
 * z-index: 2`. Equal z-index means DOM order decides, so the action bar and the
 * header paint above everything inside the body, and a `fixed inset-0 z-[78]`
 * overlay rendered from a step inside `.k-flow-body` is capped by that
 * stacking context: "Book something" stayed lit and tappable through an open
 * sheet. (`.k-glass`'s `backdrop-filter` is the second, separate trap — it
 * makes a roster card the containing block for `fixed`. Both bite the same
 * kind of code.)
 *
 * Staff mode sidesteps this by mounting StaffSheetHost OUTSIDE `.k-flow`
 * (StaffModeSurface wraps the whole thing). A step buried in the body has no
 * such vantage point, so it portals to `.kiosk-canvas` instead — the element a
 * kiosk `fixed` overlay is meant to anchor to anyway, since the canvas is
 * transformed.
 *
 * Falls back to rendering in place when there is no canvas (SSR, tests, a
 * non-kiosk host) rather than throwing — a sheet that renders imperfectly
 * beats a page that crashes.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** True after hydration — server snapshot false, client snapshot true. The
 *  house idiom (see KioskCrewFlow's useHydrated): no setState in an effect, no
 *  hydration mismatch. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

export function KioskSheetPortal({ children }: { children: ReactNode }) {
  const hydrated = useHydrated();
  // Reading the DOM during render is only safe once the client owns the tree;
  // before that the server markup has no canvas to point at anyway.
  const host = hydrated ? document.querySelector(".kiosk-canvas") : null;
  if (!host) return <>{children}</>;
  return createPortal(children, host);
}
