/**
 * Shared SEO helpers — OG/Twitter images, brand-aware defaults.
 *
 * Why a helper module:
 * - Next.js metadata inheritance fully REPLACES the openGraph object when a
 *   child sets one — it does not merge fields. So every page that exports
 *   its own openGraph must redeclare images, or the social card will be
 *   blank. Centralizing the image array here keeps every page consistent
 *   without 40 copy-paste image URLs.
 *
 * Image URLs point at existing Vercel Blob assets used by the hero/gallery
 * components, so social cards reuse what's already cached at the CDN edge.
 */

import type { Metadata } from "next";

export const FASTTRAX_OG_IMAGE =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/hero/hero-racing.webp";

export const HEADPINZ_OG_IMAGE =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp";

export const FASTTRAX_OG = [
  {
    url: FASTTRAX_OG_IMAGE,
    width: 1200,
    height: 630,
    alt: "FastTrax Entertainment — indoor go-kart racing in Fort Myers, FL",
  },
] as const;

export const HEADPINZ_OG = [
  {
    url: HEADPINZ_OG_IMAGE,
    width: 1200,
    height: 630,
    alt: "HeadPinz Entertainment — bowling lanes with cosmic glow effects",
  },
] as const;

/**
 * Build an openGraph object for a FastTrax-branded page with the shared
 * brand image attached. Pass any per-page overrides (title, description,
 * url) and they'll merge with sensible defaults.
 */
export function fasttraxOpenGraph(
  overrides: NonNullable<Metadata["openGraph"]> = {},
): NonNullable<Metadata["openGraph"]> {
  return {
    type: "website",
    siteName: "FastTrax Entertainment",
    locale: "en_US",
    images: [...FASTTRAX_OG],
    ...overrides,
  };
}

/**
 * Build an openGraph object for a HeadPinz-branded page with the shared
 * brand image attached. Same merge semantics as fasttraxOpenGraph.
 */
export function headpinzOpenGraph(
  overrides: NonNullable<Metadata["openGraph"]> = {},
): NonNullable<Metadata["openGraph"]> {
  return {
    type: "website",
    siteName: "HeadPinz",
    locale: "en_US",
    images: [...HEADPINZ_OG],
    ...overrides,
  };
}

/**
 * Build a twitter card object with the shared FastTrax image attached.
 */
export function fasttraxTwitter(
  overrides: NonNullable<Metadata["twitter"]> = {},
): NonNullable<Metadata["twitter"]> {
  return {
    card: "summary_large_image",
    images: [FASTTRAX_OG_IMAGE],
    ...overrides,
  };
}

export function headpinzTwitter(
  overrides: NonNullable<Metadata["twitter"]> = {},
): NonNullable<Metadata["twitter"]> {
  return {
    card: "summary_large_image",
    images: [HEADPINZ_OG_IMAGE],
    ...overrides,
  };
}
