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
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday"],
        opens: "13:00",
        closes: "23:00",
      },
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: "Friday",
        opens: "13:00",
        closes: "00:00",
      },
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: "Saturday",
        opens: "11:00",
        closes: "00:00",
      },
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: "Sunday",
        opens: "11:00",
        closes: "23:00",
      },
    ],
    priceRange: "$$",
    currenciesAccepted: "USD",
    paymentAccepted: "Cash, Credit Card, Debit Card",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/logo/FT_logo.png",
    sameAs: ["https://www.facebook.com/FastTraxFM"],
    // Sister brand on the same Fort Myers campus (14513 Global Parkway).
    // Declaring HeadPinz as a relatedLink + the Organization's @id reference
    // helps Google merge the two as an entity pair rather than competing
    // duplicates. Adjacent address proximity is the SEO hook.
    relatedLink: ["https://headpinz.com", "https://headpinz.com/fort-myers"],
    hasOfferCatalog: {
      "@type": "OfferCatalog",
      name: "FastTrax Activities",
      itemListElement: [
        {
          "@type": "Offer",
          itemOffered: {
            "@type": "Service",
            name: "Adult Go-Kart Racing",
            description: "High-performance electric kart racing for ages 13+",
          },
          price: "20.99",
          priceCurrency: "USD",
        },
        {
          "@type": "Offer",
          itemOffered: {
            "@type": "Service",
            name: "Junior Go-Kart Racing",
            description: "Speed-controlled electric kart racing for ages 7-13",
          },
          price: "15.99",
          priceCurrency: "USD",
        },
        {
          "@type": "Offer",
          itemOffered: {
            "@type": "Service",
            name: "Mini Kart Racing",
            description: "Electric kart racing for ages 3-6",
          },
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
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday"],
        opens: "13:00",
        closes: "23:00",
      },
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: "Friday",
        opens: "13:00",
        closes: "00:00",
      },
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: "Saturday",
        opens: "11:00",
        closes: "00:00",
      },
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: "Sunday",
        opens: "11:00",
        closes: "23:00",
      },
    ],
    priceRange: "$$",
    menu: "https://fasttraxent.com/menu",
    acceptsReservations: "True",
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06481.webp",
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
    sameAs: ["https://www.facebook.com/headpinz", "https://www.instagram.com/headpinz"],
    department: [
      { "@id": "https://headpinz.com/fort-myers/#localbusiness" },
      { "@id": "https://headpinz.com/naples/#localbusiness" },
    ],
    // FastTrax shares the Fort Myers campus (14501 Global Parkway, the
    // adjacent building). Cross-link in schema mirrors the footer link and
    // establishes the entity pair for Google.
    relatedLink: ["https://fasttraxent.com"],
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
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"],
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
    priceRange: "$$",
    currenciesAccepted: "USD",
    paymentAccepted: "Cash, Credit Card, Debit Card",
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp",
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
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"],
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
    priceRange: "$$",
    currenciesAccepted: "USD",
    paymentAccepted: "Cash, Credit Card, Debit Card",
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp",
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

// ── Recurring weekly events (Trivia Tuesday, Midnight Madness, Mega Track) ──
//
// IMPORTANT: Google's Event rich results IGNORE schema.org `eventSchedule` /
// `Schedule` (byDay / repeatFrequency / scheduleTimezone). Google requires an
// explicit ISO-8601 `startDate` ON the Event — it's one of the three required
// fields (name, startDate, location), so an Event whose dates live only inside
// a Schedule reads as "missing startDate" and is ineligible. We therefore
// compute the NEXT occurrence at render time and emit a concrete
// startDate/endDate per recurring day. (A prior version relied on
// `eventSchedule` and was flagged in Search Console.)
//
// Because these render on statically-built pages, the pages set
// `export const revalidate` so the computed dates refresh instead of freezing
// at build time.

const SCHEMA_DAY_INDEX: Record<string, number> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

const EVENT_TZ = "America/New_York";

/** ET UTC offset (e.g. "-04:00" / "-05:00") for the calendar date anchored by `noonUtc`. */
function etUtcOffset(noonUtc: Date): string {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: EVENT_TZ,
    timeZoneName: "longOffset",
  })
    .formatToParts(noonUtc)
    .find((p) => p.type === "timeZoneName")?.value; // e.g. "GMT-04:00"
  const off = (name ?? "GMT-05:00").replace("GMT", "");
  return off === "" ? "+00:00" : off;
}

/** ISO-8601 timestamp (with ET offset) for the calendar date in `noonUtc` at wall-clock `time`. */
function etTimestamp(noonUtc: Date, time: string): string {
  const y = noonUtc.getUTCFullYear();
  const m = String(noonUtc.getUTCMonth() + 1).padStart(2, "0");
  const d = String(noonUtc.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}T${time}${etUtcOffset(noonUtc)}`;
}

/**
 * Next upcoming occurrence of `dayName` in ET, as ISO-8601 startDate/endDate.
 * Today counts as the occurrence when it matches — the weekly series always has
 * an upcoming instance and the page revalidates daily, rolling it forward. We
 * anchor at noon UTC so adding days never trips over a 2 AM DST boundary; the
 * real ET offset for each resulting date is applied by `etTimestamp`.
 */
function nextOccurrence(
  dayName: string,
  startTime: string,
  endTime: string,
): { startDate: string; endDate: string } {
  const todayParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EVENT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = Number(todayParts.find((p) => p.type === "year")!.value);
  const mo = Number(todayParts.find((p) => p.type === "month")!.value);
  const d = Number(todayParts.find((p) => p.type === "day")!.value);

  const start = new Date(Date.UTC(y, mo - 1, d, 12));
  const delta = (SCHEMA_DAY_INDEX[dayName] - start.getUTCDay() + 7) % 7;
  start.setUTCDate(start.getUTCDate() + delta);

  // Crosses midnight (e.g. 11:59 PM → 2 AM) → end lands on the next day.
  const end = new Date(start);
  if (endTime <= startTime) end.setUTCDate(end.getUTCDate() + 1);

  return {
    startDate: etTimestamp(start, startTime),
    endDate: etTimestamp(end, endTime),
  };
}

interface RecurringEventArgs {
  name: string;
  description: string;
  url: string;
  image: string;
  byDay: string | string[]; // "Monday" … "Sunday"
  startTime: string; // "HH:MM:SS" (ET)
  endTime: string; // "HH:MM:SS" (ET) — if ≤ startTime, the event ends the next day
  locationName: string;
  streetAddress: string;
  addressLocality: string;
  addressRegion: string;
  postalCode: string;
  organizerName: string;
  organizerUrl: string;
  /** Optional offer; omit for "varies / see venue" pricing. */
  price?: string;
}

/**
 * Google-valid Event JSON-LD for a weekly event. Emits one Event per recurring
 * day, each with a concrete next-occurrence startDate/endDate. Returns a single
 * object for one day, or an array (multiple Events) for several.
 */
function recurringEventSchema({
  name,
  description,
  url,
  image,
  byDay,
  startTime,
  endTime,
  locationName,
  streetAddress,
  addressLocality,
  addressRegion,
  postalCode,
  organizerName,
  organizerUrl,
  price,
}: RecurringEventArgs) {
  const days = Array.isArray(byDay) ? byDay : [byDay];
  const offers =
    price !== undefined
      ? {
          offers: {
            "@type": "Offer",
            price,
            priceCurrency: "USD",
            availability: "https://schema.org/InStock",
            url,
          },
        }
      : {};

  const events = days.map((dayName) => {
    const { startDate, endDate } = nextOccurrence(dayName, startTime, endTime);
    return {
      "@context": "https://schema.org",
      "@type": "Event",
      name,
      description,
      url,
      image: [image],
      startDate,
      endDate,
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      location: {
        "@type": "Place",
        name: locationName,
        address: {
          "@type": "PostalAddress",
          streetAddress,
          addressLocality,
          addressRegion,
          postalCode,
          addressCountry: "US",
        },
      },
      organizer: {
        "@type": "Organization",
        name: organizerName,
        url: organizerUrl,
      },
      ...offers,
    };
  });

  return events.length === 1 ? events[0] : events;
}

export function TriviaTuesdayJsonLd() {
  const schema = recurringEventSchema({
    name: "Trivia Tuesday at HeadPinz Fort Myers",
    description:
      "Weekly trivia night at HeadPinz Fort Myers. Free to play, food and drink specials at the bar, prizes for top teams.",
    url: "https://headpinz.com/fort-myers",
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp",
    byDay: "Tuesday",
    startTime: "19:00:00",
    endTime: "21:00:00",
    locationName: "HeadPinz Fort Myers",
    streetAddress: "14513 Global Parkway",
    addressLocality: "Fort Myers",
    addressRegion: "FL",
    postalCode: "33913",
    organizerName: "HeadPinz",
    organizerUrl: "https://headpinz.com",
    price: "0",
  });
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

// Midnight Madness runs at BOTH HeadPinz centers (Fort Myers + Naples) on the
// same nights. Schema.org Event entries with multi-location are awkward in
// rich results — Google prefers one Event per venue. So we expose a
// `location` prop and emit one Event per page (rendered on the matching
// /fort-myers and /naples landing pages).
type HeadPinzLocation = "fort-myers" | "naples";

const MIDNIGHT_MADNESS_VENUES: Record<
  HeadPinzLocation,
  {
    locationName: string;
    streetAddress: string;
    addressLocality: string;
    postalCode: string;
    url: string;
  }
> = {
  "fort-myers": {
    locationName: "HeadPinz Fort Myers",
    streetAddress: "14513 Global Parkway",
    addressLocality: "Fort Myers",
    postalCode: "33913",
    url: "https://headpinz.com/fort-myers",
  },
  naples: {
    locationName: "HeadPinz Naples",
    streetAddress: "8525 Radio Lane",
    addressLocality: "Naples",
    postalCode: "34104",
    url: "https://headpinz.com/naples",
  },
};

export function MidnightMadnessJsonLd({ location }: { location: HeadPinzLocation }) {
  const venue = MIDNIGHT_MADNESS_VENUES[location];
  const schema = recurringEventSchema({
    name: `Midnight Madness at ${venue.locationName}`,
    description: `Late-night unlimited bowling at ${venue.locationName} every Friday and Saturday from 11:59 PM to 2 AM. Cosmic lighting, music, full bar.`,
    url: venue.url,
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp",
    byDay: ["Friday", "Saturday"],
    startTime: "23:59:00",
    endTime: "02:00:00",
    locationName: venue.locationName,
    streetAddress: venue.streetAddress,
    addressLocality: venue.addressLocality,
    addressRegion: "FL",
    postalCode: venue.postalCode,
    organizerName: "HeadPinz",
    organizerUrl: "https://headpinz.com",
    // Price varies (regular vs. VIP lanes) — omit `price` so Google doesn't
    // print a misleading single number.
  });
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

export function MegaTrackTuesdayJsonLd() {
  const schema = recurringEventSchema({
    name: "Mega Track Tuesday at FastTrax",
    description:
      "Every Tuesday FastTrax pulls the barrier between Blue and Red tracks to create Florida's largest indoor racing circuit — the 2,108 ft Mega Track. All kart classes (Adult, Junior, Mini) race for a flat $20.99. First-time Junior racers excluded.",
    url: "https://fasttraxent.com/racing",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/hero/hero-racing.webp",
    byDay: "Tuesday",
    startTime: "13:00:00",
    endTime: "23:00:00",
    locationName: "FastTrax Entertainment",
    streetAddress: "14501 Global Parkway",
    addressLocality: "Fort Myers",
    addressRegion: "FL",
    postalCode: "33913",
    organizerName: "FastTrax Entertainment",
    organizerUrl: "https://fasttraxent.com",
    price: "20.99",
  });
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

// ── Article (BlogPosting) ────────────────────────────────────────────────────

export function ArticleJsonLd({
  url,
  headline,
  description,
  image,
  datePublished,
  dateModified,
  authorName,
  publisherName,
  publisherLogo,
}: {
  url: string;
  headline: string;
  description: string;
  image: string;
  datePublished: string;
  dateModified?: string;
  authorName: string;
  publisherName: string;
  publisherLogo: string;
}) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    url,
    headline,
    description,
    image: [image],
    datePublished,
    dateModified: dateModified ?? datePublished,
    author: { "@type": "Organization", name: authorName },
    publisher: {
      "@type": "Organization",
      name: publisherName,
      logo: { "@type": "ImageObject", url: publisherLogo },
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
