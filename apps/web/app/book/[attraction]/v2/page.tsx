import { headers } from "next/headers";
import { notFound } from "next/navigation";
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
 * Promo `?code=` handling:
 *   - Resolve via `resolveAppliedPromo` server-side.
 *   - If the resulting promo IS valid for this activity (scope match),
 *     seed `BookingFlow` with `initialPromo`.
 *   - If the code is unusable for any reason — unknown, expired,
 *     exhausted, OR scoped to a different activity — render the wizard
 *     WITHOUT applying the code. The customer arrived at a specific URL
 *     on purpose; we don't bounce them somewhere else. (Earlier rev
 *     redirected to `/book/v2?code=X` on a wrong-domain mismatch; the
 *     redirect was removed 2026-05-21 because it created an unclear
 *     flow from the customer's perspective.)
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
        // Code is valid for this activity → seed it into the session.
        initialPromo = promo;
      }
      // Wrong-domain / wrong-product → render the wizard WITHOUT the
      // promo. No redirect (removed 2026-05-21 — see file-level doc).
    }
    // Unusable code (unknown/expired/etc.) falls through the same way.
  }

  return (
    <BookingFlow
      activity={activity}
      slug={slug}
      entryBrand={entryBrand}
      initialContext={initialContext}
      initialPromo={initialPromo}
      urlCode={code || null}
    />
  );
}
