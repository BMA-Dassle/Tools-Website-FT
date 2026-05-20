import type { Metadata } from "next";
import { headers } from "next/headers";
import {
  allOfferings,
  initialOfferingsFor,
  type ActivityOffering,
  type Brand,
} from "~/features/booking";
import { resolveAppliedPromo, type AppliedPromo } from "~/features/discount-codes";
import { PromoLanding } from "./PromoLanding";

/**
 * Promo-aware booking landing — `/book/v2`.
 *
 * Server component. Reads optional `?code=X` URL seed, resolves the
 * promo, and pre-computes the offering tiles the client island
 * renders. Without a code (or with an invalid one), shows all
 * offerings — the customer can either enter / fix the code or click
 * a tile to go direct.
 *
 * This is a different page from the chooser we deleted in commit 1 of
 * PR-B2. That one filtered by brand only. This one filters by promo
 * scope and is the canonical promo-led entry point.
 *
 * Direct slug entry (`/book/race/v2`, `/book/bowling/v2`, etc.) still
 * works without going through this page. Customers who hit a slug URL
 * with a `?code=` that doesn't apply to that activity get
 * server-side-redirected here.
 */

async function readEntryBrand(): Promise<Brand> {
  const hdrs = await headers();
  return hdrs.get("x-brand") === "headpinz" ? "headpinz" : "fasttrax";
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const sp = await searchParams;
  const codeRaw = sp.code;
  const code = typeof codeRaw === "string" ? codeRaw.trim() : "";
  if (code) {
    return {
      title: `Book online · code ${code.toUpperCase()}`,
      description: `Apply your code to see eligible activities and dates.`,
    };
  }
  return {
    title: "Book online",
    description: "Pick your activity to get started.",
  };
}

export default async function BookV2LandingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const codeParam = sp.code;
  const seedCode = typeof codeParam === "string" ? codeParam.trim().toUpperCase() : "";

  const entryBrand = await readEntryBrand();

  // Server-side resolve so the first paint already has the filtered list
  // (no flash of all-offerings before the code applies).
  let seededPromo: AppliedPromo | null = null;
  let seedRejected = false;
  if (seedCode) {
    seededPromo = await resolveAppliedPromo(seedCode);
    if (!seededPromo) seedRejected = true;
  }

  const initialOfferings: ActivityOffering[] = seededPromo
    ? initialOfferingsFor(seededPromo)
    : allOfferings().slice();

  return (
    <PromoLanding
      entryBrand={entryBrand}
      seedCode={seedCode}
      seededPromo={seededPromo}
      seedRejected={seedRejected}
      initialOfferings={initialOfferings}
      allOfferings={allOfferings().slice()}
    />
  );
}
