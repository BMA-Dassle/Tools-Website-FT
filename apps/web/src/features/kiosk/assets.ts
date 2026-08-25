/**
 * Kiosk media manifest.
 *
 * Photos are served through the Next Image Optimizer (`/_next/image`), NOT the
 * Vercel Blob host directly, for two reasons:
 *
 *  1. Same-origin. The blob host sits behind a Vercel firewall challenge that
 *     trips per source-IP under bursty traffic (a NATed venue loading many
 *     tiles at once) and hands back a JS "Security Checkpoint" that a CSS
 *     `background-image` / plain <img> can't solve — so a challenged device
 *     gets the checkpoint HTML instead of the image and the tile silently
 *     blanks (owner report: HeadPinz-Fort-Myers, 2026-07-24). Same-origin
 *     requests are never challenged; the optimizer fetches the source
 *     server-side.
 *  2. Cost + weight. The optimizer downscales + WebP-encodes + edge-caches, so
 *     a 10.7 MB source original ships as ~tens of KB. The interim raw `/kimg`
 *     proxy served originals untouched — and because Fast Data Transfer is
 *     billed on every client egress (cache hit or not), one oversized
 *     attraction photo pulled in a loop became a 717 MB transfer spike
 *     (2026-07-24). (`/kimg` is still wired in next.config as a fallback for
 *     kiosks that haven't self-updated to this build yet; remove it once the
 *     fleet is confirmed on the optimizer path.)
 *
 * Width 1200 covers the 1080-px kiosk canvas; q75 is Next 16's default-allowed
 * quality (`images.qualities` = [75]); the blob host is already in next.config
 * `images.remotePatterns`. Static v1; a CMS/config layer can replace this later
 * without touching components.
 */
import type { Brand, CenterCode } from "~/features/booking";
import { megaWindowTodayET, type MegaDayWindow } from "~/features/racing/mega-calendar";
import type { MessageKey } from "./i18n";

const BLOB_HOST = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";
const OPT_WIDTH = 1200;
const OPT_QUALITY = 75; // must be listed in next.config images.qualities (Next 16 default: [75])

/**
 * Route a Vercel-Blob image URL through the same-origin Next Image Optimizer.
 * Absolute blob URLs are optimized; non-blob / already-relative URLs pass
 * through untouched. Use for image URLs from SHARED catalogs
 * (offering.heroImage, combo.heroImage) that the website serves straight from
 * the blob.
 */
export function kioskImg(url: string | undefined): string | undefined {
  if (!url || !url.startsWith(BLOB_HOST)) return url;
  return `/_next/image?url=${encodeURIComponent(url)}&w=${OPT_WIDTH}&q=${OPT_QUALITY}`;
}

/** Optimized same-origin URL for a blob image PATH (with a leading slash). */
function photo(path: string): string {
  return kioskImg(`${BLOB_HOST}${path}`) as string;
}

// Brand logos are BUNDLED into the app (apps/web/public/brand/) — tiny,
// brand-critical, and guaranteed to load whenever the page itself did. Never
// routed through the blob host. Render them via <BrandLogo>, which falls back
// to a text wordmark if even the local file is somehow unavailable, so a
// broken-image glyph can never appear.
export const KIOSK_LOGOS = {
  fasttrax: "/brand/ft-logo.png",
  headpinz: "/brand/hp-logo.webp",
} as const;

export const KIOSK_PHOTOS = {
  race: photo("/images/tracks/blue-track-kiosk.webp"),
  redTrack: photo("/images/tracks/red-track-kiosk.webp"),
  bowl: photo("/images/headpinz/gallery-bowling.webp"),
  kbf: photo("/images/headpinz/birthday-girl-bowling.jpg"),
  gel: photo("/images/attractions/gel-blaster-new-QKNNgvKt7Jah4ZJNO7JLa3vIp2t6EK.jpg"),
  laser: photo("/images/attractions/laser-tag-new-2iiYIDNemOIB9NaaGjsY0ujWAGiV5x.jpg"),
  duck: photo("/images/attractions/duckpin-bowling-R8vkBZc68YfiqmN7yP2SP2hElvWOCX.webp"),
  shuf: photo("/images/attractions/shuffly-tables-Nlc3Y5cuNU6C5WrFIhGvHN42pYMfVK.jpg"),
  vip: photo("/images/subpages/pricing-combos.webp"),
  /** VIP bowling SUITES (HyperBowling glow) — the bowling-tier card. `vip`
   *  above is the combo hero (racing) and looked wrong on a lanes card. */
  vipLanes: photo("/images/headpinz/hyperbowling.jpg"),
  flag: photo("/images/subpages/checkered-flag.webp"),
  /** Kart-action shot (attractions library) — Race Info hub "Race Types" tile. */
  raceAction: photo("/images/attractions/DSC06577.webp"),
  arcade: photo("/images/headpinz/gallery-arcade.webp"),
  /** FastTrax race car cutout (transparent bg) — races across the attract
   *  ad zone once per slide on FastTrax kiosks. Art faces LEFT. 1011×240. */
  raceCar: photo("/images/kiosk/ft-race-car.webp"),
} as const;

/**
 * Attract backdrop CLIPS (headline layout only).
 *
 * Served as RAW blob URLs, not through `photo()` — `/_next/image` is an image
 * optimizer and will not transcode video. That matches every other <video> on
 * the site (home Hero, BowlingWizard, the attractions pages), so these inherit
 * the same caching behaviour the marketing pages already rely on.
 *
 * A slide with no entry here falls back to its still `photo` with ken-burns,
 * which is a supported mix — the screen must never depend on a clip existing.
 *
 * KEYFRAME DENSITY IS ALSO A CORRECTNESS CONCERN. Playback position is seeked
 * to the shared clock (see AttractHeadline's seekToClock) so every screen in a
 * bank shows the same frame. A seek can only land quickly if there is a
 * keyframe near the target — the first race cut had a default ~10s GOP and NO
 * keyframe at all in its first 8 seconds, so each browser decoded forward from
 * frame 0 and arrived at its own pace. That is the "videos load a split second
 * different" (owner 2026-07-28). Every kiosk clip is encoded with a keyframe
 * every second: `-g 24 -keyint_min 24 -sc_threshold 0` at 24fps.
 *
 * SIZE IS A CORRECTNESS CONCERN HERE, not just a cost one. Chrome refuses to
 * store any single cache entry larger than roughly 1/8 of its disk cache, which
 * lands around 30–40MB on these machines. A clip over that ceiling is evicted
 * immediately and RE-DOWNLOADS every time a guest finishes and the attract
 * screen re-mounts — on a screen that runs 24/7. So kiosk clips are encoded
 * kiosk-sized (810×1440, silent, ~2–4MB) rather than reusing the marketing
 * masters:
 *   - race was the 31.9MB landscape home-page hero, centre-cropped by the
 *     browser. Now a 2.5MB portrait cut framed on the karts.
 *   - gel is the Nexus montage (marketing drive, "Nexus Assets-June 2025"),
 *     trimmed before its "EXPERIENCE NEXUS TODAY!" end card, which would
 *     otherwise collide with our own headline. 38MB source → 3.9MB.
 * bowl and arcade are already small enough to use as-is.
 */
export const KIOSK_VIDEOS = {
  /** Portrait kiosk cut of the FastTrax kart reel (from images/hero/hero-video.mp4). */
  race: `${BLOB_HOST}/videos/ft-race-kiosk.mp4`,
  /** Cut from 6.2s of the marketing reel: earlier there is a lit HEADPINZ sign
   *  on the wall, and this slide also runs on FASTTRAX kiosks as cross-promo —
   *  a HeadPinz logo on a FastTrax screen (owner 2026-07-28). The window also
   *  clears the food and service-robot segments further in. */
  bowl: `${BLOB_HOST}/videos/hp-bowling-kiosk.mp4`,
  gel: `${BLOB_HOST}/videos/nexus-gel-kiosk.mp4`,
  /** Trimmed at 25.5s: the marketing reel moves to AXE THROWING at ~27s, which
   *  is not Game Zone and read as a mistake behind "Let's play." (owner
   *  2026-07-28). Portrait cut of a low-res 720x406 master, so it is soft by
   *  origin — a sharper Game Zone clip would need new footage. */
  arcade: `${BLOB_HOST}/videos/hp-arcade-kiosk.mp4`,
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

  /* ---- headline layout (config.attractLayout === "headline") -----------
     There is no 480px ad zone in that layout, so the slide drives the
     screen's OWN headline, backdrop and vehicle instead. Every field below
     is ignored by the ad-zone layout, which is left unchanged. */

  /** The "Let's …" line this slide puts in the headline slot, replacing the
   *  free-running RotatingWelcome. An i18n key: Spanish lengths differ, so
   *  the renderer measures the rendered string down to a single line. */
  headline: MessageKey;
  /** Backdrop clip key into KIOSK_VIDEOS. Absent = the still `photo` is used
   *  with ken-burns, which is a supported mix (gel has no clip yet). */
  video?: keyof typeof KIOSK_VIDEOS;
  /** Which sprite crosses the headline on this slide, on the shared clock with
   *  the same per-kiosk stagger the ad-zone banner uses. Only the activity's
   *  OWN vehicle runs — the car races, the ball bowls, gel and Game Zone run
   *  clean. (The ad zone instead runs one per BRAND on every slide.) */
  vehicle?: "car" | "ball";
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
    headline: "attract.letsRace",
    video: "race",
    vehicle: "car",
  },
  {
    title: "Bowling starts here",
    bannerAction: "to book",
    accent: "#00e2e5",
    photo: KIOSK_PHOTOS.bowl,
    headline: "attract.letsBowl",
    video: "bowl",
    vehicle: "ball",
  },
  {
    title: "Gel blasters start here",
    bannerAction: "to book",
    accent: "#46d68c",
    photo: KIOSK_PHOTOS.gel,
    headline: "attract.letsBlast",
    video: "gel",
  },
  {
    title: "Game Zone starts here",
    bannerAction: "to get started",
    accent: "#f0b341",
    photo: KIOSK_PHOTOS.arcade,
    headline: "attract.letsPlay",
    video: "arcade",
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
    headline: "attract.letsBowl",
    video: "bowl",
    vehicle: "ball",
  },
  {
    title: "Gel blasters start here",
    bannerAction: "to book",
    accent: "#46d68c",
    photo: KIOSK_PHOTOS.gel,
    headline: "attract.letsBlast",
    video: "gel",
  },
  {
    title: "Game Zone starts here",
    bannerAction: "to get started",
    accent: "#f0b341",
    photo: KIOSK_PHOTOS.arcade,
    headline: "attract.letsPlay",
    video: "arcade",
  },
];

/** Mega day door (owner 2026-07-21) — leads the Fort Myers rotation on Mega
 *  days only, Mega-purple accent + the red junior rule.
 *
 *  The title NAMES THE DAY, so it is built from the live window rather than
 *  frozen: a slide reading "It's Mega Tuesday" on a Mega Thursday is worse
 *  than no slide at all. Everything else about it is fixed. */
function megaSlideFor(window: MegaDayWindow): KioskAdSlide {
  return {
    title: `It's ${window.label}`,
    bannerAction: "to race the Mega",
    accent: "#8652ff",
    photo: KIOSK_PHOTOS.race,
    notice: "Junior Pro only on Mega",
    headline: "attract.letsGoMega",
    // Reuses the kart reel: Mega IS racing, and it keeps the slide from being
    // the only still one in an otherwise moving rotation.
    video: "race",
    vehicle: "car",
  };
}

/** The attract rotation for this kiosk's center (null = not provisioned yet;
 *  the Fort Myers set is a harmless placeholder behind the setup card).
 *  Called per render, so the Mega slide appears/retires on the attract
 *  loop's own re-render cadence — no reload needed across midnight.
 *
 *  `brand` gates the Mega slide to FASTTRAX kiosks. The rotation is
 *  keyed by CENTER, and both FM venues share center "fort-myers", so HeadPinz
 *  Fort Myers was picking up a racing-only promo — complete with the red
 *  "Junior Pro only on Mega" rule — on the one bank that also runs the
 *  billboard, and the two fought over the same screen (owner 2026-07-28:
 *  "mega slide looks messed up"). The everyday racing slide stays on HeadPinz:
 *  that is ordinary cross-campus promotion. A dated promo with an operational
 *  rule attached is not. Omit `brand` and nothing changes. */
export function kioskAdSlidesFor(center: CenterCode | null, brand?: Brand): KioskAdSlide[] {
  if (center === "naples") return NAPLES_AD_SLIDES;
  const megaWindow = brand === "headpinz" ? null : megaWindowTodayET();
  return megaWindow ? [megaSlideFor(megaWindow), ...FORT_MYERS_AD_SLIDES] : FORT_MYERS_AD_SLIDES;
}
