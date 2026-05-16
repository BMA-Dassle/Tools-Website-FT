import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { BookingFlow } from "~/components/features/booking";
import type { Activity } from "~/features/booking";

/**
 * Per-activity v2 booking page — `/book/[attraction]/v2`.
 *
 * The dynamic segment is named `[attraction]` to match v1's existing
 * `app/book/[attraction]/page.tsx` (Next.js requires consistent param
 * names at any given route depth). The URL still reads naturally:
 *
 *   /book/race/v2           → "race"
 *   /book/race-pack/v2      → "race-pack"
 *   /book/gel-blaster/v2    → "attraction"   (slug pinned in draft later)
 *   /book/laser-tag/v2      → "attraction"
 *   /book/duck-pin/v2       → "attraction"
 *   /book/shuffly/v2        → "attraction"
 *   /book/bowling/v2        → "bowling"
 *
 * KBF lives at /book/kbf/v2 (separate route — different SEO + legal
 * model) rather than in this dynamic slot.
 *
 * Unknown slugs → 404.
 */

const ATTRACTION_SLUGS = new Set(["gel-blaster", "laser-tag", "duck-pin", "shuffly"]);

function slugToActivity(slug: string): Activity | null {
  if (slug === "race") return "race";
  if (slug === "race-pack" || slug === "race-packs") return "race-pack";
  if (slug === "bowling") return "bowling";
  if (ATTRACTION_SLUGS.has(slug)) return "attraction";
  return null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ attraction: string }>;
}): Promise<Metadata> {
  const { attraction: slug } = await params;
  const activity = slugToActivity(slug);
  if (!activity) return { title: "Not found" };
  return {
    title: `Book ${slug.replace(/-/g, " ")} (v2)`,
    description: `v2 booking flow — ${slug}.`,
  };
}

export default async function BookActivityV2Page({
  params,
}: {
  params: Promise<{ attraction: string }>;
}) {
  const { attraction: slug } = await params;
  const activity = slugToActivity(slug);
  if (!activity) notFound();

  return <BookingFlow activity={activity} />;
}
