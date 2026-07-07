import type { Metadata } from "next";
import { headers } from "next/headers";
import {
  landingOfferingsFor,
  type ActivityOffering,
  type Brand,
  type CenterCode,
} from "~/features/booking";
import { parseEntryContextFromSearchParams } from "~/features/booking/state/parse-entry-context";
import { resolveAppliedPromo, type AppliedPromo } from "~/features/discount-codes";
import { enabledCombos, type ComboSpecial } from "~/features/combos";
import {
  fixtureDayLabel,
  fixtureLabel,
  fixtureTimeLabel,
  upcomingFrom,
  worldCupEnabledCenters,
  worldCupWindowActive,
} from "~/features/world-cup";
import { fixturesWithLiveTeams } from "~/features/world-cup/live-teams";
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

  // Center scoping: `?location=` (carried in by the HeadPinz Fort Myers / Naples
  // entry points) decides which complex this landing serves. Naples scopes to
  // ONLY Naples-available activities; Fort Myers / unknown shows everything, with
  // the visitor's own brand propagating first.
  const center: CenterCode | null = parseEntryContextFromSearchParams(sp).center ?? null;
  const initialOfferings: ActivityOffering[] = landingOfferingsFor(entryBrand, center);

  // Combo specials lead the grid (best value). Center-scoped like the
  // offerings: a combo only shows when this landing serves its complex
  // (racing combos are Fort Myers-only, so Naples never sees them).
  const combos: ComboSpecial[] = enabledCombos().filter((c) => !center || c.center === center);

  // World Cup VIP Bowling tile — HeadPinz brand only, limited-time (self-hides
  // after the July 19 final), per-center kill switches honored. Launch = Fort
  // Myers only (the Naples flag ships "false" until its LED wall is verified);
  // Naples appears automatically when its flag flips. The link seeds the
  // match-picker entry at this landing's center (or the first enabled one).
  const nowMs = Date.now();
  const wcCenters = worldCupEnabledCenters().filter((c) => !center || c === center);
  const showWorldCup =
    entryBrand === "headpinz" && worldCupWindowActive(nowMs) && wcCenters.length > 0;
  // Live-enriched fixtures (Redis-cached, fail-soft) only when the tile shows.
  const nextFixture = showWorldCup
    ? (upcomingFrom(await fixturesWithLiveTeams(), nowMs)[0] ?? null)
    : null;
  // Deep-link the center only when we actually know it (or only one center is
  // enabled). A center-less landing must NOT force fort-myers (owner bug 7/6) —
  // the wizard's center picker asks instead.
  const wcHrefCenter = center ?? (wcCenters.length === 1 ? wcCenters[0] : null);
  const worldCup = showWorldCup
    ? {
        href: `/book/bowling/v2?experience=world-cup${wcHrefCenter ? `&location=${wcHrefCenter}` : ""}`,
        nextMatch: nextFixture
          ? `${fixtureLabel(nextFixture)} — ${fixtureDayLabel(nextFixture)} ${fixtureTimeLabel(nextFixture)}`
          : null,
        // Country flags for the "Next up" line (owner 7/6) — live-enriched,
        // null when the feed hasn't resolved the matchup yet.
        nextWhen: nextFixture
          ? `${fixtureDayLabel(nextFixture)} ${fixtureTimeLabel(nextFixture)}`
          : null,
        nextHome: nextFixture?.home ?? null,
        nextAway: nextFixture?.away ?? null,
      }
    : null;

  return (
    <PromoLanding
      entryBrand={entryBrand}
      center={center}
      seedCode={seedCode}
      seededPromo={seededPromo}
      seedRejected={seedRejected}
      initialOfferings={initialOfferings}
      allOfferings={initialOfferings}
      combos={combos}
      worldCup={worldCup}
    />
  );
}
