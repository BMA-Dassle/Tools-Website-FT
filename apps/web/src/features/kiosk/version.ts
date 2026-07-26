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
 * 1.8.1 — HOTFIX for the 1.8.0 rollout: the config-envelope version bump (v2→v3
 *         for `locale`) was DISCARDING every older stored config on read, which
 *         sent all already-provisioned kiosks back to the KIOSK SETUP screen.
 *         readStorage now MIGRATES older envelopes forward (additive fields
 *         backfill from resolveKioskConfig) and re-persists at the current
 *         version, so a device keeps its venue + hardware across a shape bump.
 * 1.8.0 — SPANISH (guest i18n): the whole guest-facing kiosk speaks Spanish now,
 *         behind NEXT_PUBLIC_KIOSK_I18N. A flag switcher (US / ES) sits on the
 *         attract screen and the "what are we doing today?" chooser; the choice
 *         rides in KioskConfig and resets to the device default on Start Over.
 *         Ships with the IN-HOUSE WAIVER (NEXT_PUBLIC_KIOSK_WAIVER_INHOUSE,
 *         default ON): we serve our OWN adult/minor waiver body (EN + ES) so it
 *         can be translated, while keeping BMI's real contentID/duration so the
 *         sign path is byte-identical. Minor waivers lead with a red
 *         guardian-MUST-sign banner + a Florida Statute § 831.01 (forgery)
 *         notice; the kiosk signing UI is enlarged to use the portrait screen.
 * 1.7.2 — scanner model #2's brand corrected: it's an OPTICON 2D imager, not
 *         Posiflex. Registry id renamed posiflex-2d → opticon-2d, expected
 *         VID now 0x065A (Opticon's registered VID; was Posiflex 0x0D3A).
 *         Still fully unconfirmed until a unit is provisioned — 9600 default
 *         + the panel's baud-stepping test flow unchanged.
 * 1.7.1 — device check reports the COM QR scanner (live serial-grant match
 *         against the saved port, model + baud shown) instead of the retired
 *         USB keyboard-wedge toggle; the sign-in boxes fold/unfold on an
 *         always-visible "More ways to add people" bar at any time (roster
 *         state is just the default), keeping the amber "N phones signing in"
 *         status in every state.
 * 1.7.0 — the people-step sign-in methods are now three equal, tappable boxes
 *         under the entry buttons — "Sign in from your phone" (mobile-join QR,
 *         inline + tap to enlarge to a focused sheet), "Scan your license"
 *         (driver's license / state ID), and "Scan your FastTrax license" —
 *         each shown only when its method is live, folding into a slim bar once
 *         someone's on the roster. Race Packs gains phone sign-in (reuses the
 *         existing mobile-join feature). One shared KioskSignInBoxes across
 *         racing, gel blaster, laser tag, and race packs. UI only — scanning /
 *         parsing / lookup unchanged.
 * 1.6.6 — Posiflex 2D imaging scanner added to the QR-scanner model registry
 *         (admin → QR scanner tab → Model select). Output format, baud and
 *         USB ids are all UNCONFIRMED until a unit is provisioned — the
 *         panel's scan feed + baud stepping is the test surface, exactly the
 *         flow the 3320g used. Default model stays the Honeywell.
 * 1.6.5 — SMS-Timing member QR sign-in: scanning the app's personal QR
 *         (https://smstim.in?["<clientKey>","<code>"]) Office-searches the
 *         code and signs the member straight in (~1 s) — same rail as the
 *         license scan; foreign clientKeys and junk codes are rejected.
 * 1.6.4 — license lookup rebuilt on the BMI Office token search with a
 *         combined "LastName M/D/YYYY" token (owner's vector — no leading
 *         zeros, raw https; undici 500s on these tokens): ~1 s live vs ~8.5 s
 *         on Pandora person search. Waiver resolves post-sign-in via the
 *         OTP path's "Checking waiver…" rail; live duplicate ranks first
 *         (plausible-name recency beats exact-name staleness).
 * 1.6.3 — Combine cards rebuilt on the real rails: TPI_ConsolidateAccounts on
 *         the standard cloud SOAP host (WSDL-exact envelope — <long> account
 *         array, LocID position, GMT_DateTime; no raw sockets / extra hosts).
 *         Failures HALT the accept loop and show the actual cause + Try again
 *         (was: silent "see attendant" + 30s reset loop); button hides itself
 *         when the backend isn't configured; card always returned promptly.
 *         Done/Back are tappable while waiting for a card (the wait had them
 *         disabled ~permanently — guests were stuck) and exit INSTANTLY by
 *         cancelling the pending insert wait; only the live money-move
 *         (seconds) disables them, and the wait screen shows the insert
 *         animation instead of a false "Combining…" spinner.
 * 1.6.2 — license lookup shows EVERY matching account (duplicates included —
 *         the picker appears whenever more than one record matches; 1.6.1
 *         silently collapsed dupes to one) and returns faster: the 2-year
 *         deposit pull moved out of the lookup (qualification refresh fills
 *         credits at step exits) and the kiosk pre-warms Pandora when a
 *         scan-capable screen mounts, so the first scan skips the cold start.
 * 1.6.1 — license lookup rebuilt on Pandora GET /bmi/person/search (lastName +
 *         birthday, filter=false, cold-start 5xx retry). 1.6.0 searched the
 *         Office token API, which 500s on name tokens — scans parsed but never
 *         found the account. Duplicate records now collapse to one sign-in
 *         (waiver-carrying copy preferred). Verified against the live route.
 * 1.6.0 — driver's-license scan (hardware QR scanner): scanning a license at
 *         the people/party/bowling screens signs a returning guest in by last
 *         name + DOB (Pandora-matched; multi-match → account picker) or opens
 *         the new-player form prefilled; guardian + setup forms scan-fill too.
 *         Only name + DOB are read off the license — nothing else is kept.
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
export const KIOSK_VERSION = "1.8.1";

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

/**
 * Record the deploy this tab booted on. Idempotent — safe to call on every
 * mount. Only latches once we ACTUALLY have a version: if the boot-time fetch
 * fails (a network blip right at load — exactly what happens on a kiosk whose
 * WiFi is flaky), we leave it uncaptured so a later call can still snapshot it.
 * Previously this latched `captured = true` even on a failed fetch, which left
 * `bootVersion` null for the life of the tab and SILENTLY disabled self-update
 * until someone manually reopened the browser (found 2026-07-24).
 */
export async function captureKioskBootVersion(): Promise<void> {
  if (captured) return;
  const v = await fetchVersion();
  if (v == null) return; // fetch failed — don't latch; retry on the next call
  bootVersion = v;
  captured = true;
}

/**
 * True when the server is serving a DIFFERENT (newer) deploy than this tab booted
 * on, so a reset should hard-reload. Fails safe to false — unknown boot version,
 * a dev build, or a fetch error never forces a reload (and never loops).
 *
 * If the boot version was never captured (boot-time fetch failed), retry the
 * capture here first — the 5-min attract poll calls this, so a device that
 * booted during a blip recovers self-update on its own instead of staying
 * stuck on the old build forever.
 */
export async function kioskUpdateAvailable(): Promise<boolean> {
  if (!bootVersion) {
    await captureKioskBootVersion();
    if (!bootVersion) return false; // still couldn't capture — try again next tick
  }
  if (bootVersion === "dev") return false;
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
