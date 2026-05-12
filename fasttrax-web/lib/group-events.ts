/**
 * Group Event Config Registry
 *
 * Static configuration for company buyout / private group events.
 * Adding a new event = adding an entry to GROUP_EVENTS below.
 * No code changes required.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface GroupEventRaceTrack {
  track: string;        // "Red" | "Blue"
  productId: string;    // $0 BMI product ID
  pageId: string;       // BMI page ID
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
  label: string;               // "Food Buffet"
  location: string;            // "HeadPinz"
  startTime: string;           // "11:30" (24h)
  endTime: string;             // "12:30" (24h)
}

export interface GroupEvent {
  slug: string;
  companyName: string;
  eventTitle: string;
  eventDate: string;           // "2026-06-19"
  startTime: string;           // "09:00"
  endTime: string;             // "13:00"
  allowedDomains: string[];    // ["healthnet.com", "headpinz.com"]
  heroImage?: string;
  accentColor: string;         // hex, used for buttons/accents
  attractions: GroupEventAttraction[];
  racingTier: "starter";       // all group events = starter only
  includesLicense: boolean;
  maxGuests?: number;
  /** Minimum age to RSVP (e.g. 18 for corporate events). Validated at name step. */
  minAge?: number;
  /** Meal window — if set, heats overlapping this window show a warning */
  mealWindow?: GroupEventMealWindow;
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
    heroImage: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/group-events/healthcare-network-logo.png",
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
        image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/blue-track-iYCkFVDkIiDVwNQaiABoZsqzj2Fjnj.jpg",
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
        image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/gel-blaster-new-QKNNgvKt7Jah4ZJNO7JLa3vIp2t6EK.jpg",
        maxPerGuest: 1,
        bmiProductId: "47122817",
        bmiPageId: "47123025",
      },
      {
        slug: "laser-tag",
        type: "reservation",
        label: "Nexus Laser Tag",
        description: "Multi-level laser tag with haptic vests",
        image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/laser-tag-new-2iiYIDNemOIB9NaaGjsY0ujWAGiV5x.jpg",
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
        image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp",
      },
      {
        slug: "electric-shuffle",
        type: "freeflow",
        label: "Electric Shuffle",
        description: "AR-powered shuffleboard tables",
        image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/shuffly-tables-Nlc3Y5cuNU6C5WrFIhGvHN42pYMfVK.jpg",
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
        image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-arcade.webp",
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

/** Returns the group event (facility buyout) on a given date, or null.
 *  Used by the public booking flow to block dates reserved for private events. */
export function getGroupEventForDate(date: string): GroupEvent | null {
  return Object.values(GROUP_EVENTS).find((e) => e.eventDate === date) ?? null;
}
