/**
 * Lobby-TV media + ad content.
 *
 * IMAGES GO THROUGH THE NEXT IMAGE OPTIMIZER, ALWAYS. Same two reasons the
 * kiosk does it (see features/kiosk/assets.ts for the full account): the blob
 * host sits behind a Vercel firewall challenge that a CSS background-image
 * cannot solve — a challenged device silently renders a blank tile — and Fast
 * Data Transfer is billed on every client egress, which is how an earlier raw
 * proxy shipped 717 MB. A TV re-painting the same backdrops every 40 seconds
 * for 16 hours a day is exactly the traffic shape that punishes getting this
 * wrong.
 *
 * The only difference from the kiosk's `kioskImg` is width: a landscape TV
 * backdrop is optimized at 1920 (in Next's default deviceSizes) rather than
 * 1200. Quality stays 75 — the ONLY value in Next 16's default
 * `images.qualities`, so anything else would be silently coerced.
 */
import { KIOSK_PHOTOS } from "~/features/kiosk/assets";
import type { SignageVenue } from "./constants";

const BLOB_HOST = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";
const TV_WIDTH = 1920;
const TV_QUALITY = 75;

/**
 * Re-optimize an already-optimized kiosk URL at TV width.
 *
 * The KIOSK_PHOTOS values are already `/_next/image?url=…&w=1200&q=75` strings,
 * so this rewrites the width rather than double-wrapping them. A non-blob or
 * unrecognized URL passes through untouched — a backdrop that fails to resolve
 * must degrade to "no photo", never to a broken request.
 */
export function tvImg(url: string | undefined): string | undefined {
  if (!url) return url;
  if (url.startsWith("/_next/image")) {
    return url.replace(/([?&])w=\d+/, `$1w=${TV_WIDTH}`);
  }
  if (url.startsWith(BLOB_HOST)) {
    return `/_next/image?url=${encodeURIComponent(url)}&w=${TV_WIDTH}&q=${TV_QUALITY}`;
  }
  return url;
}

/** Backdrops, re-optimized for the 1920-wide canvas. */
export const TV_PHOTOS = {
  bowl: tvImg(KIOSK_PHOTOS.bowl)!,
  gel: tvImg(KIOSK_PHOTOS.gel)!,
  laser: tvImg(KIOSK_PHOTOS.laser)!,
  duck: tvImg(KIOSK_PHOTOS.duck)!,
  arcade: tvImg(KIOSK_PHOTOS.arcade)!,
  shuf: tvImg(KIOSK_PHOTOS.shuf)!,
  race: tvImg(KIOSK_PHOTOS.race)!,
  redTrack: tvImg(KIOSK_PHOTOS.redTrack)!,
  raceAction: tvImg(KIOSK_PHOTOS.raceAction)!,
  vipLanes: tvImg(KIOSK_PHOTOS.vipLanes)!,
  kbf: tvImg(KIOSK_PHOTOS.kbf)!,
} as const;

/**
 * One advertised thing.
 *
 * `productKeys` is what ties a slide to the maintenance gate: when a vendor is
 * down and its products are paused, the slide comes OUT of rotation rather than
 * advertising something the kiosks below cannot sell. A slide with no keys is
 * never gated (e.g. a generic "ask us about parties" card).
 */
export interface TvAdSlide {
  key: string;
  /** The neon word. Short — it renders at ~170px. */
  word: string;
  /** One line under it. Sentence case, no exclamation-mark shouting. */
  line: string;
  accent: string;
  photo: string;
  /** Product ids this slide sells; matched against pausedProductIds. */
  productKeys?: string[];
}

/**
 * Fort Myers HeadPinz — what the bank of kiosks underneath can actually take
 * money for. Accents match the kiosk billboard so the TV and the screens below
 * read as one system.
 *
 * Copy rule: "bowling center", never "alley".
 */
const HPFM_ADS: TvAdSlide[] = [
  {
    key: "bowling",
    word: "Bowling",
    line: "Glow lanes, big screens, and no rain delays.",
    accent: "#00e2e5",
    photo: TV_PHOTOS.bowl,
    productKeys: ["bowling"],
  },
  {
    key: "laser",
    word: "Laser Tag",
    line: "Two levels, one dark arena, zero mercy.",
    accent: "#f800c6",
    photo: TV_PHOTOS.laser,
    productKeys: ["laser-tag"],
  },
  {
    key: "gel",
    word: "Gel Blasters",
    line: "Team up. Take cover. Blast away.",
    accent: "#46d68c",
    photo: TV_PHOTOS.gel,
    productKeys: ["gel-blaster"],
  },
  {
    key: "gamezone",
    word: "Game Zone",
    line: "Hundreds of games. Load a card and go.",
    accent: "#f0b341",
    photo: TV_PHOTOS.arcade,
    productKeys: ["game-zone"],
  },
];

/** FastTrax — racing first, with the HeadPinz side of the campus alongside. */
const FT_ADS: TvAdSlide[] = [
  {
    key: "racing",
    word: "Racing",
    line: "Electric karts. Two indoor tracks. Real lap times.",
    accent: "#e53935",
    photo: TV_PHOTOS.raceAction,
    productKeys: ["racing"],
  },
  {
    key: "bowling",
    word: "Bowling",
    line: "Glow lanes right next door at HeadPinz.",
    accent: "#00e2e5",
    photo: TV_PHOTOS.bowl,
    productKeys: ["bowling"],
  },
  {
    key: "gel",
    word: "Gel Blasters",
    line: "Team up. Take cover. Blast away.",
    accent: "#46d68c",
    photo: TV_PHOTOS.gel,
    productKeys: ["gel-blaster"],
  },
  {
    key: "gamezone",
    word: "Game Zone",
    line: "Hundreds of games. Load a card and go.",
    accent: "#f0b341",
    photo: TV_PHOTOS.arcade,
    productKeys: ["game-zone"],
  },
];

/** Naples never advertises racing — same rule the kiosk ad rotation follows. */
const HPN_ADS: TvAdSlide[] = [
  {
    key: "bowling",
    word: "Bowling",
    line: "Glow lanes, big screens, and no rain delays.",
    accent: "#00e2e5",
    photo: TV_PHOTOS.bowl,
    productKeys: ["bowling"],
  },
  {
    key: "laser",
    word: "Laser Tag",
    line: "Two levels, one dark arena, zero mercy.",
    accent: "#f800c6",
    photo: TV_PHOTOS.laser,
    productKeys: ["laser-tag"],
  },
  {
    key: "gamezone",
    word: "Game Zone",
    line: "Hundreds of games. Load a card and go.",
    accent: "#f0b341",
    photo: TV_PHOTOS.arcade,
    productKeys: ["game-zone"],
  },
  {
    key: "duckpin",
    word: "Duckpin",
    line: "Little balls, no holes, surprisingly competitive.",
    accent: "#4fa9ff",
    photo: TV_PHOTOS.duck,
    productKeys: ["duckpin"],
  },
];

const AD_SETS: Record<SignageVenue, TvAdSlide[]> = {
  FT: FT_ADS,
  HPFM: HPFM_ADS,
  HPN: HPN_ADS,
};

/**
 * The slides a screen may show right now.
 *
 * Paused products are filtered OUT: advertising laser tag on a wall while the
 * kiosk two feet below refuses to sell it is worse than showing one fewer
 * slide. If everything is paused we return the full set anyway — a blank
 * rotation would leave the screen with nothing at all, and a stale advert is a
 * smaller failure than a dead panel.
 */
export function tvAdSlides(venue: SignageVenue, pausedProductIds: string[] = []): TvAdSlide[] {
  const all = AD_SETS[venue] ?? HPFM_ADS;
  if (pausedProductIds.length === 0) return all;
  const paused = new Set(pausedProductIds);
  const live = all.filter((s) => !s.productKeys?.some((k) => paused.has(k)));
  return live.length > 0 ? live : all;
}
