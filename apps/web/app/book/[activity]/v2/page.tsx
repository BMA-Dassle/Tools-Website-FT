import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { BookingFlow } from "~/components/features/booking";
import type { Activity } from "~/features/booking";

/**
 * Per-activity v2 booking page — `/book/[activity]/v2`.
 *
 * Validates the URL slug, maps it to an Activity, and hands off to the
 * unified `<BookingFlow>` component. The slug → activity mapping is the
 * one place that translates marketing URLs into internal type-safe values:
 *
 *   /book/race/v2           → "race"
 *   /book/race-pack/v2      → "race-pack"
 *   /book/gel-blaster/v2    → "attraction"   (slug pinned in draft)
 *   /book/laser-tag/v2      → "attraction"
 *   /book/duck-pin/v2       → "attraction"
 *   /book/shuffly/v2        → "attraction"
 *   /book/bowling/v2        → "bowling"
 *
 * KBF lives at /book/kbf/v2 (separate route — different SEO + legal
 * model) rather than in the [activity] slot.
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
  params: Promise<{ activity: string }>;
}): Promise<Metadata> {
  const { activity: slug } = await params;
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
  params: Promise<{ activity: string }>;
}) {
  const { activity: slug } = await params;
  const activity = slugToActivity(slug);
  if (!activity) notFound();

  return <BookingFlow activity={activity} />;
}
