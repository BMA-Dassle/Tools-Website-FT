export function LocalBusinessJsonLd() {
  const schema = {
    "@context": "https://schema.org",
    "@type": ["AmusementPark", "SportsActivityLocation", "EntertainmentBusiness"],
    name: "FastTrax Entertainment",
    alternateName: ["FastTrax", "FastTrax Fort Myers", "FastTrax Racing"],
    description:
      "Florida's largest indoor go-kart racing destination featuring high-performance electric karts on multi-level tracks, 50+ arcade games, duckpin bowling, shuffleboard & Nemo's Brickyard Bistro trackside dining. 63,000 sq ft of entertainment.",
    url: "https://fasttraxent.com",
    telephone: "+1-239-204-4227",
    address: {
      "@type": "PostalAddress",
      streetAddress: "14501 Global Parkway",
      addressLocality: "Fort Myers",
      addressRegion: "FL",
      postalCode: "33913",
      addressCountry: "US",
    },
    geo: {
      "@type": "GeoCoordinates",
      latitude: 26.5457,
      longitude: -81.7966,
    },
    openingHoursSpecification: [
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday"], opens: "15:00", closes: "23:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: "Friday", opens: "15:00", closes: "00:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: "Saturday", opens: "11:00", closes: "00:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: "Sunday", opens: "11:00", closes: "23:00" },
    ],
    priceRange: "$$",
    currenciesAccepted: "USD",
    paymentAccepted: "Cash, Credit Card, Debit Card",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/logo/FT_logo.png",
    sameAs: [
      "https://www.facebook.com/FastTraxFM",
    ],
    hasOfferCatalog: {
      "@type": "OfferCatalog",
      name: "FastTrax Activities",
      itemListElement: [
        {
          "@type": "Offer",
          itemOffered: { "@type": "Service", name: "Adult Go-Kart Racing", description: "High-performance electric kart racing for ages 13+" },
          price: "20.99",
          priceCurrency: "USD",
        },
        {
          "@type": "Offer",
          itemOffered: { "@type": "Service", name: "Junior Go-Kart Racing", description: "Speed-controlled electric kart racing for ages 7-13" },
          price: "15.99",
          priceCurrency: "USD",
        },
        {
          "@type": "Offer",
          itemOffered: { "@type": "Service", name: "Mini Kart Racing", description: "Electric kart racing for ages 3-6" },
          price: "9.99",
          priceCurrency: "USD",
        },
      ],
    },
    amenityFeature: [
      { "@type": "LocationFeatureSpecification", name: "Indoor Go-Kart Racing", value: true },
      { "@type": "LocationFeatureSpecification", name: "Multi-Level Track", value: true },
      { "@type": "LocationFeatureSpecification", name: "Arcade Games", value: true },
      { "@type": "LocationFeatureSpecification", name: "Duckpin Bowling", value: true },
      { "@type": "LocationFeatureSpecification", name: "Trackside Restaurant", value: true },
      { "@type": "LocationFeatureSpecification", name: "Shuffleboard", value: true },
      { "@type": "LocationFeatureSpecification", name: "Birthday Parties", value: true },
      { "@type": "LocationFeatureSpecification", name: "Corporate Events", value: true },
      { "@type": "LocationFeatureSpecification", name: "Free Parking", value: true },
      { "@type": "LocationFeatureSpecification", name: "Air Conditioned", value: true },
    ],
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

export function BreadcrumbJsonLd({ items }: { items: { name: string; url: string }[] }) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

export function RestaurantJsonLd() {
  const schema = {
    "@context": "https://schema.org",
    "@type": "Restaurant",
    name: "Nemo's Brickyard Bistro",
    description:
      "Authentic wood-fired brick oven pizza, craft cocktails, and trackside dining inside FastTrax Fort Myers. Watch live go-kart racing while you eat.",
    url: "https://fasttraxent.com/menu",
    telephone: "+1-239-204-4227",
    servesCuisine: ["Italian", "Pizza", "American"],
    address: {
      "@type": "PostalAddress",
      streetAddress: "14501 Global Parkway",
      addressLocality: "Fort Myers",
      addressRegion: "FL",
      postalCode: "33913",
      addressCountry: "US",
    },
    geo: {
      "@type": "GeoCoordinates",
      latitude: 26.5457,
      longitude: -81.7966,
    },
    openingHoursSpecification: [
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday"], opens: "15:00", closes: "23:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: "Friday", opens: "15:00", closes: "00:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: "Saturday", opens: "11:00", closes: "00:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: "Sunday", opens: "11:00", closes: "23:00" },
    ],
    priceRange: "$$",
    menu: "https://fasttraxent.com/menu",
    acceptsReservations: "True",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06481.webp",
    parentOrganization: {
      "@type": "Organization",
      name: "FastTrax Entertainment",
      url: "https://fasttraxent.com",
    },
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

export function FAQJsonLd({ faqs }: { faqs: { question: string; answer: string }[] }) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer,
      },
    })),
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}
