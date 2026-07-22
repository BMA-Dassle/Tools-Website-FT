/**
 * Kiosk media manifest — all on Vercel Blob (same assets the website uses).
 * Static v1; a CMS/config layer can replace this later without touching
 * components.
 */
import type { CenterCode } from "~/features/booking";

const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";

export const KIOSK_LOGOS = {
  fasttrax: `${BLOB}/images/logo/FT_logo.png`,
  headpinz: `${BLOB}/images/headpinz/hp-logo.webp`,
} as const;

export const KIOSK_PHOTOS = {
  race: `${BLOB}/images/tracks/blue-track-iYCkFVDkIiDVwNQaiABoZsqzj2Fjnj.jpg`,
  redTrack: `${BLOB}/images/tracks/red-track-1Fsl8rQ5rVIHi6hXkkvUraGEqr4WM2.jpg`,
  bowl: `${BLOB}/images/headpinz/gallery-bowling.webp`,
  kbf: `${BLOB}/images/headpinz/birthday-girl-bowling.jpg`,
  gel: `${BLOB}/images/attractions/gel-blaster-new-QKNNgvKt7Jah4ZJNO7JLa3vIp2t6EK.jpg`,
  laser: `${BLOB}/images/attractions/laser-tag-new-2iiYIDNemOIB9NaaGjsY0ujWAGiV5x.jpg`,
  duck: `${BLOB}/images/attractions/duckpin-bowling-R8vkBZc68YfiqmN7yP2SP2hElvWOCX.webp`,
  shuf: `${BLOB}/images/attractions/shuffly-tables-Nlc3Y5cuNU6C5WrFIhGvHN42pYMfVK.jpg`,
  vip: `${BLOB}/images/subpages/pricing-combos.webp`,
  /** VIP bowling SUITES (HyperBowling glow) — the bowling-tier card. `vip`
   *  above is the combo hero (racing) and looked wrong on a lanes card. */
  vipLanes: `${BLOB}/images/headpinz/hyperbowling.jpg`,
  flag: `${BLOB}/images/subpages/checkered-flag.webp`,
  /** Kart-action shot (attractions library) — Race Info hub "Race Types" tile. */
  raceAction: `${BLOB}/images/attractions/DSC06577.webp`,
  arcade: `${BLOB}/images/headpinz/gallery-arcade.webp`,
  /** FastTrax race car cutout (transparent bg) — races across the attract
   *  ad zone once per slide on FastTrax kiosks. Art faces LEFT. 1011×240. */
  raceCar: `${BLOB}/images/kiosk/ft-race-car.webp`,
} as const;

/** Attract-screen ad rotation — v2 "doors" (owner 2026-07-21): every slide is
 *  a centered neon "<X> STARTS HERE" headline over the activity photo, with a
 *  "TOUCH ANYWHERE …" marquee banner riding the car lane. Replaced the v1
 *  five-offer rotation (VIP / Mega Track / Race Packs / 2× Skip-the-Line) —
 *  the welcome zone's VIP + race-pack quick chips still carry those offers. */
export interface KioskAdSlide {
  /** Neon headline (k-display renders it uppercase). Always one line — the
   *  renderer auto-shrinks long titles rather than wrapping. */
  title: string;
  /** Accent-colored tail of the banner line: “Touch anywhere {bannerAction}”. */
  bannerAction: string;
  /** Slide accent — neon tube glow, banner border, beacon dots, accent text. */
  accent: string;
  photo: string;
  /** Optional RED standout line above the headline (owner 2026-07-21 — the
   *  Mega Tuesday junior rule). Always red regardless of the slide accent. */
  notice?: string;
}

/** Fort Myers complex (FastTrax + HeadPinz share the campus). Gel is GREEN
 *  (k-ok, matches the glowing gear in the photo — owner pick 2026-07-21),
 *  not the purple k-gel category token. */
const FORT_MYERS_AD_SLIDES: KioskAdSlide[] = [
  {
    title: "Racing starts here",
    bannerAction: "to book",
    accent: "#e53935",
    photo: KIOSK_PHOTOS.race,
  },
  {
    title: "Bowling starts here",
    bannerAction: "to book",
    accent: "#00e2e5",
    photo: KIOSK_PHOTOS.bowl,
  },
  {
    title: "Gel blasters start here",
    bannerAction: "to book",
    accent: "#46d68c",
    photo: KIOSK_PHOTOS.gel,
  },
  {
    title: "Game Zone starts here",
    bannerAction: "to get started",
    accent: "#f0b341",
    photo: KIOSK_PHOTOS.arcade,
  },
];

/** HeadPinz Naples has NO karting (owner 2026-07-20) — same doors minus
 *  racing, never track photography. */
const NAPLES_AD_SLIDES: KioskAdSlide[] = [
  {
    title: "Bowling starts here",
    bannerAction: "to book",
    accent: "#00e2e5",
    photo: KIOSK_PHOTOS.bowl,
  },
  {
    title: "Gel blasters start here",
    bannerAction: "to book",
    accent: "#46d68c",
    photo: KIOSK_PHOTOS.gel,
  },
  {
    title: "Game Zone starts here",
    bannerAction: "to get started",
    accent: "#f0b341",
    photo: KIOSK_PHOTOS.arcade,
  },
];

/** Mega Tuesday door (owner 2026-07-21) — leads the Fort Myers rotation on
 *  Tuesdays only, Mega-purple accent + the red junior rule. */
const MEGA_TUESDAY_SLIDE: KioskAdSlide = {
  title: "It's Mega Tuesday",
  bannerAction: "to race the Mega",
  accent: "#8652ff",
  photo: KIOSK_PHOTOS.race,
  notice: "No first-time Junior racers on Mega",
};

/** Center-local (America/New_York) Tuesday check — mirrors scheduleForDate's
 *  "day 2 = mega" rule without needing a booking date. Also consumed by the
 *  kiosk people step's Mega-day junior notice (the kiosk books TODAY). */
export function isMegaTuesdayToday(): boolean {
  return (
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(
      new Date(),
    ) === "Tuesday"
  );
}

/** The attract rotation for this kiosk's center (null = not provisioned yet;
 *  the Fort Myers set is a harmless placeholder behind the setup card).
 *  Called per render, so the Tuesday slide appears/retires on the attract
 *  loop's own re-render cadence — no reload needed across midnight. */
export function kioskAdSlidesFor(center: CenterCode | null): KioskAdSlide[] {
  if (center === "naples") return NAPLES_AD_SLIDES;
  return isMegaTuesdayToday()
    ? [MEGA_TUESDAY_SLIDE, ...FORT_MYERS_AD_SLIDES]
    : FORT_MYERS_AD_SLIDES;
}
