import type { Metadata } from "next";
import { headers } from "next/headers";
import { allOfferings, type ActivityOffering, type Brand } from "~/features/booking";
import { resolveAppliedPromo, type AppliedPromo } from "~/features/discount-codes";
import { PromoLanding } from "./PromoLanding";

/**
 * Promo-aware booking landing — `/book/v2`.
 *
 * Server component. Reads optional `?code=X` URL seed, resolves the
 * promo, and renders the v1-HP-book-hub-style activity grid. The
 * landing ALWAYS shows the full catalog of offerings; when a code is
 * applied, eligible tiles are highlighted (badge + accent border) but
 * non-eligible tiles stay clickable — the code just won't activate
 * for them. Per the rev 2.5 "highlight, don't filter" design rule.
 *
 * Direct slug entry (`/book/race/v2`, `/book/bowling/v2`, etc.) still
 * works without going through this page. Customers who hit a slug URL
 * with a `?code=` that doesn't apply to that activity get
 * server-side-redirected here so they can see what IS valid.
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
      description: "Apply your code to see eligible experiences.",
    };
  }
  return {
    title: "Book online",
    description: "Pick your experience to get started.",
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

  // Server-side resolve so the first paint already shows the applied
  // chip + the per-tile eligibility highlight (no flash of un-highlighted
  // before the code applies).
  let seededPromo: AppliedPromo | null = null;
  let seedRejected = false;
  if (seedCode) {
    seededPromo = await resolveAppliedPromo(seedCode);
    if (!seededPromo) seedRejected = true;
  }

  const initialOfferings: ActivityOffering[] = allOfferings().slice();

  return (
    <PromoLanding
      entryBrand={entryBrand}
      seedCode={seedCode}
      seededPromo={seededPromo}
      seedRejected={seedRejected}
      initialOfferings={initialOfferings}
      allOfferings={initialOfferings}
    />
  );
}
