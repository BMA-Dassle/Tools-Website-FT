/**
 * Kiosk media manifest — all on Vercel Blob (same assets the website uses).
 * Static v1; a CMS/config layer can replace this later without touching
 * components.
 */
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
  flag: `${BLOB}/images/subpages/checkered-flag.webp`,
  arcade: `${BLOB}/images/headpinz/gallery-arcade.webp`,
} as const;

/** Attract-screen ad rotation (placeholder offers; owner supplies real copy). */
export interface KioskAdSlide {
  title: string;
  sub: string;
  accent: string;
  photo: string;
}

export const KIOSK_AD_SLIDES: KioskAdSlide[] = [
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
];
