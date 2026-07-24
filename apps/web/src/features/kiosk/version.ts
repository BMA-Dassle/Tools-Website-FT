/**
 * Kiosk self-update check. A kiosk browser stays open for days; when we deploy a
 * new build it otherwise keeps running the old JS until someone closes + reopens
 * it. Instead, record the deploy this tab BOOTED on, and on each between-guest
 * reset (Start Over / post-booking auto-reset) compare it to what the server is
 * serving now — if a newer deploy is live, HARD-reload to pick it up; otherwise
 * soft-nav (which preserves the engaged fullscreen). Owner 2026-07-19.
 *
 * Module-level state is per JS context: a hard reload re-captures the boot
 * version against the new deploy, so it never reload-loops.
 */

/**
 * Human-facing kiosk software version — shown in the admin header AND bottom-
 * right of every kiosk screen (KioskShell) so staff can confirm at a glance
 * what a kiosk is running. Bump on every kiosk feature release (the deploy-SHA
 * self-update below is what actually drives reloads).
 * 1.5.0 — mid-session qualification refreshing: tier/memberships, waiver, and
 *         credits re-pull from BMI/Pandora at the people-step exit + review→pay,
 *         so desk upgrades / phone-signed waivers land without re-adding anyone.
 *         Fixes: minor-vs-adult waiver template now uses the BMI birthdate
 *         (guardian paths no longer default unknown ages to adult); confirmation-
 *         screen card fulfillment gets the out-of-cards/bin-full/jam hold with
 *         staff Resume (was dead-ending the basket); Combine cards re-enabled
 *         on the documented ConsolidateCards op.
 * 1.4.1 — fix: new-card clear-on-encode (GC_CLEAR_ON_ENCODE) now actually clears.
 *         TPI_ClearAccount was sending the account array as <string> items,
 *         which the server ignored (empty array → no-op, still code 0); the
 *         array item must be <long> (int64). Verified live 2026-07-23.
 * 1.4.0 — Game Zone honors the global INTERCARD_LOAD_MODE switch: forcing
 *         `cloud` stops the kiosk dialing the on-prem bridge, so the card-system
 *         chip reads Cloud and every load rides the cloud SOAP path.
 * 1.3.1 — Game Zone shows a Local/Cloud card-system chip (bridge status) on
 *         the New cards + Reload screens; util-bar helper text clamps to two
 *         lines instead of towering when the bar is crowded.
 * 1.3.0 — race product step reads as one directed step: packages auto-advance
 *         to scheduling; covered-by-pack pricing + "now pick your race"
 *         guidance; Race-today hand-off carries fresh pack credits.
 * 1.2.0 — guest-assist radio alerts (+ card-fault auto-beacon); MSR kiosks
 *         are swipe-only (no typed card entry); version tag on every screen.
 * 1.1.0 — serial-COM MSR swipe reader (reload-only kiosks) + Windows
 *         touch-keyboard suppression on OSK fields.
 */
export const KIOSK_VERSION = "1.5.0";

let bootVersion: string | null = null;
let captured = false;

async function fetchVersion(): Promise<string | null> {
  try {
    const res = await fetch("/api/kiosk/version", { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

/** Record the deploy this tab booted on. Idempotent — safe to call on every mount. */
export async function captureKioskBootVersion(): Promise<void> {
  if (captured) return;
  captured = true;
  bootVersion = await fetchVersion();
}

/**
 * True when the server is serving a DIFFERENT (newer) deploy than this tab booted
 * on, so a reset should hard-reload. Fails safe to false — unknown boot version,
 * a dev build, or a fetch error never forces a reload (and never loops).
 */
export async function kioskUpdateAvailable(): Promise<boolean> {
  if (!bootVersion || bootVersion === "dev") return false;
  const current = await fetchVersion();
  return !!current && current !== "dev" && current !== bootVersion;
}

/**
 * Reset to the attract screen, self-updating if a newer deploy is live: hard
 * reload to load the new build (fullscreen re-engages on the first attract tap),
 * else soft-nav via the caller's router.replace so fullscreen is preserved.
 */
export async function resetToKiosk(softNav: () => void, path = "/kiosk"): Promise<void> {
  if (await kioskUpdateAvailable()) {
    window.location.href = path;
  } else {
    softNav();
  }
}
