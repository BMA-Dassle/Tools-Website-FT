export function LocalBusinessJsonLd() {
  const schema = {
    "@context": "https://schema.org",
    "@type": ["AmusementPark", "SportsActivityLocation", "EntertainmentBusiness"],
    name: "FastTrax Entertainment",
    alternateName: ["FastTrax", "FastTrax Fort Myers", "FastTrax Racing"],
    description:
      "Florida's largest indoor go-kart racing destination featuring high-performance electric karts on multi-level tracks, 50+ arcade games, duckpin bowling, shuffleboard & Nemo's Trackside trackside dining. 63,000 sq ft of entertainment.",
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
    name: "Nemo's Trackside",
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

// ── HeadPinz Organization (parent of both locations) ─────────────────────────

export function HeadPinzOrganizationJsonLd() {
  const schema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": "https://headpinz.com/#organization",
    name: "HeadPinz",
    url: "https://headpinz.com",
    logo: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/logos/headpinz-logo-9aUwk9v1Z8LcHZP5chi50PnSbDWpSg.png",
    description:
      "Premier bowling, laser tag, gel blasters, arcade games and dining in Southwest Florida. Two locations — Fort Myers and Naples.",
    sameAs: [
      "https://www.facebook.com/headpinz",
      "https://www.instagram.com/headpinz",
    ],
    department: [
      { "@id": "https://headpinz.com/fort-myers/#localbusiness" },
      { "@id": "https://headpinz.com/naples/#localbusiness" },
    ],
  };
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

// ── HeadPinz Fort Myers LocalBusiness ────────────────────────────────────────

export function HeadPinzFortMyersJsonLd() {
  const schema = {
    "@context": "https://schema.org",
    "@type": ["BowlingAlley", "AmusementPark", "EntertainmentBusiness"],
    "@id": "https://headpinz.com/fort-myers/#localbusiness",
    name: "HeadPinz Fort Myers",
    alternateName: "HeadPinz Entertainment Center Fort Myers",
    description:
      "Fort Myers' premier entertainment destination — bowling lanes, hyperbowling, laser tag, gel blasters, arcade games, and full-service dining at Nemo's. Birthday parties, corporate events, and leagues.",
    url: "https://headpinz.com/fort-myers",
    telephone: "+1-239-302-2155",
    address: {
      "@type": "PostalAddress",
      streetAddress: "14513 Global Parkway",
      addressLocality: "Fort Myers",
      addressRegion: "FL",
      postalCode: "33913",
      addressCountry: "US",
    },
    geo: {
      "@type": "GeoCoordinates",
      latitude: 26.5449,
      longitude: -81.7951,
    },
    openingHoursSpecification: [
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"], opens: "11:00", closes: "00:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Friday", "Saturday"], opens: "11:00", closes: "02:00" },
    ],
    priceRange: "$$",
    currenciesAccepted: "USD",
    paymentAccepted: "Cash, Credit Card, Debit Card",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp",
    parentOrganization: { "@id": "https://headpinz.com/#organization" },
    amenityFeature: [
      { "@type": "LocationFeatureSpecification", name: "Bowling Lanes", value: true },
      { "@type": "LocationFeatureSpecification", name: "Hyperbowling", value: true },
      { "@type": "LocationFeatureSpecification", name: "Laser Tag Arena", value: true },
      { "@type": "LocationFeatureSpecification", name: "Gel Blasters", value: true },
      { "@type": "LocationFeatureSpecification", name: "Arcade Games", value: true },
      { "@type": "LocationFeatureSpecification", name: "Full Bar", value: true },
      { "@type": "LocationFeatureSpecification", name: "Restaurant (Nemo's)", value: true },
      { "@type": "LocationFeatureSpecification", name: "Birthday Parties", value: true },
      { "@type": "LocationFeatureSpecification", name: "Corporate Events", value: true },
      { "@type": "LocationFeatureSpecification", name: "VIP Lanes", value: true },
      { "@type": "LocationFeatureSpecification", name: "Free Parking", value: true },
      { "@type": "LocationFeatureSpecification", name: "Wheelchair Accessible", value: true },
    ],
  };
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

// ── HeadPinz Naples LocalBusiness ────────────────────────────────────────────

export function HeadPinzNaplesJsonLd() {
  const schema = {
    "@context": "https://schema.org",
    "@type": ["BowlingAlley", "AmusementPark", "EntertainmentBusiness"],
    "@id": "https://headpinz.com/naples/#localbusiness",
    name: "HeadPinz Naples",
    alternateName: "HeadPinz Entertainment Center Naples",
    description:
      "Naples' premier entertainment destination — bowling lanes, laser tag, gel blasters, arcade games, and full-service dining at Nemo's. Birthday parties, corporate events, and leagues.",
    url: "https://headpinz.com/naples",
    telephone: "+1-239-455-3755",
    address: {
      "@type": "PostalAddress",
      streetAddress: "8525 Radio Lane",
      addressLocality: "Naples",
      addressRegion: "FL",
      postalCode: "34104",
      addressCountry: "US",
    },
    geo: {
      "@type": "GeoCoordinates",
      latitude: 26.1786,
      longitude: -81.7536,
    },
    openingHoursSpecification: [
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"], opens: "11:00", closes: "00:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Friday", "Saturday"], opens: "11:00", closes: "02:00" },
    ],
    priceRange: "$$",
    currenciesAccepted: "USD",
    paymentAccepted: "Cash, Credit Card, Debit Card",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp",
    parentOrganization: { "@id": "https://headpinz.com/#organization" },
    amenityFeature: [
      { "@type": "LocationFeatureSpecification", name: "Bowling Lanes", value: true },
      { "@type": "LocationFeatureSpecification", name: "Laser Tag Arena", value: true },
      { "@type": "LocationFeatureSpecification", name: "Gel Blasters", value: true },
      { "@type": "LocationFeatureSpecification", name: "Arcade Games", value: true },
      { "@type": "LocationFeatureSpecification", name: "Full Bar", value: true },
      { "@type": "LocationFeatureSpecification", name: "Restaurant (Nemo's)", value: true },
      { "@type": "LocationFeatureSpecification", name: "Birthday Parties", value: true },
      { "@type": "LocationFeatureSpecification", name: "Corporate Events", value: true },
      { "@type": "LocationFeatureSpecification", name: "VIP Lanes", value: true },
      { "@type": "LocationFeatureSpecification", name: "Free Parking", value: true },
      { "@type": "LocationFeatureSpecification", name: "Wheelchair Accessible", value: true },
    ],
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
