/**
 * Lobby-TV signage — venue vocabulary and platform constants.
 *
 * The TV platform deliberately speaks the SAME venue slugs as the kiosk device
 * registry (`FT` / `HPFM` / `HPN`, see features/kiosk/config.ts `venueSlug`),
 * because a lobby TV is another in-center device standing in the same building
 * as a bank of kiosks — and the kiosk-bank billboard choreography it joins is
 * keyed by that slug. One vocabulary, two device classes.
 *
 * CENTER NAMESPACE TRAP: this repo carries four parallel ids for "where" —
 * center slug (`fort-myers`), Square location id, BMI/Office location id, and
 * BMI clientKey. FastTrax and HeadPinz Fort Myers SHARE the center slug
 * `fort-myers` and are told apart only by brand/venue. Anything here that has
 * to talk to another system bridges through the maps below rather than
 * re-deriving them, and never assumes center slug alone identifies a building.
 */
import type { CenterCode } from "~/features/booking/types";

/** Venue slug — same three values the kiosk registry uses. */
export type SignageVenue = "FT" | "HPFM" | "HPN";

export const SIGNAGE_VENUES: SignageVenue[] = ["FT", "HPFM", "HPN"];

export interface VenueInfo {
  venue: SignageVenue;
  /** Human label for the admin picker. */
  label: string;
  center: CenterCode;
  brand: "fasttrax" | "headpinz";
  /** BMI / Office location id — the key for daily-events + resource lookups. */
  bmiLocationId: number;
}

/**
 * Venue → everything else. Values mirror features/daily-events/constants.ts
 * (332160 HP FM, 467486 FastTrax, 332145 Naples); both Fort Myers venues share
 * the `fort-myers` center slug and the `headpinzftmyers` BMI clientKey.
 */
export const VENUE_INFO: Record<SignageVenue, VenueInfo> = {
  FT: {
    venue: "FT",
    label: "FastTrax Fort Myers",
    center: "fort-myers",
    brand: "fasttrax",
    bmiLocationId: 467486,
  },
  HPFM: {
    venue: "HPFM",
    label: "HeadPinz Fort Myers",
    center: "fort-myers",
    brand: "headpinz",
    bmiLocationId: 332160,
  },
  HPN: {
    venue: "HPN",
    label: "HeadPinz Naples",
    center: "naples",
    brand: "headpinz",
    bmiLocationId: 332145,
  },
};

/** `HPFM:1` — the registry primary key and the `?screen=` launch param. */
export function screenKey(venue: SignageVenue, screenNumber: number): string {
  return `${venue}:${screenNumber}`;
}

/**
 * Parse a screen key back to its parts. Returns null for anything malformed —
 * an unparseable key must degrade to the ads-only default, never throw on a
 * screen that has been running unattended for weeks.
 */
export function parseScreenKey(
  key: string | null | undefined,
): { venue: SignageVenue; screenNumber: number } | null {
  if (!key) return null;
  const [venue, rawNum] = key.split(":");
  if (!venue || !rawNum) return null;
  if (!SIGNAGE_VENUES.includes(venue as SignageVenue)) return null;
  const screenNumber = Number(rawNum);
  if (!Number.isInteger(screenNumber) || screenNumber < 0) return null;
  return { venue: venue as SignageVenue, screenNumber };
}

/**
 * Screen 99 is the TEST screen at every venue — the same convention kiosk 99
 * uses (`isTestKiosk`). Demo fixtures and `?demo=` overrides are accepted ONLY
 * here, so a fabricated VIP takeover can never appear on a lobby wall.
 */
export const TEST_SCREEN_NUMBER = 99;

export function isTestScreen(screenNumber: number): boolean {
  return screenNumber === TEST_SCREEN_NUMBER;
}

/**
 * The TV canvas. Authored at a locked 1920×1080 and uniformly transform-scaled
 * to the panel (TvStage), exactly as the kiosk does at 1080×1920 portrait — so
 * proportions never drift between a preview laptop and the wall.
 */
export const TV_W = 1920;
export const TV_H = 1080;

/** Most a panel may be inset per edge, in percent. A correction, not a crop
 *  tool: 10% per edge already gives back a fifth of the wall, and anything
 *  hungrier than that is a wrongly configured display, not an overscanning one. */
export const TV_MAX_OVERSCAN_PCT = 10;

/**
 * A stored inset, made safe. ONE definition of what is legal, shared by the
 * config resolver and the stage, because the value arrives from a hand-edited
 * JSONB blob that an older or newer deploy may have written.
 *
 * Anything absent, negative, non-numeric or absurd resolves to 0 — "this panel
 * is fine". That is the safe reading in both directions: an unnecessary inset
 * only wastes glass, while an unclamped one can leave a wall dark.
 */
export function clampOverscanPct(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(TV_MAX_OVERSCAN_PCT, Math.max(0, value))
    : 0;
}

/**
 * The scale that fits the 1920×1080 canvas onto a `vw`×`vh` panel, inset by
 * `overscanPct` on every edge for a TV that crops its own input (see
 * ScreenConfig.overscanPct).
 *
 * Pure, and here rather than inline in TvStage, because it is the one part of
 * that component worth asserting on: it decides whether a wall reads complete,
 * letterboxed, or — with a bad number — not at all.
 */
export function tvFitScale(vw: number, vh: number, overscanPct: unknown = 0): number {
  const inset = clampOverscanPct(overscanPct);
  const fit = Math.min(vh / TV_H, vw / TV_W);
  // An unmeasurable viewport must never resolve to 0 — a scale of 0 is a wall
  // showing nothing at all, which is the one outcome worse than a mis-fitted
  // one. Fall back to 1:1 and let the next resize event correct it.
  return (Number.isFinite(fit) && fit > 0 ? fit : 1) * (1 - (2 * inset) / 100);
}

/**
 * TWO CADENCES, because the two halves of the feed cost very different amounts.
 *
 * The PULSE is scans, birthdays, wrong-race notices, reload and preview
 * commands — three Redis reads, nothing else. It runs fast so a racer's name
 * reaches the wall while they are still standing at the desk; ten seconds felt
 * like the screen had not noticed them.
 *
 * The FULL feed carries the party board, the VIP roster and the heat's
 * checked-in count, which touch Neon and BMI. Those change on the order of
 * minutes and have no business running at the pulse rate.
 */
export const TV_PULSE_MS = 2_000;
export const TV_POLL_MS = 15_000;

/** Deploy-check cadence. A TV has no between-guest boundary like a kiosk, so
 *  it checks on a timer and reloads at a scene boundary (never mid-takeover). */
export const TV_UPDATE_CHECK_MS = 5 * 60_000;

/**
 * Human-facing signage software version — rendered bottom-right on every screen
 * so staff can confirm what a wall is running without a laptop. Bump on each
 * signage release; the deploy-SHA check is what actually drives reloads.
 *
 * 0.1.0 — Platform + ad rotation. Screen registry, admin management page,
 *         clock-locked scene director, house-ad scene.
 * 0.2.0 — Camera monitor scene: a live venue camera on a wall (~1fps stills via
 *         the Nx relay proxy), with that track's session + delay clocks big
 *         across the bottom.
 * 0.2.1 — Camera monitor reworked to the original layout: camera left, on-track
 *         session clock HUGE on the track's colour, full-width track-status bar
 *         (green/amber) below, and the briefing room's session + video-remaining
 *         over the picture. Room-addressed frames (`?room=`) feed the check-in
 *         board's in-room panel too.
 * 0.3.0 — Camera return strip along the bottom of both briefing room TVs: POV
 *         cameras whose race has finished but that we have not seen come back,
 *         red with minutes-out, green for 90s when they check in. Reserves 104px
 *         in every phase, the safety film included.
 * 0.4.0 — Race results scene: a track's scores wall at the kart return. Final
 *         standings with best laps, positions, karts and laps, plus a "who
 *         levelled up" panel. Carries lap times deliberately — it is the
 *         surface the briefing room's welcome-back board points people to.
 */
export const SIGNAGE_VERSION = "0.4.0";
