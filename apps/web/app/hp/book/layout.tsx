import type { Metadata } from "next";
import { HEADPINZ_OG, HEADPINZ_OG_IMAGE } from "@/lib/seo";

/**
 * /hp/book — HeadPinz booking hub. URL surfaces as `/book` on
 * headpinz.com via middleware rewrite, but the file lives under /hp/book
 * so the underlying page can share components with the FastTrax book hub.
 *
 * Why a dedicated layout here:
 * - The inner page.tsx is "use client" (it reads cart + booking-location
 *   stores), so it can't `export const metadata`. This layout supplies it.
 * - We want the page's `<title>` to be brand-led ("Book HeadPinz Online")
 *   so Google's sitelink for this URL doesn't fall back to the generic
 *   root brand title.
 * - The ItemList JSON-LD below names every bookable attraction and links
 *   to its `/hp/book/...` sub-URL — this is the strongest signal we can
 *   give Google to surface those URLs as sub-sitelinks (or at least to
 *   replace the generic "Book Now" sitelink description with attraction
 *   names). Sitelinks are always Google's call — but a SiteNavigationElement
 *   + matching internal nav text is the standard influence pattern.
 *
 * Note: the metadata only applies to this segment + below. Sub-routes
 * (bowling, kids-bowl-free, [attraction]) can still override.
 */

export const metadata: Metadata = {
  title: "Book HeadPinz Online | Bowling, Laser Tag, Gel Blasters & More",
  description:
    "Reserve bowling lanes, NEXUS laser tag, gel blasters, shuffleboard or arcade time at HeadPinz Fort Myers or Naples. Easy online booking — pick a date, lock in your group, done.",
  openGraph: {
    title: "Book HeadPinz Online — Pick Your Experience",
    description:
      "Reserve bowling lanes, NEXUS laser tag, gel blasters & more at HeadPinz Fort Myers and Naples. Online booking with instant confirmation.",
    type: "website",
    url: "https://headpinz.com/book",
    siteName: "HeadPinz",
    images: [...HEADPINZ_OG],
  },
  twitter: {
    card: "summary_large_image",
    title: "Book HeadPinz Online — Pick Your Experience",
    description: "Reserve bowling, laser tag, gel blasters & more at HeadPinz Fort Myers & Naples.",
    images: [HEADPINZ_OG_IMAGE],
  },
  alternates: { canonical: "https://headpinz.com/book" },
};

/**
 * Schema.org ItemList of bookable experiences. Each item is a distinct
 * /hp/book/* URL so Google can surface them as Book-Now sub-sitelinks.
 * Order matches the on-page card order in page.tsx.
 */
const bookingItemList = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  name: "Book HeadPinz Online",
  description:
    "Bookable experiences at HeadPinz Fort Myers and Naples — bowling, laser tag, gel blasters, shuffleboard and arcade.",
  itemListOrder: "https://schema.org/ItemListOrderAscending",
  numberOfItems: 5,
  itemListElement: [
    {
      "@type": "ListItem",
      position: 1,
      name: "Book Bowling",
      url: "https://headpinz.com/book/bowling",
      item: {
        "@type": "Service",
        name: "Bowling Reservations",
        description:
          "Reserve 24 or 32 lanes at HeadPinz Fort Myers or Naples. Shoes included. 1.5-hour sessions, up to 6 per lane.",
        provider: { "@type": "Organization", name: "HeadPinz" },
        url: "https://headpinz.com/book/bowling",
      },
    },
    {
      "@type": "ListItem",
      position: 2,
      name: "Book Laser Tag",
      url: "https://headpinz.com/book/laser-tag",
      item: {
        "@type": "Service",
        name: "NEXUS Laser Tag",
        description: "Two-story glow arena with haptic vests. 15-minute objective-based missions.",
        provider: { "@type": "Organization", name: "HeadPinz" },
        url: "https://headpinz.com/book/laser-tag",
      },
    },
    {
      "@type": "ListItem",
      position: 3,
      name: "Book Gel Blasters",
      url: "https://headpinz.com/book/gel-blaster",
      item: {
        "@type": "Service",
        name: "NEXUS Gel Blasters",
        description: "Zero-mess combat with eco-friendly gellets and haptic vests.",
        provider: { "@type": "Organization", name: "HeadPinz" },
        url: "https://headpinz.com/book/gel-blaster",
      },
    },
    {
      "@type": "ListItem",
      position: 4,
      name: "Book Shuffleboard",
      url: "https://headpinz.com/book/shuffly",
      item: {
        "@type": "Service",
        name: "Shuffleboard Lanes",
        description: "Hour-long shuffleboard reservations.",
        provider: { "@type": "Organization", name: "HeadPinz" },
        url: "https://headpinz.com/book/shuffly",
      },
    },
    {
      "@type": "ListItem",
      position: 5,
      name: "Kids Bowl Free",
      url: "https://headpinz.com/book/kids-bowl-free",
      item: {
        "@type": "Service",
        name: "Kids Bowl Free Summer Program",
        description: "Free summer bowling for registered kids. Two games per day, all summer long.",
        provider: { "@type": "Organization", name: "HeadPinz" },
        url: "https://headpinz.com/book/kids-bowl-free",
      },
    },
  ],
};

export default function HeadPinzBookLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(bookingItemList) }}
      />
      {children}
    </>
  );
}
