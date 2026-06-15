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
}

// ── Event Registry ───────────────────────────────────────────────────────────

export const GROUP_EVENTS: Record<string, GroupEvent> = {
  "healthnet-2026": {
    slug: "healthnet-2026",
    companyName: "Healthcare Network",
    eventTitle: "Healthcare Network Team Day",
    eventDate: "2026-06-19",
    startTime: "09:00",
    endTime: "14:00",
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
    companyName: "FastTrax", // host venue — used in "complimentary for FastTrax guests" copy
    eventTitle: "Xmas in July",
    eventDate: "2026-07-30",
    startTime: "16:30", // 4:30 PM
    endTime: "17:30", // 5:30 PM
    allowedDomains: [], // unused in open mode
    accessMode: "open",
    eventKicker: "FastTrax", // small eyebrow above the title; "Xmas in July" is the brand
    publicBlock: "event-window", // only the 16:30–17:30 heats blocked for the public
    accentColor: "#E41C1D", // Christmas red (alt festive green: #1A7A3C)
    accentTextColor: "#ffffff",
    accentHoverColor: "#ff3b30", // lighter red on hover (white label stays readable)
    pandoraLocation: "headpinz", // same physical Fort Myers venue
    heroImage: "", // TODO(ops): "Xmas in July" hero/logo blob URL
    racingTier: "starter",
    includesLicense: true,
    minAge: 18,
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
