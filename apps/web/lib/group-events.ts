/**
 * Group Event Config Registry
 *
 * Static configuration for company buyout / private group events.
 * Adding a new event = adding an entry to GROUP_EVENTS below.
 * No code changes required.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface GroupEventRaceTrack {
  track: string; // "Red" | "Blue"
  productId: string; // $0 BMI product ID
  pageId: string; // BMI page ID
}

export interface GroupEventAttraction {
  slug: string;
  type: "reservation" | "freeflow";
  label: string;
  description: string;
  /** Card image URL — reservation activities get a full image card,
   *  freeflow activities get a small thumbnail. */
  image?: string;
  /** Max bookings per email for this attraction (default: unlimited) */
  maxPerGuest?: number;
  /** Per-track BMI products (racing) */
  bmiTracks?: GroupEventRaceTrack[];
  /** Single BMI product (gel blaster, laser tag) */
  bmiProductId?: string;
  bmiPageId?: string;
}

export interface GroupEventMealWindow {
  label: string; // "Food Buffet"
  location: string; // "HeadPinz"
  startTime: string; // "11:30" (24h)
  endTime: string; // "12:30" (24h)
}

/** Background hero video for the landing page. Muted/looping/autoplay; the poster
 *  paints instantly and is also the still fallback for reduced-motion / Save-Data. */
export interface GroupEventHeroVideo {
  mp4_1080: string; // desktop source
  mp4_720: string; // mobile source (lighter)
  poster: string; // still frame — instant paint + reduced-motion fallback
}

/** A gallery photo (WebP preferred, JPEG fallback). */
export interface GroupEventGalleryPhoto {
  webp: string;
  jpg: string;
  alt: string;
}

/** One choosable location for a multi-venue event (e.g. Naples vs Fort Myers).
 *  `racing` gates the go-kart booking — only Fort Myers has FastTrax, so Naples
 *  is RSVP-only. `bookingSlug` is the GROUP_EVENTS key whose funnel this location
 *  enters after sign-up (lets each venue carry its own date / BMI products). */
export interface GroupEventLocation {
  key: string; // "fort-myers" | "naples"
  label: string; // "Fort Myers"
  venue: string; // "HeadPinz & FastTrax"
  date: string; // "2026-07-30"
  address: string; // "14513 Global Pkwy, Fort Myers, FL 33913"
  racing: boolean; // FM true, Naples false
}

/** Marketing landing-page content. When present, `/event/<slug>` renders a full
 *  hero + experience + gallery above the booking funnel (on the entry step only).
 *  Absent → the event keeps the plain compact-header funnel (e.g. corporate buyouts). */
export interface GroupEventLanding {
  heroVideo?: GroupEventHeroVideo;
  headline?: string; // big hero headline (default: eventTitle)
  tagline?: string; // hero subline
  freeBadge?: string; // e.g. "100% FREE"
  ctaLabel?: string; // hero CTA button (default: "Sign Up")
  intro?: string; // experience-section lead paragraph
  eventTime?: string; // friendly overall window, e.g. "4:00 – 7:00 PM"
  highlights?: { title: string; text: string }[];
  /** "What's included" perk list (e.g. drink tickets, buffet, bowling, race). */
  included?: { item: string; note?: string }[];
  /** Choosable venues. When present, the page shows a location picker before the
   *  sign-up form; the chosen location drives date/address and racing availability. */
  locations?: GroupEventLocation[];
  /** Secondary feature video shown mid-page (e.g. real go-kart racing footage).
   *  Single source + poster; honors the same reduced-motion / Save-Data opt-out. */
  featureVideo?: { src: string; poster: string; heading?: string; text?: string };
  gallery?: GroupEventGalleryPhoto[];
  /** Festive section background image URLs (rendered low-opacity behind a dark overlay). */
  backgrounds?: { included?: string; signup?: string; form?: string };
  /** Show a live countdown to each location's date on the chooser cards. */
  countdown?: boolean;
  finePrint?: string; // small print under the sign-up form
}

export interface GroupEvent {
  slug: string;
  companyName: string;
  eventTitle: string;
  eventDate: string; // "2026-06-19"
  startTime: string; // "09:00"
  endTime: string; // "13:00"
  allowedDomains: string[]; // ["healthnet.com", "headpinz.com"]
  heroImage?: string;
  accentColor: string; // hex, used for buttons/accents
  attractions: GroupEventAttraction[];
  racingTier: "starter"; // all group events = starter only
  includesLicense: boolean;
  maxGuests?: number;
  /** Minimum age to RSVP (e.g. 18 for corporate events). Validated at name step. */
  minAge?: number;
  /** Meal window — if set, heats overlapping this window show a warning */
  mealWindow?: GroupEventMealWindow;
  /** Access control. "domain" (default) = email domain must be in allowedDomains
   *  (corporate buyout). "open" = any valid email (public event, no domain check). */
  accessMode?: "domain" | "open";
  /** Foreground color on accent buttons (contrast against accentColor).
   *  Default "#000418" (dark on cyan); use "#ffffff" for darker accents like FastTrax red. */
  accentTextColor?: string;
  /** Accent button hover background. Default "#ffffff" (works with dark accentTextColor).
   *  Darker-accent brands with white text must set this to keep the label readable on hover. */
  accentHoverColor?: string;
  /** Eyebrow label above the event title. Default "Private Event". */
  eventKicker?: string;
  /** Pandora onboarding/waiver location key. Default "headpinz". */
  pandoraLocation?: string;
  /** How this event restricts the PUBLIC race calendar on its date.
   *  "full-day" (default) = whole date greyed/unclickable (facility buyout).
   *  "event-window" = date stays bookable; only heats overlapping [startTime,endTime] are disabled. */
  publicBlock?: "full-day" | "event-window";
  /** Public booking reopens at this ET wall-clock time on `eventDate` (e.g. "14:30").
   *  Used for a morning-only buyout that hands the facility back to the public partway
   *  through the day: every public slot/heat/hour BEFORE this time is disabled, and
   *  everything at-or-after stays bookable. Applies uniformly across racing, attractions,
   *  and bowling in the v2 booking flow. Independent of startTime/endTime (which describe
   *  the private event itself), so this is the explicit turnover-buffer reopen time.
   *  Surfaced via getPublicReopenTimeForDate / getPublicReopenMinutes. */
  publicReopensAt?: string;
  /** Marketing landing content. When set, the event page renders a full hero +
   *  experience + gallery on the entry step (public promos). Omit for plain funnels. */
  landing?: GroupEventLanding;
}

// ── Event Registry ───────────────────────────────────────────────────────────

/** Vercel Blob base — keeps the xmas-in-july asset URLs readable. */
const BLOB_BASE = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";
const blob = (path: string) => `${BLOB_BASE}/events/xmas-in-july/${path}`;

export const GROUP_EVENTS: Record<string, GroupEvent> = {
  "healthnet-2026": {
    slug: "healthnet-2026",
    companyName: "Healthcare Network",
    eventTitle: "Healthcare Network Team Day",
    eventDate: "2026-06-19",
    startTime: "09:00",
    endTime: "14:00",
    // Morning-only buyout: the facility returns to the public at 2:30 PM (2 PM
    // event end + 30-min turnover). Public booking before 2:30 is disabled across
    // racing/attractions/bowling; 2:30 PM onward stays bookable. (v1 still treats
    // this date as a full-day buyout via getGroupEventForDate — only v2 reopens.)
    publicReopensAt: "14:30",
    allowedDomains: ["healthcareswfl.org", "headpinz.com", "fasttraxent.com"],
    heroImage:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/group-events/healthcare-network-logo.png",
    accentColor: "#00E2E5",
    racingTier: "starter",
    includesLicense: true,
    minAge: 18,
    mealWindow: {
      label: "Food Buffet",
      location: "HeadPinz",
      startTime: "11:00",
      endTime: "12:30",
    },
    attractions: [
      // ── Reservation-based (pick a time slot) ──
      {
        slug: "racing",
        type: "reservation",
        label: "Go-Kart Racing",
        description: "High-speed electric karts on Red or Blue track",
        image:
          "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/blue-track-iYCkFVDkIiDVwNQaiABoZsqzj2Fjnj.jpg",
        maxPerGuest: 1,
        bmiTracks: [
          { track: "Red", productId: "47122743", pageId: "47123025" },
          { track: "Blue", productId: "47122690", pageId: "47123025" },
        ],
      },
      {
        slug: "gel-blaster",
        type: "reservation",
        label: "Nexus Gel Blaster",
        description: "15-min gel blaster battles in a glowing arena",
        image:
          "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/gel-blaster-new-QKNNgvKt7Jah4ZJNO7JLa3vIp2t6EK.jpg",
        maxPerGuest: 1,
        bmiProductId: "47122817",
        bmiPageId: "47123025",
      },
      {
        slug: "laser-tag",
        type: "reservation",
        label: "Nexus Laser Tag",
        description: "Multi-level laser tag with haptic vests",
        image:
          "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/laser-tag-new-2iiYIDNemOIB9NaaGjsY0ujWAGiV5x.jpg",
        maxPerGuest: 1,
        bmiProductId: "47122935",
        bmiPageId: "47123025",
      },
      // ── Free-flowing (guest list only) ──
      {
        slug: "bowling",
        type: "freeflow",
        label: "Bowling",
        description: "Classic & VIP bowling lanes",
        image:
          "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp",
      },
      {
        slug: "electric-shuffle",
        type: "freeflow",
        label: "Electric Shuffle",
        description: "AR-powered shuffleboard tables",
        image:
          "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/shuffly-tables-Nlc3Y5cuNU6C5WrFIhGvHN42pYMfVK.jpg",
      },
      {
        slug: "food",
        type: "freeflow",
        label: "Food & Drinks",
        description: "Buffet at HeadPinz · 11:30 AM – 12:30 PM",
      },
      {
        slug: "ping-pong",
        type: "freeflow",
        label: "Ping Pong",
        description: "Open ping pong tables",
      },
      {
        slug: "games",
        type: "freeflow",
        label: "Arcade Games",
        description: "Full arcade access",
        image:
          "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-arcade.webp",
      },
    ],
  },

  // ── Xmas in July (FastTrax public racing promo) ──────────────────────────────
  // Racing-only, $0, open to anyone (no domain gate), "Xmas in July" branded at the
  // FastTrax Fort Myers venue. Reserves only the 16:30–17:30 heats from the public
  // race calendar (event-window block), so the rest of that day stays publicly
  // bookable. Books against the booking-v2 $0 build products (page 49504534,
  // adult:starter, withLicense variant).
  "xmas-in-july": {
    slug: "xmas-in-july",
    companyName: "HeadPinz & FastTrax", // co-host brands
    eventTitle: "Christmas in July",
    // eventDate / startTime / endTime describe the FORT MYERS racing window
    // (4:30–5:30 PM on 7/30) — used by publicBlock to reserve those heats from the
    // public calendar. The overall 4–7 PM event + per-venue dates live in landing.
    eventDate: "2026-07-30",
    startTime: "16:30", // racing slot start (4:30 PM)
    endTime: "17:30", // racing slot end (5:30 PM)
    allowedDomains: [], // unused in open mode
    accessMode: "open",
    eventKicker: "You're Invited", // eyebrow above the title
    publicBlock: "event-window", // only the 16:30–17:30 FM heats blocked for the public
    accentColor: "#E41C1D", // Christmas red
    accentTextColor: "#ffffff",
    accentHoverColor: "#ff3b30", // lighter red on hover (white label stays readable)
    pandoraLocation: "headpinz", // Fort Myers physical venue (racing waiver)
    heroImage: "", // logo unused — landing.heroVideo drives the page hero
    racingTier: "starter",
    includesLicense: true,
    // ── Landing page (open RSVP — business-leader holiday open house) ──
    landing: {
      heroVideo: {
        mp4_1080:
          "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/events/xmas-in-july/hero-nologo-1080.mp4",
        mp4_720:
          "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/events/xmas-in-july/hero-nologo-720.mp4",
        poster:
          "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/events/xmas-in-july/hero-poster.jpg",
      },
      headline: "Christmas in July",
      tagline:
        "At HeadPinz & FastTrax, the best celebrations start with great people — and we'd love to celebrate with you. Join us for a festive evening built for local business leaders.",
      freeBadge: "You're Invited",
      ctaLabel: "RSVP",
      eventTime: "4:00 – 7:00 PM",
      intro:
        "Enjoy holiday bites, signature drinks, and an inside look at how HeadPinz & FastTrax can help you throw your best holiday party yet. Come see the space, meet the team, and feel the experience first-hand.",
      included: [
        { item: "2 Drink Tickets", note: "Per guest" },
        { item: "Holiday Buffet", note: "Festive bites" },
        { item: "Complimentary Bowling", note: "On the house" },
        { item: "1 Go-Kart Race", note: "Fort Myers · 4:30–5:30 PM" },
      ],
      locations: [
        {
          key: "fort-myers",
          label: "Fort Myers",
          venue: "HeadPinz & FastTrax Fort Myers",
          date: "2026-07-30",
          address: "14513 Global Pkwy, Fort Myers, FL 33913",
          racing: true,
        },
        {
          key: "naples",
          label: "Naples",
          venue: "HeadPinz Naples",
          date: "2026-07-23",
          address: "8525 Radio Ln, Naples, FL 34104",
          racing: false,
        },
      ],
      // Real FastTrax racing footage (the actual free activity). Reuses the
      // production FastTrax homepage hero video — already web-optimized.
      featureVideo: {
        src: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/hero/hero-video.mp4",
        poster:
          "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/hero/hero-racing.webp",
        heading: "Take a Lap, On Us",
        text: "High-speed electric karts on our pro-built indoor track — your complimentary race at the Fort Myers event (4:30–5:30 PM).",
      },
      gallery: [
        {
          webp: blob("gallery/01.webp"),
          jpg: blob("gallery/01.jpg"),
          alt: "High-speed electric go-kart racing at FastTrax",
        },
        {
          webp: blob("gallery/04.webp"),
          jpg: blob("gallery/04.jpg"),
          alt: "Neon bowling lanes at HeadPinz",
        },
        {
          webp: blob("gallery/02.webp"),
          jpg: blob("gallery/02.jpg"),
          alt: "Food and drinks for the whole group",
        },
        {
          webp: blob("gallery/03.webp"),
          jpg: blob("gallery/03.jpg"),
          alt: "Full bar and brick-oven pizza",
        },
        {
          webp: blob("gallery/06.webp"),
          jpg: blob("gallery/06.jpg"),
          alt: "Friends celebrating at HeadPinz",
        },
        {
          webp: blob("gallery/05.webp"),
          jpg: blob("gallery/05.jpg"),
          alt: "Groups enjoying a night out",
        },
      ],
      backgrounds: {
        included: blob("bg/snow.webp"),
        signup: blob("bg/gifts.webp"),
        form: blob("bg/bokeh.webp"),
      },
      countdown: true,
      finePrint:
        "Space is limited — RSVP to reserve your spot. Go-kart racing is offered at the Fort Myers event (4:30–5:30 PM); must be 18+ to race. Naples includes complimentary bowling.",
    },
    // no mealWindow; no freeflow attractions
    attractions: [
      {
        slug: "racing",
        type: "reservation",
        label: "Go-Kart Racing",
        description: "High-speed electric karts on Red or Blue track",
        image:
          "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/blue-track-iYCkFVDkIiDVwNQaiABoZsqzj2Fjnj.jpg",
        maxPerGuest: 1,
        // Booking-v2 $0 build products (page 49504534), adult:starter, withLicense variant
        bmiTracks: [
          { track: "Red", productId: "49503727", pageId: "49504534" },
          { track: "Blue", productId: "49504069", pageId: "49504534" },
        ],
      },
    ],
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getGroupEvent(slug: string): GroupEvent | null {
  return GROUP_EVENTS[slug] ?? null;
}

export function getReservationAttractions(event: GroupEvent): GroupEventAttraction[] {
  return event.attractions.filter((a) => a.type === "reservation");
}

export function getFreeflowAttractions(event: GroupEvent): GroupEventAttraction[] {
  return event.attractions.filter((a) => a.type === "freeflow");
}

/** Returns the full-day facility buyout on a given date, or null.
 *  Used by the public booking flow to grey out whole dates reserved for private
 *  events. Events with publicBlock: "event-window" are NOT returned here — they
 *  only reserve a time slice, surfaced via getRaceBlockWindowsForDate. */
export function getGroupEventForDate(date: string): GroupEvent | null {
  return (
    Object.values(GROUP_EVENTS).find(
      (e) => e.eventDate === date && (e.publicBlock ?? "full-day") === "full-day",
    ) ?? null
  );
}

/** Public-booking reopen time for a date (morning-only buyout), or null.
 *  When set, every public slot/heat/hour BEFORE `time` (ET wall-clock) on this date
 *  is disabled; at-or-after stays bookable. The date itself remains clickable — this
 *  is NOT a full-day block (so getGroupEventForDate is intentionally left alone, which
 *  keeps the conservative full-day behavior on v1; only the v2 pickers honor reopen). */
export function getPublicReopenTimeForDate(date: string): { time: string; label: string } | null {
  const e = Object.values(GROUP_EVENTS).find((e) => e.eventDate === date && !!e.publicReopensAt);
  return e ? { time: e.publicReopensAt!, label: e.eventTitle } : null;
}

/** Reopen time as ET minutes-of-day (e.g. "14:30" → 870), or null on dates with no
 *  morning-only buyout. Pickers compare a slot's ET minutes-of-day against this:
 *  slot is blocked when its start minutes-of-day < this value. */
export function getPublicReopenMinutes(date: string): number | null {
  const r = getPublicReopenTimeForDate(date);
  if (!r) return null;
  const [h, m] = r.time.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** A race time window reserved for an event on a given date. ISO local datetimes. */
export interface RaceBlockWindow {
  startIso: string; // "2026-07-25T16:30:00"
  stopIso: string; // "2026-07-25T17:30:00"
  label: string; // event title, for display
}

/** Reserved race windows on a date from "event-window" events (e.g. FastTrax
 *  16:30–17:30). The public heat pickers disable heats overlapping these windows
 *  while leaving the rest of the day bookable. Empty on dates with no such event. */
export function getRaceBlockWindowsForDate(date: string): RaceBlockWindow[] {
  return Object.values(GROUP_EVENTS)
    .filter((e) => e.eventDate === date && e.publicBlock === "event-window")
    .map((e) => ({
      startIso: `${e.eventDate}T${e.startTime}:00`,
      stopIso: `${e.eventDate}T${e.endTime}:00`,
      label: e.eventTitle,
    }));
}
