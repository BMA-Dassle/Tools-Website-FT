import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { IconArrowRight } from "@tabler/icons-react";
import { BreadcrumbJsonLd } from "@/components/seo/JsonLd";
import { HEADPINZ_OG, HEADPINZ_OG_IMAGE } from "@/lib/seo";
import { ATTRACTIONS } from "@/lib/attractions-data";
import { currentDealOffer, DEAL_CATALOG, dealValue } from "~/features/deals";
import { dealsUrgencyUiEnabled } from "~/features/deals/flags";
import { formatDealDeadlineShort, money } from "~/features/deals/format";

/**
 * Deal-pack hub.
 *
 * URL: /deals — top-level, served on every host with HeadPinz branding forced.
 * See the sibling [slug]/page.tsx header for why it is not at /hp/deals.
 *
 * Unlinked from site navigation but fully indexable — see the sibling
 * [slug]/page.tsx header for why that combination is deliberate. This page
 * exists mainly to give the individual deals a crawlable parent and an internal
 * link between them; ads point at the slug pages directly.
 */

export const revalidate = 3600;

const CANONICAL = "https://headpinz.com/deals";
const TITLE = "HeadPinz Deals — Laser Tag, Gel Blaster & Arcade Packs";
const DESCRIPTION =
  "Prepaid packs at HeadPinz Fort Myers and Naples: two laser tag or gel blaster sessions bundled with arcade game cards, for less than buying them separately.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: CANONICAL },
  keywords: [
    "headpinz deals",
    "laser tag deal fort myers",
    "gel blaster deal naples",
    "arcade game card deal",
    "family fun deals southwest florida",
    "things to do fort myers cheap",
  ],
  openGraph: {
    title: `${TITLE} | HeadPinz`,
    description: DESCRIPTION,
    type: "website",
    url: CANONICAL,
    siteName: "HeadPinz",
    images: [...HEADPINZ_OG],
  },
  twitter: {
    card: "summary_large_image",
    title: `${TITLE} | HeadPinz`,
    description: DESCRIPTION,
    images: [HEADPINZ_OG_IMAGE],
  },
};

export default async function DealsHubPage() {
  const urgencyUi = dealsUrgencyUiEnabled();
  // One resolve per deal, then the cards render from it. Two deals, and the
  // sold-count query only runs for a deal that actually has an allocation, so
  // this is zero queries in the common case.
  const priced = await Promise.all(
    DEAL_CATALOG.map(async (deal) => ({ deal, offer: await currentDealOffer(deal) })),
  );

  return (
    <div className="min-h-screen bg-[#00041b]">
      <BreadcrumbJsonLd
        items={[
          { name: "HeadPinz", url: "https://headpinz.com" },
          { name: "Deals", url: CANONICAL },
        ]}
      />

      <section className="mx-auto max-w-6xl px-4 pt-32 pb-12 sm:pt-40">
        <span className="text-xs font-bold tracking-[0.2em] text-[#fd5b56] uppercase">
          Fort Myers &amp; Naples
        </span>
        <h1 className="font-display mt-3 text-4xl leading-[0.95] text-white sm:text-6xl">
          Prepaid fun packs
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-white/65">
          Buy once, play twice. Each pack bundles two sessions with arcade credit and lands in your
          inbox as a scannable code — good for a year at either HeadPinz.
        </p>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-24">
        <div className="grid gap-6 md:grid-cols-2">
          {priced.map(({ deal, offer }) => {
            const value = dealValue(deal, deal.locations[0], offer.unitPriceCents, offer.bonusItems);
            const accent = ATTRACTIONS[deal.scheduleSlug]?.color ?? "#fd5b56";
            const deadlineBadge =
              urgencyUi && offer.isOfferLive && offer.endsAt
                ? `Bonus ends ${formatDealDeadlineShort(offer.endsAt)}`
                : null;
            return (
              <Link
                key={deal.slug}
                href={`/deals/${deal.slug}`}
                className="group relative overflow-hidden rounded-3xl border border-white/12 bg-white/[0.03] transition-all duration-300 hover:scale-[1.01] hover:border-white/30"
              >
                <div className="relative aspect-[16/10] overflow-hidden">
                  <Image
                    src={deal.media.hero}
                    alt={deal.name}
                    fill
                    sizes="(max-width: 768px) 100vw, 50vw"
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#00041b] via-[#00041b]/40 to-transparent" />
                  <span
                    className="absolute top-4 left-4 rounded-full px-3 py-1 text-xs font-bold tracking-widest uppercase"
                    style={{ background: accent, color: "#00041b" }}
                  >
                    Save {money(value.savingsCents)}
                  </span>
                  {/* The deadline sits opposite the saving, in the photo's dark
                      corner rather than the accent chip — one loud badge per
                      card is the limit before it starts reading as a flash-sale
                      site. Server-rendered as a date: a ticking clock belongs on
                      the page you buy from, not on a catalog tile. */}
                  {deadlineBadge && (
                    <span className="absolute top-4 right-4 rounded-full bg-[#00041b]/80 px-3 py-1 text-xs font-bold tracking-widest text-white uppercase backdrop-blur-sm">
                      {deadlineBadge}
                    </span>
                  )}
                </div>
                <div className="p-6">
                  <h2 className="font-display text-2xl text-white">{deal.name}</h2>
                  <p className="mt-2 text-sm text-white/60">{deal.tagline}</p>
                  <div className="mt-5 flex items-end gap-3">
                    <span className="font-display text-4xl text-white">
                      {money(offer.unitPriceCents)}
                    </span>
                    <span className="pb-1 text-sm text-white/45">
                      + tax ·{" "}
                      <span className="line-through">
                        ${(value.compareAtCents / 100).toFixed(0)} value
                      </span>
                    </span>
                  </div>
                  <span
                    className="mt-5 inline-flex items-center gap-1.5 text-sm font-bold tracking-widest uppercase"
                    style={{ color: accent }}
                  >
                    See the deal
                    <IconArrowRight
                      size={16}
                      className="transition-transform group-hover:translate-x-1"
                    />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
