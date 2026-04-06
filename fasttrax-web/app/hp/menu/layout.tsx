import type { Metadata } from "next";
import HeadPinzNav from "@/components/headpinz/Nav";
import HeadPinzFooter from "@/components/headpinz/Footer";

export const metadata: Metadata = {
  title: "Nemo's Sports Bistro | Happy Hour, Free Wings & Full Menu | Fort Myers & Naples",
  description:
    "Nemo's Sports Bistro at HeadPinz — happy hour every day until 6PM with $0.99 wings, $10 flatbreads & $1-$2 off drinks. Free Wing Friday: 5 free wings 4-6PM. Full bar, pizza, burgers & more.",
  keywords: [
    "Nemo's Sports Bistro",
    "Nemo's Sports Bistro menu",
    "happy hour Fort Myers",
    "happy hour Naples FL",
    "best happy hour Fort Myers",
    "best happy hour Naples",
    "free wings Fort Myers",
    "free wing friday",
    "wings Fort Myers",
    "cheap wings Fort Myers",
    "sports bar Fort Myers",
    "sports bar Naples",
    "bar Fort Myers",
    "bar Naples FL",
    "restaurant Fort Myers",
    "restaurant Naples FL",
    "bowling alley food",
    "pizza Fort Myers",
    "burgers Fort Myers",
    "drink specials Fort Myers",
    "drink specials Naples",
    "HeadPinz food",
    "HeadPinz dining",
    "late night food Fort Myers",
  ],
  openGraph: {
    title: "Nemo's Sports Bistro | Happy Hour & Free Wing Friday",
    description:
      "Happy hour every day until 6PM — $0.99 wings, discounted drinks & apps. Free Wing Friday: 5 free wings with any purchase, 4-6PM. Fort Myers & Naples.",
    type: "website",
    url: "https://headpinz.com/menu",
  },
  alternates: {
    canonical: "https://headpinz.com/menu",
  },
};

const jsonLdSchemas = [
  {
    "@context": "https://schema.org",
    "@type": "Restaurant",
    name: "Nemo's Sports Bistro",
    description:
      "Sports bar and restaurant inside HeadPinz Entertainment. Happy hour every day until 6PM with $0.99 wings, discounted flatbreads, and $1-$2 off drinks. Free Wing Friday: 5 free wings with any purchase, 4-6PM.",
    url: "https://headpinz.com/menu",
    servesCuisine: ["American", "Pizza", "Wings", "Burgers"],
    priceRange: "$$",
    telephone: "+1-239-288-8385",
    address: [
      {
        "@type": "PostalAddress",
        streetAddress: "14513 Global Parkway",
        addressLocality: "Fort Myers",
        addressRegion: "FL",
        postalCode: "33913",
        addressCountry: "US",
      },
      {
        "@type": "PostalAddress",
        streetAddress: "8525 Radio Lane",
        addressLocality: "Naples",
        addressRegion: "FL",
        postalCode: "34104",
        addressCountry: "US",
      },
    ],
    openingHoursSpecification: [
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Sunday"],
        opens: "11:00",
        closes: "00:00",
      },
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Friday", "Saturday"],
        opens: "11:00",
        closes: "02:00",
      },
    ],
    hasMenu: {
      "@type": "Menu",
      url: "https://headpinz.com/menu",
      hasMenuSection: [
        { "@type": "MenuSection", name: "Wings" },
        { "@type": "MenuSection", name: "Pizza" },
        { "@type": "MenuSection", name: "Burgers" },
        { "@type": "MenuSection", name: "Shareables" },
        { "@type": "MenuSection", name: "Happy Hour Specials" },
      ],
    },
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/nemos-wings.png",
  },
  {
    "@context": "https://schema.org",
    "@type": "BarOrPub",
    name: "Nemo's Sports Bistro - Happy Hour",
    description:
      "Happy hour every day open to 6PM. $0.99 wings, $10 flatbreads, craft draft beers $1 off, house wine $2 off, rum buckets $2 off. Free Wing Friday: 5 free wings 4-6PM with any purchase.",
    url: "https://headpinz.com/menu#happy-hour",
    address: {
      "@type": "PostalAddress",
      streetAddress: "14513 Global Parkway",
      addressLocality: "Fort Myers",
      addressRegion: "FL",
      postalCode: "33913",
      addressCountry: "US",
    },
    priceRange: "$",
  },
  {
    "@context": "https://schema.org",
    "@type": "Event",
    name: "Free Wing Friday at Nemo's Sports Bistro",
    description:
      "Get 5 free wings with any food or beverage purchase every Friday 4-6PM at Nemo's Sports Bistro. HeadPinz Rewards membership required. Dine-in only.",
    url: "https://headpinz.com/menu#free-wing-friday",
    eventSchedule: {
      "@type": "Schedule",
      repeatFrequency: "P1W",
      byDay: "https://schema.org/Friday",
      startTime: "16:00",
      endTime: "18:00",
    },
    location: {
      "@type": "Place",
      name: "Nemo's Sports Bistro at HeadPinz",
      address: {
        "@type": "PostalAddress",
        streetAddress: "14513 Global Parkway",
        addressLocality: "Fort Myers",
        addressRegion: "FL",
        postalCode: "33913",
      },
    },
    isAccessibleForFree: true,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "5 free wings with any food or beverage purchase. HeadPinz Rewards required.",
    },
  },
];

export default function MenuLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {jsonLdSchemas.map((schema, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
        />
      ))}
      <HeadPinzNav />
      <div>{children}</div>
      <HeadPinzFooter />
    </>
  );
}
