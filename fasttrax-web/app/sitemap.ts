import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { listAlternatives } from "@/lib/alternatives-data";

/**
 * Per-domain sitemap. Both fasttraxent.com and headpinz.com hit the same
 * Next.js app, so we need to tailor the sitemap to the requesting host —
 * Google Search Console expects each property's sitemap to contain only
 * URLs from that domain.
 *
 *   fasttraxent.com/sitemap.xml → FastTrax URLs only
 *   headpinz.com/sitemap.xml    → HeadPinz URLs only
 *
 * The root-level rewrite guard in middleware.ts ensures /sitemap.xml hits
 * this generator on both hosts (instead of being rewritten to /hp/sitemap.xml).
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const h = await headers();
  const host = (h.get("host") || "").toLowerCase();
  const isHeadPinz = host.includes("headpinz.com");

  const ft = "https://fasttraxent.com";
  const hp = "https://headpinz.com";
  const now = new Date();

  const fastTraxUrls: MetadataRoute.Sitemap = [
    { url: ft, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${ft}/racing`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${ft}/pricing`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${ft}/attractions`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${ft}/group-events`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${ft}/menu`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${ft}/leaderboards`, lastModified: now, changeFrequency: "daily", priority: 0.6 },
    { url: `${ft}/leagues`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${ft}/rewards`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${ft}/book/race`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${ft}/book/duck-pin`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    { url: `${ft}/book/shuffly`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    { url: `${ft}/book/gel-blaster`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    { url: `${ft}/book/laser-tag`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    // SEO content hub + competitor-alternative landing pages.
    { url: `${ft}/careers`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${ft}/things-to-do-fort-myers`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${ft}/alternatives`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    ...listAlternatives("ft").map((a) => ({
      url: `${ft}/alternatives/${a.slug}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];

  const headPinzUrls: MetadataRoute.Sitemap = [
    { url: hp, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${hp}/fort-myers`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${hp}/fort-myers/attractions`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${hp}/fort-myers/birthdays`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${hp}/fort-myers/group-events`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${hp}/fort-myers/have-a-ball`, lastModified: now, changeFrequency: "weekly", priority: 0.75 },
    { url: `${hp}/naples`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${hp}/naples/attractions`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${hp}/naples/birthdays`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${hp}/naples/group-events`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${hp}/menu`, lastModified: now, changeFrequency: "weekly", priority: 0.85 },
    { url: `${hp}/rewards`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${hp}/kids-bowl-free`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${hp}/book/bowling`, lastModified: now, changeFrequency: "weekly", priority: 0.95 },
    { url: `${hp}/book/gel-blaster`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    { url: `${hp}/book/laser-tag`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    { url: `${hp}/book/shuffly`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    { url: `${hp}/fwf`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${hp}/careers`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    // SEO content hubs + competitor-alternative landing pages.
    { url: `${hp}/things-to-do-fort-myers`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${hp}/things-to-do-naples`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${hp}/alternatives`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    ...listAlternatives("hp").map((a) => ({
      url: `${hp}/alternatives/${a.slug}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];

  return isHeadPinz ? headPinzUrls : fastTraxUrls;
}
