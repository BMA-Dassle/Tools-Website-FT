import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { BookingFlow } from "~/components/features/booking";
import type { Activity, Brand, EntryContext } from "~/features/booking";
import { parseEntryContextFromSearchParams } from "~/features/booking/state/parse-entry-context";

/**
 * Per-activity v2 booking page — `/book/[attraction]/v2`.
 *
 * The dynamic segment is named `[attraction]` to match v1's existing
 * `app/book/[attraction]/page.tsx` (Next.js requires consistent param
 * names at any given route depth). The URL still reads naturally:
 *
 *   /book/race/v2           → activity: "race"
 *   /book/bowling/v2        → activity: "bowling"
 *   /book/gel-blaster/v2    → activity: "attraction" (slug carried by item)
 *   /book/laser-tag/v2      → activity: "attraction"
 *   /book/duck-pin/v2       → activity: "attraction"
 *   /book/shuffly/v2        → activity: "attraction"
 *
 * KBF lives at /book/kbf/v2 (separate route — distinct SEO + legal model).
 * Race-packs are NOT a booking — they are credit-pack purchases that come
 * back in PR-B4 at their own route. /book/race-pack/v2 → 404 for now.
 *
 * Unknown slugs → 404.
 *
 * URL params (?member, ?promo, ?firstName, etc.) are parsed into
 * EntryContext and seeded into the session for prefill.
 */

const ATTRACTION_SLUGS = new Set(["gel-blaster", "laser-tag", "duck-pin", "shuffly"]);

function slugToActivity(slug: string): Activity | null {
  if (slug === "race") return "race";
  if (slug === "bowling") return "bowling";
  if (ATTRACTION_SLUGS.has(slug)) return "attraction";
  return null;
}

async function readEntryBrand(): Promise<Brand> {
  const hdrs = await headers();
  return hdrs.get("x-brand") === "headpinz" ? "headpinz" : "fasttrax";
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
  searchParams,
}: {
  params: Promise<{ attraction: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { attraction: slug } = await params;
  const activity = slugToActivity(slug);
  if (!activity) notFound();

  const sp = await searchParams;
  const entryBrand = await readEntryBrand();
  const initialContext: EntryContext = parseEntryContextFromSearchParams(sp);

  return (
    <BookingFlow activity={activity} entryBrand={entryBrand} initialContext={initialContext} />
  );
}
