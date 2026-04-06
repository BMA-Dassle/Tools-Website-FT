import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const ft = "https://fasttraxent.com";
  const hp = "https://headpinz.com";

  return [
    /* ── FastTrax ── */
    { url: ft, lastModified: new Date(), changeFrequency: "weekly", priority: 1 },
    { url: `${ft}/racing`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.9 },
    { url: `${ft}/pricing`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.9 },
    { url: `${ft}/attractions`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.8 },
    { url: `${ft}/group-events`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
    { url: `${ft}/menu`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.7 },
    { url: `${ft}/leaderboards`, lastModified: new Date(), changeFrequency: "daily", priority: 0.6 },

    /* ── HeadPinz ── */
    { url: hp, lastModified: new Date(), changeFrequency: "weekly", priority: 1 },
    { url: `${hp}/fort-myers`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.9 },
    { url: `${hp}/fort-myers/attractions`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.8 },
    { url: `${hp}/fort-myers/birthdays`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
    { url: `${hp}/fort-myers/group-events`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
    { url: `${hp}/naples`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.9 },
    { url: `${hp}/naples/attractions`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.8 },
    { url: `${hp}/naples/birthdays`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
    { url: `${hp}/naples/group-events`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
    { url: `${hp}/menu`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.7 },
    { url: `${hp}/rewards`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.7 },
    { url: `${hp}/kids-bowl-free`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.7 },
    { url: `${hp}/book/bowling`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.8 },
  ];
}
