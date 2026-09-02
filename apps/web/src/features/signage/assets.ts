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
import { KIOSK_PHOTOS, kioskAdSlidesFor } from "~/features/kiosk/assets";
import type { Brand, CenterCode } from "~/features/booking/types";
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
  /** The combo's own hero photograph (a racing shot). What the front-desk wall's
   *  All Access slide uses. */
  vip: tvImg(KIOSK_PHOTOS.vip)!,
  /** VIP bowling suites. AVOID ON A WALL: this file is a 6.8KB video still with
   *  "NO MATTER WHO YOU ARE" burned into the frame, and burned-in words fight a
   *  scene's own headline. See tasks/front-desk-wall-plan.md § Photography. */
  vipLanes: tvImg(KIOSK_PHOTOS.vipLanes)!,
  kbf: tvImg(KIOSK_PHOTOS.kbf)!,
  /** Checkered flag — the "check in" panel's ground on the front-desk wall. */
  flag: tvImg(KIOSK_PHOTOS.flag)!,
} as const;

/**
 * THE VIP WALL ARTWORK — five transparent PNGs that make ONE picture across the
 * five front-desk panels, left to right.
 *
 * Index IS wall position: 0 names the product, 4 carries the QR, and the three
 * between them are the middle of the sentence. They are laid over a photograph
 * rather than being complete pictures in themselves — the design is gold artwork
 * with the venue showing through, which is the whole reason they are PNG and not
 * JPEG (a JPEG re-encode flattens the alpha to black and hides the photo).
 *
 * Uploaded by `scripts/upload-tv-wall-vip-slides.mjs`, which pins these
 * pathnames — a re-export overwrites in place and these URLs keep working. The
 * words and numbers burned into the pixels are pinned to the live pack by
 * VIP_ART_CLAIMS in wall-content.ts; read that before changing either.
 */
const VIP_SLIDE_BLOB = (n: number) => `${BLOB_HOST}/images/tv-wall/vip-s1-p${n}.png`;

export const TV_WALL_VIP_ART: readonly string[] = [1, 2, 3, 4, 5].map(
  (n) => tvImg(VIP_SLIDE_BLOB(n))!,
);

/**
 * THE WALL'S MOVING PICTURES — the site's own marketing reels, on the pricing panels
 * (owner 2026-09-01: "the pricing boards can show video of what they're selling").
 *
 * These are the SAME FILES the public website plays, referenced rather than re-cut, so
 * a re-shoot that lands on headpinz.com reaches the wall with it. Raw blob URLs and NOT
 * `tvImg` — that is the image optimizer, and it neither handles nor should be handed a
 * video; these are fetched once into Cache Storage instead (see useWallFilms).
 *
 * Each panel's list is what IT alternates between, one file per turn.
 */
/**
 * THE NEXUS ARENA REEL, CUT TO 18 SECONDS (owner 2026-09-01, who knew where to cut).
 *
 * The master on the marketing share runs 26.9s and its tail is two things a guest wall
 * must never show: a franchise-sales map ("75+ locations contracted by the end of 2025")
 * and then a "COMING SOON!" card — for an attraction that is open, priced and bookable
 * in this building today. Everything before 18s is arena footage of both games.
 *
 * Cut, stripped of audio and re-encoded by `scripts/upload-tv-wall-film.mjs`, which pins
 * this pathname so a re-cut overwrites in place and this URL keeps working.
 *
 * Used TWICE, deliberately shared rather than copied: the front-desk wall's Nexus
 * pricing panel, and the arena check-in board's dead time.
 */
export const NEXUS_REEL = `${BLOB_HOST}/videos/tv-wall/nexus-hero-18s.mp4`;

export const TV_WALL_FILMS = {
  /**
   * The reel behind the VIP Experience section on headpinz.com/fort-myers, alternating
   * with the NeoVerse lane reel — the two halves of what a VIP lane actually looks like,
   * which is what the bowling panel is selling.
   *
   * The HyperBowling one is CUT AT 31.7s (owner 2026-09-01: "the end logo needs cut
   * out"). Past that the web version runs a HYPER BOWLING logo card and then a HeadPinz
   * "NOW EXCLUSIVELY AVAILABLE AT… RESERVE YOUR LANES TODAY!" end card — a call to
   * action that makes sense at the end of a page and not on a loop, where it would sit
   * on the wall for six of every thirty-two seconds telling a guest already standing in
   * the building to come to the building.
   *
   * AND RETIMED TO 30fps, which is what "the pricing videos are laggy… bowling video is
   * still lagging" turned out to be (owner 2026-09-01). It was never the file size and
   * never the cache — the panels had the cache fix and the reel is the LIGHTEST file on
   * the wall (754 kbps). The web master is 25fps, and the panels run at 60Hz: 60/25 is
   * 2.4, so a player must hold each frame for two refreshes or three, alternating
   * 33ms/50ms forever. That irregular cadence is visible, and "laggy" is exactly how a
   * person describes it. Its own panel-mate below is 30fps — a clean 2:2 — and was never
   * once reported, which is what isolated it.
   *
   * Motion-INTERPOLATED rather than frame-duplicated (`minterpolate=mci:aobmc:bidir`):
   * duplicating every fifth frame would hold five frames for 33ms and one for 66ms,
   * trading one irregular cadence for a worse one. Interpolation synthesises genuine
   * intermediate moments, so every frame is a distinct instant on an even beat.
   *
   * A NEW PATHNAME, not an overwrite of the old one, and that part is load-bearing:
   * `planCacheOps` keys on the URL, so re-cutting in place would leave five panels
   * playing the 25fps copy off their own disks forever, with nothing to tell them the
   * bytes behind the URL had changed. A new URL leaves the old one out of the manifest,
   * where `pruneCache` collects it.
   */
  bowling: [
    `${BLOB_HOST}/videos/tv-wall/hyperbowling-32s-30fps.mp4`,
    `${BLOB_HOST}/videos/headpinz-neoverse-v2.mp4`,
  ],
  /** The Nexus arena reel — see NEXUS_REEL. */
  nexus: [NEXUS_REEL],
  /**
   * The reel behind the party packages section, CUT AT 27s (owner 2026-09-01).
   *
   * Past that it leaves the arcade entirely: eight seconds of AXE THROWING — cages,
   * wooden targets, a tablet showing "Standard Axe Throwing Rules", "LANE 3" on the
   * wall — and then a HeadPinz card over bowling lanes. Neither is Game Zone, and this
   * panel is the one selling Game Zone. Everything kept is arcade: the Game Zone
   * entrance, the rides, racing cabinets, air hockey, the crane machines, basketball,
   * Connect 4 Hoops and the ring toss.
   */
  gameZone: [`${BLOB_HOST}/videos/tv-wall/gamezone-27s.mp4`],
  /** The FastTrax home-page hero. Genuinely lives under /images/hero/ — not a typo. */
  fastTrax: [`${BLOB_HOST}/images/hero/hero-video.mp4`],
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
/**
 * The slides the kiosks below are showing, as TV slides.
 *
 * A screen bolted above a bank of kiosks advertising something different from
 * the machines underneath it looks broken, so the TV runs the SAME catalog in
 * the SAME order (owner 2026-08-11). Only the presentation differs — the wall
 * gets a fuller line of copy where we have one, because it is read from further
 * away and has room for it.
 *
 * Falls back to the TV's own set if the kiosk catalog is ever empty, so the
 * screen can never end up with nothing to show.
 */
export function kioskMatchedAdSlides(center: CenterCode, brand: Brand): TvAdSlide[] {
  const kioskSlides = kioskAdSlidesFor(center, brand);
  if (kioskSlides.length === 0) return [];
  return kioskSlides.map((k, i) => {
    const copy = TV_LINE_BY_ACCENT[k.accent];
    return {
      key: `kiosk-${i}`,
      // The kiosk title reads "Bowling starts here"; on a wall nobody is about
      // to touch, the activity alone is the stronger headline.
      word: copy?.word ?? k.title.replace(/\s+starts here$/i, ""),
      line: copy?.line ?? "Book it at any kiosk below.",
      accent: k.accent,
      photo: tvImg(k.photo) ?? k.photo,
      productKeys: copy?.productKeys,
    };
  });
}

/** Richer wall copy, keyed by the kiosk slide's accent — the one stable
 *  identifier a kiosk slide carries for what it is selling. */
const TV_LINE_BY_ACCENT: Record<string, { word: string; line: string; productKeys?: string[] }> = {
  "#e53935": {
    word: "Racing",
    line: "Electric karts. Two indoor tracks. Real lap times.",
    productKeys: ["racing"],
  },
  "#00e2e5": {
    word: "Bowling",
    line: "Glow lanes, big screens, and no rain delays.",
    productKeys: ["bowling"],
  },
  "#46d68c": {
    word: "Gel Blasters",
    line: "Team up. Take cover. Blast away.",
    productKeys: ["gel-blaster"],
  },
  "#f800c6": {
    word: "Laser Tag",
    line: "Two levels, one dark arena, zero mercy.",
    productKeys: ["laser-tag"],
  },
  "#f0b341": {
    word: "Game Zone",
    line: "Hundreds of games. Load a card and go.",
    productKeys: ["game-zone"],
  },
  "#4fa9ff": {
    word: "Duckpin",
    line: "Little balls, no holes, surprisingly competitive.",
    productKeys: ["duckpin"],
  },
};

export function tvAdSlides(venue: SignageVenue, pausedProductIds: string[] = []): TvAdSlide[] {
  const all = AD_SETS[venue] ?? HPFM_ADS;
  if (pausedProductIds.length === 0) return all;
  const paused = new Set(pausedProductIds);
  const live = all.filter((s) => !s.productKeys?.some((k) => paused.has(k)));
  return live.length > 0 ? live : all;
}
