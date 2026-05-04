import type { Metadata } from "next";
import Link from "next/link";

/**
 * HeadPinz pricing page.
 *
 * Filling the SEO gap GSC surfaced: FastTrax /pricing pulled 208
 * organic clicks in the last 28 days, HeadPinz had no equivalent
 * page and got zero pricing-keyword traffic.
 *
 * Targets the bowling-pricing search cohort:
 *   - "bowling prices fort myers"
 *   - "bowling cost naples fl"
 *   - "headpinz bowling prices"
 *   - "bowling near me"   (long-tail signal via the "Find HeadPinz near you" section)
 *
 * Rate sources: bowling start price from the existing booking flow
 * (Mon-Thu before 6 PM / from $12.99/person). Attraction rates from
 * /hp/fort-myers/attractions data already published on the site.
 *
 * No dynamic logic — this is a static SEO landing page. The actual
 * booking flow lives at /hp/book/bowling and handles current rates.
 */

export const metadata: Metadata = {
  title: "Bowling Prices, Laser Tag & Attraction Rates – HeadPinz Fort Myers & Naples",
  description:
    "HeadPinz pricing: bowling lanes from $12.99/person, NEXUS laser tag $10/person, NEXUS gel blasters $12/person. VIP lanes with HyperBowling and NeoVerse included. Two Southwest Florida locations — book online.",
  keywords: [
    "HeadPinz prices",
    "bowling prices Fort Myers",
    "bowling prices Naples",
    "bowling cost Fort Myers",
    "bowling cost Naples FL",
    "laser tag prices Fort Myers",
    "laser tag prices Naples",
    "gel blaster prices",
    "VIP bowling lanes",
    "HyperBowling pricing",
    "bowling near me",
    "bowling rates Southwest Florida",
    "headpinz bowling rates",
    "cosmic bowling prices",
    "family bowling prices Fort Myers",
    "group bowling rates",
    "birthday bowling packages",
  ],
  openGraph: {
    title: "Bowling & Attraction Prices – HeadPinz Fort Myers & Naples",
    description:
      "Bowling from $12.99/person, laser tag $10, gel blasters $12. Two SWFL locations — book online.",
    type: "website",
    url: "https://headpinz.com/pricing",
  },
  alternates: {
    canonical: "https://headpinz.com/pricing",
  },
};

/* ------------------------------------------------------------------ */
/*  Schema.org JSON-LD — exposes the pricing as a Product/Offer list  */
/*  so Google can show rich snippets and answer "headpinz prices?"     */
/*  voice queries with structured rates.                               */
/* ------------------------------------------------------------------ */

const pricingSchema = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  name: "HeadPinz Pricing",
  description:
    "Bowling, laser tag, and gel blaster rates at HeadPinz Fort Myers and Naples.",
  itemListElement: [
    {
      "@type": "ListItem",
      position: 1,
      item: {
        "@type": "Service",
        name: "Premier Bowling",
        description:
          "State-of-the-art lanes with cosmic glow effects, full bar service, up to 6 bowlers per lane.",
        offers: {
          "@type": "Offer",
          price: "12.99",
          priceCurrency: "USD",
          description: "Per person, Mon–Thu before 6 PM. Shoes included.",
        },
      },
    },
    {
      "@type": "ListItem",
      position: 2,
      item: {
        "@type": "Service",
        name: "NEXUS Laser Tag",
        description:
          "Two-story glow-in-the-dark space-themed arena with team-based 15-minute missions.",
        offers: {
          "@type": "Offer",
          price: "10.00",
          priceCurrency: "USD",
          description: "Per person, per session.",
        },
      },
    },
    {
      "@type": "ListItem",
      position: 3,
      item: {
        "@type": "Service",
        name: "NEXUS Gel Blasters",
        description:
          "Glow arena gel blaster combat with haptic vests and eco-friendly Gellets.",
        offers: {
          "@type": "Offer",
          price: "12.00",
          priceCurrency: "USD",
          description: "Per person, per session.",
        },
      },
    },
    {
      "@type": "ListItem",
      position: 4,
      item: {
        "@type": "Service",
        name: "VIP Lanes (HyperBowling + NeoVerse)",
        description:
          "Private VIP suite with NeoVerse interactive LED video walls and HyperBowling LED target scoring. Premium bowling experience.",
        offers: {
          "@type": "Offer",
          priceCurrency: "USD",
          description:
            "Per-lane VIP pricing varies by day and time — see the booking flow for live availability.",
        },
      },
    },
  ],
};

/* ------------------------------------------------------------------ */

const navy = "#070827";
const coral = "#fd5b56";
const gold = "#FFD700";
const purple = "#9b51e0";

const cardBase = {
  backgroundColor: "rgba(7,8,39,0.5)",
  borderRadius: "8px",
  padding: "24px",
} as const;

const glow = (color: string) => `${color}88 0px 0px 30px`;

interface RateCard {
  name: string;
  price: string;
  priceLabel: string;
  description: string;
  accent: string;
  bookHref: string;
  bookLabel: string;
}

const rateCards: RateCard[] = [
  {
    name: "Premier Bowling",
    price: "From $12.99",
    priceLabel: "per person",
    description:
      "State-of-the-art lanes, cosmic glow effects, full bar service. Mon–Thu before 6 PM rate. Shoes included on every booking.",
    accent: coral,
    bookHref: "/book/bowling",
    bookLabel: "Reserve Lanes",
  },
  {
    name: "NEXUS Laser Tag",
    price: "$10",
    priceLabel: "per person",
    description:
      "Two-story glow arena with immersive, objective-based 15-minute team missions. Fort Myers exclusive.",
    accent: "#E41C1D",
    bookHref: "/book/laser-tag",
    bookLabel: "Book Laser Tag",
  },
  {
    name: "NEXUS Gel Blasters",
    price: "$12",
    priceLabel: "per person",
    description:
      "Haptic-vest gel blaster combat with eco-friendly Gellets that evaporate on impact. Real-time scoring + power-ups.",
    accent: purple,
    bookHref: "/book/gel-blaster",
    bookLabel: "Book Gel Blasters",
  },
  {
    name: "VIP Lanes",
    price: "Premium",
    priceLabel: "per lane",
    description:
      "Includes HyperBowling LED-target scoring + NeoVerse interactive video walls. Private lounge seating, complimentary chips & salsa. See the booking flow for live VIP availability and pricing.",
    accent: gold,
    bookHref: "/book/bowling",
    bookLabel: "Book VIP",
  },
];

export default function HeadPinzPricingPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(pricingSchema) }}
      />

      {/* ── Hero ────────────────────────────────────────────────────── */}
      <section
        style={{
          backgroundColor: navy,
          padding: "clamp(80px, 14vw, 160px) clamp(16px, 4vw, 32px) clamp(40px, 8vw, 80px)",
          textAlign: "center",
        }}
      >
        <div className="max-w-5xl mx-auto">
          <h1
            className="font-heading font-black uppercase text-white"
            style={{
              fontSize: "clamp(36px, 9vw, 80px)",
              lineHeight: 1,
              letterSpacing: "3px",
              marginBottom: "24px",
              textShadow: glow(coral),
            }}
          >
            HeadPinz Pricing
          </h1>
          <p
            className="font-body mx-auto"
            style={{
              maxWidth: "720px",
              fontSize: "clamp(16px, 2vw, 20px)",
              color: "rgba(255,255,255,0.85)",
              lineHeight: 1.6,
            }}
          >
            Bowling rates, laser tag, gel blasters, and VIP lane experiences across our two Southwest Florida locations — Fort Myers and Naples. Book online for the best rates and guaranteed availability.
          </p>
        </div>
      </section>

      {/* ── Rate cards ──────────────────────────────────────────────── */}
      <section
        style={{
          backgroundColor: navy,
          padding: "clamp(40px, 6vw, 60px) clamp(16px, 4vw, 32px) clamp(60px, 10vw, 100px)",
        }}
      >
        <div className="max-w-7xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {rateCards.map((c) => (
              <div
                key={c.name}
                style={{
                  ...cardBase,
                  border: `1.78px dashed ${c.accent}`,
                }}
                className="flex flex-col"
              >
                <h2
                  className="font-heading uppercase mb-3"
                  style={{ color: c.accent, fontSize: "26px", letterSpacing: "1.2px" }}
                >
                  {c.name}
                </h2>
                <p
                  className="font-heading text-white uppercase"
                  style={{ fontSize: "36px", letterSpacing: "1.5px", marginBottom: "4px" }}
                >
                  {c.price}
                </p>
                <p
                  className="font-body uppercase"
                  style={{
                    color: "rgba(255,255,255,0.55)",
                    fontSize: "13px",
                    letterSpacing: "1.5px",
                    marginBottom: "16px",
                  }}
                >
                  {c.priceLabel}
                </p>
                <p
                  className="font-body flex-1"
                  style={{
                    color: "rgba(255,255,255,0.78)",
                    fontSize: "16px",
                    lineHeight: 1.55,
                    marginBottom: "20px",
                  }}
                >
                  {c.description}
                </p>
                <Link
                  href={c.bookHref}
                  className="block text-center font-body font-semibold uppercase text-white transition-all hover:scale-105 mt-auto"
                  style={{
                    backgroundColor: c.accent,
                    borderRadius: "555px",
                    padding: "14px 24px",
                    fontSize: "13px",
                    letterSpacing: "1.5px",
                  }}
                >
                  {c.bookLabel}
                </Link>
              </div>
            ))}
          </div>

          <p
            className="font-body italic mx-auto mt-10"
            style={{
              maxWidth: "780px",
              color: "rgba(255,255,255,0.6)",
              fontSize: "14px",
              lineHeight: 1.6,
              textAlign: "center",
            }}
          >
            Disclaimer: rates above reflect base per-person and per-lane pricing. Day-of-week, time-of-day, group size, and package selections may adjust the final price. Live availability and the most current rates are shown in each booking flow. Prices subject to change without notice.
          </p>
        </div>
      </section>

      {/* ── Find HeadPinz near you ──────────────────────────────────── */}
      <section
        style={{
          backgroundColor: "rgba(7,8,39,0.92)",
          padding: "clamp(60px, 9vw, 100px) clamp(16px, 4vw, 32px)",
        }}
      >
        <div className="max-w-5xl mx-auto text-center">
          <h2
            className="font-heading font-black uppercase text-white"
            style={{
              fontSize: "clamp(28px, 6vw, 56px)",
              lineHeight: 1,
              letterSpacing: "2px",
              marginBottom: "16px",
              textShadow: glow(coral),
            }}
          >
            Find HeadPinz near you
          </h2>
          <p
            className="font-body mx-auto"
            style={{
              maxWidth: "720px",
              fontSize: "16px",
              color: "rgba(255,255,255,0.78)",
              lineHeight: 1.6,
              marginBottom: "32px",
            }}
          >
            Two Southwest Florida bowling and entertainment centers. Whether you&apos;re searching &ldquo;bowling near me&rdquo; from Fort Myers, Naples, Cape Coral, Bonita Springs, Estero, or Marco Island — one of our locations is a short drive away.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <Link
              href="/fort-myers"
              className="block text-left transition-all hover:scale-[1.02]"
              style={{
                ...cardBase,
                border: `1.78px solid ${coral}55`,
                textDecoration: "none",
              }}
            >
              <h3
                className="font-heading uppercase"
                style={{ color: coral, fontSize: "22px", letterSpacing: "1.2px", marginBottom: "8px" }}
              >
                HeadPinz Fort Myers
              </h3>
              <p className="font-body" style={{ color: "rgba(255,255,255,0.85)", fontSize: "15px", lineHeight: 1.5, marginBottom: "10px" }}>
                14513 Global Pkwy, Fort Myers, FL 33913
              </p>
              <p className="font-body" style={{ color: "rgba(255,255,255,0.6)", fontSize: "13px", lineHeight: 1.5 }}>
                24 lanes · NEXUS Laser Tag · Gel Blasters · Old Time Pinboyz Lanes · Nemo&apos;s
              </p>
            </Link>
            <Link
              href="/naples"
              className="block text-left transition-all hover:scale-[1.02]"
              style={{
                ...cardBase,
                border: `1.78px solid ${coral}55`,
                textDecoration: "none",
              }}
            >
              <h3
                className="font-heading uppercase"
                style={{ color: coral, fontSize: "22px", letterSpacing: "1.2px", marginBottom: "8px" }}
              >
                HeadPinz Naples
              </h3>
              <p className="font-body" style={{ color: "rgba(255,255,255,0.85)", fontSize: "15px", lineHeight: 1.5, marginBottom: "10px" }}>
                8525 Radio Ln, Naples, FL 34104
              </p>
              <p className="font-body" style={{ color: "rgba(255,255,255,0.6)", fontSize: "13px", lineHeight: 1.5 }}>
                16 lanes · Gel Blasters · VIP HyperBowling + NeoVerse · Nemo&apos;s
              </p>
            </Link>
          </div>
        </div>
      </section>

      {/* ── Frequently asked ────────────────────────────────────────── */}
      <section
        style={{
          backgroundColor: navy,
          padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)",
        }}
      >
        <div className="max-w-3xl mx-auto">
          <h2
            className="font-heading font-black uppercase text-white text-center"
            style={{
              fontSize: "clamp(28px, 6vw, 48px)",
              lineHeight: 1,
              letterSpacing: "2px",
              marginBottom: "32px",
              textShadow: glow(coral),
            }}
          >
            Pricing FAQ
          </h2>
          <div className="space-y-5">
            {[
              {
                q: "Is bowling shoe rental included?",
                a: "Yes — every bowling booking includes shoes for all bowlers in your party. No separate rental fee.",
              },
              {
                q: "How much is bowling per person at HeadPinz?",
                a: "Premier Lane bowling starts at $12.99 per person, Mon–Thu before 6 PM. Peak times and weekends are slightly higher; the booking flow shows your exact rate after you pick a date and time.",
              },
              {
                q: "How does VIP lane pricing work?",
                a: "VIP lanes are priced per lane (not per person), and they include HyperBowling LED target scoring and the NeoVerse interactive video wall. Pricing depends on the day and time slot — see live VIP availability in the bowling booking flow.",
              },
              {
                q: "How much is NEXUS laser tag and gel blasters?",
                a: "NEXUS laser tag is $10 per person per session (Fort Myers only). NEXUS gel blasters are $12 per person per session, available at both Fort Myers and Naples.",
              },
              {
                q: "Are there bowling discounts or specials?",
                a: "Mon–Thu before 6 PM is our lowest published rate. We also run Kids Bowl Free in summer, leagues, and birthday-party / group-event packages. Check our locations or join our rewards program for current offers.",
              },
            ].map((f) => (
              <div
                key={f.q}
                style={{
                  ...cardBase,
                  border: "1.78px solid rgba(255,255,255,0.10)",
                  padding: "20px",
                }}
              >
                <h3
                  className="font-body font-bold mb-2"
                  style={{ color: coral, fontSize: "17px", letterSpacing: "0.3px" }}
                >
                  {f.q}
                </h3>
                <p className="font-body" style={{ color: "rgba(255,255,255,0.78)", fontSize: "15px", lineHeight: 1.6 }}>
                  {f.a}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
