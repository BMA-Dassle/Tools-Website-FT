import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  IconArrowRight,
  IconBolt,
  IconCalendarEvent,
  IconDeviceGamepad2,
  IconMail,
  IconMapPin,
  IconQrcode,
} from "@tabler/icons-react";
import SeoFaq from "@/components/headpinz/SeoFaq";
import { BreadcrumbJsonLd } from "@/components/seo/JsonLd";
import { HEADPINZ_OG, HEADPINZ_OG_IMAGE } from "@/lib/seo";
import { ATTRACTIONS, normalizeLocationSlug } from "@/lib/attractions-data";
import {
  DEAL_CATALOG,
  DEAL_LOCATION_INFO,
  dealValue,
  getDeal,
  isDealLocation,
  type DealCatalogEntry,
  type DealLocationKey,
} from "~/features/deals";
import DealBuyPanel from "./DealBuyPanel";

/**
 * Prepaid deal-pack landing page.
 *
 * URL: /deals/{slug} — a TOP-LEVEL route, served on every host.
 *
 * It deliberately does NOT live at /hp/deals. That rewrite only fires when the
 * hostname contains "headpinz.com", so on a Vercel preview alias
 * (…-headpinz.vercel.app) or any bare deployment URL the page 404'd with FastTrax
 * chrome — and an ad or an emailed link must not depend on which hostname it
 * lands on. `/deals` is registered in `isSharedTopLevelRoute` (middleware.ts) and
 * middleware FORCES `x-brand: headpinz` on both hosts: these are HeadPinz
 * products, so the brand comes from the product, not the host. The canonical
 * always points at headpinz.com/deals/{slug} regardless of where it was served.
 *
 * UNLINKED BUT INDEXABLE (owner decision). It appears in no nav, footer or
 * on-page link anywhere on the site — you cannot browse to it — but it is fully
 * crawlable with a canonical, Product/Offer and FAQPage structured data, because
 * it has to do two jobs at once: rank for "laser tag deal fort myers" and serve
 * as the landing page for paid search. Discovery is via sitemap.ts (PR E) plus
 * wherever the ads point. It is deliberately NOT noindex.
 *
 * Server component so it can own its metadata and JSON-LD; the only client code
 * is the buy panel island.
 */

export const revalidate = 3600;

type Params = { slug: string };
type Search = { [key: string]: string | string[] | undefined };

export function generateStaticParams(): Params[] {
  return DEAL_CATALOG.map((d) => ({ slug: d.slug }));
}

function canonicalFor(slug: string): string {
  return `https://headpinz.com/deals/${slug}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const deal = getDeal(slug);
  if (!deal) return { title: "Not found" };

  const url = canonicalFor(deal.slug);
  const title = deal.seo.title;
  return {
    title,
    description: deal.seo.description,
    alternates: { canonical: url },
    keywords: deal.seo.keywords,
    openGraph: {
      title: `${title} | HeadPinz`,
      description: deal.seo.description,
      type: "website",
      url,
      siteName: "HeadPinz",
      images: [...HEADPINZ_OG],
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | HeadPinz`,
      description: deal.seo.description,
      images: [HEADPINZ_OG_IMAGE],
    },
  };
}

/**
 * Product + Offer structured data.
 *
 * New shape for this repo, which uses ItemList/Service everywhere else — but
 * those describe things you enquire about, and this is a thing you buy. Product
 * with an Offer is what earns Google's price/availability rich result, which is
 * the whole point on a paid-search landing page.
 *
 * No aggregateRating: there are no real reviews for this pack, and inventing one
 * is both a policy violation and a manual-action risk.
 */
function productJsonLd(deal: DealCatalogEntry, value: ReturnType<typeof dealValue>) {
  const url = canonicalFor(deal.slug);
  // Offers need an end date; a rolling year keeps it valid without a content edit.
  const validUntil = new Date();
  validUntil.setFullYear(validUntil.getFullYear() + 1);

  return {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": `${url}#product`,
    name: deal.name,
    description: deal.seo.description,
    image: [deal.media.hero],
    brand: { "@type": "Brand", name: "HeadPinz" },
    category: "Family Entertainment",
    offers: {
      "@type": "Offer",
      url,
      priceCurrency: "USD",
      price: (deal.priceCents / 100).toFixed(2),
      priceValidUntil: validUntil.toISOString().slice(0, 10),
      availability: "https://schema.org/InStock",
      itemCondition: "https://schema.org/NewCondition",
      seller: { "@type": "Organization", name: "HeadPinz", "@id": "https://headpinz.com/#organization" },
      areaServed: deal.locations.map((l) => DEAL_LOCATION_INFO[l].shortLabel),
      // What a walk-in would pay for the same things, so the discount is
      // machine-readable and matches the on-page strikethrough.
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: (deal.priceCents / 100).toFixed(2),
        priceCurrency: "USD",
        valueAddedTaxIncluded: false,
      },
      eligibleQuantity: {
        "@type": "QuantitativeValue",
        minValue: 1,
        maxValue: deal.maxPerBuyer,
        unitText: "packs",
      },
    },
    additionalProperty: value.lines.map((l) => ({
      "@type": "PropertyValue",
      name: l.label,
      value: `$${(l.cents / 100).toFixed(2)} value`,
    })),
  };
}

export default async function DealPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const deal = getDeal(slug);
  if (!deal) notFound();

  // `?location=` lets one ad target one venue. Read on the SERVER so the right
  // venue is already selected in the first HTML — no post-hydration flip.
  //
  // Normally reading searchParams would cost this route its static rendering,
  // but nothing in this app is statically rendered: the root layout calls
  // headers() for host-based brand detection, so every route is server-rendered
  // on demand (verified — the build reports zero static routes). There is no
  // cache to lose here, so the simpler and better-looking option wins.
  //
  // Accepts the friendly spellings marketing already uses ("fort-myers", "fm",
  // "np") via the shared normalizeLocationSlug.
  const raw = typeof sp.location === "string" ? sp.location : undefined;
  const normalized = normalizeLocationSlug(raw);
  const initialLocation: DealLocationKey | null =
    normalized && isDealLocation(normalized) && deal.locations.includes(normalized)
      ? normalized
      : null;

  // Value is per location; dealValue throws if a product is missing there, so an
  // unsellable combination fails loudly rather than under-stating a saving.
  const value = dealValue(deal, initialLocation ?? deal.locations[0]);
  const attraction = ATTRACTIONS[deal.scheduleSlug];
  const accent = attraction?.color ?? "#fd5b56";
  const cardItems = deal.items.filter((i) => i.kind === "gamezone");
  const playDollars = cardItems.reduce(
    (sum, i) => sum + (i.kind === "gamezone" ? (i.tokens + i.bonusTokens) / 10 : 0),
    0,
  );

  return (
    <div
      className="relative min-h-screen bg-[#00041b]"
      style={{ ["--deal-accent" as string]: accent }}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd(deal, value)) }}
      />
      <BreadcrumbJsonLd
        items={[
          { name: "HeadPinz", url: "https://headpinz.com" },
          { name: "Deals", url: "https://headpinz.com/deals" },
          { name: deal.name, url: canonicalFor(deal.slug) },
        ]}
      />

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
          <Image
            src={deal.media.hero}
            alt=""
            fill
            priority
            sizes="100vw"
            className="object-cover"
            style={{
              WebkitMaskImage:
                "linear-gradient(to bottom, #000 0%, #000 55%, rgba(0,0,0,0.35) 85%, transparent 100%)",
              maskImage:
                "linear-gradient(to bottom, #000 0%, #000 55%, rgba(0,0,0,0.35) 85%, transparent 100%)",
            }}
          />
          <div className="absolute inset-0 bg-[#00041b]/70" />
          {/* Copy-side scrim. The base wash alone left the small trust row sitting
              directly on the bright vest glow. This darkens the left (text) half
              and fades out before the photo's focal point, so legibility comes
              from a gradient rather than from flattening the whole image — the
              imagery is the reason someone stops scrolling. */}
          <div className="absolute inset-0 bg-gradient-to-r from-[#00041b]/85 via-[#00041b]/45 to-transparent" />
          <div
            className="absolute inset-0"
            style={{
              background: `radial-gradient(60% 50% at 50% 0%, ${accent}33, transparent 70%)`,
            }}
          />
        </div>

        <div className="relative z-10 mx-auto max-w-6xl px-4 pt-32 pb-14 sm:pt-40 sm:pb-20">
          <div className="grid gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:gap-14">
            <div>
              <span
                className="text-xs font-bold tracking-[0.2em] uppercase"
                style={{ color: accent }}
              >
                HeadPinz Deal · Fort Myers &amp; Naples
              </span>
              <h1 className="font-display mt-3 text-4xl leading-[0.95] text-white sm:text-6xl lg:text-7xl">
                {deal.name}
              </h1>
              <p className="mt-4 max-w-xl text-lg text-white/70 sm:text-xl">{deal.tagline}</p>

              <div className="mt-8 flex flex-wrap items-end gap-x-5 gap-y-2">
                <span className="font-display text-6xl text-white sm:text-7xl">
                  ${(deal.priceCents / 100).toFixed(0)}
                </span>
                <div className="pb-2">
                  <span className="block text-sm text-white/50">plus tax</span>
                  <span className="block text-base text-white/45 line-through">
                    ${(value.compareAtCents / 100).toFixed(0)} value
                  </span>
                </div>
                <span
                  className="mb-2 rounded-full px-3 py-1 text-xs font-bold tracking-widest uppercase"
                  style={{ background: accent, color: "#00041b" }}
                >
                  Save {value.savingsPct}%
                </span>
              </div>

              <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-white/60">
                <li className="flex items-center gap-1.5">
                  <IconMapPin size={15} style={{ color: accent }} />
                  Good at either HeadPinz
                </li>
                <li className="flex items-center gap-1.5">
                  <IconCalendarEvent size={15} style={{ color: accent }} />
                  {deal.expiresMonths} months to use it
                </li>
                <li className="flex items-center gap-1.5">
                  <IconQrcode size={15} style={{ color: accent }} />
                  Emailed instantly
                </li>
              </ul>

              <a
                href="#buy"
                className="mt-9 inline-flex items-center gap-2 rounded-full px-8 py-4 text-sm font-bold tracking-widest uppercase transition hover:brightness-110"
                style={{ background: accent, color: "#00041b" }}
              >
                Get this deal
                <IconArrowRight size={17} />
              </a>
            </div>

            {/* Buy panel — sticky alongside the hero on desktop. */}
            <div id="buy" className="lg:sticky lg:top-28 lg:self-start">
              <DealBuyPanel
                slug={deal.slug}
                dealName={deal.name}
                priceCents={deal.priceCents}
                locations={deal.locations}
                initialLocation={initialLocation}
                maxPerBuyer={deal.maxPerBuyer}
                expiresMonths={deal.expiresMonths}
                accentColor={accent}
                scheduleLabel={`Pick your ${attraction?.shortName.toLowerCase() ?? "session"} time`}
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── What you get ─────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-4 py-16">
        <h2 className="font-display text-3xl text-white sm:text-4xl">What&apos;s in the pack</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-white/12 bg-white/[0.04] p-6">
            <IconBolt size={26} style={{ color: accent }} />
            <h3 className="mt-3 text-lg font-bold text-white">
              2 × {attraction?.name ?? deal.scheduleSlug}
            </h3>
            <p className="mt-2 text-sm text-white/60">
              {attraction?.description}. {attraction?.durationLabel ?? "Timed session"} each — book a
              time right after checkout or whenever suits you.
            </p>
          </div>
          <div className="rounded-2xl border border-white/12 bg-white/[0.04] p-6">
            <IconDeviceGamepad2 size={26} style={{ color: accent }} />
            <h3 className="mt-3 text-lg font-bold text-white">
              {cardItems.length} × game cards · ${playDollars} of play
            </h3>
            <p className="mt-2 text-sm text-white/60">
              Scan your code at any kiosk and it prints the cards with the credit already loaded. The
              cards themselves are on us — no $2 activation fee, unlike buying one at the counter.
            </p>
          </div>
        </div>

        {/* Value table — the argument for the strikethrough, itemised. */}
        <div className="mt-10 overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <caption className="pb-3 text-left text-xs tracking-widest text-white/40 uppercase">
              What this costs à la carte
            </caption>
            <tbody>
              {value.lines.map((line) => (
                <tr key={line.label} className="border-b border-white/8">
                  <th scope="row" className="py-2.5 pr-4 text-left font-normal text-white/65">
                    {line.label}
                  </th>
                  <td className="py-2.5 text-right text-white/65">
                    ${(line.cents / 100).toFixed(2)}
                  </td>
                </tr>
              ))}
              <tr className="border-b border-white/15">
                <th scope="row" className="py-2.5 pr-4 text-left font-bold text-white">
                  Normally
                </th>
                <td className="py-2.5 text-right font-bold text-white">
                  ${(value.compareAtCents / 100).toFixed(2)}
                </td>
              </tr>
              <tr>
                <th scope="row" className="py-3 pr-4 text-left font-bold" style={{ color: accent }}>
                  This pack
                </th>
                <td className="py-3 text-right font-bold" style={{ color: accent }}>
                  ${(deal.priceCents / 100).toFixed(2)} + tax
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────── */}
      <section className="border-y border-white/8 bg-white/[0.02]">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <h2 className="font-display text-3xl text-white sm:text-4xl">How it works</h2>
          <ol className="mt-8 grid gap-6 sm:grid-cols-3">
            {[
              {
                icon: <IconMail size={22} />,
                title: "Buy it here",
                body: "Your voucher lands in your inbox straight away, as a code and a scannable QR.",
              },
              {
                icon: <IconQrcode size={22} />,
                title: "Scan for your cards",
                body: "Hold the QR up to any HeadPinz kiosk and it prints your game cards, credit already on them.",
              },
              {
                icon: <IconCalendarEvent size={22} />,
                title: `Play ${attraction?.shortName.toLowerCase() ?? "your session"}`,
                body: "Pick a time online whenever you like — the sessions sit on your voucher until you do.",
              },
            ].map((step, i) => (
              <li key={step.title} className="relative rounded-2xl border border-white/10 p-6">
                <span
                  className="absolute -top-3 left-6 flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold"
                  style={{ background: accent, color: "#00041b" }}
                >
                  {i + 1}
                </span>
                <span style={{ color: accent }}>{step.icon}</span>
                <h3 className="mt-3 font-bold text-white">{step.title}</h3>
                <p className="mt-1.5 text-sm text-white/60">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Gallery ──────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-4 py-16">
        <div className="grid gap-4 sm:grid-cols-2">
          {deal.media.gallery.map((photo) => (
            <div key={photo.url} className="relative aspect-[4/3] overflow-hidden rounded-2xl">
              <Image
                src={photo.url}
                alt={photo.alt}
                fill
                loading="lazy"
                sizes="(max-width: 640px) 100vw, 50vw"
                className="object-cover"
              />
            </div>
          ))}
        </div>
      </section>

      {/* ── Locations ────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-4 pb-16">
        <h2 className="font-display text-3xl text-white sm:text-4xl">Where to use it</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {deal.locations.map((key) => {
            const info = DEAL_LOCATION_INFO[key];
            return (
              <div key={key} className="rounded-2xl border border-white/12 bg-white/[0.04] p-6">
                <h3 className="text-lg font-bold text-white">{info.label}</h3>
                <p className="mt-1.5 text-sm text-white/60">{info.address}</p>
                <div className="mt-4 flex flex-wrap gap-4 text-sm">
                  <a
                    href={`https://maps.google.com/?q=${encodeURIComponent(info.address)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: accent }}
                  >
                    Directions →
                  </a>
                  <Link
                    href={key === "naples" ? "/naples/attractions" : "/fort-myers/attractions"}
                    className="text-white/55 hover:text-white"
                  >
                    Everything at this location →
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* FAQ — carries its own FAQPage JSON-LD. */}
      <SeoFaq title="Questions" items={deal.faqs} />

      {/* ── Fine print ───────────────────────────────────────────────── */}
      <section className="mx-auto max-w-4xl px-4 py-14">
        <h2 className="text-xs font-bold tracking-widest text-white/40 uppercase">The fine print</h2>
        <ul className="mt-4 space-y-2 text-sm text-white/50">
          <li>
            Valid for {deal.expiresMonths} months from purchase at the HeadPinz you select at
            checkout.
          </li>
          <li>
            Each item on the voucher is single-use, and they&apos;re redeemed independently — use one
            game card today and come back for the rest.
          </li>
          <li>
            {attraction?.shortName ?? "Sessions"} run as timed sessions and are subject to
            availability. Booking ahead is recommended.
          </li>
          <li>
            Prices shown exclude sales tax; your exact total appears before you enter card details.
          </li>
          <li>Limit {deal.maxPerBuyer} packs per person. Not redeemable for cash.</li>
        </ul>
        <p className="mt-6 text-sm text-white/40">
          Other deals on this pack&apos;s sibling:{" "}
          {DEAL_CATALOG.filter((d) => d.slug !== deal.slug).map((d) => (
            <Link key={d.slug} href={`/deals/${d.slug}`} className="underline hover:text-white/70">
              {d.name}
            </Link>
          ))}
        </p>
      </section>
    </div>
  );
}
