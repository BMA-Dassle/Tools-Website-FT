import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { BookingFlow } from "~/components/features/booking";
import {
  findOffering,
  isOfferingInPromoScope,
  type Activity,
  type Brand,
  type EntryContext,
} from "~/features/booking";
import { parseEntryContextFromSearchParams } from "~/features/booking/state/parse-entry-context";
import { resolveAppliedPromo, type AppliedPromo } from "~/features/discount-codes";

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
 * URL params (?member, ?firstName, ...) are parsed into EntryContext and
 * seeded into the session for prefill.
 *
 * Promo `?code=` handling (per memory: booking_v2_promo_integration.md):
 *   1. Resolve via `resolveAppliedPromo` server-side.
 *   2. If the resulting promo is NOT in this activity's scope, redirect
 *      to `/book/v2?code=X` so the customer sees what IS valid.
 *   3. If valid + in scope, seed `BookingFlow` with `initialPromo`.
 *   4. If the code is unusable (unknown/expired/exhausted/etc.), continue
 *      rendering the activity without a promo — direct-slug entry without
 *      a working code is still a valid booking, just without discount.
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

  // Promo seed: resolve, then check whether THIS activity is in scope.
  // The catalog's `findOffering(slug)` matches the URL slug for attractions
  // (gel-blaster, laser-tag, ...). Race / bowling slugs match their own
  // offering directly.
  const codeRaw = sp.code;
  const code = typeof codeRaw === "string" ? codeRaw.trim().toUpperCase() : "";
  let initialPromo: AppliedPromo | null = null;
  if (code) {
    const promo = await resolveAppliedPromo(code);
    if (promo) {
      const offering = findOffering(slug);
      if (offering && isOfferingInPromoScope(offering, promo)) {
        initialPromo = promo;
      } else {
        // Wrong-domain (or wrong-product) — send the customer to the
        // landing where they can see what IS valid. Carry the code through.
        redirect(`/book/v2?code=${encodeURIComponent(code)}`);
      }
    }
    // Unusable code (unknown/expired/etc.) falls through — render the
    // activity without a promo. Don't redirect to the landing for those:
    // the customer arrived at a specific URL on purpose.
  }

  return (
    <BookingFlow
      activity={activity}
      entryBrand={entryBrand}
      initialContext={initialContext}
      initialPromo={initialPromo}
    />
  );
}
