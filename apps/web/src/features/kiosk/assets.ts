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
  arcade: `${BLOB}/images/headpinz/gallery-arcade.webp`,
  /** FastTrax race car cutout (transparent bg) — races across the attract
   *  ad zone once per slide on FastTrax kiosks. Art faces LEFT. 1011×240. */
  raceCar: `${BLOB}/images/kiosk/ft-race-car.webp`,
} as const;

/** Attract-screen ad rotation (placeholder offers; owner supplies real copy). */
export interface KioskAdSlide {
  title: string;
  sub: string;
  accent: string;
  photo: string;
}

/** Fort Myers complex (FastTrax + HeadPinz share the campus) — racing-forward. */
const FORT_MYERS_AD_SLIDES: KioskAdSlide[] = [
  {
    title: "ULTIMATE VIP EXPERIENCE",
    sub: "Race · Bowl · Race — from $65 per person",
    accent: "#e8b14c",
    photo: KIOSK_PHOTOS.vip,
  },
  {
    title: "MEGA TRACK TUESDAYS",
    sub: "The big track runs all day",
    accent: "#e53935",
    photo: KIOSK_PHOTOS.redTrack,
  },
  {
    title: "RACE PACKS",
    sub: "Bank five races. Save on every one.",
    accent: "#00e2e5",
    photo: KIOSK_PHOTOS.flag,
  },
  {
    title: "SKIP THE LINE",
    sub: "Racing starts here — book your heat at this kiosk",
    accent: "#e53935",
    photo: KIOSK_PHOTOS.race,
  },
  {
    title: "SKIP THE LINE",
    sub: "Bowling starts here — book your lane at this kiosk",
    accent: "#00e2e5",
    photo: KIOSK_PHOTOS.bowl,
  },
];

/** HeadPinz Naples has NO karting (owner 2026-07-20) — bowling + Nexus
 *  attractions only, never racing ads or track photography. */
const NAPLES_AD_SLIDES: KioskAdSlide[] = [
  {
    title: "HYPERBOWLING VIP SUITES",
    sub: "Glowing lanes, private suite seating, lounge service",
    accent: "#e8b14c",
    photo: KIOSK_PHOTOS.vipLanes,
  },
  {
    title: "NEXUS GEL BLASTER",
    sub: "High-tech gel blaster battles in a glowing arena",
    accent: "#00e2e5",
    photo: KIOSK_PHOTOS.gel,
  },
  {
    title: "NEXUS LASER TAG",
    sub: "Multi-level laser tag with haptic vests",
    accent: "#8652FF",
    photo: KIOSK_PHOTOS.laser,
  },
  {
    title: "KIDS BOWL FREE",
    sub: "Registered kids bowl free — Monday to Friday",
    accent: "#FFD700",
    photo: KIOSK_PHOTOS.kbf,
  },
  {
    title: "SKIP THE LINE",
    sub: "Bowling starts here — book your lane at this kiosk",
    accent: "#00e2e5",
    photo: KIOSK_PHOTOS.bowl,
  },
];

/** The attract rotation for this kiosk's center (null = not provisioned yet;
 *  the Fort Myers set is a harmless placeholder behind the setup card). */
export function kioskAdSlidesFor(center: CenterCode | null): KioskAdSlide[] {
  return center === "naples" ? NAPLES_AD_SLIDES : FORT_MYERS_AD_SLIDES;
}
