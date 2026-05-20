import type { MetadataRoute } from "next";
import { headers } from "next/headers";

/**
 * /robots.txt — brand-aware. Different sitemap URL per host so each brand's
 * search property in Search Console / Bing Webmaster Tools sees only its
 * own sitemap.
 *
 * The disallow list mirrors public/robots.txt (which we keep for the rare
 * crawler that doesn't follow the dynamic route), plus a few additions:
 *   - /hp/book/.../confirmation paths (booking confirmations, PII-adjacent)
 *   - /admin/[token] paths (token-auth surfaces — public reachability is
 *     intentional but they have no SEO value)
 *   - /e/, /s/, /t/ short links (one-off, not for indexing)
 *
 * Reading headers() makes this dynamic per request (matching the rest of
 * the brand-aware metadata pipeline).
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const hdrs = await headers();
  const host = (hdrs.get("host") || "").toLowerCase();
  const isHeadPinz = host.includes("headpinz.com");

  const sitemap = isHeadPinz
    ? "https://headpinz.com/sitemap.xml"
    : "https://fasttraxent.com/sitemap.xml";

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/api-docs",
          "/admin/",
          "/embed/",
          "/e/",
          "/s/",
          "/t/",
          "/g/",
          "/book/checkout",
          "/book/confirmation",
          "/book/*/confirmation",
          "/book/race/confirmation",
          "/book/race-packs/confirmation",
          "/hp/book/bowling/confirmation",
          "/hp/book/bowlingold/confirmation",
          "/hp/book/kids-bowl-free/confirmation",
          "/hp/book/kids-bowl-free-old/confirmation",
          "/hp/book/*/confirmation",
          "/waiver-3",
          "/rewards/dashboard",
          "/hp/rewards/dashboard",
        ],
      },
    ],
    sitemap,
    host: isHeadPinz ? "https://headpinz.com" : "https://fasttraxent.com",
  };
}
