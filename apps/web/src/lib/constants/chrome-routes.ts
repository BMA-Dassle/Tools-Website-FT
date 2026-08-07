/**
 * Site-chrome route registry — the ONE place that answers "does this path get
 * a Nav / Footer / mobile Book-Now bar?".
 *
 * Read by TWO callers, and it has to be both or the answer goes stale:
 *
 *   1. `middleware.ts` — sets `x-no-chrome` / `x-no-mobile-bar` request headers
 *      for the ENTRY render (the document the browser actually loads).
 *   2. `ChromeGate` (src/components/layout/ChromeGate.tsx) — re-evaluates on
 *      every client-side navigation after that.
 *
 * Why (2) exists: `app/layout.tsx` reads those headers, and a root layout
 * "[doesn't] re-render on navigation" (Next.js partial rendering — see
 * node_modules/next/dist/docs/01-app/02-guides/authentication.md). So the chrome
 * decision made for the first page of a visit was frozen for the whole session:
 * clicking "Waiver" in the FastTrax nav landed on /waiver with the site nav
 * still overlaying the waiver's own header, and only a hard refresh cleared it.
 * HeadPinz never showed the symptom because its nav is rendered by the nested
 * per-section layouts under app/hp/, which DO unmount when you navigate off /hp.
 *
 * Rules for changing this file:
 *   - A route that wants chrome suppressed is named ONCE, here. Do not add a
 *     path test to a host branch in middleware.ts — that is exactly how /racer
 *     shipped with a tap-blocking bar on fasttraxent.com but not headpinz.com
 *     (2026-08-06).
 *   - Keep it dependency-free and pure. It is imported by the edge middleware
 *     AND by a client component, so it must not touch `process.env`, `headers()`
 *     or any feature module.
 */

/** Where a guest blocked by a vendor outage lands. Kept as a literal so this
 *  module stays dependency-free; pinned to `SERVICE_NOTICE_PATH` (the real
 *  export, in ~/features/maintenance) by a test in chrome-routes.test.ts. */
const SERVICE_NOTICE = "/service-notice";

/** Trailing slashes are not significant to any rule below ("/waiver/" is
 *  "/waiver"), but the root path keeps its slash. */
function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/, "") || "/";
  return pathname;
}

/**
 * Focused customer screens that render their OWN brand header and want no site
 * Nav, Footer, mobile bar, chat widget or ad popups on either brand host.
 *
 * Prefix tests carry a trailing slash on purpose: a bare `startsWith("/r")`
 * would also swallow /racing, /rewards and /reload.
 */
export function isChromeFreePath(pathname: string): boolean {
  const p = normalize(pathname);
  return (
    // Cross-brand promo landing — full-bleed marketing hero carrying its own
    // dual-brand logos, so neither brand's nav belongs on it.
    p === "/july4" ||
    // Kiosk "join from your phone" screen. A focused mid-visit screen whose
    // brand comes from the join-session record, not the host.
    p === "/join" ||
    p.startsWith("/join/") ||
    // Unified first-party waiver flow — its own brand header, and the site nav
    // sat on top of it when you arrived from the menu (owner report 2026-08-07).
    p === "/waiver" ||
    p.startsWith("/waiver/") ||
    // A racer's own page — their licence QR, their next race. The fixed site
    // Nav was overlaying the racer's NAME at the top of it.
    p.startsWith("/r/") ||
    // Collecting a party's licences after scanning a kiosk QR — one job, its
    // own brand header, nothing else on screen competing with it.
    p.startsWith("/passes/") ||
    // In-center self-service kiosk — its own shell (KioskShell), its own
    // chrome, and a shared public device that also drops the mini-carts.
    p === "/kiosk" ||
    p.startsWith("/kiosk/")
  );
}

/**
 * Screens that KEEP the nav and footer but drop the fixed mobile "Book Now"
 * bar: the guest is already mid-flow (or holding up a QR) and the bar covers
 * the one control that matters.
 */
export function isMobileBarFreePath(pathname: string): boolean {
  const p = normalize(pathname);
  return (
    // Focused customer-flow screens: post-visit survey, group-function contract
    // signing, event landing pages, the account portal.
    p.startsWith("/survey/") ||
    p.startsWith("/contract/") ||
    p.startsWith("/event/") ||
    p === "/account" ||
    p.startsWith("/account/") ||
    // E-tickets (racing + Arena). The bar overlaps the full-screen ticket
    // button and the QR modals, and the guest already paid.
    p.startsWith("/t/") ||
    p.startsWith("/g/") ||
    // Voucher redemption — the guest is holding a QR up to a kiosk and the bar
    // covers the bottom of the code (owner 2026-08-03).
    p.startsWith("/v/") ||
    // Racing-licence lookup. Keeps the nav, unlike /r/, because this is a way
    // IN to the site — but the bar sat over the one control on the page and
    // iPhone racers reported they could not tap it (2026-08-06).
    p === "/racer" ||
    p.startsWith("/racer/") ||
    // The page that just told the guest we cannot take a booking right now.
    p === SERVICE_NOTICE ||
    // Any booking confirmation — top-level /book/confirmation and the per-flow
    // nested ones (/book/checkout/confirmation, /book/race/confirmation, …).
    // These ARE the customer's e-ticket screen.
    /\/confirmation(?:\/|$)/.test(p)
  );
}

/** Staff-only admin tool — bare, no chrome, no carts. */
export function isAdminPath(pathname: string): boolean {
  const p = normalize(pathname);
  return p === "/admin" || p.startsWith("/admin/");
}

/** In-center kiosk — shared public device, no carts. */
export function isKioskPath(pathname: string): boolean {
  const p = normalize(pathname);
  return p === "/kiosk" || p.startsWith("/kiosk/");
}

/** The HeadPinz location-chooser splash (headpinz.com/, /hp in dev). Its whole
 *  job is "pick a location", so the center Nav/Footer — which default to Fort
 *  Myers with nothing picked — must not render on it. */
export function isHeadPinzSplashPath(pathname: string): boolean {
  const p = normalize(pathname);
  return p === "/" || p === "/hp";
}

export type Brand = "fasttrax" | "headpinz";

/** Which chrome slots are visible. Mirrors the booleans app/layout.tsx builds
 *  from the request headers — the two must agree slot for slot. */
export interface ChromeFlags {
  /** Brand of the DOCUMENT. Host-derived, so it never changes under a
   *  client-side navigation — unlike everything else here. */
  brand: Brand;
  /** FastTrax Nav / Footer / chat widget. */
  ftChrome: boolean;
  /** HeadPinz Nav / Footer. */
  hpChrome: boolean;
  /** FastTrax mobile "Book Now" bar. */
  ftMobileBar: boolean;
  /** HeadPinz mobile "Book Now" bar. */
  hpMobileBar: boolean;
  /** Both mini-carts. */
  carts: boolean;
}

/** The chrome a path gets, for a document of the given brand. */
export function chromeFlagsForPath(pathname: string, brand: Brand): ChromeFlags {
  const p = normalize(pathname);
  const admin = isAdminPath(p);
  const noChrome = isChromeFreePath(p);
  const noBar = isMobileBarFreePath(p);
  const ftChrome = brand === "fasttrax" && !admin && !noChrome;
  const hpChrome = brand === "headpinz" && !admin && !noChrome && !isHeadPinzSplashPath(p);
  return {
    brand,
    ftChrome,
    hpChrome,
    ftMobileBar: ftChrome && !noBar,
    hpMobileBar: hpChrome && !noBar,
    carts: !admin && !isKioskPath(p),
  };
}
