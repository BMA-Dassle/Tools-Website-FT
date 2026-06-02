"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { modalBackdropProps } from "@/lib/a11y";
import { useRouter, useSearchParams } from "next/navigation";
import HeadPinzNav from "@/components/headpinz/Nav";
import BowlingPaymentStep from "@/components/bowling/BowlingPaymentStep";
import BowlingAttractionsStep from "@/components/bowling/BowlingAttractionsStep";
import type { AttractionAddon } from "@/components/bowling/BowlingAttractionsStep";
import ClickwrapCheckbox from "@/components/booking/ClickwrapCheckbox";
import { CURRENT_POLICY_VERSION } from "@/lib/clickwrap";
import { bookableDateRange, isKbfBookableDate } from "@/lib/kbf-schedule";
import {
  getBookingLocation,
  setBookingLocation,
  syncLocationFromUrl,
} from "@/lib/booking-location";
import type { BowlingSquareProduct, BowlingExperienceWithDetails } from "@/lib/bowling-db";
import { HP_LOCATIONS } from "@/lib/headpinz-locations";
import { KBF_ELIGIBILITY_HEADING, KBF_ELIGIBILITY_TEXT } from "@/components/kbf/EligibilityNotice";

/**
 * BowlingWizard — shared wizard for Kids Bowl Free (v2) and Open Bowling.
 *
 * Pass `kind="kbf"` for the KBF flow and `kind="open"` for open bowling.
 *
 * KBF-only steps:  location → lookup → verify → [existing] → [reschedule] → bowlers
 * Open-only steps: location → players
 * Shared steps:    → slots → offer → shoes → [attractions] → [food]
 *                  → review → details → [payment] → submitting
 *
 * Both flows use:
 *   - Graphical calendar + hour chips for date/time selection
 *   - Video offer cards for Regular vs VIP lane selection
 *   - Square eGift-card deposit pattern
 */

// ── Design tokens ──────────────────────────────────────────────────────────

const CORAL = "#fd5b56";
const GOLD = "#FFD700";
const BG = "#0a1628";
const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";

// $0 Square catalog item IDs for pizza-bowl packages.
// These must be added as separate line items on the day-of order so staff
// can see the pizza topping / soda flavor selections as individual items.
const PIZZA_BOWL_PIZZA_CATALOG_ID = "2IKZB4O2HQBXWMTSUQ2SEKJY";
const PIZZA_BOWL_SODA_CATALOG_ID = "SJUBJLB4QGHIHCW5AKTTMLH7";

// Booking fee — added to every non-$0 reservation (100% deposit)
const BOOKING_FEE_CATALOG_ID = "7VKAFU3HDPRSKY7ZB6CKXTRW";
const BOOKING_FEE_CENTS = 299;

// Pizza bowl: 1 topping included per lane, $1 each additional
const PIZZA_BOWL_FREE_TOPPINGS = 1;
const EXTRA_TOPPING_CENTS = 100;

// ── Experience display map ─────────────────────────────────────────────────
// Visual presentation data keyed by experience slug.
// The DB drives which experiences exist and what QAMF offer IDs they map to;
// the frontend controls video, accent, description, and feature bullets.

interface ExperienceDisplay {
  videoUrl: string;
  accent: string;
  description: string;
  features: string[];
  includesShoes?: boolean; // true → show "Bowling Shoes Included" banner + skip shoes step
  perLane?: boolean; // true → price is per lane, not per person (pizza bowl, hourly)
}

const EXPERIENCE_DISPLAY: Record<string, ExperienceDisplay> = {
  "kbf-regular": {
    videoUrl: `${BLOB}/videos/headpinz-bowling.mp4`,
    accent: CORAL,
    description:
      "Two free games per kid per day on participating weekdays. Bring your KBF coupon to the front desk. Shoes not included.",
    features: [
      "Standard HeadPinz lanes",
      "Up to 6 bowlers per lane",
      "Glow lighting in the evenings",
      "Bring your KBF coupon to check in",
    ],
  },
  "kbf-vip": {
    videoUrl: `${BLOB}/videos/headpinz-neoverse-v2.mp4`,
    accent: GOLD,
    description:
      "Upgrade your free bowling to the VIP suite — same coupon, premium lanes with NeoVerse + HyperBowling. Shoes not included.",
    features: [
      "VIP lounge & dedicated lanes",
      "NeoVerse video walls",
      "Priority check-in",
      "Up to 6 bowlers per lane",
    ],
  },
  "fun-4-all": {
    videoUrl: `${BLOB}/videos/headpinz-bowling.mp4`,
    accent: CORAL,
    description:
      "The weekday special — 1.5 hours of unlimited bowling with shoes included, one flat price per person!",
    features: [
      "1.5 hours of unlimited bowling",
      "Bowling shoes included",
      "One flat per-person price",
      "Glow bowling in the evenings",
    ],
    includesShoes: true,
  },
  "fun-4-all-vip": {
    videoUrl: `${BLOB}/videos/headpinz-neoverse-v2.mp4`,
    accent: GOLD,
    description:
      "The premium weekday deal — 1.5 hours of VIP bowling with shoes, complimentary chips & salsa, and NeoVerse technology all included!",
    features: [
      "1.5 hours of premium VIP bowling",
      "Bowling shoes included",
      "Complimentary chips & salsa",
      "VIP NeoVerse lanes",
    ],
    includesShoes: true,
  },
  "regular-mon-thur": {
    videoUrl: `${BLOB}/videos/headpinz-bowling.mp4`,
    accent: CORAL,
    description: "Reserve a lane by the hour — Monday through Thursday. Shoes not included.",
    features: ["Standard HeadPinz lanes", "Up to 6 bowlers per lane", "Flexible hourly rate"],
    perLane: true,
  },
  "vip-mon-thur": {
    videoUrl: `${BLOB}/videos/headpinz-neoverse-v2.mp4`,
    accent: GOLD,
    description:
      "Premium hourly lane in the VIP suite — includes chips & salsa and NeoVerse technology. Shoes not included.",
    features: [
      "VIP lounge & dedicated lanes",
      "NeoVerse video walls",
      "Chips & salsa included",
      "Up to 6 bowlers per lane",
    ],
    perLane: true,
  },
  "regular-fri-sun": {
    videoUrl: `${BLOB}/videos/headpinz-bowling.mp4`,
    accent: CORAL,
    description: "Reserve a lane by the hour — Friday through Sunday. Shoes not included.",
    features: ["Standard HeadPinz lanes", "Up to 6 bowlers per lane", "Flexible hourly rate"],
    perLane: true,
  },
  "vip-fri-sun": {
    videoUrl: `${BLOB}/videos/headpinz-neoverse-v2.mp4`,
    accent: GOLD,
    description:
      "Premium VIP lane rental — Friday through Sunday. Includes chips & salsa and NeoVerse technology. Shoes not included.",
    features: [
      "VIP lounge & dedicated lanes",
      "NeoVerse video walls",
      "Chips & salsa included",
      "Up to 6 bowlers per lane",
    ],
    perLane: true,
  },
  "pizza-bowl": {
    videoUrl: `${BLOB}/videos/headpinz-bowling.mp4`,
    accent: CORAL,
    description:
      "The ultimate Sunday deal — 2 hours of bowling with a large one-topping pizza, pitcher of soda, and shoes for up to 6 people all included in one price!",
    features: [
      "2 hours of bowling",
      "Large one-topping pizza",
      "Pitcher of soda",
      "Shoes for up to 6 people",
    ],
    includesShoes: true,
    perLane: true,
  },
  "pizza-bowl-vip": {
    videoUrl: `${BLOB}/videos/headpinz-neoverse-v2.mp4`,
    accent: GOLD,
    description:
      "The ultimate VIP Sunday deal — 2 hours of premium bowling with a large one-topping pizza, pitcher of soda, shoes for up to 6, and complimentary chips & salsa!",
    features: [
      "2 hours of premium bowling",
      "Large one-topping pizza",
      "Pitcher of soda",
      "Shoes for up to 6 people",
      "Complimentary chips & salsa",
      "VIP NeoVerse lanes",
    ],
    includesShoes: true,
    perLane: true,
  },
  "midnight-madness": {
    videoUrl: `${BLOB}/videos/headpinz-bowling.mp4`,
    accent: CORAL,
    description:
      "The Friday & Saturday night special — unlimited bowling all night long at one flat price per person! Shoes not included.",
    features: [
      "Unlimited bowling",
      "Bowl all night",
      "One flat per-person price",
      "Glow bowling atmosphere",
    ],
  },
  "midnight-madness-vip": {
    videoUrl: `${BLOB}/videos/headpinz-neoverse-v2.mp4`,
    accent: GOLD,
    description:
      "The ultimate weekend night out — unlimited VIP bowling all night with complimentary chips & salsa and NeoVerse technology! Shoes not included.",
    features: [
      "Unlimited premium VIP bowling",
      "Bowl all night",
      "Complimentary chips & salsa",
      "VIP NeoVerse lanes",
    ],
  },
};

/** Returns display config for a slug, with sensible defaults for unknown slugs. */
function getExperienceDisplay(slug: string, isVip: boolean): ExperienceDisplay {
  return (
    EXPERIENCE_DISPLAY[slug] ?? {
      videoUrl: isVip
        ? `${BLOB}/videos/headpinz-neoverse-v2.mp4`
        : `${BLOB}/videos/headpinz-bowling.mp4`,
      accent: isVip ? GOLD : CORAL,
      description: "",
      features: [],
    }
  );
}

// ── Centers ────────────────────────────────────────────────────────────────

const CENTERS = [
  {
    id: "9172",
    qamfId: 9172,
    squareCenterCode: "TXBSQN0FEKQ11",
    locationKey: "headpinz" as const,
    hpSlug: "fort-myers", // key into HP_LOCATIONS for hours
    name: "HeadPinz Fort Myers",
    address: "14513 Global Pkwy, Fort Myers",
    phone: "(239) 302-2155",
    smsFrom: "+12393022155",
  },
  {
    id: "3148",
    qamfId: 3148,
    squareCenterCode: "PPTR5G2N0QXF7",
    locationKey: "naples" as const,
    hpSlug: "naples", // key into HP_LOCATIONS for hours
    name: "HeadPinz Naples",
    address: "8525 Radio Ln, Naples",
    phone: "(239) 455-3755",
    smsFrom: "+12394553755",
  },
];

const CENTER_BY_ID: Record<string, (typeof CENTERS)[0]> = Object.fromEntries(
  CENTERS.map((c) => [c.id, c]),
);
const CENTER_BY_CODE: Record<string, (typeof CENTERS)[0]> = Object.fromEntries(
  CENTERS.map((c) => [c.squareCenterCode, c]),
);

// ── Types ──────────────────────────────────────────────────────────────────

type Step =
  | "location"
  | "lookup" // KBF only
  | "verify" // KBF only
  | "existing" // KBF only — future reservation detected
  | "reschedule" // KBF only — pick a new date/time
  | "bowlers" // KBF only — select members
  | "players" // Open only — player count
  | "slots" // Both — calendar + hour chips
  | "tier" // Both — Regular vs VIP picker
  | "offer" // Both — video cards + exact time chips
  | "shoes" // Both
  | "attractions" // Both (stub)
  | "food" // Both (stub)
  | "review" // Both
  | "details" // Both
  | "payment" // Both
  | "submitting"; // Both

interface Member {
  id: number;
  passId: number;
  relation: "kid" | "family";
  slot: number;
  firstName: string;
  lastName: string;
  birthday: string;
  prefs: { wantBumpers: boolean | null } | null;
}

interface PassWithMembers {
  id: number;
  email: string;
  centerName: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  preferred2fa: "sms" | "email";
  isTest: boolean;
  fpass: boolean;
  members: Member[];
}

interface BowlerSelection {
  key: string;
  displayName: string;
  relation: "parent" | "kid" | "family";
  selected: boolean;
  wantBumpers: boolean;
  kbfPassId?: number;
  kbfMemberSlot?: number;
  kbfRelation?: "kid" | "family";
  /** True for paid adults (non-FBF account holder, non-FBF family, guest adults). */
  isPaid?: boolean;
  /** Editable name for manually-added guest adults. */
  isGuestAdult?: boolean;
}

interface AvailabilitySlot {
  bookedAt: string;
  webOfferId: number;
  webOfferTitle: string;
  webOfferDescription?: string;
  optionId?: number;
  optionType?: "Game" | "Time" | "Unlimited";
}

interface ExistingReservation {
  id: number;
  centerCode: string;
  qamfReservationId?: string;
  shortCode?: string;
  depositCents: number;
  totalCents: number;
  status: string;
  bookedAt: string;
  playerCount?: number;
  guestName?: string;
  lines: Array<{
    id: number;
    label: string;
    quantity: number;
    unitPriceCents: number;
  }>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
  } catch {
    return iso;
  }
}

function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/**
 * Format a Date as YYYY-MM-DD in Eastern Time (America/New_York).
 * Both HeadPinz centers are in SW Florida (Eastern time zone).
 * Using toISOString() would give UTC and flip to the next day after 8 PM ET.
 */
function ymdFromDate(dt: Date): string {
  return dt.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function todayYmd(): string {
  return ymdFromDate(new Date());
}

/**
 * Effective "today" for booking purposes.
 * Between midnight and 2 AM ET on Sat/Sun mornings (= Fri/Sat late-night
 * extension), returns yesterday so post-midnight time slots remain bookable.
 * Both centers close at 2 AM on Fri-Sat.
 */
function effectiveToday(): string {
  const today = todayYmd();
  const nowMins = etNowMinutes();
  if (nowMins >= 120) return today; // past 2 AM → normal day
  // Between midnight and 2 AM — check if yesterday was Fri (5) or Sat (6)
  const yesterday = addDays(today, -1);
  const dow = new Date(`${yesterday}T12:00:00`).getDay();
  if (dow === 5 || dow === 6) return yesterday;
  return today;
}

/**
 * Current Eastern Time expressed as minutes-from-midnight.
 * Used to compute the earliest bookable slot for today's date.
 */
function etNowMinutes(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    timeZone: "America/New_York",
  }).formatToParts(new Date());
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return h * 60 + m;
}

function addDays(ymd: string, n: number): string {
  // Anchor at noon ET to avoid DST / day-boundary drift.
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + n);
  return ymdFromDate(d);
}

/**
 * Returns the ET hour of an ISO slot timestamp as a "display hour" value
 * that matches the hour chip numbers in the wizard.
 *
 * Post-midnight slots (0–2 AM) belong to the PREVIOUS booking date and are
 * represented as hours 24–26 so they map to the correct chip.
 * e.g. "2026-05-10T01:00:00-04:00" for a May 9 booking → hour 25.
 *
 * Pass the booking date (YYYY-MM-DD) so we can detect the day rollover.
 */
function slotHourET(iso: string, bookingDate?: string): number {
  try {
    const dt = new Date(iso);
    const parts = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: "America/New_York",
    }).formatToParts(dt);
    const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    if (isNaN(h)) return -1;
    if (bookingDate && h < 9) {
      // Slot is in the early-morning hours of the next calendar day — add 24
      // so it aligns with the post-midnight hour chips (24=12AM, 25=1AM, …).
      // Use find() by part type to avoid any locale-dependent format ordering.
      const yr = parts.find((p) => p.type === "year")?.value ?? "1970";
      const mo = parts.find((p) => p.type === "month")?.value ?? "01";
      const dy = parts.find((p) => p.type === "day")?.value ?? "01";
      const slotYmd = `${yr}-${mo}-${dy}`;
      if (slotYmd > bookingDate) return h + 24;
    }
    return h;
  } catch {
    return -1;
  }
}

function slotMinuteET(iso: string): number {
  try {
    const m = parseInt(
      new Date(iso).toLocaleString("en-US", {
        minute: "2-digit",
        timeZone: "America/New_York",
      }),
      10,
    );
    return isNaN(m) ? 0 : m;
  } catch {
    return 0;
  }
}

function formatHour(h: number): string {
  // Support post-midnight hours: 24 = 12 AM, 25 = 1 AM, 26 = 2 AM, …
  const h24 = h % 24;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const hr = h24 % 12 || 12;
  return `${hr} ${ampm}`;
}

function formatHourMinute(h: number, m: number): string {
  const h24 = h % 24;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const hr = h24 % 12 || 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

/**
 * Parse a single hour token (e.g. "11AM", "12AM", "2AM", "9PM") into the
 * wizard's internal 24h-plus representation where midnight = 24, 1 AM = 25, 2 AM = 26.
 */
function parseHourToken(token: string): number {
  const m = token.trim().match(/^(\d+)(AM|PM)$/i);
  if (!m) return 11;
  let h = parseInt(m[1], 10);
  const period = m[2].toUpperCase();
  if (period === "PM" && h !== 12)
    h += 12; // 1 PM–11 PM → 13–23
  else if (period === "AM" && h === 12)
    h = 24; // 12 AM (midnight) → 24
  else if (period === "AM" && h < 9) h += 24; // 1 AM → 25, 2 AM → 26 (post-midnight)
  return h;
}

/**
 * Parse an HP_LOCATIONS hours string like "Sun-Thu 11AM-12AM" → { open: 11, close: 24 }.
 * The day-range prefix is stripped; only the time range after the space is parsed.
 */
function parseHoursRange(hoursStr: string): { open: number; close: number } {
  const timePart = hoursStr.split(" ").pop() ?? "11AM-2AM";
  const dash = timePart.lastIndexOf("-");
  const openToken = timePart.slice(0, dash);
  const closeToken = timePart.slice(dash + 1);
  return { open: parseHourToken(openToken), close: parseHourToken(closeToken) };
}

/**
 * Return operating hours for the given HP_LOCATIONS slug + calendar date.
 * Fri/Sat use hoursWeekend; Sun-Thu use hours.
 * Falls back to 11 AM–2 AM if the slug is unknown.
 */
function centerHoursForDate(hpSlug: string, dateStr: string): { open: number; close: number } {
  const loc = HP_LOCATIONS[hpSlug];
  if (!loc) return { open: 11, close: 26 };
  const dow = new Date(`${dateStr}T12:00:00`).getDay(); // 0 = Sun, 6 = Sat
  const isWeekend = dow === 5 || dow === 6;
  return parseHoursRange(isWeekend ? loc.hoursWeekend : loc.hours);
}

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ── Loading state ──────────────────────────────────────────────────────────

const LOADING_MESSAGES = [
  "Polishing the pins…",
  "Waxing the lanes…",
  "Checking with the pin chasers…",
  "Counting open lanes…",
  "Lining up the bumpers…",
  "Asking the lane monitor…",
];

function LoadingPackages() {
  const [idx, setIdx] = useState(0);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const rotate = setInterval(() => {
      setIdx((i) => (i + 1) % LOADING_MESSAGES.length);
    }, 2500);
    const slowTimer = setTimeout(() => setSlow(true), 8000);
    return () => {
      clearInterval(rotate);
      clearTimeout(slowTimer);
    };
  }, []);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-10 text-center">
      <div
        className="w-10 h-10 border-2 border-white/15 rounded-full animate-spin mx-auto mb-4"
        style={{ borderTopColor: CORAL }}
      />
      <p className="font-body text-white/70 text-sm">{LOADING_MESSAGES[idx]}</p>
      {slow && (
        <p className="font-body text-white/40 text-xs mt-2">
          Still looking — this is taking longer than usual.
        </p>
      )}
    </div>
  );
}

// ── Props ──────────────────────────────────────────────────────────────────

interface BowlingWizardProps {
  kind: "kbf" | "open";
}

// ── Component ──────────────────────────────────────────────────────────────

export default function BowlingWizard({ kind }: BowlingWizardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const confirmationBase =
    kind === "kbf" ? "/hp/book/kids-bowl-free/confirmation" : "/hp/book/bowling/confirmation";

  // ── Center ───────────────────────────────────────────────────────

  const [centerId, setCenterId] = useState("9172");

  useEffect(() => {
    syncLocationFromUrl();
    const fromUrl = searchParams.get("location");
    let resolved: string | null = null;
    if (fromUrl === "naples") resolved = "3148";
    else if (fromUrl === "fortmyers" || fromUrl === "fort-myers") resolved = "9172";
    else {
      const stored = getBookingLocation();
      if (stored === "naples") resolved = "3148";
      else if (stored === "headpinz") resolved = "9172";
    }
    setCenterId(resolved ?? "9172");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── URL-seeded discount code (open bowling only) ────────────────
  // Marketing can share links like /book/bowling-open?code=MAY20WEEKDAY and the
  // wizard auto-validates + applies the code on mount. The param is stripped
  // from the URL after consumption so a refresh doesn't re-toast and the
  // shareable URL doesn't leak the code afterward. Silent on failure — a bad
  // URL code shouldn't show an error chrome before the user even interacts.
  const discountSeededRef = useRef(false);
  useEffect(() => {
    if (kind === "kbf") return;
    if (discountSeededRef.current) return;
    const fromUrl = searchParams.get("code");
    if (!fromUrl) return;
    discountSeededRef.current = true;
    void applyDiscountCode(fromUrl, { silentOnFail: true });
    // Strip ?code= from the address bar without a navigation. Use URL API on
    // window.location since router.replace would force a Next-managed nav.
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("code");
      window.history.replaceState({}, "", url.toString());
    } catch {
      /* non-fatal */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Wizard core ──────────────────────────────────────────────────

  const [step, setStep] = useState<Step>("location");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Scroll to top on step change so the user always starts at the top.
  // Without this, long steps (slots with calendar) leave the viewport
  // scrolled down when advancing, making the next step feel broken.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [step]);

  // ── QAMF hold state ──────────────────────────────────────────────
  // A Temporary hold is created as soon as the user taps a time chip on
  // the offer step. The hold is extended every 8 min and released when
  // the user navigates back to offer or the wizard unmounts.
  // holdRef / holdTimerRef use refs to avoid stale closures in the timer.
  //
  // Hold lifetime is also gated by a 15-minute client-side countdown that
  // resets on user activity (step changes, clicks, keypresses, scrolls).
  // If the countdown reaches zero, the hold is released and the wizard
  // reloads back to the start so the user can't accept a slot they no
  // longer own.

  const HOLD_MAX_MS = 15 * 60 * 1000;
  // Throttle: only send a server-side extend PATCH at most once every 60s
  // when activity resets the countdown. The 8-min keep-alive interval still
  // covers the QAMF TTL independently — this just keeps the server in sync
  // sooner when the user is actively interacting.
  const HOLD_EXTEND_THROTTLE_MS = 60 * 1000;

  const holdRef = useRef<{ qamfId: string; centerId: number } | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdExpiresAtRef = useRef<number | null>(null);
  const holdLastExtendRef = useRef<number>(0);
  const [holdBusy, setHoldBusy] = useState(false);
  const [holdActive, setHoldActive] = useState(false);
  const [holdSecondsLeft, setHoldSecondsLeft] = useState(0);
  // Pending back-navigation that would release the hold — stored while
  // the "Release lane?" confirmation is visible.
  const [pendingRelease, setPendingRelease] = useState<Step | null>(null);

  // ── KBF: lookup + verify ─────────────────────────────────────────

  const [lookupTab, setLookupTab] = useState<"email" | "phone" | "new">("email");
  const [emailInput, setEmailInput] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [contact, setContact] = useState("");
  const [code, setCode] = useState("");
  const [channel, setChannel] = useState<"email" | "sms" | null>(null);
  const [maskedDest, setMaskedDest] = useState("");
  const [pass, setPass] = useState<PassWithMembers | null>(null);

  // ── KBF: bowler selection ────────────────────────────────────────

  const [bowlerSelections, setBowlerSelections] = useState<BowlerSelection[]>([]);

  // ── Open: player count ───────────────────────────────────────────

  const [playerCount, setPlayerCount] = useState(2);

  // ── Slots ────────────────────────────────────────────────────────

  const initialDate = kind === "kbf" ? (bookableDateRange()[0] ?? todayYmd()) : effectiveToday();
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [availableSlots, setAvailableSlots] = useState<AvailabilitySlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlot | null>(null);
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [selectedMinute, setSelectedMinute] = useState<number | null>(null);
  // Track what we last fetched to skip redundant QAMF calls
  const lastFetchKey = useRef("");

  // Auto-scroll refs for the slots step (date → hours → minutes → CTA)
  const hoursRef = useRef<HTMLDivElement>(null);
  const minutesRef = useRef<HTMLDivElement>(null);
  const seePackagesRef = useRef<HTMLDivElement>(null);

  // Calendar nav
  const initCal = new Date(`${initialDate}T12:00:00`);
  const [calMonth, setCalMonth] = useState(initCal.getMonth());
  const [calYear, setCalYear] = useState(initCal.getFullYear());

  // ── Tier picker (Regular vs VIP) ────────────────────────────────

  const [selectedTier, setSelectedTier] = useState<"regular" | "vip" | null>(null);

  // Lane count is derived: 1 lane per 6 bowlers, minimum 1.

  // Confirmation popup when user clicks a tier card whose time has no slots
  const [tierTimeConfirm, setTierTimeConfirm] = useState<{
    tierId: "regular" | "vip";
    hour: number;
    minute: number;
  } | null>(null);

  // VIP upgrade modal (shown after Regular selection on offer step)
  const [showVipUpgrade, setShowVipUpgrade] = useState(false);

  // ── Experience catalog ───────────────────────────────────────────
  // Loaded from the DB once the center is known.
  // Drives offer IDs fetched from QAMF, offer card rendering, and lineItems.

  const [experiences, setExperiences] = useState<BowlingExperienceWithDetails[]>([]);
  const [experiencesLoading, setExperiencesLoading] = useState(false);

  // ── Add-ons ──────────────────────────────────────────────────────

  const [shoeProducts, setShoeProducts] = useState<BowlingSquareProduct[]>([]);
  const [shoeQty, setShoeQty] = useState<Record<number, number>>({});
  const [showNoShoesModal, setShowNoShoesModal] = useState(false);

  // ── Pizza Bowl modifier selections ───────────────────────────────
  // Loaded from Square catalog once a pizza-bowl experience is selected.
  // groups      — the modifier lists (e.g. "Pizza Toppings", "Soda Choice")
  // selections  — Array indexed by lane (0..laneCount-1).
  //               Each entry: { [groupId]: string[] }
  //               SINGLE groups store at most one ID; MULTIPLE groups store many.
  //               Special key "__note__" holds fallback free-text when no groups loaded.

  interface ModifierGroup {
    id: string;
    name: string;
    selectionType: "SINGLE" | "MULTIPLE";
    options: Array<{ id: string; name: string }>;
  }

  // Build Square applied_modifiers array from one lane's selection map.
  function buildLaneModifiers(sel: Record<string, string[]>) {
    return Object.entries(sel)
      .filter(([key]) => key !== "__note__")
      .flatMap(([, ids]) => ids.map((id) => ({ catalog_object_id: id })));
  }

  // Helpers to build human-readable notes for the $0 split items.
  // Applied-modifiers on Square catalog items only work when those modifier
  // groups are configured in the Square catalog for that specific item.
  // Since the $0 Pizza Bowl Pizza / Soda Pitcher items don't have those groups
  // attached, we use notes instead — Square stores them as visible line-item text.

  /** Count selected toppings across all topping groups (excludes soda/drink groups). */
  function countToppings(sel: Record<string, string[]>, groups: ModifierGroup[]): number {
    let count = 0;
    for (const group of groups) {
      if (/soda|drink|pitcher/i.test(group.name)) continue;
      count += (sel[group.id] ?? []).length;
    }
    return count;
  }

  /** Number of extra (paid) toppings for one lane's selections. */
  function extraToppingCount(sel: Record<string, string[]>, groups: ModifierGroup[]): number {
    return Math.max(0, countToppings(sel, groups) - PIZZA_BOWL_FREE_TOPPINGS);
  }

  /** Returns the pizza-topping selection as a note string (e.g. "Pepperoni, Cheese"). */
  function buildPizzaNote(
    sel: Record<string, string[]>,
    groups: ModifierGroup[],
  ): string | undefined {
    const names: string[] = [];
    for (const group of groups) {
      if (/soda|drink|pitcher/i.test(group.name)) continue;
      for (const id of sel[group.id] ?? []) {
        names.push(group.options.find((o) => o.id === id)?.name ?? id);
      }
    }
    return names.length > 0 ? names.join(", ") : undefined;
  }

  /** Returns the soda-choice selection as a note string (e.g. "Diet Pepsi"). */
  function buildSodaNote(
    sel: Record<string, string[]>,
    groups: ModifierGroup[],
  ): string | undefined {
    for (const group of groups) {
      if (!/soda|drink|pitcher/i.test(group.name)) continue;
      const ids = sel[group.id] ?? [];
      if (!ids.length) continue;
      return ids.map((id) => group.options.find((o) => o.id === id)?.name ?? id).join(", ");
    }
    return undefined;
  }

  // Build human-readable note for one lane's selection map.
  function buildLaneNote(
    sel: Record<string, string[]>,
    groups: ModifierGroup[],
  ): string | undefined {
    if (groups.length > 0) {
      const parts = groups
        .map((g) => {
          const selectedIds = sel[g.id] ?? [];
          if (!selectedIds.length) return null;
          const names = selectedIds
            .map((id) => g.options.find((o) => o.id === id)?.name ?? id)
            .join(", ");
          return `${g.name}: ${names}`;
        })
        .filter(Boolean) as string[];
      return parts.length > 0 ? parts.join(" | ") : undefined;
    }
    return ((sel["__note__"] ?? [])[0] ?? "").trim() || undefined;
  }

  const [pizzaModifierGroups, setPizzaModifierGroups] = useState<ModifierGroup[]>([]);
  const [pizzaModifiersLoading, setPizzaModifiersLoading] = useState(false);
  // Per-lane selections: Array<Record<groupId, selectedOptionId[]>>
  // Length == laneCount; index 0 = Lane 1, index 1 = Lane 2, etc.
  const [pizzaModifierSelections, setPizzaModifierSelections] = useState<
    Array<Record<string, string[]>>
  >([{}]);

  // ── Attraction add-ons (laser tag / gel blaster) ─────────────────
  const [attractionAddons, setAttractionAddons] = useState<AttractionAddon[]>([]);

  // ── KBF: existing reservation ────────────────────────────────────

  const [existingReservation, setExistingReservation] = useState<ExistingReservation | null>(null);
  const [cancelConfirming, setCancelConfirming] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);

  // ── Square quote (review step) ───────────────────────────────────

  const [quoteDayofOrderId, setQuoteDayofOrderId] = useState<string | null>(null);
  const [quoteTotalCents, setQuoteTotalCents] = useState(0);
  const [quoteDepositCents, setQuoteDepositCents] = useState(0);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  /**
   * Discount amount applied by Square at the order level (cents, pre-tax).
   * Sourced from the quote endpoint's `appliedDiscount.amountOffCents`, which
   * mirrors `order.total_discount_money` returned by Square. Surfaced as a
   * dedicated line in the review summary so customers see the savings.
   */
  const [quoteDiscountOffCents, setQuoteDiscountOffCents] = useState(0);
  const [quoteDiscountCode, setQuoteDiscountCode] = useState<string | null>(null);

  // ── Discount code (open bowling only) ───────────────────────────
  // The slots step shows an inline input; URL `?code=` is auto-applied on
  // mount. State is intentionally minimal — the server is the source of
  // truth at quote + reserve time. The chip + calendar filter are pure UX.
  interface AppliedDiscount {
    code: string;
    description: string | null;
    amountPct: number | null;
    amountCents: number | null;
    /** Allowed weekdays 0–6 (Sun=0). `null` means any weekday. */
    allowedWeekdays: number[] | null;
    /** ISO timestamps bounding the date window. */
    startsAt: string;
    expiresAt: string;
  }
  const [appliedDiscount, setAppliedDiscount] = useState<AppliedDiscount | null>(null);
  const [discountInput, setDiscountInput] = useState("");
  const [discountChecking, setDiscountChecking] = useState(false);
  const [discountError, setDiscountError] = useState<string | null>(null);

  /** Map a validate-endpoint failure reason to a customer-friendly message. */
  function discountReasonMessage(reason: string, code: string): string {
    switch (reason) {
      case "expired":
        return `Code ${code} has expired.`;
      case "not_yet_active":
        return `Code ${code} isn't active yet.`;
      case "exhausted":
        return `Code ${code} has been fully redeemed.`;
      case "wrong_location":
        return `Code ${code} isn't valid at this center.`;
      case "wrong_domain":
        return `Code ${code} isn't valid for bowling reservations.`;
      case "wrong_product":
        return `Code ${code} isn't valid for the selected package.`;
      case "rate_limited":
        return "Too many code attempts — please try again in a few minutes.";
      case "inactive":
      case "unsupported_mechanic":
      case "unknown":
      default:
        return `Code ${code} is not valid.`;
    }
  }

  async function applyDiscountCode(rawCode: string, opts: { silentOnFail?: boolean } = {}) {
    const code = rawCode.trim().toUpperCase();
    if (!code) return;
    setDiscountChecking(true);
    setDiscountError(null);
    try {
      const res = await fetch("/api/discount-codes/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          domain: "bowling",
          locationId: center.squareCenterCode,
        }),
      });
      const data = (await res.json()) as
        | {
            valid: true;
            code: string;
            description: string | null;
            amountPct: number | null;
            amountCents: number | null;
            allowedWeekdays: number[] | null;
            startsAt: string;
            expiresAt: string;
          }
        | { valid: false; reason: string };
      if (!data || !("valid" in data) || !data.valid) {
        const reason = data && "reason" in data ? data.reason : "unknown";
        if (!opts.silentOnFail) setDiscountError(discountReasonMessage(reason, code));
        return;
      }
      setAppliedDiscount({
        code: data.code,
        description: data.description,
        amountPct: data.amountPct,
        amountCents: data.amountCents,
        allowedWeekdays: data.allowedWeekdays,
        startsAt: data.startsAt,
        expiresAt: data.expiresAt,
      });
      setDiscountInput("");
      setDiscountError(null);
      // If the currently-selected date is now disallowed, clear it so the user
      // re-picks. Cheaper than silently leaving them on an invalid date.
      if (
        selectedDate &&
        !dateMatchesDiscount(selectedDate, data.allowedWeekdays, data.expiresAt, data.startsAt)
      ) {
        setSelectedDate("");
        setSelectedHour(null);
        setSelectedMinute(null);
      }
    } catch (err) {
      console.warn("[discount] validate failed:", err);
      if (!opts.silentOnFail) setDiscountError("Couldn't validate that code. Try again.");
    } finally {
      setDiscountChecking(false);
    }
  }

  function clearDiscountCode() {
    setAppliedDiscount(null);
    setDiscountError(null);
  }

  /** Returns true when `ymd` falls inside the discount's window AND on an allowed weekday. */
  function dateMatchesDiscount(
    ymd: string,
    allowedWeekdays: number[] | null,
    expiresAtIso: string,
    startsAtIso: string,
  ): boolean {
    // Compare dates as the YYYY-MM-DD of the discount window in ET. Bowling
    // dates are already ET-local YYYY-MM-DD strings, so we slice the same
    // prefix off the discount window — avoids any UTC/ET roll-over surprises.
    const minDate = startsAtIso.slice(0, 10);
    const maxDate = expiresAtIso.slice(0, 10);
    if (ymd < minDate || ymd > maxDate) return false;
    if (allowedWeekdays && allowedWeekdays.length > 0) {
      // Day-of-week in ET. The wizard's date strings are already ET-local.
      const [y, m, d] = ymd.split("-").map(Number);
      const wd = new Date(y, m - 1, d, 12).getDay();
      if (!allowedWeekdays.includes(wd)) return false;
    }
    return true;
  }

  // ── Guest details ────────────────────────────────────────────────

  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [clickwrapAccepted, setClickwrapAccepted] = useState(false);
  const [smsOptIn, setSmsOptIn] = useState(true);

  // ── HeadPinz Rewards / Loyalty ──────────────────────────────────

  const [loyaltyAccount, setLoyaltyAccount] = useState<{
    id: string;
    balance: number;
    lifetimePoints: number;
    customerId: string;
    enrolledAt?: string;
  } | null>(null);
  const [loyaltyCustomer, setLoyaltyCustomer] = useState<{
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    profileComplete: boolean;
  } | null>(null);
  const [phoneLookedUp, setPhoneLookedUp] = useState(false);
  const [phoneLookupLoading, setPhoneLookupLoading] = useState(false);
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [verifyStep, setVerifyStep] = useState<"idle" | "sending" | "code" | "verified">("idle");
  const [verifyCode, setVerifyCode] = useState(["", "", "", "", "", ""]);
  const [verifyError, setVerifyError] = useState("");
  const [rewardsSignup, setRewardsSignup] = useState(false);
  const [loyaltyIsNewSignup, setLoyaltyIsNewSignup] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const verifyCodeRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Reward tiers + selection for Pinz redemption at booking time
  const [rewardTiers, setRewardTiers] = useState<
    Array<{
      id: string;
      name: string;
      points: number;
      discountCents: number;
    }>
  >([]);
  const [selectedRewardTier, setSelectedRewardTier] = useState<{
    id: string;
    name: string;
    points: number;
    discountCents: number;
  } | null>(null);

  // ── Payment ──────────────────────────────────────────────────────

  const [paymentError, setPaymentError] = useState<string | null>(null);

  // ── Computed values ──────────────────────────────────────────────

  const center = CENTER_BY_ID[centerId] ?? CENTERS[0];
  const bmiClientKey = center.locationKey === "naples" ? "headpinznaples" : undefined;

  const kbfBowlers = bowlerSelections.filter((b) => b.selected);
  const activePlayerCount = kind === "kbf" ? kbfBowlers.length : playerCount;

  // Experience matching the selected QAMF slot
  const selectedExperience = selectedSlot
    ? (experiences.find((e) => e.qamfWebOfferId === selectedSlot.webOfferId) ?? null)
    : null;

  // Whether the selected experience already includes shoes (skip shoes step)
  const selectedIncludesShoes = selectedExperience
    ? (getExperienceDisplay(selectedExperience.slug, selectedExperience.isVip).includesShoes ??
      false)
    : false;

  // Whether the selected experience is a pizza-bowl package (needs modifier selection)
  const isPizzaBowl = (selectedExperience?.slug ?? "").includes("pizza-bowl");

  // Extra-topping surcharge across all lanes (1 free, $1 each additional per lane)
  const extraToppingsCents =
    isPizzaBowl && pizzaModifierGroups.length > 0
      ? pizzaModifierSelections.reduce(
          (sum, sel) => sum + extraToppingCount(sel, pizzaModifierGroups) * EXTRA_TOPPING_CENTS,
          0,
        )
      : 0;

  // Whether the selected experience is priced per lane (not per person)
  const selectedIsPerLane = selectedExperience
    ? (getExperienceDisplay(selectedExperience.slug, selectedExperience.isVip).perLane ?? false) ||
      selectedExperience.kind === "hourly"
    : false;

  // 1 lane per 6 bowlers (round up), minimum 1.
  // Always computed — per-lane add-ons (C&S) need it even in per-person experiences.
  const laneCount = Math.max(1, Math.ceil(activePlayerCount / 6));

  // Per-lane → scale by lanes.  Per-person → scale by player count.
  // These are mutually exclusive — never both.
  const qtyMultiplier = selectedIsPerLane ? laneCount : activePlayerCount;

  // VIP counterpart experience for the upgrade modal
  const vipUpgradeExperience =
    selectedTier === "regular" && selectedExperience && !selectedExperience.isVip
      ? (experiences.find((e) => e.isVip && e.kind === selectedExperience.kind) ?? null)
      : null;
  const vipUpgradeSlot =
    vipUpgradeExperience && selectedSlot
      ? (availableSlots.find(
          (s) =>
            s.webOfferId === vipUpgradeExperience.qamfWebOfferId &&
            slotHourET(s.bookedAt, selectedDate) ===
              slotHourET(selectedSlot.bookedAt, selectedDate) &&
            slotMinuteET(s.bookedAt) === slotMinuteET(selectedSlot.bookedAt),
        ) ?? null)
      : null;

  // Bundled items auto-included in the selected experience (the combo)
  const baseItems = selectedExperience?.items ?? [];

  // Selected duration option (for hourly experiences with multiple durations)
  const selectedDurationOpt =
    selectedExperience?.durationOptions.find((o) => o.qamfOptionId === selectedSlot?.optionId) ??
    null;

  // Effective per-unit price for the primary bowling item, accounting for
  // duration option overrides.  For 2hr options the override product is
  // the 1hr Square catalog item; multiplied by squareMultiplier=2 it gives
  // the correct 2hr total (2 × 1hr price).
  function effectiveItemPrice(item: (typeof baseItems)[0]): {
    priceCents: number;
    depositPct: number;
  } {
    if (
      selectedDurationOpt?.overridePriceCents != null &&
      item.sortOrder === 0 // only override the primary bowling item, not add-ons like VIP Chips
    ) {
      return {
        priceCents: selectedDurationOpt.overridePriceCents,
        depositPct: selectedDurationOpt.overrideDepositPct ?? item.depositPct,
      };
    }
    return { priceCents: item.priceCents, depositPct: item.depositPct };
  }

  // Effective quantity multiplier from the selected duration option.
  // For non-hourly or the default 1.5hr option, this is 1.
  const durationMultiplier = selectedDurationOpt?.squareMultiplier ?? 1;

  // ── Bowling duration for attraction time-blocking ──────────────
  // Derives the bowling session length in minutes so the attractions
  // step can grey-out overlapping time slots and label them "Bowling".
  const bowlingDurationMinutes = (() => {
    if (selectedDurationOpt) return selectedDurationOpt.durationMinutes;
    const slug = selectedExperience?.slug ?? "";
    if (slug.includes("pizza-bowl")) return 120;
    if (slug.includes("midnight-madness")) return 180;
    if (slug.includes("fun-4-all")) return 90;
    if (slug.startsWith("kbf")) return 60;
    return 90; // safe default
  })();

  // Shoe totals (pre-tax, for display before quote lands)
  const shoePreTaxTotal = Object.entries(shoeQty).reduce((sum, [pidStr, qty]) => {
    const p = shoeProducts.find((sp) => sp.id === Number(pidStr));
    return sum + (p ? p.priceCents * qty : 0);
  }, 0);
  const shoePreTaxDeposit = Object.entries(shoeQty).reduce((sum, [pidStr, qty]) => {
    const p = shoeProducts.find((sp) => sp.id === Number(pidStr));
    if (!p) return sum;
    return sum + Math.round(p.priceCents * qty * (p.depositPct / 100));
  }, 0);

  // Base (experience) totals pre-tax
  // qtyMultiplier is lanes (per-lane) or players (per-person).
  // For hourly experiences, also factor in the duration multiplier and any price override.
  const basePreTaxTotal = baseItems.reduce((s, item) => {
    const { priceCents } = effectiveItemPrice(item);
    const qty =
      item.sortOrder === 0
        ? item.quantity * qtyMultiplier * durationMultiplier
        : item.quantity * laneCount;
    return s + priceCents * qty;
  }, 0);
  const basePreTaxDeposit = baseItems.reduce((s, item) => {
    const { priceCents, depositPct } = effectiveItemPrice(item);
    const qty =
      item.sortOrder === 0
        ? item.quantity * qtyMultiplier * durationMultiplier
        : item.quantity * laneCount;
    return s + Math.round(priceCents * qty * (depositPct / 100));
  }, 0);

  // Attraction add-ons: full price, 100% deposit (no split — guest pays in full online)
  const attractionPreTaxCents = attractionAddons.reduce(
    (s, a) => s + Math.round(a.totalPrice * 100),
    0,
  );

  // KBF adult game charges: $5/game Mon–Thu, $6/game Fri, 2 games/session, 100% deposit.
  // Server re-derives pricing independently — this drives deposit display + payment step gating.
  const kbfPaidAdultCount = kind === "kbf" ? kbfBowlers.filter((b) => b.isPaid).length : 0;
  // KBF VIP detection — must be computed before pricing so VIP premium applies
  const kbfIsVip = kind === "kbf" && (selectedExperience?.isVip ?? false);

  // KBF adult game pricing: VIP adults pay $1 more per game (baked into rate)
  const kbfAdultPerGameCents = (() => {
    if (!selectedDate || kbfPaidAdultCount === 0) return 0;
    const dow = new Date(`${selectedDate}T12:00:00`).getDay();
    const isFri = dow === 5;
    return kbfIsVip ? (isFri ? 700 : 600) : isFri ? 600 : 500;
  })();
  const kbfAdultGameCents = kbfPaidAdultCount * kbfAdultPerGameCents * 2; // 2 games/session

  // KBF VIP lane upcharge: $1/person/game × 2 games × FREE bowlers only.
  // Paid adults already have VIP baked into their per-game rate above.
  const kbfFreeBowlerCount = kbfIsVip ? kbfBowlers.length - kbfPaidAdultCount : 0;
  const kbfVipUpchargeCents = kbfFreeBowlerCount * 100 * 2; // $1/game × 2 games

  // Combined KBF extra charges (adult games + VIP upcharge), both 100% deposit
  const kbfExtraCents = kbfAdultGameCents + kbfVipUpchargeCents;

  // Booking fee: $2.99 on every non-$0 reservation (100% deposit)
  const hasBookingFee =
    basePreTaxTotal + shoePreTaxTotal + extraToppingsCents + attractionPreTaxCents + kbfExtraCents >
    0;
  const bookingFeeCents = hasBookingFee ? BOOKING_FEE_CENTS : 0;

  const preTaxTotalCents =
    basePreTaxTotal +
    shoePreTaxTotal +
    extraToppingsCents +
    attractionPreTaxCents +
    kbfExtraCents +
    bookingFeeCents;
  const preTaxDepositCents =
    basePreTaxDeposit +
    shoePreTaxDeposit +
    extraToppingsCents +
    attractionPreTaxCents +
    kbfExtraCents +
    bookingFeeCents;

  // Use Square's tax-inclusive quote once loaded.
  // Extra toppings are added to the quote (Square doesn't know about them).
  const depositCents =
    quoteDepositCents > 0 ? quoteDepositCents + extraToppingsCents : preTaxDepositCents;
  const displayTotal =
    quoteTotalCents > 0 ? quoteTotalCents + extraToppingsCents : preTaxTotalCents;

  // Loyalty reward: reduce deposit by discount amount (floored at $0)
  const rewardDiscountCents = selectedRewardTier?.discountCents ?? 0;
  const effectiveDepositCents = Math.max(0, depositCents - rewardDiscountCents);
  const effectiveDisplayTotal = Math.max(0, displayTotal - rewardDiscountCents);

  // Pizza bowl modifier selections:
  //   - selectedModifiers: lane-0 selections (used for Square quote approximation)
  //   - pizzaNoteText: aggregated note across all lanes for review display
  //   - lineItems for pizza bowl: one item per lane each with per-lane modifiers
  const selectedModifiers =
    isPizzaBowl && pizzaModifierGroups.length > 0
      ? buildLaneModifiers(pizzaModifierSelections[0] ?? {})
      : [];

  // Aggregated human-readable note across all lanes (used on review step).
  const pizzaNoteText: string | undefined = (() => {
    if (!isPizzaBowl) return undefined;
    const laneNotes = pizzaModifierSelections
      .map((sel, i) => {
        const note = buildLaneNote(sel, pizzaModifierGroups);
        return laneCount > 1 && note ? `Lane ${i + 1}: ${note}` : note;
      })
      .filter(Boolean) as string[];
    return laneNotes.length > 0 ? laneNotes.join(" | ") : undefined;
  })();

  // $0 pass-through items for pizza-bowl bookings sent alongside lineItems to
  // /api/bowling/v2/reserve as rawItems.  One Pizza Bowl Pizza + one Pizza Bowl
  // Soda Pitcher per lane, with the customer's selections as item notes.
  // These are $0 catalog items that must appear as separate Square order lines
  // so staff can see the exact pizza topping + soda choice on each item.
  // Notes (not applied_modifiers) are used because Square only applies
  // modifiers when the group is explicitly configured on the catalog item.
  const pizzaBowlRawItems = isPizzaBowl
    ? pizzaModifierSelections.flatMap((sel, laneIdx) => {
        const pizzaNote = buildPizzaNote(sel, pizzaModifierGroups);
        const sodaNote = buildSodaNote(sel, pizzaModifierGroups);
        const prefix = laneCount > 1 ? `Lane ${laneIdx + 1}: ` : "";
        return [
          {
            catalogObjectId: PIZZA_BOWL_PIZZA_CATALOG_ID,
            name: "Pizza Bowl Pizza",
            quantity: 1,
            ...(pizzaNote ? { note: `${prefix}${pizzaNote}` } : {}),
          },
          {
            catalogObjectId: PIZZA_BOWL_SODA_CATALOG_ID,
            name: "Pizza Bowl Soda Pitcher",
            quantity: 1,
            ...(sodaNote ? { note: `${prefix}${sodaNote}` } : {}),
          },
        ];
      })
    : [];

  // Line items sent to /api/bowling/v2/reserve.
  // Pizza bowl: one base item per lane (note only — modifiers go on rawItems above).
  // All other experiences: multiply quantity by qtyMultiplier (lanes or players).
  // Hourly experiences: use override product if the selected duration specifies one,
  // and apply the duration multiplier to the primary bowling item.
  const lineItems = [
    ...(isPizzaBowl
      ? pizzaModifierSelections.flatMap((_sel, _laneIdx) => {
          // No note on the base item — selections appear as notes on the
          // $0 Pizza Bowl Pizza / Soda Pitcher items (see pizzaBowlRawItems).
          return baseItems.map((item) => ({
            squareProductId: item.squareProductId,
            quantity: item.quantity,
          }));
        })
      : baseItems.map((item) => {
          // For the primary bowling item (sortOrder 0), use the duration
          // option's override product (e.g. 1hr item for 2hr bookings)
          // and apply the duration multiplier.
          const useOverride =
            item.sortOrder === 0 && selectedDurationOpt?.overrideSquareProductId != null;
          return {
            squareProductId: useOverride
              ? selectedDurationOpt!.overrideSquareProductId!
              : item.squareProductId,
            quantity:
              item.sortOrder === 0
                ? item.quantity * qtyMultiplier * durationMultiplier
                : item.quantity * laneCount,
          };
        })),
    ...shoeProducts
      .filter((p) => (shoeQty[p.id] ?? 0) > 0)
      .map((p) => ({ squareProductId: p.id, quantity: shoeQty[p.id] })),
  ];

  // ── Date bookability helpers ─────────────────────────────────────

  function isBookableDate(dateStr: string): boolean {
    if (kind === "kbf") return isKbfBookableDate(dateStr);
    const earliest = effectiveToday();
    const max = addDays(todayYmd(), 30);
    if (dateStr < earliest || dateStr > max) return false;
    // Layer the discount-code's date window + weekday filter on top of the
    // normal booking window. When no code is applied this is a no-op.
    if (
      appliedDiscount &&
      !dateMatchesDiscount(
        dateStr,
        appliedDiscount.allowedWeekdays,
        appliedDiscount.expiresAt,
        appliedDiscount.startsAt,
      )
    ) {
      return false;
    }
    return true;
  }

  /**
   * True when an applied discount has zero bookable days left in the next
   * 30-day window. Surface as a banner so the user understands why every
   * day is greyed out, instead of staring at a blank calendar wondering
   * what they did wrong.
   */
  const discountHasNoEligibleDays = (() => {
    if (!appliedDiscount) return false;
    if (kind === "kbf") return false; // KBF has its own bookable-date logic; discounts don't apply
    const start = effectiveToday();
    for (let i = 0; i <= 30; i++) {
      const d = addDays(start, i);
      if (
        dateMatchesDiscount(
          d,
          appliedDiscount.allowedWeekdays,
          appliedDiscount.expiresAt,
          appliedDiscount.startsAt,
        )
      ) {
        return false;
      }
    }
    return true;
  })();

  function getFilteredHours(dateStr: string): number[] {
    // Derive open/close from HP_LOCATIONS for this center + day-of-week.
    // e.g. Sun-Thu → 11 AM–midnight (11–23), Fri-Sat → 11 AM–2 AM (11–25).
    const { open, close } = centerHoursForDate(center.hpSlug, dateStr);
    // Hour chips: [open, open+1, ..., close-1]  (close hour is not a valid start)
    let filtered = Array.from({ length: close - open }, (_, i) => i + open);

    // KBF Friday: further cap at 5 PM (KBF sessions end before the center stays open late)
    if (kind === "kbf") {
      const dow = dateStr ? new Date(`${dateStr}T12:00:00`).getDay() : 4;
      if (dow === 5) filtered = filtered.filter((h) => h < 17);
    }

    // Today: hide hours where every slot is < 15 min from now.
    // An hour chip stays visible if its last slot (h:45) is still >= 15 min away.
    // Individual minute chips within that hour are filtered separately in the UI.
    const today = todayYmd();
    const nowMins = etNowMinutes();
    if (dateStr === today) {
      const cutoffMins = nowMins + 15;
      filtered = filtered.filter((h) => h * 60 + 45 >= cutoffMins);
    } else if (dateStr < today && nowMins < 120) {
      // Post-midnight window: booking for yesterday's late-night slots.
      // Convert current time to 24+ representation (midnight=1440, 1:15AM=1515, …)
      const cutoffMins = nowMins + 24 * 60 + 15;
      filtered = filtered.filter((h) => h * 60 + 45 >= cutoffMins);
    }

    return filtered;
  }

  // ── Load experiences when center changes ─────────────────────────
  // Fetches active experiences for this center+kind from the DB.
  // Results drive the QAMF offer IDs used in fetchSlots, offer card
  // rendering, and line item construction.

  useEffect(() => {
    setExperiences([]);
    setExperiencesLoading(true);
    void (async () => {
      try {
        // KBF wizard: filter strictly to kbf kind.
        // Open bowling wizard: fetch all and exclude kbf — captures both
        // 'open' (Fun 4 All) and 'hourly' (Mon-Thur lane rental) experiences.
        const kindParam = kind === "kbf" ? "&kind=kbf" : "";
        const res = await fetch(
          `/api/bowling/v2/experiences?centerCode=${center.squareCenterCode}${kindParam}`,
        );
        const data = await res.json();
        const all: BowlingExperienceWithDetails[] = Array.isArray(data) ? data : [];
        setExperiences(kind === "kbf" ? all : all.filter((e) => e.kind !== "kbf"));
      } catch {
        setExperiences([]);
      } finally {
        setExperiencesLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center.squareCenterCode, kind]);

  // ── KBF: auto-deselect adults when last kid is removed ───────────

  useEffect(() => {
    if (kind !== "kbf") return;
    const anyKid = bowlerSelections.some((b) => b.relation === "kid" && b.selected);
    if (anyKid) return;
    const hasSelectedAdult = bowlerSelections.some((b) => b.relation !== "kid" && b.selected);
    if (!hasSelectedAdult) return;
    setBowlerSelections((prev) =>
      prev.map((b) => (b.relation !== "kid" && b.selected ? { ...b, selected: false } : b)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bowlerSelections.map((b) => `${b.key}:${b.selected}`).join(","), kind]);

  // ── Fetch availability ────────────────────────────────────────────

  const fetchSlots = useCallback(
    async (
      date: string,
      opts?: { forPlayerCount?: number; hour?: number; minute?: number; webOfferId?: number },
    ) => {
      const count = opts?.forPlayerCount ?? activePlayerCount;
      setSlotsLoading(true);
      setSlotsError(null);
      setAvailableSlots([]);
      setSelectedSlot(null);
      // Do NOT reset selectedHour/selectedMinute here — we want to preserve the
      // user's time selection while the fetch runs so the UI stays filled in.

      type RawSlot = {
        BookedAt: string;
        WebOffer: {
          Id: number;
          Title: string;
          Description?: string;
          Options?: {
            Game?: { Id: number; GamesPerPlayer?: number }[];
            Time?: { Id: number }[];
            Unlimited?: { Id: number }[];
          };
        };
      };

      function parseRaw(raw: RawSlot[]): AvailabilitySlot[] {
        // Server already filters to valid offers for this day-of-week.
        // Client just maps to our internal slot type.
        return raw.map((a) => {
          const gameOpts = a.WebOffer.Options?.Game ?? [];
          const twoGame = gameOpts.find((g) => g.GamesPerPlayer === 2) ?? gameOpts[0];
          const timeOpts = a.WebOffer.Options?.Time ?? [];
          const unlimOpts = a.WebOffer.Options?.Unlimited ?? [];
          let optionId: number | undefined;
          let optionType: "Game" | "Time" | "Unlimited" | undefined;
          if (twoGame) {
            optionId = twoGame.Id;
            optionType = "Game";
          } else if (timeOpts[0]) {
            optionId = timeOpts[0].Id;
            optionType = "Time";
          } else if (unlimOpts[0]) {
            optionId = unlimOpts[0].Id;
            optionType = "Unlimited";
          }
          return {
            bookedAt: a.BookedAt,
            webOfferId: a.WebOffer.Id,
            webOfferTitle: a.WebOffer.Title,
            webOfferDescription: a.WebOffer.Description,
            optionId,
            optionType,
          };
        });
      }

      // Server handles daysOfWeek filtering via DB lookup.
      // Targeted mode (hour+minute) probes a ±5h window — fast (~1 batch of 8
      // QAMF calls) and the common path. Full-day mode probes every 15 min from
      // open to close — slower but exhaustive. We fall back to full-day below
      // when targeted returns no slot at the user's exact selected time.
      async function probe(targeted: boolean): Promise<AvailabilitySlot[]> {
        let url = `/api/bowling/v2/availability?centerId=${center.qamfId}&players=${Math.max(count, 1)}&startDate=${date}`;
        // KBF wizard: scope to kbf offers only.
        // Open bowling wizard: pass kind=open,hourly so the server excludes KBF
        // from validOfferIds. Without this, KBF-offer slots flow through but
        // contribute to no tier (client filters kbf out of experiences[]),
        // poisoning the "next available" fallback with phantom unmatched slots.
        if (kind === "kbf") url += `&kind=kbf`;
        else url += `&kind=open,hourly`;
        if (opts?.webOfferId) url += `&webOfferId=${opts.webOfferId}`;
        if (targeted && opts?.hour !== undefined && opts?.minute !== undefined) {
          url += `&hour=${opts.hour}&minute=${opts.minute}`;
        }
        // First request after a deploy can hit a cold Lambda / cold QAMF
        // auth and return 502 from the route's all-probes-failed guard.
        // Vercel may also spin up additional cold instances under load, so
        // subsequent requests can hit fresh cold workers — retry a few
        // times with growing backoff to cover that case before surfacing
        // a "no slots" UX that's actually an upstream blip.
        const backoffs = [600, 1500, 2500];
        let lastStatus = 0;
        for (let attempt = 0; attempt < backoffs.length; attempt++) {
          const res = await fetch(url);
          if (res.ok) {
            const data = (await res.json()) as { Availabilities?: RawSlot[]; error?: string };
            return parseRaw(data.Availabilities ?? []);
          }
          lastStatus = res.status;
          const retryable = res.status === 502 || res.status === 503 || res.status === 504;
          const last = attempt === backoffs.length - 1;
          if (!retryable || last) break;
          await new Promise((r) => setTimeout(r, backoffs[attempt]));
        }
        throw new Error(`Availability request failed: ${lastStatus}`);
      }

      try {
        const merged = await probe(true);

        // Widen to full-day if the targeted ±5h probe missed the user's exact
        // selected time. Without this, the offer step renders "No more
        // availability today" against a stale window — e.g. user picks 1 PM,
        // window covers 8 AM–6 PM, real slots from 9 PM are invisible.
        // Skip widen when no time was selected (probe was already full-day).
        if (
          opts?.hour !== undefined &&
          opts?.minute !== undefined &&
          !merged.some(
            (s) =>
              slotHourET(s.bookedAt, date) === opts.hour &&
              slotMinuteET(s.bookedAt) === opts.minute,
          )
        ) {
          try {
            const fullDay = await probe(false);
            const seen = new Set(merged.map((s) => `${s.bookedAt}::${s.webOfferId}`));
            for (const s of fullDay) {
              const k = `${s.bookedAt}::${s.webOfferId}`;
              if (!seen.has(k)) {
                merged.push(s);
                seen.add(k);
              }
            }
          } catch (err) {
            // Keep targeted results — partial is better than nothing.
            console.warn(
              "[bowling-wizard] widen probe failed:",
              err instanceof Error ? err.message : err,
            );
          }
        }

        setAvailableSlots(merged);
        lastFetchKey.current = `${date}:${count}:${opts?.hour ?? ""}:${opts?.minute ?? ""}`;

        if (merged.length === 0) {
          setSlotsError("No slots available for this date. Try another date.");
        }
      } catch (err) {
        setSlotsError(err instanceof Error ? err.message : "Failed to load slots");
      } finally {
        setSlotsLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [center.qamfId, activePlayerCount, kind],
  );

  // On entering the slots step: reset time selection and clear stale slot data.
  // Availability is NOT fetched here — it's deferred to the "See Packages" click
  // so the calendar renders instantly with no loading spinner.
  // Reschedule (any experience) still fetches immediately since it needs slots inline.
  useEffect(() => {
    if (step !== "slots" && step !== "reschedule") return;
    if (experiencesLoading) return;

    setSelectedHour(null);
    setSelectedMinute(null);
    setAvailableSlots([]);
    setSlotsError(null);
    // Drop the fetch cache key too — otherwise re-picking the same time
    // after Back skips the fetch and renders against an empty slot list.
    lastFetchKey.current = "";

    if (step === "reschedule") {
      void fetchSlots(selectedDate, { forPlayerCount: existingReservation?.playerCount ?? 1 });
    }
    // slots step: no fetch — deferred to "See Packages"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, experiencesLoading]);

  // ── Fetch shoe products ───────────────────────────────────────────

  useEffect(() => {
    if (step !== "shoes") return;
    (async () => {
      try {
        const res = await fetch(
          `/api/bowling/v2/square-products?centerCode=${center.squareCenterCode}&kind=addon_shoe`,
        );
        const data = (await res.json()) as BowlingSquareProduct[];
        if (!res.ok) return;
        setShoeProducts(Array.isArray(data) ? data : []);
        if (Array.isArray(data) && data.length > 0) {
          // Default one pair per bowler — user can adjust down
          setShoeQty({ [data[0].id]: activePlayerCount });
        }
      } catch {
        // Non-fatal
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ── Fetch Square modifier groups for pizza-bowl experiences ─────
  // Runs whenever the selected experience changes. Clears previous groups/
  // selections if the new experience is not a pizza-bowl package.

  useEffect(() => {
    if (!isPizzaBowl) {
      setPizzaModifierGroups([]);
      setPizzaModifierSelections([{}]);
      return;
    }

    // Prefer squareModifierListIds stored on the experience (avoids Square
    // catalog item permission issues). Fall back to catalog object lookup
    // when present.
    const modifierListIds = selectedExperience?.squareModifierListIds ?? [];
    const catalogObjectId = selectedExperience?.items.find(
      (i) => i.squareCatalogObjectId,
    )?.squareCatalogObjectId;

    if (modifierListIds.length === 0 && !catalogObjectId) return;

    const url =
      modifierListIds.length > 0
        ? `/api/bowling/v2/catalog-modifiers?modifierListIds=${encodeURIComponent(modifierListIds.join(","))}`
        : `/api/bowling/v2/catalog-modifiers?catalogObjectId=${encodeURIComponent(catalogObjectId!)}`;

    setPizzaModifiersLoading(true);
    void (async () => {
      try {
        const res = await fetch(url);
        const data = (await res.json()) as ModifierGroup[];
        if (res.ok && Array.isArray(data)) {
          setPizzaModifierGroups(data as ModifierGroup[]);
          // Reset selections when experience changes
          setPizzaModifierSelections([{}]);
        }
      } catch {
        // Non-fatal — modifiers are a convenience, booking proceeds without them
      } finally {
        setPizzaModifiersLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedExperience?.slug]);

  // ── Resize pizza modifier selections when derived laneCount changes ─
  // Keeps one Record per lane so per-lane modifier UI stays in sync.

  useEffect(() => {
    if (!isPizzaBowl) return;
    setPizzaModifierSelections((prev) => {
      if (laneCount === prev.length) return prev;
      if (laneCount > prev.length)
        return [...prev, ...Array.from({ length: laneCount - prev.length }, () => ({}))];
      return prev.slice(0, laneCount);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneCount]);

  // ── Clear attraction add-ons when bowling date changes ─────────────
  // BMI bookings are date-specific — if the user goes back and picks
  // a different bowling date, stale attraction slots must be dropped.
  const prevDateRef = useRef(selectedDate);
  useEffect(() => {
    if (selectedDate !== prevDateRef.current) {
      prevDateRef.current = selectedDate;
      if (attractionAddons.length > 0) setAttractionAddons([]);
    }
  }, [selectedDate, attractionAddons.length]);

  // ── Clear stale quote when user backs up to shoes step ────────────

  useEffect(() => {
    if (step === "shoes" || step === "attractions") {
      setQuoteDayofOrderId(null);
      setQuoteTotalCents(0);
      setQuoteDepositCents(0);
      setQuoteDiscountOffCents(0);
      setQuoteDiscountCode(null);
      setQuoteError(null);
      return;
    }
    if (step !== "review") return;
    if (lineItems.length === 0) return;

    setQuoteLoading(true);
    setQuoteError(null);

    const sqLineItems = [
      ...(isPizzaBowl
        ? pizzaModifierSelections.flatMap((sel, laneIdx) => {
            const pizzaNote = buildPizzaNote(sel, pizzaModifierGroups);
            const sodaNote = buildSodaNote(sel, pizzaModifierGroups);
            const prefix = laneCount > 1 ? `Lane ${laneIdx + 1}: ` : "";
            return [
              // Base pizza-bowl item — no note (selections live on the $0 items below)
              ...baseItems.map((item) => ({
                name: item.label,
                quantity: String(item.quantity),
                catalogObjectId: item.squareCatalogObjectId,
              })),
              // Pizza Bowl Pizza $0 item — customer's topping choice as a note
              {
                name: "Pizza Bowl Pizza",
                quantity: "1",
                catalogObjectId: PIZZA_BOWL_PIZZA_CATALOG_ID,
                ...(pizzaNote ? { note: `${prefix}${pizzaNote}` } : {}),
              },
              // Pizza Bowl Soda Pitcher $0 item — customer's soda choice as a note
              {
                name: "Pizza Bowl Soda Pitcher",
                quantity: "1",
                catalogObjectId: PIZZA_BOWL_SODA_CATALOG_ID,
                ...(sodaNote ? { note: `${prefix}${sodaNote}` } : {}),
              },
            ];
          })
        : baseItems.map((item) => {
            // For the primary bowling item (sortOrder 0), use duration override
            // product and apply duration multiplier (e.g. 2× 1hr item for 2hr).
            const useOverride =
              item.sortOrder === 0 && selectedDurationOpt?.overrideCatalogObjectId != null;
            return {
              name: useOverride
                ? selectedDurationOpt!.overrideCatalogObjectId
                  ? item.label.replace(/1\.5\s*Hr/i, "1 Hr")
                  : item.label
                : item.label,
              quantity: String(
                item.sortOrder === 0
                  ? item.quantity * qtyMultiplier * durationMultiplier
                  : item.quantity * laneCount,
              ),
              catalogObjectId: useOverride
                ? selectedDurationOpt!.overrideCatalogObjectId!
                : item.squareCatalogObjectId,
              ...(selectedModifiers.length > 0 ? { modifiers: selectedModifiers } : {}),
            };
          })),
      ...shoeProducts
        .filter((p) => (shoeQty[p.id] ?? 0) > 0)
        .map((p) => ({
          name: p.label,
          quantity: String(shoeQty[p.id]),
          catalogObjectId: p.squareCatalogObjectId,
        })),
      // Attraction add-ons (laser tag / gel blaster) — full-price catalog items
      ...attractionAddons
        .filter((a) => a.squareCatalogObjectId)
        .map((a) => ({
          name: `${a.name} · ${a.timeLabel}`,
          quantity: String(a.quantity),
          catalogObjectId: a.squareCatalogObjectId!,
        })),
      // Booking fee ($2.99)
      ...(hasBookingFee
        ? [{ name: "Booking Fee", quantity: "1", catalogObjectId: BOOKING_FEE_CATALOG_ID }]
        : []),
    ];

    const preTaxDeposit = preTaxDepositCents;
    const preTaxTotal = preTaxTotalCents;
    const depositPct = preTaxTotal > 0 ? Math.round((preTaxDeposit / preTaxTotal) * 100) : 100;

    void (async () => {
      try {
        const res = await fetch("/api/square/bowling-orders/quote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            locationId: center.squareCenterCode,
            lineItems: sqLineItems,
            depositPct,
            // Attach loyalty customer so the day-of order has customer_id from creation
            ...(loyaltyCustomer?.id ? { squareCustomerId: loyaltyCustomer.id } : {}),
            // Discount code (server re-validates and tells Square; the % off
            // is reflected in the dayofTotal Square returns, NOT something
            // we compute client-side).
            ...(appliedDiscount && selectedDate
              ? { discountCode: appliedDiscount.code, bookingDate: selectedDate }
              : {}),
          }),
        });
        const data = (await res.json()) as {
          dayofOrderId?: string;
          dayofTotalCents?: number;
          depositCents?: number;
          appliedDiscount?: { code: string; amountOffCents: number };
          discountError?: string;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? "Failed to get price");
        setQuoteDayofOrderId(data.dayofOrderId ?? null);
        setQuoteTotalCents(data.dayofTotalCents ?? 0);
        setQuoteDepositCents(data.depositCents ?? 0);
        setQuoteDiscountOffCents(data.appliedDiscount?.amountOffCents ?? 0);
        setQuoteDiscountCode(data.appliedDiscount?.code ?? null);
        // If the server tells us the discount stopped applying since the user
        // entered it (date drifted past expiry, code deactivated, etc.) drop
        // the applied chip so the displayed price matches reality.
        if (data.discountError && appliedDiscount) {
          setAppliedDiscount(null);
          setDiscountError(discountReasonMessage(data.discountError, appliedDiscount.code));
        }
      } catch (err) {
        setQuoteError(err instanceof Error ? err.message : "Failed to load price");
      } finally {
        setQuoteLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ── KBF: lookup ───────────────────────────────────────────────────

  function formatPhoneDisplay(raw: string): string {
    const d = raw.replace(/\D/g, "").slice(0, 10);
    if (d.length < 4) return d;
    if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }

  async function handleLookup() {
    const resolved = lookupTab === "phone" ? phoneInput.replace(/\D/g, "") : emailInput.trim();
    if (!resolved) return;
    if (lookupTab === "email" && !resolved.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }
    if (lookupTab === "phone" && resolved.length !== 10) {
      setError("Please enter a 10-digit phone number.");
      return;
    }
    setContact(resolved);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/kbf/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contact: resolved, centerId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Lookup failed");
      setChannel(data.channel);
      setMaskedDest(data.maskedDest ?? "");
      setStep("verify");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  }

  // ── KBF: verify ───────────────────────────────────────────────────

  async function handleVerify() {
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/kbf/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contact: contact.trim(), code: code.trim(), centerId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Verification failed");

      const p: PassWithMembers | undefined = (data.passes as PassWithMembers[])?.[0];
      if (!p) throw new Error("No pass found for this account.");
      setPass(p);

      // Build bowler list: kids are always free. Adults are free only
      // when the account has Families Bowl Free (fpass). Non-FBF adults
      // are excluded from the free list — they can be added as paid
      // adults ($5/$6 per game) via the "Add Adult" button.
      const hasFbf = p.fpass === true;
      const selections: BowlerSelection[] = (p.members ?? [])
        .filter((m) => m.relation === "kid" || hasFbf)
        .map((m) => ({
          key: `${m.relation}:${m.passId}:${m.slot}`,
          displayName: `${m.firstName} ${m.lastName}`,
          relation: m.relation,
          selected: m.relation === "kid", // auto-select kids, not adults
          wantBumpers: m.prefs?.wantBumpers ?? true,
          kbfPassId: m.passId,
          kbfMemberSlot: m.slot,
          kbfRelation: m.relation,
          isPaid: false,
        }));
      // Account holder: free if FBF, otherwise not in the free list
      if (hasFbf) {
        selections.unshift({
          key: "parent",
          displayName: `${p.firstName} ${p.lastName}`,
          relation: "parent",
          selected: false,
          wantBumpers: false,
          isPaid: false,
        });
      }
      setBowlerSelections(selections);
      setGuestName(`${p.firstName} ${p.lastName}`);
      setGuestEmail(p.email);
      setGuestPhone(p.phone ?? "");

      // Check for an existing future KBF reservation
      try {
        const checkRes = await fetch(
          `/api/bowling/v2/my-reservations?email=${encodeURIComponent(p.email)}`,
        );
        if (checkRes.ok) {
          const checkData = (await checkRes.json()) as { reservation: ExistingReservation | null };
          if (checkData.reservation) {
            setExistingReservation(checkData.reservation);
            const existingCenter = CENTER_BY_CODE[checkData.reservation.centerCode];
            if (existingCenter) setCenterId(existingCenter.id);
            setStep("existing");
            return;
          }
        }
      } catch {
        // Non-fatal
      }

      setStep("bowlers");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  // ── KBF: cancel existing reservation ─────────────────────────────

  const handleCancelReservation = useCallback(async () => {
    if (!existingReservation) return;
    setCancelBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/bowling/v2/reservations/${existingReservation.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Cancel failed");
      setExistingReservation(null);
      setCancelConfirming(false);
      setStep("bowlers");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
      setCancelConfirming(false);
    } finally {
      setCancelBusy(false);
    }
  }, [existingReservation]);

  // ── KBF: reschedule ───────────────────────────────────────────────

  const handleReschedule = useCallback(async () => {
    if (!existingReservation || !selectedSlot) return;
    setBusy(true);
    setError(null);
    setStep("submitting");
    try {
      const res = await fetch(`/api/bowling/v2/reservations/${existingReservation.id}/reschedule`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bookedAt: selectedSlot.bookedAt,
          webOfferId: selectedSlot.webOfferId,
          optionId: selectedSlot.optionId,
          optionType: selectedSlot.optionType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Reschedule failed");

      // Clear hold ref before navigation to prevent unmount DELETE
      if (holdTimerRef.current) {
        clearInterval(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      holdRef.current = null;
      router.push(
        existingReservation.shortCode
          ? `${confirmationBase}?code=${existingReservation.shortCode}`
          : `${confirmationBase}?neonId=${existingReservation.id}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reschedule failed");
      setStep("reschedule");
    } finally {
      setBusy(false);
    }
  }, [existingReservation, selectedSlot, center.id, confirmationBase, router]);

  // ── Hold: release ────────────────────────────────────────────────
  // Fire-and-forget DELETE to release the QAMF Temporary hold.
  // Safe to call when no hold is active (no-op).

  const releaseHold = useCallback(() => {
    if (!holdRef.current) return;
    const { qamfId, centerId: hCenterId } = holdRef.current;
    holdRef.current = null;
    if (holdTimerRef.current) {
      clearInterval(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    holdExpiresAtRef.current = null;
    holdLastExtendRef.current = 0;
    setHoldActive(false);
    setHoldSecondsLeft(0);
    void fetch(`/api/bowling/v2/reserve/hold/${qamfId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ centerId: hCenterId }),
    }).catch(() => {});
  }, []);

  // ── Hold: refresh countdown on activity ──────────────────────────
  // Resets the 15-min countdown back to MAX, and (throttled) fires a
  // server-side PATCH so the QAMF TTL is also kept fresh sooner than the
  // 8-min keep-alive would. No-op when no hold is active.
  const refreshHoldCountdown = useCallback(() => {
    if (!holdRef.current) return;
    const now = Date.now();
    holdExpiresAtRef.current = now + HOLD_MAX_MS;
    setHoldSecondsLeft(Math.ceil(HOLD_MAX_MS / 1000));
    if (now - holdLastExtendRef.current > HOLD_EXTEND_THROTTLE_MS) {
      holdLastExtendRef.current = now;
      const { qamfId, centerId: hCenterId } = holdRef.current;
      void fetch(`/api/bowling/v2/reserve/hold/${qamfId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ centerId: hCenterId }),
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Hold: create + advance ───────────────────────────────────────
  // Called when the user confirms their slot on the offer step (including
  // after the VIP upgrade modal). Creates a QAMF Temporary hold for the
  // selected slot, starts the 8-min extend timer, then navigates forward.
  // Non-fatal: if the hold API fails we log and advance anyway — /reserve
  // will create a fresh reservation at submit time.

  // ── createHold ──────────────────────────────────────────────────
  // Creates a QAMF Temporary hold for the given slot.
  // Called immediately when the user taps a time chip on the offer step
  // so the hold starts counting before they fill in their details.
  //
  // Returns:
  //   "ok"          — hold created, holdRef set, safe to advance
  //   "unavailable" — slot was taken (409 LanesNotAvailable / "not available");
  //                   caller MUST stay on the offer step or fall back to
  //                   another slot. createHold has already cleared the
  //                   selection, surfaced an inline error, and refetched
  //                   availability for non-VIP callers.
  //   "error"       — transient/network failure; caller may advance and
  //                   let /reserve fall back to a fresh createReservation
  //                   at submit time.
  const createHold = useCallback(
    async (
      slot: AvailabilitySlot,
      opts?: { silent?: boolean },
    ): Promise<"ok" | "unavailable" | "error"> => {
      // Release any in-flight hold before creating a new one
      releaseHold();

      setHoldBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/bowling/v2/reserve/hold", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            centerId: center.qamfId,
            webOfferId: slot.webOfferId,
            optionId: slot.optionId,
            optionType: slot.optionType,
            bookedAt: slot.bookedAt,
            players: activePlayerCount,
            service: "BookForLater",
          }),
        });
        const data = (await res.json()) as { qamfReservationId?: string; error?: string };
        if (!res.ok) {
          const msg = data.error ?? "Hold failed";
          const isLaneUnavailable = /LanesNotAvailable|not available|409|Conflict|sold\s*out/i.test(
            msg,
          );
          if (isLaneUnavailable) {
            // Slot was taken between availability fetch and hold attempt.
            // When `silent` is set (VIP fallback path), the caller will
            // handle messaging/refetch — don't trample its UI.
            if (!opts?.silent) {
              setSelectedSlot(null);
              setError(
                "That time was just taken. We've refreshed the available slots — pick another.",
              );
              void fetchSlots(selectedDate);
            }
            return "unavailable";
          }
          throw new Error(msg);
        }

        holdRef.current = { qamfId: data.qamfReservationId!, centerId: center.qamfId };
        holdExpiresAtRef.current = Date.now() + HOLD_MAX_MS;
        holdLastExtendRef.current = Date.now();
        setHoldSecondsLeft(Math.ceil(HOLD_MAX_MS / 1000));
        setHoldActive(true);

        // Extend every 8 min so the 10-min QAMF TTL never expires
        holdTimerRef.current = setInterval(
          () => {
            if (!holdRef.current) return;
            void fetch(`/api/bowling/v2/reserve/hold/${holdRef.current.qamfId}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ centerId: holdRef.current.centerId }),
            }).catch(() => {});
          },
          8 * 60 * 1000,
        );
        return "ok";
      } catch (err) {
        // Non-fatal — submit will fall back to fresh createReservation
        console.warn("[BowlingWizard] hold creation failed:", err);
        return "error";
      } finally {
        setHoldBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [center.qamfId, activePlayerCount, releaseHold, fetchSlots, selectedDate],
  );

  // Used by VIP upgrade modal — awaits hold creation, then advances only
  // if the hold succeeded.
  //
  // When the primary slot is unavailable (e.g. someone snagged the VIP
  // lane between the modal opening and the user tapping Upgrade), and a
  // `fallbackSlot` is provided (the regular slot the user already had
  // selected), we silently try the fallback and still advance. This
  // matches the "VIP no longer available, just move on" UX.
  //
  // If no fallback is provided, or the fallback is also unavailable,
  // createHold has cleared the selection / refetched / shown an inline
  // error; we do NOT advance.
  const createHoldAndAdvance = useCallback(
    async (
      slot: AvailabilitySlot,
      incShoes: boolean,
      isPerLaneExp: boolean,
      fallback?: {
        slot: AvailabilitySlot;
        incShoes: boolean;
        isPerLaneExp: boolean;
        onFallback?: () => void;
      },
    ) => {
      let result = await createHold(slot);
      let effectiveIncShoes = incShoes;

      if (result === "unavailable" && fallback) {
        // VIP slot gone — silently fall back to the regular slot the user
        // had picked before opening the upgrade modal. createHold(silent)
        // suppresses the "time was just taken" banner so the fallback is
        // seamless.
        fallback.onFallback?.();
        result = await createHold(fallback.slot, { silent: true });
        effectiveIncShoes = fallback.incShoes;
      }

      if (result !== "ok") return;
      // Per-lane experiences only skip the shoes step when shoes are actually
      // included in the package (e.g. pizza-bowl). Hourly per-lane rentals
      // still need the shoes step.
      setStep(effectiveIncShoes ? "attractions" : "shoes");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [createHold],
  );

  // ── Hold: cleanup on unmount ─────────────────────────────────────

  useEffect(() => {
    return () => {
      if (holdTimerRef.current) clearInterval(holdTimerRef.current);
      if (holdRef.current) {
        const { qamfId, centerId: hCenterId } = holdRef.current;
        void fetch(`/api/bowling/v2/reserve/hold/${qamfId}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ centerId: hCenterId }),
        }).catch(() => {});
      }
    };
  }, []);

  // ── Hold: refresh on step change ────────────────────────────────
  // Advancing or going back is a strong "user is engaged" signal — reset
  // the 15-min countdown so we don't expire someone mid-checkout.
  useEffect(() => {
    if (!holdActive) return;
    refreshHoldCountdown();
  }, [step, holdActive, refreshHoldCountdown]);

  // ── Hold: refresh on user interaction ───────────────────────────
  // Any pointer/key/scroll activity resets the countdown. Throttled
  // server-side PATCH lives in refreshHoldCountdown.
  useEffect(() => {
    if (!holdActive) return;
    const handler = () => refreshHoldCountdown();
    window.addEventListener("pointerdown", handler, { passive: true });
    window.addEventListener("keydown", handler);
    window.addEventListener("scroll", handler, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", handler);
      window.removeEventListener("keydown", handler);
      window.removeEventListener("scroll", handler);
    };
  }, [holdActive, refreshHoldCountdown]);

  // ── Hold: 1-second tick + auto-expire ───────────────────────────
  // When the countdown hits zero we release the QAMF hold and reload the
  // wizard back to the start — the user can't pay for a slot we no
  // longer own.
  useEffect(() => {
    if (!holdActive) return;
    const tick = setInterval(() => {
      if (!holdExpiresAtRef.current) return;
      const secs = Math.max(0, Math.ceil((holdExpiresAtRef.current - Date.now()) / 1000));
      setHoldSecondsLeft(secs);
      if (secs === 0) {
        // Release hold and refresh the wizard back to the beginning
        releaseHold();
        if (typeof window !== "undefined") {
          window.location.reload();
        }
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [holdActive, releaseHold]);

  // ── HeadPinz Rewards helpers ────────────────────────────────────

  const phoneDigits = useCallback((phone: string) => phone.replace(/\D/g, ""), []);

  /** Look up loyalty account once phone has 10 digits */
  const handlePhoneLookup = useCallback(async (digits: string) => {
    if (digits.length !== 10) return;
    setPhoneLookupLoading(true);
    setPhoneLookedUp(false);
    try {
      const res = await fetch("/api/square/loyalty/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: digits }),
      });
      const data = await res.json();
      if (data.exists) {
        setLoyaltyAccount(data.account);
        // Customer PII not returned here — only after SMS verification
      } else {
        setLoyaltyAccount(null);
      }
      setLoyaltyCustomer(null);
      setPhoneLookedUp(true);
    } catch {
      // Silently fail — guest can still proceed without rewards
      setPhoneLookedUp(true);
    } finally {
      setPhoneLookupLoading(false);
    }
  }, []);

  /** Send SMS verification code */
  const handleSendVerifyCode = useCallback(async () => {
    const digits = phoneDigits(guestPhone);
    if (digits.length !== 10) return;
    setVerifyStep("sending");
    setVerifyError("");
    try {
      const res = await fetch("/api/sms-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: digits, from: center.smsFrom }),
      });
      const data = await res.json();
      if (data.sent) {
        setVerifyStep("code");
        setVerifyCode(["", "", "", "", "", ""]);
      } else {
        setVerifyError(data.error || "Failed to send code");
        setVerifyStep("idle");
      }
    } catch {
      setVerifyError("Failed to send code");
      setVerifyStep("idle");
    }
  }, [guestPhone, phoneDigits, center.smsFrom]);

  /** Verify the 6-digit code against server */
  const verifyCodeSubmit = useCallback(
    async (codeStr: string) => {
      const digits = phoneDigits(guestPhone);
      setVerifyError("");
      try {
        const res = await fetch("/api/sms-verify", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone: digits,
            code: codeStr,
            // Pass customer ID so the server returns PII only after verified
            squareCustomerId: loyaltyAccount?.customerId,
          }),
        });
        const data = await res.json();
        if (data.verified) {
          setPhoneVerified(true);
          setVerifyStep("verified");
          // Customer PII is returned by sms-verify only after code is correct
          if (data.customer) {
            setLoyaltyCustomer(data.customer);
            const name = [data.customer.firstName, data.customer.lastName]
              .filter(Boolean)
              .join(" ");
            if (name) setGuestName(name);
            if (data.customer.email) setGuestEmail(data.customer.email);
          }
          // Fetch reward tiers so verified members can redeem Pinz
          if (loyaltyAccount) {
            void fetch("/api/square/loyalty/program")
              .then((r) => r.json())
              .then((prog) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const orderTiers = (prog.rewardTiers ?? [])
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  .filter(
                    (t: any) => t.definition?.scope === "ORDER" && t.definition?.fixedDiscountCents,
                  )
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  .map((t: any) => ({
                    id: t.id as string,
                    name: t.name as string,
                    points: t.points as number,
                    discountCents: t.definition.fixedDiscountCents as number,
                  }))
                  .sort((a: { points: number }, b: { points: number }) => a.points - b.points);
                setRewardTiers(orderTiers);
              })
              .catch(() => {});
          }
        } else {
          setVerifyError(data.error || "Incorrect code");
        }
      } catch {
        setVerifyError("Verification failed");
      }
    },
    [guestPhone, phoneDigits, loyaltyAccount?.customerId, loyaltyAccount],
  );

  /** Handle individual code digit input */
  const handleVerifyCodeInput = useCallback(
    (index: number, value: string) => {
      if (!/^\d?$/.test(value)) return;
      setVerifyCode((prev) => {
        const next = [...prev];
        next[index] = value;
        // Auto-submit when all 6 digits entered
        if (value && index === 5 && next.every((d) => d)) {
          void verifyCodeSubmit(next.join(""));
        }
        return next;
      });
      if (value && index < 5) {
        verifyCodeRefs.current[index + 1]?.focus();
      }
    },
    [verifyCodeSubmit],
  );

  const handleVerifyCodeKeyDown = useCallback(
    (index: number, e: React.KeyboardEvent) => {
      if (e.key === "Backspace" && !verifyCode[index] && index > 0) {
        verifyCodeRefs.current[index - 1]?.focus();
      }
    },
    [verifyCode],
  );

  const handleVerifyCodePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
      if (pasted.length === 6) {
        e.preventDefault();
        const newCode = pasted.split("");
        setVerifyCode(newCode);
        verifyCodeRefs.current[5]?.focus();
        void verifyCodeSubmit(pasted);
      }
    },
    [verifyCodeSubmit],
  );

  /** Enroll new customer in HeadPinz Rewards */
  const handleRewardsEnroll = useCallback(async () => {
    const digits = phoneDigits(guestPhone);
    setEnrolling(true);
    try {
      const res = await fetch("/api/square/loyalty/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: digits }),
      });
      const data = await res.json();
      if (data.account) {
        setLoyaltyAccount(data.account);
        setLoyaltyCustomer(data.customer);
        setLoyaltyIsNewSignup(true);
        setRewardsSignup(false);
        // Complete profile with name + email if already provided
        if (guestName && data.account?.id && data.customer?.id) {
          const parts = guestName.trim().split(/\s+/);
          const firstName = parts[0] || "";
          const lastName = parts.slice(1).join(" ") || "";
          if (firstName && lastName) {
            void fetch("/api/square/loyalty/complete-profile", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                customerId: data.customer.id,
                loyaltyAccountId: data.account.id,
                firstName,
                lastName,
                email: guestEmail || undefined,
              }),
            })
              .then((r) => r.json())
              .then((d) => {
                if (d.account) setLoyaltyAccount(d.account);
              })
              .catch(() => {});
          }
        }
      }
    } catch {
      // Silently fail — booking continues without rewards
    } finally {
      setEnrolling(false);
    }
  }, [guestPhone, guestName, guestEmail, phoneDigits]);

  // ── Submit ────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (tender?: { cardToken?: string; giftCardNonce?: string }) => {
      if (!selectedSlot) return;
      const squareToken = tender?.cardToken;
      const giftCardNonce = tender?.giftCardNonce;
      setBusy(true);
      setPaymentError(null);
      setStep("submitting");

      try {
        void fetch("/api/clickwrap/record", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ts: new Date().toISOString(),
            email: guestEmail,
            phone: guestPhone,
            firstName: guestName.split(" ")[0] || guestName,
            amountCents: effectiveDepositCents,
            bookingType: "attractions",
            policyVersion: CURRENT_POLICY_VERSION,
          }),
        }).catch(() => {});

        const players =
          kind === "kbf"
            ? kbfBowlers.map((b) => ({
                name: b.displayName,
                kbfPassId: b.kbfPassId ?? null,
                kbfMemberSlot: b.kbfMemberSlot ?? null,
                kbfRelation: b.kbfRelation ?? null,
                isPaidAdult: b.isPaid === true,
              }))
            : Array.from({ length: playerCount }, (_, i) => ({ name: `Bowler ${i + 1}` }));

        const kbfPaidCount = kind === "kbf" ? kbfBowlers.filter((b) => b.isPaid).length : 0;
        const notes =
          kind === "kbf"
            ? `${pass?.fpass ? "Families Bowl Free" : "Kids Bowl Free"} - ${kbfBowlers.map((b) => b.displayName).join(" - ")}${kbfPaidCount > 0 ? `. ${kbfPaidCount} paid adult(s)` : ""}. Coupons verified online.`
            : undefined;

        const res = await fetch("/api/bowling/v2/reserve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            centerId: center.qamfId,
            kind,
            webOfferId: selectedSlot.webOfferId,
            optionId: selectedSlot.optionId ?? selectedExperience?.qamfOptionId ?? undefined,
            optionType: selectedSlot.optionType ?? selectedExperience?.qamfOptionType ?? undefined,
            bookedAt: selectedSlot.bookedAt,
            service: "BookForLater",
            players,
            guest: { name: guestName, email: guestEmail, phone: guestPhone },
            lineItems,
            // Booking fee on non-$0 reservations
            ...(hasBookingFee ? { bookingFee: true } : {}),
            // $0 pizza/soda items — must be separate Square order line items
            ...(pizzaBowlRawItems.length > 0 ? { rawItems: pizzaBowlRawItems } : {}),
            // Extra topping surcharge (1 free per lane, $1 each extra)
            ...(extraToppingsCents > 0 ? { extraToppingsCents } : {}),
            squareToken,
            ...(giftCardNonce ? { giftCardNonce } : {}),
            locationId: center.squareCenterCode,
            notes,
            smsOptIn,
            // Link loyalty account to the Square day-of order for point accrual
            ...(loyaltyCustomer?.id ? { squareCustomerId: loyaltyCustomer.id } : {}),
            // Track loyalty action for admin reporting
            ...(loyaltyCustomer?.id
              ? { loyaltyAction: loyaltyIsNewSignup ? "signup" : "existing" }
              : {}),
            // Always send loyalty account ID so reserve can accrue points
            ...(loyaltyAccount?.id ? { loyaltyAccountId: loyaltyAccount.id } : {}),
            // Loyalty reward redemption — server creates + redeems reward, charges reduced deposit
            ...(selectedRewardTier
              ? {
                  rewardTierId: selectedRewardTier.id,
                  rewardDiscountCents: selectedRewardTier.discountCents,
                }
              : {}),
            // Attraction add-ons booked on BMI (included in Square order)
            ...(attractionAddons.length > 0
              ? {
                  attractionBookings: attractionAddons.map((a) => ({
                    slug: a.slug,
                    name: a.name,
                    bmiOrderId: a.bmiOrderId,
                    bmiBillLineId: a.bmiBillLineId,
                    squareCatalogObjectId: a.squareCatalogObjectId,
                    quantity: a.quantity,
                    totalPriceDollars: a.totalPrice,
                    timeSlot: a.block.start,
                    timeLabel: a.timeLabel,
                  })),
                }
              : {}),
            // Pass existing hold ID so reserve route confirms it instead of
            // creating a duplicate QAMF reservation
            ...(holdRef.current?.qamfId ? { qamfReservationId: holdRef.current.qamfId } : {}),
            ...(quoteDayofOrderId
              ? {
                  dayofOrderId: quoteDayofOrderId,
                  dayofTotalCents: quoteTotalCents,
                  // Send the reduced deposit so bowling-orders charges the right amount
                  depositCents: Math.max(0, (quoteDepositCents ?? 0) - rewardDiscountCents),
                }
              : {}),
            // Discount code carried through to reserve for final re-validation
            // and redemption logging. The dayofOrder already has the Square
            // discount attached from the quote step; this lets the server
            // hard-fail if the code became invalid between quote and submit.
            ...(appliedDiscount && selectedDate
              ? { discountCode: appliedDiscount.code, bookingDate: selectedDate }
              : {}),
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          // If the server couldn't create the loyalty reward, clear the
          // selection so the customer can retry without it (proceeds to
          // payment step for the full deposit) or try again.
          if (data.code === "REWARD_FAILED") {
            setSelectedRewardTier(null);
            setError(data.error ?? "Reward couldn't be applied.");
            setStep("details");
            return;
          }
          const detail = data.code ? ` (${data.code}${data.detail ? `: ${data.detail}` : ""})` : "";
          throw new Error((data.error ?? "Reservation failed") + detail);
        }

        // Clear the hold ref BEFORE navigating away so the unmount cleanup
        // doesn't fire a DELETE against the now-confirmed QAMF reservation.
        if (holdTimerRef.current) {
          clearInterval(holdTimerRef.current);
          holdTimerRef.current = null;
        }
        holdRef.current = null;

        // Notification (email + SMS) is now fired server-side in the
        // reserve route — no client-side fetch needed.

        // Navigate via short URL if the reserve route returned one;
        // fall back to a plain neonId param (confirmation page fetches everything else).
        const dest = data.shortCode
          ? `${confirmationBase}?code=${data.shortCode}`
          : `${confirmationBase}?neonId=${data.neonId}`;
        router.push(dest);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Reservation failed";
        if (effectiveDepositCents > 0) {
          setPaymentError(msg);
        } else {
          setError(msg);
        }
        setStep(effectiveDepositCents > 0 ? "payment" : "details");
      } finally {
        setBusy(false);
      }
    },
    [
      selectedSlot,
      depositCents,
      effectiveDepositCents,
      center,
      kind,
      kbfBowlers,
      playerCount,
      guestName,
      guestEmail,
      guestPhone,
      lineItems,
      pass,
      router,
      confirmationBase,
      quoteDayofOrderId,
      quoteTotalCents,
      quoteDepositCents,
      smsOptIn,
      loyaltyCustomer,
      selectedRewardTier,
      loyaltyAccount,
      rewardDiscountCents,
    ],
  );

  // ── KBF bookable dates for reschedule picker ─────────────────────

  const kbfBookableDates = kind === "kbf" ? bookableDateRange() : [];

  // ── Step title ───────────────────────────────────────────────────

  const programLabel = kind === "kbf" ? "Kids Bowl Free" : "Open Bowling";

  function stepTitle(): string {
    if (step === "location") return "Confirm Your Center";
    if (step === "lookup") return "Sign In";
    if (step === "verify") return "Verify";
    if (step === "existing") return "You're Already Booked";
    if (step === "reschedule") return "Change Date & Time";
    if (step === "bowlers") return "Who's Bowling?";
    if (step === "players") return "How Many Bowlers?";
    if (step === "slots") return "When Do You Want to Bowl?";
    if (step === "tier") return "Choose Your Experience";
    if (step === "offer") return "Choose a Package";
    if (step === "shoes") return "Add Shoe Rentals";
    if (step === "attractions") return "Level Up Your Visit";
    if (step === "food") return "Add Food & Drinks";
    if (step === "review") return "Review Your Booking";
    if (step === "details") return "Your Details";
    if (step === "payment") return "Payment";
    return "";
  }

  // ── Calendar helpers ─────────────────────────────────────────────

  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const monthName = new Date(calYear, calMonth).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });

  // ── Render ───────────────────────────────────────────────────────

  return (
    <>
      <HeadPinzNav />
      <main className="min-h-screen pt-28 sm:pt-32 pb-16 px-4" style={{ backgroundColor: BG }}>
        <div className="mx-auto max-w-4xl">
          {/* Header */}
          {step !== "submitting" && (
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <div
                  className="uppercase font-bold"
                  style={{ color: CORAL, fontSize: "11px", letterSpacing: "3px" }}
                >
                  {programLabel}
                </div>
                {holdActive && (
                  <div
                    className="flex items-center gap-1.5 font-body font-bold text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-full"
                    style={{
                      backgroundColor: `${GOLD}18`,
                      color: GOLD,
                      border: `1px solid ${GOLD}45`,
                    }}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full animate-pulse"
                      style={{ backgroundColor: GOLD }}
                    />
                    Lane held ·{" "}
                    <span className="tabular-nums">
                      {Math.floor(holdSecondsLeft / 60)}:
                      {(holdSecondsLeft % 60).toString().padStart(2, "0")}
                    </span>
                  </div>
                )}
              </div>
              <h1
                className="font-heading font-black uppercase italic text-white"
                style={{
                  fontSize: "clamp(28px, 5vw, 40px)",
                  lineHeight: 1.05,
                  letterSpacing: "-0.5px",
                }}
              >
                {stepTitle()}
              </h1>
            </div>
          )}

          {/* Error banner */}
          {error && step !== "submitting" && (
            <div
              className="mb-4 rounded-xl p-3 text-sm font-body"
              style={{
                backgroundColor: "rgba(253,91,86,0.12)",
                border: "1.5px solid rgba(253,91,86,0.35)",
                color: CORAL,
              }}
            >
              {error}
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════
              STEP: Location
          ═══════════════════════════════════════════════════════ */}
          {step === "location" &&
            (() => {
              const other = CENTERS.find((c) => c.id !== centerId);
              const nextStep: Step = kind === "kbf" ? "lookup" : "players";
              return (
                <div className="text-center">
                  <div
                    className="rounded-lg p-6 mb-6"
                    style={{
                      backgroundColor: "rgba(7,16,39,0.5)",
                      border: `1.78px dashed ${GOLD}30`,
                    }}
                  >
                    <p className="font-body text-white/50 text-xs uppercase tracking-wider mb-2">
                      You&apos;re booking at
                    </p>
                    <h3
                      className="font-heading uppercase text-white text-xl tracking-wider"
                      style={{ textShadow: `0 0 20px ${GOLD}25` }}
                    >
                      {center.name}
                    </h3>
                    <p className="font-body text-white/40 text-sm mt-1">{center.address}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setStep(nextStep)}
                    className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
                    style={{ backgroundColor: CORAL, boxShadow: `0 0 16px ${CORAL}30` }}
                  >
                    Continue
                  </button>
                  {other && (
                    <button
                      type="button"
                      onClick={() => {
                        setCenterId(other.id);
                        setBookingLocation(other.locationKey);
                      }}
                      className="mt-3 font-body text-white/40 text-xs cursor-pointer hover:text-white/60 transition-colors"
                    >
                      Switch to {other.name}
                    </button>
                  )}
                </div>
              );
            })()}

          {/* ═══════════════════════════════════════════════════════
              STEP: Lookup (KBF only)
          ═══════════════════════════════════════════════════════ */}
          {step === "lookup" && kind === "kbf" && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7 space-y-4">
                <p className="text-white/65 text-sm leading-relaxed">
                  Kids Bowl Free — kids 15 and under bowl two free games per day, Mon–Thu open to
                  close, Fri until 5 PM. Sign in below or register in under 30 seconds.
                </p>
                <div
                  className="rounded-xl px-4 py-3"
                  style={{
                    backgroundColor: "rgba(255,215,0,0.06)",
                    border: `1px solid ${GOLD}40`,
                  }}
                >
                  <div
                    className="font-heading uppercase text-[10px] tracking-[3px] mb-1"
                    style={{ color: GOLD }}
                  >
                    {KBF_ELIGIBILITY_HEADING}
                  </div>
                  <p className="text-white/65 text-xs leading-relaxed">{KBF_ELIGIBILITY_TEXT}</p>
                </div>
                <div className="flex gap-1 bg-white/5 rounded-lg p-1">
                  {(["email", "phone", "new"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        setLookupTab(m);
                        setError(null);
                      }}
                      className="flex-1 py-2 rounded-md text-xs font-semibold transition-colors uppercase tracking-wider"
                      style={{
                        backgroundColor: lookupTab === m ? CORAL : "transparent",
                        color: lookupTab === m ? "#0a1628" : "rgba(255,255,255,0.45)",
                        fontWeight: lookupTab === m ? 800 : 600,
                      }}
                    >
                      {m === "phone" ? "SMS" : m === "new" ? "New" : "Email"}
                    </button>
                  ))}
                </div>
                {lookupTab === "email" && (
                  <div className="space-y-3">
                    <input
                      type="email"
                      autoComplete="email"
                      value={emailInput}
                      onChange={(e) => setEmailInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && void handleLookup()}
                      placeholder="parent@example.com"
                      className="w-full rounded-xl bg-white/5 border border-white/15 px-4 py-3 text-white text-sm placeholder:text-white/25 focus:outline-none focus:border-[#fd5b56]/50"
                    />
                    <button
                      type="button"
                      onClick={() => void handleLookup()}
                      disabled={busy || !emailInput.includes("@")}
                      className="w-full py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-40"
                      style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                    >
                      {busy ? "Looking up…" : "Send verification code"}
                    </button>
                  </div>
                )}
                {lookupTab === "phone" && (
                  <div className="space-y-3">
                    <input
                      type="tel"
                      autoComplete="tel"
                      inputMode="tel"
                      value={phoneInput}
                      onChange={(e) => setPhoneInput(formatPhoneDisplay(e.target.value))}
                      onKeyDown={(e) => e.key === "Enter" && void handleLookup()}
                      placeholder="(239) 555-1234"
                      className="w-full rounded-xl bg-white/5 border border-white/15 px-4 py-3 text-white text-sm text-center tracking-wider placeholder:text-white/25 focus:outline-none"
                      style={{ borderColor: "rgba(253,91,86,0.30)" }}
                    />
                    <button
                      type="button"
                      onClick={() => void handleLookup()}
                      disabled={busy || phoneInput.replace(/\D/g, "").length !== 10}
                      className="w-full py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-40"
                      style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                    >
                      {busy ? "Looking up…" : "Send verification code"}
                    </button>
                  </div>
                )}
                {lookupTab === "new" && (
                  <div
                    className="rounded-xl px-4 py-4"
                    style={{
                      backgroundColor: "rgba(253,91,86,0.05)",
                      border: "1px solid rgba(253,91,86,0.20)",
                    }}
                  >
                    <div
                      className="font-heading uppercase text-[10px] tracking-[3px] mb-1"
                      style={{ color: CORAL }}
                    >
                      New to Kids Bowl Free?
                    </div>
                    <p className="text-white/65 text-xs leading-relaxed mb-3">
                      Sign up at{" "}
                      <a
                        href="https://www.kidsbowlfree.com/bowland"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-white"
                      >
                        kidsbowlfree.com/bowland
                      </a>{" "}
                      — new accounts take about an hour to be reservable here. Once registered, come
                      back and use the Email tab.
                    </p>
                    <a
                      href="https://www.kidsbowlfree.com/bowland"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center w-full py-2.5 rounded-full font-body font-bold text-xs uppercase tracking-wider transition-all hover:scale-[1.01]"
                      style={{
                        backgroundColor: "rgba(253,91,86,0.20)",
                        border: `1px solid ${CORAL}60`,
                        color: CORAL,
                      }}
                    >
                      Register at kidsbowlfree.com →
                    </a>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setStep("location")}
                className="w-full font-body text-white/35 text-sm py-1"
              >
                ← Back
              </button>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════
              STEP: Verify (KBF only)
          ═══════════════════════════════════════════════════════ */}
          {step === "verify" && kind === "kbf" && (
            <div className="space-y-4">
              <p className="font-body text-white/55 text-sm text-center">
                We sent a 6-digit code to {maskedDest} via {channel === "sms" ? "text" : "email"}.
                Enter it below.
              </p>
              <input
                type="text"
                inputMode="numeric"
                placeholder="000000"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && void handleVerify()}
                className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3.5 text-white font-body text-xl tracking-[0.5em] text-center placeholder:text-white/15 focus:outline-none focus:border-[#fd5b56]/50"
              />
              <button
                type="button"
                onClick={() => void handleVerify()}
                disabled={busy || code.length < 6}
                className="w-full rounded-full px-6 py-3.5 font-body font-bold text-sm uppercase tracking-wider text-white disabled:opacity-50"
                style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
              >
                {busy ? "Verifying…" : "Verify"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setCode("");
                  setStep("lookup");
                }}
                className="w-full font-body text-white/35 text-sm"
              >
                ← Back
              </button>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════
              STEP: Existing reservation (KBF only)
          ═══════════════════════════════════════════════════════ */}
          {step === "existing" &&
            kind === "kbf" &&
            existingReservation &&
            (() => {
              const ex = existingReservation;
              const exCenter = CENTER_BY_CODE[ex.centerCode] ?? center;
              const hasPaid = ex.depositCents > 0;
              const remaining = ex.totalCents - ex.depositCents;
              return (
                <div className="space-y-4">
                  <div
                    className="rounded-2xl p-5"
                    style={{
                      backgroundColor: "rgba(253,91,86,0.08)",
                      border: `1.78px solid ${CORAL}55`,
                    }}
                  >
                    <div
                      className="uppercase font-bold mb-3"
                      style={{ color: CORAL, fontSize: "10px", letterSpacing: "2.5px" }}
                    >
                      You&apos;re already booked
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="font-body text-white/50">Center</span>
                        <span className="font-body text-white font-semibold">{exCenter.name}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="font-body text-white/50">Date</span>
                        <span className="font-body text-white font-semibold">
                          {formatDate(ex.bookedAt.slice(0, 10))}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="font-body text-white/50">Time</span>
                        <span className="font-body text-white font-semibold">
                          {formatTime(ex.bookedAt)}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="font-body text-white/50">Bowlers</span>
                        <span className="font-body text-white font-semibold">
                          {ex.playerCount ?? "—"}
                        </span>
                      </div>
                      {ex.lines.length > 0 && (
                        <>
                          <div className="h-px bg-white/10 my-1" />
                          {ex.lines.map((line, i) => (
                            <div key={i} className="flex justify-between text-sm">
                              <span className="font-body text-white/50">
                                {line.label}
                                {line.quantity > 1 ? ` ×${line.quantity}` : ""}
                              </span>
                              <span className="font-body text-white">
                                {line.unitPriceCents === 0
                                  ? "Free"
                                  : centsToDollars(line.unitPriceCents * line.quantity)}
                              </span>
                            </div>
                          ))}
                        </>
                      )}
                      {hasPaid && (
                        <>
                          <div className="h-px bg-white/10 my-1" />
                          <div className="flex justify-between text-sm">
                            <span className="font-body text-white/50">Paid at booking</span>
                            <span className="font-body font-semibold" style={{ color: "#4ade80" }}>
                              {centsToDollars(ex.depositCents)}
                            </span>
                          </div>
                          {remaining > 0 && (
                            <div className="flex justify-between text-sm">
                              <span className="font-body text-white/50">Due at center</span>
                              <span className="font-body text-white">
                                {centsToDollars(remaining)}
                              </span>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  <p className="font-body text-white/45 text-xs text-center leading-relaxed">
                    Kids Bowl Free allows one active reservation at a time. View your booking
                    details, change the date &amp; time, or cancel to start fresh.
                  </p>

                  {ex.shortCode && (
                    <button
                      type="button"
                      onClick={() => router.push(`${confirmationBase}?code=${ex.shortCode}`)}
                      className="w-full rounded-full px-6 py-3.5 font-body font-bold text-sm uppercase tracking-wider"
                      style={{
                        backgroundColor: "transparent",
                        border: `1.78px solid ${CORAL}80`,
                        color: CORAL,
                      }}
                    >
                      View My Reservation
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedDate(bookableDateRange()[0] ?? todayYmd());
                      setAvailableSlots([]);
                      setSelectedSlot(null);
                      setSlotsError(null);
                      setStep("reschedule");
                    }}
                    className="w-full rounded-full px-6 py-3.5 font-body font-bold text-sm uppercase tracking-wider text-white"
                    style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                  >
                    Change Date &amp; Time
                  </button>

                  {!cancelConfirming ? (
                    <button
                      type="button"
                      onClick={() => setCancelConfirming(true)}
                      className="w-full font-body text-white/35 text-xs py-1"
                    >
                      Cancel this reservation
                    </button>
                  ) : (
                    <div
                      className="rounded-xl p-4 space-y-3"
                      style={{
                        backgroundColor: "rgba(253,91,86,0.08)",
                        border: "1.5px solid rgba(253,91,86,0.3)",
                      }}
                    >
                      <p className="font-body text-white/75 text-sm text-center">
                        Cancel this reservation?
                        {ex.depositCents > 0 && (
                          <span className="block text-xs text-white/45 mt-1">
                            A full {centsToDollars(ex.depositCents)} refund will be returned to your
                            original payment method automatically.
                          </span>
                        )}
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setCancelConfirming(false)}
                          className="flex-1 rounded-full px-4 py-2.5 font-body font-bold text-sm uppercase tracking-wider text-white/70 border border-white/20"
                        >
                          Keep it
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleCancelReservation()}
                          disabled={cancelBusy}
                          className="flex-1 rounded-full px-4 py-2.5 font-body font-bold text-sm uppercase tracking-wider disabled:opacity-50"
                          style={{ backgroundColor: CORAL, color: "white" }}
                        >
                          {cancelBusy ? "Cancelling…" : "Yes, cancel"}
                        </button>
                      </div>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setCancelConfirming(false);
                      setStep("verify");
                    }}
                    className="w-full font-body text-white/35 text-sm"
                  >
                    ← Back
                  </button>
                </div>
              );
            })()}

          {/* ═══════════════════════════════════════════════════════
              STEP: Reschedule (KBF only)
          ═══════════════════════════════════════════════════════ */}
          {step === "reschedule" &&
            kind === "kbf" &&
            existingReservation &&
            (() => {
              const ex = existingReservation;
              const exCenter = CENTER_BY_CODE[ex.centerCode] ?? center;
              return (
                <div className="space-y-4">
                  <div className="md:grid md:grid-cols-[260px_1fr] md:gap-6 md:items-start">
                    <div className="space-y-4">
                      <div
                        className="rounded-xl px-4 py-3"
                        style={{
                          backgroundColor: "rgba(255,255,255,0.04)",
                          border: "1px solid rgba(255,255,255,0.08)",
                        }}
                      >
                        <div
                          className="uppercase font-bold mb-1"
                          style={{
                            color: "rgba(255,255,255,0.35)",
                            fontSize: "10px",
                            letterSpacing: "2px",
                          }}
                        >
                          Rescheduling · {exCenter.name}
                        </div>
                        <div className="font-body text-white/55 text-xs line-through">
                          {formatDate(ex.bookedAt.slice(0, 10))} · {formatTime(ex.bookedAt)}
                        </div>
                      </div>
                      <div>
                        <label
                          htmlFor="reschedule-date"
                          className="font-body text-white/55 text-xs uppercase tracking-wider block mb-2"
                        >
                          Pick a new date
                        </label>
                        <input
                          id="reschedule-date"
                          type="date"
                          min={kbfBookableDates[0] ?? ""}
                          max={kbfBookableDates[kbfBookableDates.length - 1] ?? ""}
                          value={selectedDate}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (!isKbfBookableDate(v)) return;
                            setSelectedDate(v);
                            void fetchSlots(v, { forPlayerCount: ex.playerCount ?? 1 });
                          }}
                          className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white font-body text-sm focus:outline-none focus:border-[#fd5b56]/50"
                        />
                      </div>
                      {selectedSlot && (
                        <div
                          className="hidden md:block rounded-xl px-4 py-3"
                          style={{
                            backgroundColor: "rgba(253,91,86,0.08)",
                            border: `1px solid ${CORAL}40`,
                          }}
                        >
                          <div className="font-body text-white/45 text-[10px] uppercase tracking-wider mb-1">
                            New time
                          </div>
                          <div className="font-body text-white font-bold text-sm">
                            {formatTime(selectedSlot.bookedAt)}
                          </div>
                          <div className="font-body text-white/50 text-xs mt-0.5">
                            {selectedExperience?.isVip ? "VIP Suite" : "Regular Lanes"}
                          </div>
                        </div>
                      )}
                      <div className="hidden md:flex md:flex-col md:gap-2">
                        <button
                          type="button"
                          onClick={() => void handleReschedule()}
                          disabled={!selectedSlot || slotsLoading || busy}
                          className="w-full rounded-full px-6 py-3.5 font-body font-bold text-sm uppercase tracking-wider text-white disabled:opacity-50"
                          style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                        >
                          {busy
                            ? "Rescheduling…"
                            : selectedSlot
                              ? `Confirm — ${formatTime(selectedSlot.bookedAt)}`
                              : "Select a time"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setStep("existing")}
                          className="w-full font-body text-white/35 text-sm py-1"
                        >
                          ← Keep existing time
                        </button>
                      </div>
                    </div>

                    <div className="space-y-3 mt-4 md:mt-0">
                      {slotsLoading && (
                        <div className="flex items-center gap-2 font-body text-white/40 text-sm py-8 justify-center">
                          <div className="w-4 h-4 border border-white/20 border-t-[#fd5b56] rounded-full animate-spin" />
                          Loading available times…
                        </div>
                      )}
                      {slotsError && !slotsLoading && (
                        <div
                          className="rounded-xl p-3 text-sm font-body"
                          style={{
                            backgroundColor: "rgba(253,91,86,0.08)",
                            border: "1.5px solid rgba(253,91,86,0.25)",
                            color: CORAL,
                          }}
                        >
                          {slotsError}
                        </div>
                      )}
                      {!slotsLoading && (
                        <div className="space-y-3 md:grid md:grid-cols-2 md:gap-4 md:space-y-0">
                          {experiences.map((exp) => {
                            const display = getExperienceDisplay(exp.slug, exp.isVip);
                            const accent = display.accent;
                            const offerSlots = availableSlots.filter(
                              (s) => s.webOfferId === exp.qamfWebOfferId,
                            );
                            const isSelected = selectedSlot?.webOfferId === exp.qamfWebOfferId;
                            const hasSlots = offerSlots.length > 0;
                            return (
                              <div
                                key={exp.qamfWebOfferId}
                                className={`w-full rounded-xl overflow-hidden transition-all flex flex-col ${!hasSlots && availableSlots.length > 0 ? "opacity-50" : ""}`}
                                style={{
                                  backgroundColor: "rgba(7,16,39,0.5)",
                                  border: `1.78px dashed ${!hasSlots && availableSlots.length > 0 ? `${accent}30` : isSelected ? `${accent}AA` : `${accent}35`}`,
                                  boxShadow: isSelected ? `0 0 24px ${accent}20` : undefined,
                                }}
                              >
                                <button
                                  type="button"
                                  className="w-full text-left p-4"
                                  onClick={() => {
                                    if (!hasSlots && availableSlots.length > 0) return;
                                    if (selectedSlot?.webOfferId !== exp.qamfWebOfferId)
                                      setSelectedSlot(null);
                                  }}
                                >
                                  <h3 className="font-heading uppercase text-white text-sm tracking-wider">
                                    {exp.label}
                                  </h3>
                                  <p className="font-body text-white/45 text-xs mt-0.5">
                                    {display.description}
                                  </p>
                                </button>
                                {hasSlots && (
                                  <div
                                    className={isSelected ? "block" : "hidden md:block"}
                                    style={{ borderTop: `1px solid ${accent}20` }}
                                  >
                                    <div className="px-4 pb-4 pt-3">
                                      <div className="flex flex-wrap gap-1.5">
                                        {offerSlots.map((s) => {
                                          const on =
                                            selectedSlot?.bookedAt === s.bookedAt &&
                                            selectedSlot?.webOfferId === s.webOfferId;
                                          return (
                                            <button
                                              key={s.bookedAt}
                                              type="button"
                                              onClick={() => setSelectedSlot(s)}
                                              className="px-2.5 py-1.5 rounded-lg text-xs font-bold font-body transition-all"
                                              style={{
                                                backgroundColor: on
                                                  ? accent
                                                  : "rgba(255,255,255,0.08)",
                                                color: on
                                                  ? exp.isVip
                                                    ? BG
                                                    : "white"
                                                  : "rgba(255,255,255,0.7)",
                                                border: `1px solid ${on ? accent : "rgba(255,255,255,0.12)"}`,
                                                boxShadow: on ? `0 0 10px ${accent}40` : "none",
                                              }}
                                            >
                                              {formatTime(s.bookedAt)}
                                            </button>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="md:hidden space-y-2">
                    <button
                      type="button"
                      onClick={() => void handleReschedule()}
                      disabled={!selectedSlot || slotsLoading || busy}
                      className="w-full rounded-full px-6 py-3.5 font-body font-bold text-sm uppercase tracking-wider text-white disabled:opacity-50"
                      style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                    >
                      {busy
                        ? "Rescheduling…"
                        : selectedSlot
                          ? `Confirm — ${formatTime(selectedSlot.bookedAt)}`
                          : "Select a time"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setStep("existing")}
                      className="w-full font-body text-white/35 text-sm"
                    >
                      ← Keep existing time
                    </button>
                  </div>
                </div>
              );
            })()}

          {/* ═══════════════════════════════════════════════════════
              STEP: Bowlers (KBF only)
          ═══════════════════════════════════════════════════════ */}
          {step === "bowlers" &&
            kind === "kbf" &&
            (() => {
              const KBF_BLUE = "#4fa3e0";
              const AMBER = "#f59e0b";
              const hasFamilyPass = pass?.fpass ?? false;
              const anyKidSelected = bowlerSelections.some(
                (b) => b.relation === "kid" && b.selected,
              );
              const bowlerCount = kbfBowlers.length;

              // Day-dependent adult game pricing: $5/game Mon–Thu, $6/game Fri
              // VIP lanes: adults pay $1 more/game ($6/$7), baked into per-game rate
              const selectedDow = selectedDate ? new Date(`${selectedDate}T12:00:00`).getDay() : 1;
              const isFriday = selectedDow === 5;
              const isVipLane = selectedExperience?.isVip ?? false;
              const perGameRate = isFriday ? (isVipLane ? 7 : 6) : isVipLane ? 6 : 5;
              const basePerGameRate = isFriday ? 6 : 5; // non-VIP rate for display
              const gamesPerSession = 2;
              const adultSessionPrice = perGameRate * gamesPerSession;

              const paidAdults = bowlerSelections.filter((b) => b.isPaid && b.selected);
              const adultGameTotal = paidAdults.length * adultSessionPrice;

              // VIP lane upcharge: $1/person/game × 2 games = $2/bowler for FREE bowlers only
              // (paid adults already have VIP baked into their per-game rate above)
              const vipPerBowler = isVipLane ? 2 : 0; // $1/game × 2 games
              const freeBowlerCount = bowlerCount - paidAdults.length;
              const vipTotal = freeBowlerCount * vipPerBowler;
              const bowlerStepTotal = adultGameTotal + vipTotal;

              const relationLabel = (b: BowlerSelection) => {
                if (b.isPaid) {
                  return isVipLane
                    ? `$${perGameRate}/game × 2 games (incl. VIP)`
                    : `$${perGameRate}/game × 2 games`;
                }
                if (isVipLane) return `$${vipPerBowler} · VIP upcharge`;
                if (b.relation === "kid") return "Free";
                if (hasFamilyPass) return "Free · Families Bowl Free";
                return "Account holder";
              };

              // Helper to add a guest adult
              const addGuestAdult = (name?: string) => {
                const idx = bowlerSelections.filter((b) => b.isGuestAdult).length + 1;
                const newAdult: BowlerSelection = {
                  key: `guest-adult-${Date.now()}-${idx}`,
                  displayName: name || "",
                  relation: "parent",
                  selected: true,
                  wantBumpers: false,
                  isPaid: true,
                  isGuestAdult: true,
                };
                setBowlerSelections((prev) => [...prev, newAdult]);
              };

              return (
                <div className="space-y-3">
                  <div
                    className="rounded-2xl px-4 py-3 flex items-center gap-3"
                    style={{
                      backgroundColor: `${isVipLane ? GOLD : KBF_BLUE}14`,
                      border: `1.78px solid ${isVipLane ? GOLD : KBF_BLUE}55`,
                    }}
                  >
                    <div
                      className="w-9 h-9 rounded-full flex items-center justify-center font-heading font-black shrink-0"
                      style={{
                        backgroundColor: `${isVipLane ? GOLD : KBF_BLUE}26`,
                        color: isVipLane ? GOLD : KBF_BLUE,
                      }}
                    >
                      ★
                    </div>
                    <div className="flex-1 min-w-0">
                      <div
                        className="font-heading uppercase tracking-[3px] text-[10px] mb-0.5"
                        style={{ color: isVipLane ? GOLD : KBF_BLUE }}
                      >
                        {hasFamilyPass ? "Families Bowl Free" : "Kids Bowl Free"}
                        {isVipLane ? " · VIP" : ""}
                      </div>
                      <div className="text-white/85 text-sm font-semibold truncate">
                        {pass ? `${pass.firstName} ${pass.lastName}` : ""}
                      </div>
                    </div>
                  </div>

                  <p className="font-body text-white/65 text-sm leading-relaxed">
                    {hasFamilyPass
                      ? "Everyone on your Families Bowl Free pass bowls free! Select who’s coming."
                      : `Registered kids bowl free. Adults can be added for $${basePerGameRate}/game (2 games).`}
                    {isVipLane && " VIP lanes are $1/game extra per person."} At least one kid is
                    required.
                  </p>

                  {/* ── Free bowlers (kids + FBF adults) ── */}
                  {bowlerSelections
                    .filter((b) => !b.isPaid)
                    .map((b, _i) => {
                      const idx = bowlerSelections.indexOf(b);
                      const isAdult = b.relation !== "kid";
                      const adultLocked = isAdult && !anyKidSelected;
                      const accent = isAdult ? KBF_BLUE : CORAL;
                      return (
                        <button
                          key={b.key}
                          type="button"
                          disabled={adultLocked}
                          onClick={() => {
                            if (adultLocked) return;
                            const updated = [...bowlerSelections];
                            updated[idx] = { ...b, selected: !b.selected };
                            setBowlerSelections(updated);
                          }}
                          className="w-full rounded-xl text-left flex items-center gap-3 px-4 py-3.5 transition-all disabled:cursor-not-allowed"
                          style={{
                            backgroundColor: b.selected ? `${accent}12` : "rgba(255,255,255,0.025)",
                            border: `1.78px solid ${b.selected ? `${accent}80` : "rgba(255,255,255,0.10)"}`,
                            boxShadow: b.selected ? `0 0 18px ${accent}18` : undefined,
                            opacity: adultLocked ? 0.45 : 1,
                          }}
                        >
                          <div
                            className="w-10 h-10 rounded-full flex items-center justify-center font-heading font-black text-sm shrink-0"
                            style={{
                              backgroundColor: `${accent}22`,
                              color: accent,
                              border: `1.78px solid ${accent}55`,
                            }}
                          >
                            {b.displayName
                              .split(" ")
                              .map((w: string) => w[0])
                              .join("")
                              .slice(0, 2)
                              .toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-white font-semibold text-sm truncate">
                              {b.displayName}
                            </div>
                            <span
                              className="inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full mt-0.5"
                              style={{ backgroundColor: `${accent}22`, color: accent }}
                            >
                              {relationLabel(b)}
                            </span>
                          </div>
                          <div
                            className="text-[10px] uppercase tracking-[2px] font-bold px-3 py-1.5 rounded-full shrink-0"
                            style={{
                              backgroundColor: b.selected
                                ? `${accent}26`
                                : "rgba(255,255,255,0.06)",
                              color: b.selected ? accent : "rgba(255,255,255,0.45)",
                              border: b.selected
                                ? `1px solid ${accent}80`
                                : "1px solid rgba(255,255,255,0.10)",
                            }}
                          >
                            {adultLocked ? "Kid required" : b.selected ? "Bowling" : "Add"}
                          </div>
                        </button>
                      );
                    })}

                  {/* ── Adult game section (paid adults) ── */}
                  {bowlerSelections.filter((b) => b.isPaid).length > 0 && (
                    <div className="pt-2">
                      <div className="font-body text-white/40 text-[10px] uppercase tracking-[2px] mb-2">
                        Adult games · ${perGameRate}/game × {gamesPerSession} games
                        {isVipLane ? " (incl. VIP)" : ""}
                      </div>
                      {bowlerSelections
                        .filter((b) => b.isPaid)
                        .map((b) => {
                          const idx = bowlerSelections.indexOf(b);
                          return (
                            <div
                              key={b.key}
                              className="w-full rounded-xl flex items-center gap-3 px-4 py-3.5 mb-2 transition-all"
                              style={{
                                backgroundColor: b.selected
                                  ? `${AMBER}12`
                                  : "rgba(255,255,255,0.025)",
                                border: `1.78px solid ${b.selected ? `${AMBER}60` : "rgba(255,255,255,0.10)"}`,
                              }}
                            >
                              <div
                                className="w-10 h-10 rounded-full flex items-center justify-center font-heading font-black text-sm shrink-0"
                                style={{
                                  backgroundColor: `${AMBER}22`,
                                  color: AMBER,
                                  border: `1.78px solid ${AMBER}55`,
                                }}
                              >
                                {b.displayName
                                  ? b.displayName
                                      .split(" ")
                                      .map((w: string) => w[0])
                                      .join("")
                                      .slice(0, 2)
                                      .toUpperCase()
                                  : "+"}
                              </div>
                              <div className="flex-1 min-w-0">
                                {b.isGuestAdult ? (
                                  <input
                                    type="text"
                                    placeholder="Adult name"
                                    value={b.displayName}
                                    onChange={(e) => {
                                      const updated = [...bowlerSelections];
                                      updated[idx] = { ...b, displayName: e.target.value };
                                      setBowlerSelections(updated);
                                    }}
                                    className="w-full bg-transparent text-white font-semibold text-sm border-none outline-none placeholder:text-white/30"
                                  />
                                ) : (
                                  <div className="text-white font-semibold text-sm truncate">
                                    {b.displayName}
                                  </div>
                                )}
                                <span
                                  className="inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full mt-0.5"
                                  style={{ backgroundColor: `${AMBER}22`, color: AMBER }}
                                >
                                  ${adultSessionPrice} · {gamesPerSession} games
                                  {isVipLane ? " (VIP)" : ""}
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={() =>
                                  setBowlerSelections((prev) => prev.filter((_, j) => j !== idx))
                                }
                                className="text-white/30 hover:text-white/60 text-lg font-bold px-1 shrink-0"
                              >
                                ✕
                              </button>
                            </div>
                          );
                        })}
                    </div>
                  )}

                  {/* ── Add Adult buttons ── */}
                  <div className="flex gap-2">
                    {!hasFamilyPass &&
                      pass &&
                      !bowlerSelections.some(
                        (b) =>
                          b.isPaid &&
                          !b.isGuestAdult &&
                          b.displayName === `${pass.firstName} ${pass.lastName}`,
                      ) && (
                        <button
                          type="button"
                          disabled={!anyKidSelected}
                          onClick={() => {
                            if (!anyKidSelected) return;
                            const parentName = `${pass.firstName} ${pass.lastName}`;
                            setBowlerSelections((prev) => [
                              ...prev,
                              {
                                key: `paid-parent-${Date.now()}`,
                                displayName: parentName,
                                relation: "parent",
                                selected: true,
                                wantBumpers: false,
                                isPaid: true,
                                isGuestAdult: false,
                              },
                            ]);
                          }}
                          className="flex-1 rounded-xl px-3 py-3 font-body text-xs uppercase tracking-wider text-center transition-all disabled:opacity-40"
                          style={{
                            backgroundColor: `${AMBER}10`,
                            border: `1.5px dashed ${AMBER}50`,
                            color: AMBER,
                          }}
                        >
                          Add yourself · ${adultSessionPrice}
                        </button>
                      )}
                    <button
                      type="button"
                      disabled={!anyKidSelected}
                      onClick={() => {
                        if (!anyKidSelected) return;
                        addGuestAdult();
                      }}
                      className="flex-1 rounded-xl px-3 py-3 font-body text-xs uppercase tracking-wider text-center transition-all disabled:opacity-40"
                      style={{
                        backgroundColor: "rgba(255,255,255,0.03)",
                        border: "1.5px dashed rgba(255,255,255,0.15)",
                        color: "rgba(255,255,255,0.55)",
                      }}
                    >
                      + Add adult · ${adultSessionPrice}
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      if (bowlerCount === 0) {
                        setError("Select at least one bowler");
                        return;
                      }
                      if (!anyKidSelected) {
                        setError("At least one kid must be bowling");
                        return;
                      }
                      // Validate paid adult names
                      const unnamed = bowlerSelections.filter(
                        (b) => b.isPaid && b.selected && !b.displayName.trim(),
                      );
                      if (unnamed.length > 0) {
                        setError("Please enter a name for each adult");
                        return;
                      }
                      setError(null);
                      setStep("slots");
                    }}
                    className="w-full rounded-full px-4 sm:px-6 py-3.5 font-body font-bold text-xs sm:text-sm uppercase tracking-wider text-white whitespace-nowrap"
                    style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                  >
                    Continue — {bowlerCount} bowler{bowlerCount === 1 ? "" : "s"}
                    {bowlerStepTotal > 0 ? ` · $${bowlerStepTotal}` : ""}
                  </button>
                  <button
                    type="button"
                    onClick={() => setStep("verify")}
                    className="w-full font-body text-white/35 text-sm"
                  >
                    ← Back
                  </button>
                </div>
              );
            })()}

          {/* ═══════════════════════════════════════════════════════
              STEP: Players (Open only)
          ═══════════════════════════════════════════════════════ */}
          {step === "players" && kind === "open" && (
            <div className="space-y-6">
              <p className="font-body text-white/55 text-sm text-center">Up to 20 bowlers</p>
              <div className="flex items-center justify-center gap-6">
                <button
                  type="button"
                  onClick={() => setPlayerCount((n) => Math.max(1, n - 1))}
                  className="w-14 h-14 rounded-full flex items-center justify-center font-heading font-black text-2xl transition-all hover:scale-105"
                  style={{
                    backgroundColor: "rgba(255,255,255,0.07)",
                    border: "1.78px solid rgba(255,255,255,0.18)",
                    color: "rgba(255,255,255,0.75)",
                  }}
                >
                  −
                </button>
                <div className="text-center">
                  <div
                    className="font-heading font-black text-white"
                    style={{ fontSize: "72px", lineHeight: 1, textShadow: `0 0 40px ${CORAL}40` }}
                  >
                    {playerCount}
                  </div>
                  <div className="font-body text-white/40 text-xs uppercase tracking-[3px] mt-1">
                    {playerCount === 1 ? "bowler" : "bowlers"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setPlayerCount((n) => Math.min(20, n + 1))}
                  className="w-14 h-14 rounded-full flex items-center justify-center font-heading font-black text-2xl transition-all hover:scale-105"
                  style={{
                    backgroundColor: playerCount < 20 ? `${CORAL}22` : "rgba(255,255,255,0.07)",
                    border: `1.78px solid ${playerCount < 20 ? `${CORAL}60` : "rgba(255,255,255,0.18)"}`,
                    color: playerCount < 20 ? CORAL : "rgba(255,255,255,0.75)",
                    boxShadow: playerCount < 20 ? `0 0 14px ${CORAL}30` : undefined,
                  }}
                >
                  +
                </button>
              </div>
              <button
                type="button"
                onClick={() => setStep("slots")}
                className="w-full py-3.5 rounded-full font-body font-bold text-xs sm:text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.02] whitespace-nowrap"
                style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
              >
                Continue — {playerCount} {playerCount === 1 ? "bowler" : "bowlers"}
              </button>
              <button
                type="button"
                onClick={() => setStep("location")}
                className="w-full font-body text-white/35 text-sm"
              >
                ← Back
              </button>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════
              STEP: Slots — calendar + hour chips
          ═══════════════════════════════════════════════════════ */}
          {step === "slots" &&
            (() => {
              const filteredHours = getFilteredHours(selectedDate);

              return (
                <div className="space-y-6">
                  {/* Context bar */}
                  <div className="flex flex-wrap items-center justify-center gap-3 text-xs uppercase tracking-wider text-white/55 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5">
                    <span style={{ color: CORAL }}>📍 {center.name}</span>
                    {selectedDate && (
                      <>
                        <span className="text-white/20">·</span>
                        <span>
                          📅{" "}
                          {new Date(`${selectedDate}T12:00:00`).toLocaleDateString("en-US", {
                            weekday: "short",
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                      </>
                    )}
                    {selectedHour !== null && selectedMinute !== null && (
                      <>
                        <span className="text-white/20">·</span>
                        <span style={{ color: GOLD }}>
                          🕐 {formatHourMinute(selectedHour, selectedMinute)}
                        </span>
                      </>
                    )}
                    {appliedDiscount?.amountPct != null && (
                      <>
                        <span className="text-white/20">·</span>
                        <span style={{ color: "#22c55e" }}>
                          💸 Saving {appliedDiscount.amountPct}% at checkout
                        </span>
                      </>
                    )}
                  </div>

                  {/* Discount code — open bowling only.
                      KBF reservations are free, so a percent discount is a no-op.
                      Server is the source of truth: this UI shows the chip + filters
                      the calendar, but the quote/reserve endpoints re-validate the
                      same code at every step. */}
                  {kind !== "kbf" && (
                    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                      {appliedDiscount ? (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 text-sm">
                            <span
                              style={{ background: "rgba(34,197,94,0.18)", color: "#22c55e" }}
                              className="rounded-full px-2.5 py-1 text-xs font-bold tracking-wider"
                            >
                              ✓ {appliedDiscount.code}
                            </span>
                            <span className="text-white/70 text-xs">
                              {appliedDiscount.amountPct != null
                                ? `${appliedDiscount.amountPct}% off`
                                : appliedDiscount.amountCents != null
                                  ? `$${(appliedDiscount.amountCents / 100).toFixed(2)} off`
                                  : "Discount applied"}
                              {appliedDiscount.allowedWeekdays &&
                                appliedDiscount.allowedWeekdays.length > 0 && (
                                  <>
                                    {" · "}
                                    valid{" "}
                                    {appliedDiscount.allowedWeekdays
                                      .slice()
                                      .sort()
                                      .map(
                                        (n) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][n],
                                      )
                                      .join("/")}
                                  </>
                                )}
                              {" · "}
                              thru{" "}
                              {new Date(appliedDiscount.expiresAt).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={clearDiscountCode}
                            className="text-xs uppercase tracking-wider text-white/40 hover:text-white/80 transition-colors"
                          >
                            ✕ Remove
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                            <span className="text-xs uppercase tracking-wider text-white/40 shrink-0">
                              Discount code
                            </span>
                            <input
                              type="text"
                              value={discountInput}
                              onChange={(e) => setDiscountInput(e.target.value.toUpperCase())}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  void applyDiscountCode(discountInput);
                                }
                              }}
                              placeholder="Have a code?"
                              autoCapitalize="characters"
                              autoCorrect="off"
                              spellCheck={false}
                              className="flex-1 bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white placeholder:text-white/30 focus:border-white/25 focus:outline-none"
                            />
                          </div>
                          <button
                            type="button"
                            disabled={!discountInput || discountChecking}
                            onClick={() => void applyDiscountCode(discountInput)}
                            className="rounded-lg px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-40"
                            style={{ backgroundColor: "rgba(34,197,94,0.18)", color: "#22c55e" }}
                          >
                            {discountChecking ? "Checking…" : "Apply"}
                          </button>
                        </div>
                      )}
                      {discountError && (
                        <p className="mt-2 text-xs text-red-400">{discountError}</p>
                      )}
                      {appliedDiscount && discountHasNoEligibleDays && (
                        <div
                          className="mt-2 rounded-lg px-3 py-2 text-xs"
                          style={{
                            background: "rgba(245,158,11,0.12)",
                            border: "1px solid rgba(245,158,11,0.35)",
                            color: "#f59e0b",
                          }}
                        >
                          This code has no eligible dates remaining — its window has ended or falls
                          outside the next 30 days. Remove the code to see the regular calendar.
                        </div>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Calendar */}
                    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                      <div className="text-white/35 text-xs uppercase tracking-[3px] mb-3 text-center">
                        Date
                      </div>
                      <div className="flex items-center justify-between mb-3">
                        <button
                          type="button"
                          onClick={() => {
                            if (calMonth === 0) {
                              setCalMonth(11);
                              setCalYear(calYear - 1);
                            } else setCalMonth(calMonth - 1);
                          }}
                          className="text-white/50 hover:text-white p-2"
                          aria-label="Previous month"
                        >
                          ←
                        </button>
                        <span className="font-body text-white font-bold text-sm">{monthName}</span>
                        <button
                          type="button"
                          onClick={() => {
                            if (calMonth === 11) {
                              setCalMonth(0);
                              setCalYear(calYear + 1);
                            } else setCalMonth(calMonth + 1);
                          }}
                          className="text-white/50 hover:text-white p-2"
                          aria-label="Next month"
                        >
                          →
                        </button>
                      </div>
                      <div className="grid grid-cols-7 mb-1">
                        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
                          <div key={d} className="text-center text-[12px] text-white/30 py-1">
                            {d}
                          </div>
                        ))}
                      </div>
                      <div className="grid grid-cols-7 gap-1">
                        {Array.from({ length: firstDay }).map((_, i) => (
                          <div key={`pad-${i}`} />
                        ))}
                        {Array.from({ length: daysInMonth }).map((_, i) => {
                          const day = i + 1;
                          const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                          const bookable = isBookableDate(dateStr);
                          const isSelected = dateStr === selectedDate;
                          return (
                            <button
                              key={day}
                              type="button"
                              disabled={!bookable}
                              onClick={() => {
                                setSelectedDate(dateStr);
                                setSelectedHour(null);
                                setSelectedMinute(null);
                                setAvailableSlots([]);
                                setSlotsError(null);
                                setTimeout(
                                  () =>
                                    hoursRef.current?.scrollIntoView({
                                      behavior: "smooth",
                                      block: "center",
                                    }),
                                  100,
                                );
                              }}
                              className="aspect-square rounded-lg text-sm font-medium transition-all duration-150"
                              style={{
                                backgroundColor: isSelected
                                  ? CORAL
                                  : bookable
                                    ? "rgba(253,91,86,0.15)"
                                    : "transparent",
                                color: isSelected
                                  ? "#0a1628"
                                  : bookable
                                    ? CORAL
                                    : "rgba(255,255,255,0.18)",
                                fontWeight: isSelected ? 800 : 500,
                                cursor: bookable ? "pointer" : "not-allowed",
                                boxShadow: isSelected ? `0 0 14px ${CORAL}60` : undefined,
                              }}
                            >
                              {day}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Hour chips */}
                    <div
                      ref={hoursRef}
                      className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"
                    >
                      {!selectedDate ? (
                        <div className="flex items-center justify-center h-full min-h-[200px]">
                          <p className="font-body text-white/30 text-sm">Pick a date first</p>
                        </div>
                      ) : (
                        <>
                          <div className="text-white/35 text-xs uppercase tracking-[3px] mb-3 text-center">
                            Time
                          </div>
                          <div className="flex flex-wrap justify-center gap-2">
                            {filteredHours.map((h) => {
                              const isActive = selectedHour === h;
                              return (
                                <button
                                  key={h}
                                  type="button"
                                  onClick={() => {
                                    setSelectedHour(h);
                                    setSelectedMinute(null);
                                    setTimeout(
                                      () =>
                                        minutesRef.current?.scrollIntoView({
                                          behavior: "smooth",
                                          block: "center",
                                        }),
                                      100,
                                    );
                                  }}
                                  className="rounded-lg px-3 py-2 text-sm font-medium transition-all"
                                  style={{
                                    backgroundColor: isActive ? GOLD : "rgba(255,215,0,0.10)",
                                    color: isActive ? "#0a1628" : GOLD,
                                    fontWeight: isActive ? 800 : 500,
                                    minWidth: "60px",
                                  }}
                                >
                                  {formatHour(h)}
                                </button>
                              );
                            })}
                          </div>
                          {selectedHour !== null &&
                            (() => {
                              // Offer :00 / :15 / :30 / :45 for the selected hour.
                              // For today, hide minutes whose slot is < 15 min from now.
                              // Actual QAMF availability is checked when the user hits
                              // "See Packages" — these chips just gate the CTA button.
                              const cutoffToday = (() => {
                                const td = todayYmd();
                                const nm = etNowMinutes();
                                if (selectedDate === td) return nm + 15;
                                if (selectedDate < td && nm < 120) return nm + 24 * 60 + 15;
                                return 0;
                              })();
                              const distinctMinutes = [0, 15, 30, 45].filter(
                                (m) => selectedHour * 60 + m >= cutoffToday,
                              );
                              // If the previously-selected minute was filtered out (e.g. page
                              // left open and time advanced past the cutoff), deselect it.
                              if (
                                selectedMinute !== null &&
                                !distinctMinutes.includes(selectedMinute)
                              ) {
                                setSelectedMinute(null);
                              }
                              return (
                                <div ref={minutesRef} className="mt-4 pt-3 border-t border-white/8">
                                  <div className="text-white/35 text-xs uppercase tracking-[3px] mb-3 text-center">
                                    Select Time
                                  </div>
                                  <div className="flex flex-wrap justify-center gap-2">
                                    {distinctMinutes.map((m) => {
                                      const isActive = selectedMinute === m;
                                      return (
                                        <button
                                          key={m}
                                          type="button"
                                          onClick={() => {
                                            setSelectedMinute(m);
                                            setTimeout(
                                              () =>
                                                seePackagesRef.current?.scrollIntoView({
                                                  behavior: "smooth",
                                                  block: "center",
                                                }),
                                              100,
                                            );
                                          }}
                                          className="rounded-lg px-3 py-2 text-sm font-medium transition-all hover:scale-[1.02]"
                                          style={{
                                            backgroundColor: isActive
                                              ? GOLD
                                              : "rgba(255,215,0,0.10)",
                                            color: isActive ? "#0a1628" : GOLD,
                                            fontWeight: isActive ? 800 : 500,
                                            minWidth: "90px",
                                            boxShadow: isActive ? `0 0 12px ${GOLD}60` : undefined,
                                          }}
                                        >
                                          {formatHourMinute(selectedHour, m)}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })()}
                        </>
                      )}
                    </div>
                  </div>

                  {/* CTA */}
                  <div ref={seePackagesRef} className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setStep(kind === "kbf" ? "bowlers" : "players")}
                      className="flex-1 rounded-full px-4 py-3 font-body font-bold text-xs sm:text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        setSelectedTier(null);
                        setStep("tier");
                        // Only fetch if date or player count changed since last fetch.
                        // QAMF returns all offers for the entire day in one call —
                        // no need to re-fetch just because the user picked a different time.
                        const key = `${selectedDate}:${activePlayerCount}:${selectedHour}:${selectedMinute}`;
                        if (lastFetchKey.current !== key) {
                          void fetchSlots(selectedDate, {
                            hour: selectedHour ?? undefined,
                            minute: selectedMinute ?? undefined,
                          });
                        }
                      }}
                      disabled={selectedHour === null || selectedMinute === null || slotsLoading}
                      className="flex-1 rounded-full px-4 sm:px-6 py-3 font-body font-bold text-xs sm:text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-50 text-center whitespace-nowrap"
                      style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                    >
                      {selectedHour !== null && selectedMinute !== null
                        ? "See Packages"
                        : selectedHour !== null
                          ? "Pick a time"
                          : "See Packages"}
                    </button>
                  </div>
                </div>
              );
            })()}

          {/* ═══════════════════════════════════════════════════════
              STEP: Tier — Regular vs VIP picker
          ═══════════════════════════════════════════════════════ */}
          {step === "tier" &&
            (() => {
              const dateLabel = selectedDate
                ? new Date(`${selectedDate}T12:00:00`).toLocaleDateString("en-US", {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                  })
                : "";

              // Only show tiers that have at least one experience valid for today's day-of-week
              const tierDow = new Date(`${selectedDate}T12:00:00`).getDay();
              // VIP first — it's the premium upsell and should be the first
              // thing the customer sees above the fold.
              const tiersToShow = (
                [
                  {
                    id: "vip" as const,
                    label: "VIP",
                    subtitle: "Premium VIP suite with NeoVerse video walls and HyperBowling.",
                    accent: GOLD,
                    videoUrl: `${BLOB}/videos/headpinz-neoverse-v2.mp4`,
                    features: [
                      "VIP lounge & dedicated lanes",
                      "NeoVerse video walls",
                      "HyperBowling technology",
                    ],
                  },
                  {
                    id: "regular" as const,
                    label: "Regular",
                    subtitle: "Standard HeadPinz lanes — great for families and groups.",
                    accent: CORAL,
                    videoUrl: `${BLOB}/videos/headpinz-bowling.mp4`,
                    features: [
                      "Standard lanes",
                      "Up to 6 bowlers per lane",
                      "Glow lighting evenings",
                    ],
                  },
                ] as const
              ).filter((t) =>
                experiences.some(
                  (e) =>
                    (t.id === "vip" ? e.isVip : !e.isVip) &&
                    (!e.daysOfWeek.length || e.daysOfWeek.includes(tierDow)),
                ),
              );

              // Per-tier availability at the selected time + next-available fallback.
              // availableSlots contains all QAMF slots already fetched for this date.
              function tierAvailability(tierId: "regular" | "vip") {
                const tierExps = experiences.filter(
                  (e) =>
                    (tierId === "vip" ? e.isVip : !e.isVip) &&
                    (!e.daysOfWeek.length || e.daysOfWeek.includes(tierDow)),
                );
                // Slots belonging to any experience in this tier
                const tierSlots = availableSlots.filter((s) =>
                  tierExps.some((e) => e.qamfWebOfferId === s.webOfferId),
                );

                // Check if any slot matches the currently selected hour+minute
                const hasAtTime =
                  selectedHour === null ||
                  tierSlots.some(
                    (s) =>
                      slotHourET(s.bookedAt, selectedDate) === selectedHour &&
                      (selectedMinute === null || slotMinuteET(s.bookedAt) === selectedMinute),
                  );

                // If nothing at the chosen time, find the nearest slot after it
                const nextSlot = hasAtTime
                  ? null
                  : (tierSlots
                      .filter((s) => {
                        if (selectedHour === null) return true;
                        const h = slotHourET(s.bookedAt, selectedDate);
                        const m = slotMinuteET(s.bookedAt);
                        if (h > selectedHour) return true;
                        if (h === selectedHour && m > (selectedMinute ?? -1)) return true;
                        return false;
                      })
                      .sort((a, b) => a.bookedAt.localeCompare(b.bookedAt))[0] ?? null);

                return { hasAtTime, nextSlot };
              }

              return (
                <div className="space-y-6">
                  <p className="text-center text-white/45 text-xs">
                    {selectedHour !== null && selectedMinute !== null
                      ? `Available at ${formatHourMinute(selectedHour, selectedMinute)}`
                      : "Available"}{" "}
                    on {dateLabel}
                  </p>

                  {/* Loading state — shown while availability OR experiences
                    fetch is in flight. Both must complete before tiersToShow
                    can be evaluated honestly: experiences[] drives the filter,
                    and if it's still empty we'd false-negative as "No packages
                    available" on the first visit (race vs the availability
                    fetch). We advance to this step immediately when "See
                    Packages" is tapped so the user sees forward motion instead
                    of a frozen calendar screen. */}
                  {slotsLoading || experiencesLoading ? (
                    <LoadingPackages />
                  ) : tiersToShow.length === 0 ? (
                    <div className="text-center py-10 space-y-4">
                      <p className="font-body text-white/65 text-sm">
                        {selectedHour !== null && selectedMinute !== null
                          ? `No packages open at ${formatHourMinute(selectedHour, selectedMinute)} on ${dateLabel} at ${center.name}.`
                          : `No packages open on ${dateLabel} at ${center.name}.`}
                      </p>
                      <p className="font-body text-white/45 text-xs">
                        Try a different time or pick another date.
                      </p>
                      <button
                        type="button"
                        onClick={() => setStep("slots")}
                        className="rounded-full px-5 py-2.5 font-body font-bold text-xs uppercase tracking-wider text-white transition-all hover:scale-[1.01]"
                        style={{ backgroundColor: CORAL, boxShadow: `0 0 14px ${CORAL}40` }}
                      >
                        Change time
                      </button>
                    </div>
                  ) : availableSlots.length === 0 ? (
                    // Fetch finished with no data — either an upstream blip
                    // (slotsError set, e.g. cold-Lambda retry exhausted) or
                    // genuinely zero availability for this date. Either way,
                    // render ONE coherent message + retry instead of N tier
                    // cards each saying "No more availability today," which
                    // misleadingly implies QAMF said the day is sold out.
                    <div className="text-center py-10 space-y-4">
                      <p className="font-body text-white/55 text-sm">
                        {slotsError
                          ? "We couldn't reach the bowling system. Please try again."
                          : "No times available for this day. Try another date."}
                      </p>
                      <div className="flex gap-3 justify-center">
                        <button
                          type="button"
                          onClick={() => {
                            setError(null);
                            lastFetchKey.current = "";
                            void fetchSlots(selectedDate, {
                              hour: selectedHour ?? undefined,
                              minute: selectedMinute ?? undefined,
                            });
                          }}
                          className="rounded-full px-5 py-2.5 font-body font-bold text-xs uppercase tracking-wider text-white transition-all hover:scale-[1.01]"
                          style={{ backgroundColor: CORAL, boxShadow: `0 0 14px ${CORAL}40` }}
                        >
                          Retry
                        </button>
                        <button
                          type="button"
                          onClick={() => setStep("slots")}
                          className="rounded-full px-5 py-2.5 font-body font-bold text-xs uppercase tracking-wider text-white/70 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
                        >
                          Change time
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {tiersToShow.map((tier) => {
                        const { hasAtTime, nextSlot } = tierAvailability(tier.id);
                        const nextH = nextSlot ? slotHourET(nextSlot.bookedAt, selectedDate) : null;
                        const nextM = nextSlot ? slotMinuteET(nextSlot.bookedAt) : null;
                        const isClickable = hasAtTime || nextSlot !== null;
                        return (
                          <div
                            key={tier.id}
                            role={isClickable ? "button" : undefined}
                            tabIndex={isClickable ? 0 : undefined}
                            className={`w-full rounded-xl overflow-hidden text-left transition-all${isClickable ? " cursor-pointer hover:scale-[1.005] active:scale-[0.99]" : " cursor-default"}`}
                            style={{
                              backgroundColor: "rgba(7,16,39,0.5)",
                              border: `1.78px solid ${tier.accent}${hasAtTime ? "50" : "28"}`,
                              boxShadow: hasAtTime ? `0 0 24px ${tier.accent}18` : "none",
                              opacity: hasAtTime ? 1 : 0.85,
                            }}
                            onClick={() => {
                              if (hasAtTime) {
                                setSelectedTier(tier.id);
                                setStep("offer");
                              } else if (nextSlot && nextH !== null && nextM !== null) {
                                setTierTimeConfirm({ tierId: tier.id, hour: nextH, minute: nextM });
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                if (hasAtTime) {
                                  setSelectedTier(tier.id);
                                  setStep("offer");
                                } else if (nextSlot && nextH !== null && nextM !== null) {
                                  setTierTimeConfirm({
                                    tierId: tier.id,
                                    hour: nextH,
                                    minute: nextM,
                                  });
                                }
                              }
                            }}
                          >
                            <div className="flex flex-col sm:flex-row">
                              {/* Video thumbnail */}
                              <div className="relative w-full sm:w-52 h-36 sm:h-auto shrink-0 overflow-hidden">
                                <video
                                  autoPlay
                                  muted
                                  loop
                                  playsInline
                                  preload="metadata"
                                  className="absolute inset-0 w-full h-full object-cover"
                                >
                                  <source src={tier.videoUrl} type="video/mp4" />
                                </video>
                                <div className="absolute inset-0 bg-gradient-to-b sm:bg-gradient-to-r from-transparent to-[#071027]/70 pointer-events-none" />
                              </div>
                              {/* Content */}
                              <div className="flex-1 p-5">
                                <div className="flex items-center gap-2 mb-1">
                                  <h3
                                    className="font-heading uppercase text-white text-lg tracking-wider"
                                    style={{ textShadow: `0 0 18px ${tier.accent}30` }}
                                  >
                                    {tier.label}
                                  </h3>
                                  {tier.id === "vip" && (
                                    <span
                                      className="font-body text-xs uppercase tracking-wider px-2 py-0.5 rounded-full font-bold"
                                      style={{
                                        backgroundColor: `${GOLD}22`,
                                        color: GOLD,
                                        border: `1px solid ${GOLD}50`,
                                      }}
                                    >
                                      Premium
                                    </span>
                                  )}
                                </div>
                                <p className="font-body text-white/55 text-sm mb-3">
                                  {tier.subtitle}
                                </p>
                                {kind === "kbf" && tier.id === "vip" && (
                                  <p
                                    className="font-body text-xs mb-3 -mt-1"
                                    style={{ color: GOLD }}
                                  >
                                    +$1/game per person VIP upcharge · bowling is still free
                                  </p>
                                )}
                                <div className="flex flex-wrap gap-x-4 gap-y-1 mb-4">
                                  {tier.features.map((f) => (
                                    <span key={f} className="flex items-center gap-1.5">
                                      <span
                                        className="w-1.5 h-1.5 rounded-full"
                                        style={{ backgroundColor: tier.accent }}
                                      />
                                      <span className="font-body text-white/40 text-xs">{f}</span>
                                    </span>
                                  ))}
                                </div>
                                {hasAtTime ? (
                                  <div
                                    className="inline-flex items-center gap-1.5 font-body text-xs font-bold uppercase tracking-wider"
                                    style={{ color: tier.accent }}
                                  >
                                    Select {tier.label} →
                                  </div>
                                ) : nextSlot && nextH !== null && nextM !== null ? (
                                  <div className="space-y-0.5">
                                    <p className="font-body text-white/35 text-xs">
                                      No lanes at{" "}
                                      {selectedHour !== null
                                        ? formatHourMinute(selectedHour, selectedMinute ?? 0)
                                        : "this time"}
                                    </p>
                                    <p
                                      className="font-body text-xs font-bold"
                                      style={{ color: tier.accent }}
                                    >
                                      Next available: {formatHourMinute(nextH, nextM)} →
                                    </p>
                                  </div>
                                ) : (
                                  <p className="font-body text-white/30 text-xs">
                                    No more availability today — try another date
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {!slotsLoading && (
                    <button
                      type="button"
                      onClick={() => setStep("slots")}
                      className="w-full rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/70 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
                    >
                      Back
                    </button>
                  )}

                  {/* ── Time-switch confirmation modal ────────────────── */}
                  {tierTimeConfirm &&
                    (() => {
                      const confirmTier = tiersToShow.find((t) => t.id === tierTimeConfirm.tierId);
                      const currentTimeLabel =
                        selectedHour !== null
                          ? formatHourMinute(selectedHour, selectedMinute ?? 0)
                          : "selected time";
                      const nextTimeLabel = formatHourMinute(
                        tierTimeConfirm.hour,
                        tierTimeConfirm.minute,
                      );
                      return (
                        <div
                          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
                          style={{
                            backgroundColor: "rgba(0,0,0,0.65)",
                            backdropFilter: "blur(4px)",
                          }}
                          {...modalBackdropProps(() => setTierTimeConfirm(null))}
                        >
                          <div
                            className="w-full sm:max-w-sm mx-0 sm:mx-4 rounded-t-2xl sm:rounded-2xl p-6 pb-8 sm:pb-6"
                            style={{
                              backgroundColor: "#0d1829",
                              border: "1px solid rgba(255,255,255,0.10)",
                            }}
                          >
                            <p className="font-heading uppercase tracking-widest text-white/50 text-xs mb-3">
                              Switch time?
                            </p>
                            <p className="font-body text-white text-base mb-1">
                              {confirmTier?.label ?? "This lane"} isn&apos;t available at{" "}
                              {currentTimeLabel}.
                            </p>
                            <p className="font-body text-white/55 text-sm mb-6">
                              Switch your time to{" "}
                              <span className="text-white font-bold">{nextTimeLabel}</span> and
                              continue?
                            </p>
                            <div className="flex gap-3">
                              <button
                                type="button"
                                onClick={() => setTierTimeConfirm(null)}
                                className="flex-1 rounded-xl py-3 font-body font-bold text-sm text-white/60 hover:text-white transition-colors"
                                style={{ border: "1px solid rgba(255,255,255,0.15)" }}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedHour(tierTimeConfirm.hour);
                                  setSelectedMinute(tierTimeConfirm.minute);
                                  setSelectedTier(tierTimeConfirm.tierId);
                                  setStep("offer");
                                  setTierTimeConfirm(null);
                                }}
                                className="flex-1 rounded-xl py-3 font-body font-bold text-sm text-white transition-colors"
                                style={{
                                  backgroundColor: confirmTier?.accent
                                    ? `${confirmTier.accent}22`
                                    : "rgba(255,255,255,0.1)",
                                  border: `1px solid ${confirmTier?.accent ?? "rgba(255,255,255,0.3)"}`,
                                  color: confirmTier?.accent ?? "white",
                                }}
                              >
                                Switch to {nextTimeLabel}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                </div>
              );
            })()}

          {/* ═══════════════════════════════════════════════════════
              STEP: Offer — video cards + time chips
          ═══════════════════════════════════════════════════════ */}
          {step === "offer" &&
            (() => {
              // Filter experiences for offer cards:
              //   1. Must be valid for the selected day-of-week
              //   2. Must match the selected tier (Regular vs VIP)
              //   3. 'open' kind (Fun 4 All, Pizza Bowl) — hide when QAMF has no slots on this day
              //   4. 'hourly' kind — always show (may be genuinely sold out; show SOLD OUT badge)
              const selectedDow = new Date(`${selectedDate}T12:00:00`).getDay();
              const offerExperiences = experiences.filter((exp) => {
                // Day-of-week gate — skip if this experience doesn't run today
                if (exp.daysOfWeek.length && !exp.daysOfWeek.includes(selectedDow)) return false;
                const tierMatch =
                  selectedTier === null || (selectedTier === "vip" ? exp.isVip : !exp.isVip);
                if (!tierMatch) return false;
                if (exp.kind === "open") {
                  // Fun 4 All / Pizza Bowl — only show when QAMF confirms availability
                  return availableSlots.some(
                    (s) =>
                      s.webOfferId === exp.qamfWebOfferId &&
                      (selectedHour === null ||
                        slotHourET(s.bookedAt, selectedDate) === selectedHour) &&
                      (selectedMinute === null || slotMinuteET(s.bookedAt) === selectedMinute),
                  );
                }
                return true; // hourly: always show, may show SOLD OUT
              });

              // Specials (open kind) always on top, hourly lane rentals below.
              // This puts Fun 4 All, Pizza Bowl, and Midnight Madness above
              // the per-hour lane rental options.
              offerExperiences.sort((a, b) => {
                const aP = a.kind === "open" ? 0 : 1;
                const bP = b.kind === "open" ? 0 : 1;
                return aP - bP;
              });

              return (
                <div className="space-y-6">
                  <p className="text-center text-white/45 text-xs">
                    {selectedHour !== null && selectedMinute !== null
                      ? `Showing packages at ${formatHourMinute(selectedHour, selectedMinute)}`
                      : "Showing packages"}{" "}
                    on{" "}
                    {selectedDate
                      ? new Date(`${selectedDate}T12:00:00`).toLocaleDateString("en-US", {
                          weekday: "long",
                          month: "long",
                          day: "numeric",
                        })
                      : ""}
                  </p>

                  <div className="space-y-4">
                    {offerExperiences.map((exp) => {
                      const display = getExperienceDisplay(exp.slug, exp.isVip);
                      const accent = display.accent;
                      const isHourly = exp.kind === "hourly";
                      const isPerLane = isHourly || !!display.perLane;
                      const offerSlots = availableSlots.filter(
                        (s) =>
                          s.webOfferId === exp.qamfWebOfferId &&
                          (selectedHour === null ||
                            slotHourET(s.bookedAt, selectedDate) === selectedHour) &&
                          (selectedMinute === null || slotMinuteET(s.bookedAt) === selectedMinute),
                      );
                      const hasSlots = offerSlots.length > 0;
                      const isExpSelected = selectedSlot?.webOfferId === exp.qamfWebOfferId;
                      const includesShoes = display.includesShoes ?? false;

                      // Base lane/game item for pricing
                      const baseItem = exp.items[0];
                      const baseItemCents = (baseItem?.priceCents ?? 0) * (baseItem?.quantity ?? 1);
                      const baseTotalCents = exp.items.reduce(
                        (s, i) => s + i.priceCents * i.quantity,
                        0,
                      );

                      // KBF base bowling is free, but VIP adds $1/person/game upcharge
                      const isKbfFree = exp.items.length === 0 && kind === "kbf";
                      const isFree = isKbfFree && !exp.isVip;
                      const isKbfVip = isKbfFree && exp.isVip;
                      // VIP upcharge: $1/game × 2 games × all bowlers
                      const kbfVipPerBowlerCents = 200; // $1/game × 2 games
                      const kbfVipTotalCents = isKbfVip
                        ? activePlayerCount * kbfVipPerBowlerCents
                        : 0;
                      // Specials (open kind) = Fun 4 All, Pizza Bowl, Midnight Madness
                      const isSpecial = exp.kind === "open";

                      return (
                        <div
                          key={exp.qamfWebOfferId}
                          className="w-full rounded-xl overflow-hidden"
                          style={{
                            border: `1.78px solid ${isExpSelected ? `${accent}88` : isSpecial ? `${accent}50` : `${accent}28`}`,
                            boxShadow: isExpSelected
                              ? `0 0 28px ${accent}20`
                              : isSpecial
                                ? `0 0 20px ${accent}15`
                                : undefined,
                          }}
                        >
                          {/* Top banner — deal badge for specials, shoes-included for non-specials */}
                          {isSpecial && hasSlots ? (
                            <div
                              className="w-full py-2.5 px-4 text-center font-body font-bold text-xs uppercase tracking-widest"
                              style={{
                                background: `linear-gradient(135deg, ${accent}30, ${accent}18)`,
                                color: accent,
                                borderBottom: `1px solid ${accent}30`,
                              }}
                            >
                              ★ Special — Everything Included ★
                            </div>
                          ) : includesShoes && hasSlots ? (
                            <div
                              className="w-full py-2 px-4 text-center font-body font-bold text-xs uppercase tracking-widest"
                              style={{
                                backgroundColor: `${accent}22`,
                                color: accent,
                                borderBottom: `1px solid ${accent}30`,
                              }}
                            >
                              ★ Bowling Shoes Included ★
                            </div>
                          ) : null}

                          <div
                            className="flex flex-col sm:flex-row"
                            style={{ backgroundColor: "rgba(7,16,39,0.55)" }}
                          >
                            {/* Video */}
                            <div
                              className="relative w-full sm:w-52 shrink-0 overflow-hidden"
                              style={{ minHeight: "10rem" }}
                            >
                              <video
                                autoPlay
                                muted
                                loop
                                playsInline
                                preload="metadata"
                                className="absolute inset-0 w-full h-full object-cover"
                                key={display.videoUrl}
                              >
                                <source src={display.videoUrl} type="video/mp4" />
                              </video>
                              <div className="absolute inset-0 bg-gradient-to-b sm:bg-gradient-to-r from-transparent to-[#071027]/60 pointer-events-none" />
                              {/* Per-person / per-lane badge */}
                              <div className="absolute top-3 left-3">
                                <span
                                  className="font-body font-bold text-[10px] uppercase tracking-widest px-2.5 py-1 rounded-full"
                                  style={{ backgroundColor: accent, color: "#0a1628" }}
                                >
                                  {isPerLane ? "Per Lane" : "Per Person"}
                                </span>
                              </div>
                            </div>

                            {/* Content */}
                            <div className="flex-1 p-5">
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                <h3
                                  className="font-heading uppercase text-white text-base tracking-wider"
                                  style={{ textShadow: `0 0 15px ${accent}25` }}
                                >
                                  {exp.label}
                                </h3>
                                {!hasSlots && (
                                  <span
                                    className="font-body text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
                                    style={{
                                      backgroundColor: "rgba(253,91,86,0.18)",
                                      color: CORAL,
                                      border: `1px solid ${CORAL}40`,
                                    }}
                                  >
                                    Sold Out
                                  </span>
                                )}
                              </div>
                              <p className="font-body text-white/55 text-sm mb-3">
                                {display.description}
                              </p>

                              {/* "What's included" checklist — special deal style */}
                              {isSpecial && (
                                <ul className="space-y-1.5 mb-4">
                                  {display.features.map((feat) => (
                                    <li
                                      key={feat}
                                      className="flex items-baseline justify-between gap-2 text-xs"
                                    >
                                      <span className="font-body text-white/75">
                                        <span className="text-emerald-400 mr-1.5">✓</span>
                                        {feat}
                                      </span>
                                      <span className="font-body font-semibold text-[10px] uppercase tracking-wider text-emerald-300/80">
                                        Included
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}

                              {isHourly && exp.durationOptions.length > 0 ? (
                                /* Duration tiles (Open Bowling Mon-Thur style) */
                                <div className="flex gap-3 flex-wrap">
                                  {exp.durationOptions.map((opt) => {
                                    // Use the override product price if set (e.g. 1hr item for 2hr),
                                    // otherwise fall back to the base experience item price.
                                    const unitCents = opt.overridePriceCents ?? baseItemCents;
                                    const optCents = Math.round(unitCents * opt.squareMultiplier);
                                    const isOn =
                                      isExpSelected && selectedSlot?.optionId === opt.qamfOptionId;
                                    const firstSlot = offerSlots[0];
                                    return (
                                      <button
                                        key={opt.qamfOptionId}
                                        type="button"
                                        disabled={!hasSlots}
                                        onClick={() => {
                                          if (!firstSlot) return;
                                          const slot = { ...firstSlot, optionId: opt.qamfOptionId };
                                          setSelectedSlot(slot);
                                          if (!holdBusy) void createHold(slot);
                                        }}
                                        className="flex flex-col items-center rounded-xl p-4 min-w-[110px] transition-all hover:scale-[1.02] disabled:opacity-40 disabled:cursor-not-allowed"
                                        style={{
                                          backgroundColor: isOn ? accent : `${accent}14`,
                                          border: `1.5px solid ${isOn ? accent : `${accent}45`}`,
                                          boxShadow: isOn ? `0 0 14px ${accent}40` : undefined,
                                        }}
                                      >
                                        <span
                                          className="font-body font-bold text-sm uppercase tracking-wider"
                                          style={{
                                            color: isOn ? "#0a1628" : "rgba(255,255,255,0.7)",
                                          }}
                                        >
                                          {opt.label}
                                        </span>
                                        <span
                                          className="font-heading text-xl font-bold mt-1"
                                          style={{ color: isOn ? "#0a1628" : accent }}
                                        >
                                          {centsToDollars(optCents)}
                                        </span>
                                        <span
                                          className="font-body text-[11px] mt-0.5"
                                          style={{
                                            color: isOn ? "#0a162890" : "rgba(255,255,255,0.35)",
                                          }}
                                        >
                                          per lane
                                        </span>
                                        {isOn && (
                                          <span
                                            className="text-xs mt-1"
                                            style={{ color: "#0a1628" }}
                                          >
                                            ✓ Selected
                                          </span>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              ) : isHourly ? (
                                /* Hourly but no duration options — just time chips */
                                hasSlots ? (
                                  <div className="flex flex-wrap gap-2">
                                    {offerSlots.map((s) => {
                                      const on =
                                        selectedSlot?.bookedAt === s.bookedAt &&
                                        selectedSlot?.webOfferId === s.webOfferId;
                                      return (
                                        <button
                                          key={s.bookedAt}
                                          type="button"
                                          onClick={() => {
                                            setSelectedSlot(s);
                                            if (!holdBusy) void createHold(s);
                                          }}
                                          className="inline-flex items-center font-body text-sm font-bold uppercase tracking-wider px-4 py-2 rounded-full transition-all hover:scale-[1.02]"
                                          style={{
                                            backgroundColor: on ? accent : `${accent}1a`,
                                            color: on ? "#0a1628" : accent,
                                            border: `1px solid ${on ? accent : `${accent}55`}`,
                                            boxShadow: on ? `0 0 10px ${accent}40` : undefined,
                                          }}
                                        >
                                          {formatTime(s.bookedAt)}
                                          {on && <span className="ml-1.5">✓</span>}
                                        </button>
                                      );
                                    })}
                                  </div>
                                ) : null
                              ) : (
                                /* 'open' kind (Fun 4 All / Pizza Bowl / KBF) */
                                hasSlots && (
                                  <div>
                                    {/* Price row */}
                                    <div className="flex items-baseline gap-2 mb-3">
                                      <span
                                        className="font-heading text-2xl font-bold"
                                        style={{ color: accent }}
                                      >
                                        {isKbfVip
                                          ? centsToDollars(kbfVipTotalCents)
                                          : isFree
                                            ? "Free"
                                            : centsToDollars(
                                                isPerLane
                                                  ? baseTotalCents
                                                  : baseTotalCents * activePlayerCount,
                                              )}
                                      </span>
                                      {isKbfVip ? (
                                        <span className="font-body text-white/40 text-sm">
                                          $1/game × 2 games × {activePlayerCount}{" "}
                                          {activePlayerCount === 1 ? "bowler" : "bowlers"}
                                        </span>
                                      ) : !isFree ? (
                                        <span className="font-body text-white/40 text-sm">
                                          {isPerLane
                                            ? "per lane"
                                            : `${centsToDollars(baseTotalCents)}/person`}
                                        </span>
                                      ) : null}
                                    </div>
                                    {/* Time chips */}
                                    <div className="flex flex-wrap gap-2">
                                      {offerSlots.map((s) => {
                                        const on =
                                          selectedSlot?.bookedAt === s.bookedAt &&
                                          selectedSlot?.webOfferId === s.webOfferId;
                                        return (
                                          <button
                                            key={s.bookedAt}
                                            type="button"
                                            onClick={() => {
                                              setSelectedSlot(s);
                                              if (!holdBusy) void createHold(s);
                                            }}
                                            className="inline-flex items-center font-body text-sm font-bold uppercase tracking-wider px-4 py-2 rounded-full transition-all hover:scale-[1.02]"
                                            style={{
                                              backgroundColor: on ? accent : `${accent}1a`,
                                              color: on ? "#0a1628" : accent,
                                              border: `1px solid ${on ? accent : `${accent}55`}`,
                                              boxShadow: on ? `0 0 10px ${accent}40` : undefined,
                                            }}
                                          >
                                            {formatTime(s.bookedAt)}
                                            {on && <span className="ml-1.5">✓</span>}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedSlot(null);
                        setStep("tier");
                      }}
                      className="flex-1 rounded-full px-4 py-3 font-body font-bold text-xs sm:text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!selectedSlot) {
                          setError("Please select a time slot");
                          return;
                        }
                        setError(null);
                        // Show VIP upgrade modal when Regular selected and VIP slot exists.
                        // Hold creation is handled inside the modal (No Thanks / Upgrade).
                        if (selectedTier === "regular" && vipUpgradeSlot) {
                          setShowVipUpgrade(true);
                          return;
                        }
                        // Hold was already created when user tapped the time chip.
                        // Just advance to the next step. Per-lane experiences
                        // don't include shoes unless explicitly flagged — only
                        // skip the shoes step when the package actually
                        // includes shoes.
                        if (selectedIncludesShoes) {
                          setStep("attractions");
                        } else {
                          setStep("shoes");
                        }
                      }}
                      disabled={!selectedSlot}
                      className="flex-1 rounded-full px-4 sm:px-6 py-3 font-body font-bold text-xs sm:text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-50 text-center whitespace-nowrap"
                      style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                    >
                      {selectedSlot ? "Continue" : "Select a time"}
                    </button>
                  </div>
                </div>
              );
            })()}

          {/* ═══════════════════════════════════════════════════════
              VIP UPGRADE MODAL
          ═══════════════════════════════════════════════════════ */}
          {showVipUpgrade &&
            vipUpgradeExperience &&
            vipUpgradeSlot &&
            selectedExperience &&
            selectedSlot &&
            (() => {
              const vipDisplay = getExperienceDisplay(vipUpgradeExperience.slug, true);
              const regTotal = selectedExperience.items.reduce(
                (s, i) => s + i.priceCents * i.quantity,
                0,
              );
              const vipTotal = vipUpgradeExperience.items.reduce(
                (s, i) => s + i.priceCents * i.quantity,
                0,
              );
              const delta = vipTotal - regTotal;
              const isHourly = vipUpgradeExperience.kind === "hourly";
              const vipIsPerLane =
                isHourly || !!getExperienceDisplay(vipUpgradeExperience.slug, true).perLane;
              return (
                <div
                  className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
                  style={{ backgroundColor: "rgba(0,0,0,0.78)" }}
                >
                  <div
                    className="w-full max-w-md rounded-2xl overflow-hidden"
                    style={{ backgroundColor: "#0d1f3c", border: `2px solid ${GOLD}55` }}
                  >
                    {/* Header video strip */}
                    <div className="relative h-36 overflow-hidden">
                      <video
                        autoPlay
                        muted
                        loop
                        playsInline
                        preload="metadata"
                        className="absolute inset-0 w-full h-full object-cover"
                      >
                        <source src={vipDisplay.videoUrl} type="video/mp4" />
                      </video>
                      <div
                        className="absolute inset-0"
                        style={{
                          background: "linear-gradient(to bottom, transparent 30%, #0d1f3c 100%)",
                        }}
                      />
                      <div className="absolute bottom-3 left-4">
                        <span
                          className="font-body font-bold text-[10px] uppercase tracking-widest px-2.5 py-1 rounded-full"
                          style={{ backgroundColor: GOLD, color: "#0a1628" }}
                        >
                          VIP Upgrade
                        </span>
                      </div>
                    </div>

                    <div className="p-5">
                      <h3
                        className="font-heading uppercase text-white text-xl tracking-wider mb-1"
                        style={{ textShadow: `0 0 20px ${GOLD}40` }}
                      >
                        Upgrade to VIP?
                      </h3>
                      <p className="font-body text-white/55 text-sm mb-4">
                        {vipDisplay.description}
                      </p>

                      {/* Feature list */}
                      <div className="space-y-2 mb-5">
                        {vipDisplay.features.map((f) => (
                          <div key={f} className="flex items-center gap-2">
                            <span
                              className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                              style={{ backgroundColor: `${GOLD}25`, color: GOLD }}
                            >
                              ✓
                            </span>
                            <span className="font-body text-white/70 text-sm">{f}</span>
                          </div>
                        ))}
                      </div>

                      {/* Price differential */}
                      {delta > 0 && (
                        <div
                          className="rounded-xl px-4 py-3 mb-5 flex items-center justify-between"
                          style={{ backgroundColor: `${GOLD}12`, border: `1px solid ${GOLD}30` }}
                        >
                          <span className="font-body text-white/55 text-sm">VIP upgrade</span>
                          <span className="font-heading font-bold text-lg" style={{ color: GOLD }}>
                            +{centsToDollars(delta)}
                            <span className="font-body text-sm font-normal text-white/40">
                              /{vipIsPerLane ? "lane" : "person"}
                            </span>
                          </span>
                        </div>
                      )}

                      {/* Buttons */}
                      <div className="flex gap-3">
                        <button
                          type="button"
                          onClick={() => {
                            setShowVipUpgrade(false);
                            // Create hold on the regular slot and advance
                            void createHoldAndAdvance(
                              selectedSlot,
                              selectedIncludesShoes,
                              selectedIsPerLane,
                            );
                          }}
                          className="flex-1 py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider border border-white/20 text-white/60 hover:text-white hover:border-white/40 transition-colors"
                        >
                          No Thanks
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            // Switch to VIP slot and create hold on it.
                            // If the VIP slot was just taken, silently fall
                            // back to the regular slot the user already had
                            // selected and advance — they don't lose their
                            // session over a VIP availability blip.
                            setSelectedTier("vip");
                            setSelectedSlot(vipUpgradeSlot);
                            setShowVipUpgrade(false);
                            const vipIncludesShoes = vipDisplay.includesShoes ?? false;
                            const regularFallbackSlot = selectedSlot;
                            void createHoldAndAdvance(
                              vipUpgradeSlot,
                              vipIncludesShoes,
                              vipIsPerLane,
                              regularFallbackSlot
                                ? {
                                    slot: regularFallbackSlot,
                                    incShoes: selectedIncludesShoes,
                                    isPerLaneExp: selectedIsPerLane,
                                    onFallback: () => {
                                      // Revert UI back to the regular slot
                                      setSelectedTier("regular");
                                      setSelectedSlot(regularFallbackSlot);
                                      setError(
                                        "That VIP lane was just taken — keeping your regular lane.",
                                      );
                                    },
                                  }
                                : undefined,
                            );
                          }}
                          className="flex-1 py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider text-[#0a1628] transition-all hover:scale-[1.02]"
                          style={{ backgroundColor: GOLD, boxShadow: `0 0 18px ${GOLD}40` }}
                        >
                          {delta > 0 ? `Upgrade +${centsToDollars(delta)}` : "Upgrade to VIP"}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

          {/* ═══════════════════════════════════════════════════════
              STEP: Shoes
          ═══════════════════════════════════════════════════════ */}
          {step === "shoes" && (
            <div className="space-y-4">
              <p className="font-body text-white/55 text-sm text-center">
                Add shoe rental for your group
              </p>
              {shoeProducts.length === 0 ? (
                <div
                  className="rounded-xl p-4 text-center"
                  style={{ border: "1.78px dashed rgba(255,255,255,0.08)" }}
                >
                  <p className="font-body text-white/35 text-sm">
                    No shoe rental available — bring your own or rent at the center.
                  </p>
                </div>
              ) : (
                shoeProducts.map((p) => {
                  const qty = shoeQty[p.id] ?? 0;
                  return (
                    <div
                      key={p.id}
                      className="rounded-xl p-4"
                      style={{
                        backgroundColor:
                          qty > 0 ? "rgba(253,91,86,0.08)" : "rgba(255,255,255,0.04)",
                        border: `1.78px dashed ${qty > 0 ? `${CORAL}40` : "rgba(255,255,255,0.10)"}`,
                      }}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className="font-body font-bold text-white text-sm">{p.label}</div>
                          <div className="font-body text-white/40 text-xs">
                            {centsToDollars(p.priceCents)} / person
                          </div>
                        </div>
                        <div className="font-body font-bold text-sm" style={{ color: CORAL }}>
                          {qty > 0 ? centsToDollars(p.priceCents * qty) : ""}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() =>
                            setShoeQty((q) => ({ ...q, [p.id]: Math.max(0, (q[p.id] ?? 0) - 1) }))
                          }
                          className="w-9 h-9 rounded-full border border-white/20 text-white/60 hover:text-white hover:border-white/40 flex items-center justify-center text-lg leading-none transition-colors"
                        >
                          −
                        </button>
                        <span className="w-6 text-center text-white font-bold text-sm">{qty}</span>
                        <button
                          type="button"
                          onClick={() =>
                            setShoeQty((q) => ({
                              ...q,
                              [p.id]: Math.min(activePlayerCount, (q[p.id] ?? 0) + 1),
                            }))
                          }
                          className="w-9 h-9 rounded-full border border-white/20 text-white/60 hover:text-white hover:border-white/40 flex items-center justify-center text-lg leading-none transition-colors"
                        >
                          +
                        </button>
                        <span className="font-body text-white/35 text-xs">
                          {qty === 0 ? "none" : `${qty} pair${qty === 1 ? "" : "s"}`}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (holdActive) {
                      setPendingRelease("offer");
                    } else {
                      setStep("offer");
                    }
                  }}
                  className="flex-1 rounded-full px-4 py-3 font-body font-bold text-xs sm:text-sm uppercase tracking-wider text-white/80 border border-white/15"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    if (shoePreTaxTotal === 0) {
                      setShowNoShoesModal(true);
                      return;
                    }
                    setStep("attractions");
                  }}
                  className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white"
                  style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                >
                  {shoePreTaxTotal > 0
                    ? `Continue — ${centsToDollars(shoePreTaxTotal)}`
                    : "Skip Shoes"}
                </button>
              </div>

              {/* ── No-shoes warning modal ───────────────────────────── */}
              {showNoShoesModal && (
                <div
                  className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
                  style={{
                    backgroundColor: "rgba(0,0,0,0.65)",
                    backdropFilter: "blur(4px)",
                  }}
                  {...modalBackdropProps(() => setShowNoShoesModal(false))}
                >
                  <div
                    className="w-full sm:max-w-sm mx-0 sm:mx-4 rounded-t-2xl sm:rounded-2xl p-6 pb-8 sm:pb-6"
                    style={{
                      backgroundColor: "#0d1829",
                      border: "1px solid rgba(255,255,255,0.10)",
                    }}
                  >
                    <p className="font-heading uppercase tracking-widest text-white/50 text-xs mb-3">
                      Bowling Shoes Required
                    </p>
                    <p className="font-body text-white text-base mb-1">
                      You must have bowling shoes to bowl.
                    </p>
                    <p className="font-body text-white/55 text-sm mb-6">
                      If you do not have your own bowling shoes, please add rentals now to avoid
                      delays at check-in.
                    </p>
                    <div className="flex flex-col gap-3">
                      <button
                        type="button"
                        onClick={() => setShowNoShoesModal(false)}
                        className="w-full rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white"
                        style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                      >
                        Add Shoes
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowNoShoesModal(false);
                          setStep("attractions");
                        }}
                        className="w-full rounded-full px-4 py-3 font-body font-bold text-xs sm:text-sm uppercase tracking-wider text-white/80 border border-white/15"
                      >
                        I have my own shoes
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════
              STEP: Attractions (laser tag / gel blaster add-ons)
          ═══════════════════════════════════════════════════════ */}
          {step === "attractions" && (
            <BowlingAttractionsStep
              locationKey={center.locationKey}
              bmiClientKey={bmiClientKey}
              date={selectedDate}
              playerCount={activePlayerCount}
              addons={attractionAddons}
              onAddonsChange={setAttractionAddons}
              onContinue={() => setStep(isPizzaBowl ? "food" : "review")}
              onBack={() => {
                if (selectedIncludesShoes) {
                  // Shoes were skipped — go back to offer (with hold-release guard)
                  if (holdActive) {
                    setPendingRelease("offer");
                  } else {
                    setStep("offer");
                  }
                } else {
                  setStep("shoes");
                }
              }}
              bowlingStartIso={selectedSlot?.bookedAt}
              bowlingDurationMinutes={bowlingDurationMinutes}
            />
          )}

          {/* ═══════════════════════════════════════════════════════
              STEP: Food / Pizza Bowl Modifiers
              For pizza-bowl experiences: show modifier selectors so
              the customer can choose pizza topping + soda flavor.
              These selections attach as applied_modifiers on the
              Square day-of order line item.
              For all other experiences: stub / coming soon.
          ═══════════════════════════════════════════════════════ */}
          {step === "food" && (
            <div className="space-y-5">
              {isPizzaBowl ? (
                <>
                  {pizzaModifiersLoading ? (
                    <div
                      className="rounded-xl p-8 text-center"
                      style={{ border: "1.78px dashed rgba(255,255,255,0.08)" }}
                    >
                      <div className="inline-block w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin mb-3" />
                      <p className="font-body text-white/55 text-sm">Loading options…</p>
                    </div>
                  ) : pizzaModifierGroups.length > 0 ? (
                    // Render one set of modifier groups per lane
                    <div className="space-y-6">
                      {Array.from({ length: laneCount }, (_, laneIdx) => (
                        <div key={laneIdx} className="space-y-4">
                          {laneCount > 1 && (
                            <p className="font-heading uppercase text-white/60 text-xs tracking-widest border-b border-white/10 pb-2">
                              Lane {laneIdx + 1}
                            </p>
                          )}
                          {pizzaModifierGroups.map((group) => {
                            const currentIds = pizzaModifierSelections[laneIdx]?.[group.id] ?? [];
                            const isToppingGroup = !/soda|drink|pitcher/i.test(group.name);
                            const laneSel = pizzaModifierSelections[laneIdx] ?? {};
                            const laneToppingCount = isToppingGroup
                              ? countToppings(laneSel, pizzaModifierGroups)
                              : 0;
                            return (
                              <div key={group.id}>
                                <p className="font-body text-white/70 text-sm mb-2">
                                  {group.name}
                                  {isToppingGroup && (
                                    <span className="text-white/40 text-xs ml-2">
                                      ({PIZZA_BOWL_FREE_TOPPINGS} included · $
                                      {(EXTRA_TOPPING_CENTS / 100).toFixed(0)} each extra)
                                    </span>
                                  )}
                                </p>
                                <div className="flex flex-wrap gap-2">
                                  {group.options.map((option) => {
                                    const selected = currentIds.includes(option.id);
                                    // For topping groups: would selecting this option be an extra (paid) topping?
                                    const wouldBeExtra =
                                      isToppingGroup &&
                                      !selected &&
                                      laneToppingCount >= PIZZA_BOWL_FREE_TOPPINGS;
                                    return (
                                      <button
                                        key={option.id}
                                        type="button"
                                        onClick={() =>
                                          setPizzaModifierSelections((prev) => {
                                            const next = [...prev];
                                            const ls = { ...(next[laneIdx] ?? {}) };
                                            const cur = ls[group.id] ?? [];
                                            if (group.selectionType === "SINGLE") {
                                              ls[group.id] = selected ? [] : [option.id];
                                            } else {
                                              ls[group.id] = selected
                                                ? cur.filter((id) => id !== option.id)
                                                : [...cur, option.id];
                                            }
                                            next[laneIdx] = ls;
                                            return next;
                                          })
                                        }
                                        className="rounded-full px-4 py-2 font-body text-sm font-bold transition-all"
                                        style={
                                          selected
                                            ? {
                                                backgroundColor: CORAL,
                                                color: "#fff",
                                                boxShadow: `0 0 14px ${CORAL}55`,
                                              }
                                            : {
                                                backgroundColor: "rgba(255,255,255,0.07)",
                                                color: "rgba(255,255,255,0.7)",
                                                border: "1.78px solid rgba(255,255,255,0.12)",
                                              }
                                        }
                                      >
                                        {option.name}
                                        {isToppingGroup && wouldBeExtra && !selected && (
                                          <span className="ml-1 text-xs opacity-60">+$1</span>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  ) : (
                    // Modifier groups empty — plain note input per lane
                    <div className="space-y-4">
                      {Array.from({ length: laneCount }, (_, laneIdx) => (
                        <div key={laneIdx} className="space-y-2">
                          {laneCount > 1 && (
                            <p className="font-heading uppercase text-white/60 text-xs tracking-widest">
                              Lane {laneIdx + 1}
                            </p>
                          )}
                          <p className="font-body text-white/70 text-sm">
                            Any pizza or drink preferences?
                          </p>
                          <textarea
                            rows={2}
                            placeholder="e.g. pepperoni pizza, Diet Coke"
                            className="w-full rounded-xl px-4 py-3 font-body text-sm text-white bg-white/5 border border-white/15 placeholder:text-white/25 resize-none focus:outline-none focus:border-white/40"
                            value={(pizzaModifierSelections[laneIdx]?.["__note__"] ?? [])[0] ?? ""}
                            onChange={(e) =>
                              setPizzaModifierSelections((prev) => {
                                const next = [...prev];
                                next[laneIdx] = {
                                  ...(next[laneIdx] ?? {}),
                                  __note__: [e.target.value],
                                };
                                return next;
                              })
                            }
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div
                  className="rounded-xl p-6 text-center"
                  style={{ border: "1.78px dashed rgba(255,255,255,0.08)" }}
                >
                  <p className="font-body text-white/35 text-sm">Food packages coming soon.</p>
                </div>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setStep("attractions")}
                  className="flex-1 rounded-full px-4 py-3 font-body font-bold text-xs sm:text-sm uppercase tracking-wider text-white/80 border border-white/15"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => setStep("review")}
                  className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white"
                  style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                >
                  {isPizzaBowl && pizzaModifierGroups.length > 0
                    ? "Continue"
                    : isPizzaBowl
                      ? "Skip"
                      : "Continue"}
                </button>
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════
              STEP: Review
          ═══════════════════════════════════════════════════════ */}
          {step === "review" && selectedSlot && (
            <div className="space-y-4">
              <h2 className="font-heading uppercase text-white text-lg tracking-wider text-center">
                Order Summary
              </h2>
              <div
                className="rounded-xl p-4 space-y-3"
                style={{
                  backgroundColor: "rgba(255,255,255,0.04)",
                  border: `1.78px dashed ${GOLD}35`,
                }}
              >
                <div className="flex justify-between text-sm">
                  <span className="font-body text-white/55">Center</span>
                  <span className="font-body text-white font-bold">{center.name}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="font-body text-white/55">Date</span>
                  <span className="font-body text-white font-bold">{formatDate(selectedDate)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="font-body text-white/55">Time</span>
                  <span className="font-body text-white font-bold">
                    {formatTime(selectedSlot.bookedAt)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="font-body text-white/55">Package</span>
                  <span className="font-body text-white font-bold">
                    {selectedSlot.webOfferTitle}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="font-body text-white/55">Bowlers</span>
                  <span className="font-body text-white font-bold">{activePlayerCount}</span>
                </div>
                {/* Pizza bowl selections summary */}
                {isPizzaBowl && pizzaNoteText && (
                  <div className="flex justify-between text-sm">
                    <span className="font-body text-white/55">Selections</span>
                    <span className="font-body text-white font-bold text-right max-w-[60%]">
                      {pizzaNoteText}
                    </span>
                  </div>
                )}
                <div className="h-px bg-white/10" />

                {/* Base experience line items */}
                {baseItems.length === 0 ? (
                  <div className="flex justify-between text-sm">
                    <span className="font-body text-white/55">
                      Bowling{kbfIsVip ? " · VIP" : ""}
                    </span>
                    <span className="font-body text-white font-bold">
                      {kind === "kbf" ? (kbfIsVip ? "2 free games" : "Free (KBF)") : "—"}
                    </span>
                  </div>
                ) : (
                  baseItems.map((item, idx) => {
                    const { priceCents: itemPrice } = effectiveItemPrice(item);
                    const qty =
                      item.sortOrder === 0
                        ? item.quantity * qtyMultiplier * durationMultiplier
                        : item.quantity * laneCount;
                    return (
                      <div key={idx} className="flex justify-between text-sm">
                        <span className="font-body text-white/55">
                          {item.label}
                          {item.sortOrder > 0 && laneCount > 1 && (
                            <span className="text-white/35"> × {laneCount} lanes</span>
                          )}
                          {item.sortOrder === 0 && selectedIsPerLane && laneCount > 1 && (
                            <span className="text-white/35"> × {laneCount} lanes</span>
                          )}
                          {item.sortOrder === 0 && !selectedIsPerLane && activePlayerCount > 1 && (
                            <span className="text-white/35"> × {activePlayerCount} people</span>
                          )}
                          {item.sortOrder === 0 && durationMultiplier > 1 && (
                            <span className="text-white/35"> × {durationMultiplier}</span>
                          )}
                        </span>
                        {quoteLoading ? (
                          <span className="font-body text-white/35 text-xs italic">
                            calculating…
                          </span>
                        ) : (
                          <span className="font-body font-bold" style={{ color: CORAL }}>
                            {centsToDollars(itemPrice * qty)}
                          </span>
                        )}
                      </div>
                    );
                  })
                )}

                {/* Shoes line */}
                {shoePreTaxTotal > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="font-body text-white/55">Shoe rental</span>
                    {quoteLoading ? (
                      <span className="font-body text-white/35 text-xs italic">calculating…</span>
                    ) : (
                      <span className="font-body font-bold" style={{ color: CORAL }}>
                        {centsToDollars(shoePreTaxTotal)}
                      </span>
                    )}
                  </div>
                )}

                {/* Attraction add-ons (included in Square order) */}
                {attractionAddons.map((addon) => (
                  <div key={addon.slug} className="flex justify-between text-sm">
                    <span className="font-body text-white/55">
                      {addon.name}
                      <span className="text-white/35">
                        {" "}
                        × {addon.quantity} · {addon.timeLabel}
                      </span>
                    </span>
                    {quoteLoading ? (
                      <span className="font-body text-white/35 text-xs italic">calculating…</span>
                    ) : (
                      <span className="font-body font-bold" style={{ color: addon.color }}>
                        {centsToDollars(Math.round(addon.totalPrice * 100))}
                      </span>
                    )}
                  </div>
                ))}

                {/* KBF adult game charges (non-FBF adults pay per game) */}
                {kbfAdultGameCents > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="font-body text-white/55">
                      Adult games{kbfIsVip ? " (VIP)" : ""}
                      <span className="text-white/35">
                        {" "}
                        × {kbfPaidAdultCount} · ${(kbfAdultPerGameCents / 100).toFixed(0)}/game
                      </span>
                    </span>
                    <span className="font-body font-bold" style={{ color: "#f59e0b" }}>
                      {centsToDollars(kbfAdultGameCents)}
                    </span>
                  </div>
                )}

                {/* KBF VIP lane upcharge ($1/person/game × 2 games, free bowlers only) */}
                {kbfVipUpchargeCents > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="font-body text-white/55">
                      VIP lane upcharge
                      <span className="text-white/35"> × {kbfFreeBowlerCount} · $1/game</span>
                    </span>
                    <span className="font-body font-bold" style={{ color: GOLD }}>
                      {centsToDollars(kbfVipUpchargeCents)}
                    </span>
                  </div>
                )}

                {/* Booking fee line */}
                {hasBookingFee && (
                  <div className="flex justify-between text-sm">
                    <span className="font-body text-white/55">Booking fee</span>
                    {quoteLoading ? (
                      <span className="font-body text-white/35 text-xs italic">calculating…</span>
                    ) : (
                      <span className="font-body font-bold" style={{ color: CORAL }}>
                        {centsToDollars(BOOKING_FEE_CENTS)}
                      </span>
                    )}
                  </div>
                )}

                {/* Extra toppings line */}
                {extraToppingsCents > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="font-body text-white/55">
                      Extra toppings
                      <span className="text-white/35">
                        {" "}
                        × {extraToppingsCents / EXTRA_TOPPING_CENTS}
                      </span>
                    </span>
                    <span className="font-body font-bold" style={{ color: CORAL }}>
                      {centsToDollars(extraToppingsCents)}
                    </span>
                  </div>
                )}

                {/* Discount line — shown when the Square quote returned an
                    order-level discount. Sourced from the server response,
                    not a UI estimate, so the displayed savings match what
                    Square actually computed. */}
                {quoteDiscountOffCents > 0 && !quoteLoading && (
                  <div
                    className="flex justify-between text-sm rounded-lg px-2 py-1.5"
                    style={{ backgroundColor: "rgba(34,197,94,0.10)" }}
                  >
                    <span className="font-body" style={{ color: "#22c55e" }}>
                      Discount{quoteDiscountCode ? ` (${quoteDiscountCode})` : ""}
                      {appliedDiscount?.amountPct != null && (
                        <span className="text-white/45"> · {appliedDiscount.amountPct}% off</span>
                      )}
                    </span>
                    <span className="font-body font-bold" style={{ color: "#22c55e" }}>
                      −{centsToDollars(quoteDiscountOffCents)}
                    </span>
                  </div>
                )}

                {/* Tax line */}
                {quoteTotalCents > preTaxTotalCents - quoteDiscountOffCents && !quoteLoading && (
                  <div className="flex justify-between text-xs">
                    <span className="font-body text-white/35">Incl. sales tax</span>
                    <span className="font-body text-white/35">
                      +
                      {centsToDollars(quoteTotalCents - (preTaxTotalCents - quoteDiscountOffCents))}
                    </span>
                  </div>
                )}

                {quoteError && (
                  <div className="text-xs font-body" style={{ color: CORAL }}>
                    {quoteError} — amount shown is pre-tax estimate.
                  </div>
                )}

                {preTaxTotalCents > 0 && (
                  <>
                    <div className="h-px bg-white/10" />
                    <div className="flex justify-between">
                      <span className="font-body text-white/55 text-sm">Due today (deposit)</span>
                      {quoteLoading ? (
                        <span className="font-body text-white/35 text-sm italic">calculating…</span>
                      ) : (
                        <span className="font-body text-white font-bold text-base">
                          {centsToDollars(depositCents)}
                        </span>
                      )}
                    </div>
                    {displayTotal > depositCents && !quoteLoading && (
                      <div className="flex justify-between text-xs">
                        <span className="font-body text-white/35">Remaining due at center</span>
                        <span className="font-body text-white/35">
                          {centsToDollars(displayTotal - depositCents)}
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setStep(isPizzaBowl ? "food" : "attractions");
                  }}
                  className="flex-1 rounded-full px-4 py-3 font-body font-bold text-xs sm:text-sm uppercase tracking-wider text-white/80 border border-white/15"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => setStep("details")}
                  disabled={quoteLoading}
                  className="flex-1 rounded-full px-4 sm:px-6 py-3 font-body font-bold text-xs sm:text-sm uppercase tracking-wider text-white disabled:opacity-50 whitespace-nowrap"
                  style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                >
                  {quoteLoading ? "Calculating…" : "Continue"}
                </button>
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════
              STEP: Details (phone-first with HeadPinz Rewards)
          ═══════════════════════════════════════════════════════ */}
          {step === "details" && (
            <div className="space-y-4">
              <h2 className="font-heading uppercase text-white text-lg tracking-wider text-center">
                Your Details
              </h2>

              {/* ── Phone (first field) ─────────────────────────── */}
              <div className="relative">
                <input
                  type="tel"
                  placeholder="Phone Number"
                  autoComplete="tel"
                  value={formatPhoneDisplay(guestPhone)}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/\D/g, "").slice(0, 10);
                    setGuestPhone(raw);
                    // Reset loyalty state when phone changes
                    if (phoneLookedUp) {
                      setPhoneLookedUp(false);
                      setLoyaltyAccount(null);
                      setLoyaltyCustomer(null);
                      setPhoneVerified(false);
                      setVerifyStep("idle");
                      setVerifyCode(["", "", "", "", "", ""]);
                      setRewardsSignup(false);
                      setRewardTiers([]);
                      setSelectedRewardTier(null);
                    }
                    // Auto-lookup when 10 digits
                    if (raw.length === 10 && !phoneLookedUp) {
                      void handlePhoneLookup(raw);
                    }
                  }}
                  className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3.5 text-white font-body text-sm placeholder:text-white/25 focus:outline-none focus:border-[#fd5b56]/50"
                />
                {phoneLookupLoading && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <div className="w-5 h-5 border-2 border-white/15 border-t-[#22c55e] rounded-full animate-spin" />
                  </div>
                )}
              </div>

              {/* ── Rewards Member Found ────────────────────────── */}
              {phoneLookedUp && loyaltyAccount && !phoneVerified && verifyStep === "idle" && (
                <div className="rounded-xl border border-[#22c55e]/30 bg-[#22c55e]/5 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">🎳</span>
                    <span className="font-body font-bold text-[#22c55e] text-sm">
                      HeadPinz Rewards Member
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="font-body text-white/55 text-xs">
                      {loyaltyAccount.balance.toLocaleString()} Pinz available
                    </span>
                    <button
                      type="button"
                      onClick={handleSendVerifyCode}
                      className="rounded-full px-4 py-1.5 font-body font-bold text-xs uppercase tracking-wider bg-[#22c55e] text-white"
                    >
                      Verify
                    </button>
                  </div>
                  <p className="font-body text-white/35 text-xs">
                    We&apos;ll text you a code to confirm your identity and prefill your info.
                  </p>
                </div>
              )}

              {/* ── SMS Verification Code ──────────────────────── */}
              {(verifyStep === "code" || verifyStep === "sending") && !phoneVerified && (
                <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
                  <p className="font-body text-white/70 text-sm text-center">
                    Enter the 6-digit code sent to {formatPhoneDisplay(guestPhone)}
                  </p>
                  <div className="flex justify-center gap-2">
                    {verifyCode.map((digit, i) => (
                      <input
                        key={i}
                        ref={(el) => {
                          verifyCodeRefs.current[i] = el;
                        }}
                        type="text"
                        inputMode="numeric"
                        maxLength={1}
                        value={digit}
                        onChange={(e) => handleVerifyCodeInput(i, e.target.value)}
                        onKeyDown={(e) => handleVerifyCodeKeyDown(i, e)}
                        onPaste={i === 0 ? handleVerifyCodePaste : undefined}
                        className="w-10 h-12 text-center bg-white/5 border border-white/15 rounded-lg text-white font-body text-lg focus:outline-none focus:border-[#22c55e]/50"
                      />
                    ))}
                  </div>
                  {verifyError && (
                    <p className="font-body text-xs text-center" style={{ color: CORAL }}>
                      {verifyError}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={handleSendVerifyCode}
                    className="block mx-auto font-body text-xs text-white/35 hover:text-white/55 transition-colors"
                  >
                    Resend code
                  </button>
                </div>
              )}

              {/* ── Verified Badge ─────────────────────────────── */}
              {phoneVerified && loyaltyAccount && (
                <div className="rounded-xl border border-[#22c55e]/30 bg-[#22c55e]/5 p-3 flex items-center gap-3">
                  <span className="text-[#22c55e] text-lg">✓</span>
                  <div className="flex-1">
                    <span className="font-body font-bold text-[#22c55e] text-sm">
                      HeadPinz Rewards Verified
                    </span>
                    <span className="font-body text-white/45 text-xs block">
                      {loyaltyAccount.balance.toLocaleString()} Pinz · Member since{" "}
                      {new Date(loyaltyAccount.enrolledAt ?? "").getFullYear() || ""}
                    </span>
                  </div>
                </div>
              )}

              {/* ── Use Your Pinz (reward redemption) ───────────── */}
              {phoneVerified && loyaltyAccount && rewardTiers.length > 0 && depositCents > 0 && (
                <div className="rounded-xl border border-[#FFD700]/20 bg-[#FFD700]/5 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">⭐</span>
                    <span className="font-body font-bold text-[#FFD700] text-sm">
                      Use Your Pinz
                    </span>
                  </div>
                  <p className="font-body text-white/50 text-xs">
                    Apply a reward to reduce your deposit. Points are deducted when you book.
                  </p>
                  <div className="space-y-2">
                    {rewardTiers.map((tier) => {
                      const canAfford = loyaltyAccount.balance >= tier.points;
                      const isSelected = selectedRewardTier?.id === tier.id;
                      const exceedsDeposit = tier.discountCents > depositCents;
                      return (
                        <button
                          key={tier.id}
                          type="button"
                          disabled={!canAfford}
                          onClick={() => setSelectedRewardTier(isSelected ? null : tier)}
                          className={`w-full flex items-center justify-between rounded-lg px-3 py-2.5 border transition-all text-left ${
                            isSelected
                              ? "border-[#FFD700]/50 bg-[#FFD700]/10"
                              : canAfford
                                ? "border-white/10 bg-white/[0.03] hover:border-[#FFD700]/30"
                                : "border-white/5 bg-white/[0.01] opacity-40 cursor-not-allowed"
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div
                              className={`w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                                isSelected ? "border-[#FFD700] bg-[#FFD700]" : "border-white/25"
                              }`}
                            >
                              {isSelected && (
                                <div className="w-1.5 h-1.5 rounded-full bg-[#0a1628]" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <span className="font-body font-semibold text-white text-sm block truncate">
                                ${(tier.discountCents / 100).toFixed(0)} off
                                {exceedsDeposit ? " (covers full deposit)" : ""}
                              </span>
                              <span className="font-body text-white/40 text-xs">
                                {tier.points.toLocaleString()} Pinz
                              </span>
                            </div>
                          </div>
                          {isSelected && (
                            <span className="text-[#FFD700] text-xs font-body font-bold uppercase tracking-wider flex-shrink-0">
                              Applied
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {selectedRewardTier && (
                    <div className="flex items-center justify-between pt-1 border-t border-[#FFD700]/10">
                      <span className="font-body text-white/50 text-xs">New deposit</span>
                      <span className="font-body font-bold text-[#FFD700] text-sm">
                        ${(effectiveDepositCents / 100).toFixed(2)}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* ── Not a Member — Rewards Pitch ───────────────── */}
              {phoneLookedUp && !loyaltyAccount && phoneDigits(guestPhone).length === 10 && (
                <div className="rounded-xl border border-[#FFD700]/20 bg-[#FFD700]/5 p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <span className="text-xl mt-0.5">⭐</span>
                    <div className="flex-1 space-y-1">
                      <span className="font-body font-bold text-[#FFD700] text-sm block">
                        Join HeadPinz Rewards!
                      </span>
                      <p className="font-body text-white/55 text-xs leading-relaxed">
                        Earn 10% back in Pinz on every visit. Pinz = free money for bowling, food,
                        and a whole lot of fun at both HeadPinz and FastTrax Entertainment.
                      </p>
                    </div>
                  </div>
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={rewardsSignup}
                      onChange={(e) => setRewardsSignup(e.target.checked)}
                      className="w-4 h-4 rounded border-[#FFD700]/30 bg-white/5 focus:ring-[#FFD700]/50 focus:ring-offset-0 cursor-pointer accent-[#FFD700]"
                    />
                    <span className="text-sm text-white/70 group-hover:text-white transition-colors font-body">
                      Sign me up for free
                    </span>
                  </label>
                </div>
              )}

              {/* ── Name & Email ────────────────────────────────── */}
              <input
                type="text"
                placeholder="Full Name"
                autoComplete="name"
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3.5 text-white font-body text-sm placeholder:text-white/25 focus:outline-none focus:border-[#fd5b56]/50"
              />
              <input
                type="email"
                placeholder="Email"
                autoComplete="email"
                value={guestEmail}
                onChange={(e) => setGuestEmail(e.target.value)}
                className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3.5 text-white font-body text-sm placeholder:text-white/25 focus:outline-none focus:border-[#fd5b56]/50"
              />

              {/* ── SMS opt-in + Clickwrap ──────────────────────── */}
              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={smsOptIn}
                  onChange={(e) => setSmsOptIn(e.target.checked)}
                  className="w-4 h-4 rounded border-white/20 bg-white/5 focus:ring-[#fd5b56]/50 focus:ring-offset-0 cursor-pointer accent-[#fd5b56]"
                />
                <span className="text-sm text-white/50 group-hover:text-white/70 transition-colors">
                  Send me a text confirmation
                </span>
              </label>
              <ClickwrapCheckbox
                checked={clickwrapAccepted}
                onChange={setClickwrapAccepted}
                cancellationHours={1}
              />

              {/* ── Actions ─────────────────────────────────────── */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setStep("review")}
                  className="flex-1 rounded-full px-4 py-3 font-body font-bold text-xs sm:text-sm uppercase tracking-wider text-white/80 border border-white/15"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (!guestName || !guestEmail || !guestPhone) {
                      setError("Please fill in all contact details");
                      return;
                    }
                    if (!clickwrapAccepted) {
                      setError("Please accept the cancellation policy");
                      return;
                    }
                    setError(null);

                    // Enroll in rewards if opted in
                    if (rewardsSignup && !loyaltyAccount && !enrolling) {
                      await handleRewardsEnroll();
                    }

                    // Attach the customer to the hold + rename it so staff see
                    // the guest name. Pre-attaching the customer here ensures
                    // PATCH /status at submit time takes effect immediately,
                    // eliminating the timing race that caused Temporary holds
                    // not to confirm.
                    if (holdRef.current) {
                      void fetch(`/api/bowling/v2/reserve/hold/${holdRef.current.qamfId}`, {
                        method: "PATCH",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                          centerId: holdRef.current.centerId,
                          title: `${guestName} (${activePlayerCount}p)`,
                          guest: { name: guestName, email: guestEmail, phone: guestPhone },
                        }),
                      }).catch(() => {});
                    }
                    if (effectiveDepositCents > 0) setStep("payment");
                    else void handleSubmit();
                  }}
                  disabled={
                    busy ||
                    enrolling ||
                    !clickwrapAccepted ||
                    !guestName ||
                    !guestEmail ||
                    !guestPhone
                  }
                  className="flex-1 rounded-full px-4 sm:px-6 py-3 font-body font-bold text-xs sm:text-sm uppercase tracking-wider disabled:opacity-50 whitespace-nowrap"
                  style={{ backgroundColor: GOLD, color: BG }}
                >
                  {enrolling
                    ? "Enrolling…"
                    : effectiveDepositCents > 0
                      ? "Continue to payment"
                      : "Confirm"}
                </button>
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════
              STEP: Payment
          ═══════════════════════════════════════════════════════ */}
          {step === "payment" && (
            <BowlingPaymentStep
              depositCents={effectiveDepositCents}
              totalCents={effectiveDisplayTotal}
              locationId={center.locationKey}
              paymentError={paymentError}
              busy={busy}
              originalDepositCents={rewardDiscountCents > 0 ? depositCents : undefined}
              rewardDiscountCents={rewardDiscountCents}
              onBack={() => setStep("details")}
              onPay={(tender) => void handleSubmit(tender)}
            />
          )}

          {/* ═══════════════════════════════════════════════════════
              STEP: Submitting
          ═══════════════════════════════════════════════════════ */}
          {step === "submitting" && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-10 text-center">
              <div className="w-10 h-10 border-2 border-white/15 border-t-[#fd5b56] rounded-full animate-spin mx-auto mb-4" />
              <p className="font-body text-white/60 text-sm">Reserving your lane…</p>
            </div>
          )}
        </div>
      </main>

      {/* ── Release-hold confirmation modal ─────────────────────────── */}
      {pendingRelease && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
          style={{ backgroundColor: "rgba(0,0,0,0.75)" }}
        >
          <div
            className="w-full max-w-sm rounded-2xl p-6 space-y-4"
            style={{ backgroundColor: "#0d1f3c", border: `1.5px solid ${CORAL}55` }}
          >
            <h3 className="font-heading uppercase text-white text-lg tracking-wider">
              Release your lane?
            </h3>
            <p className="font-body text-white/55 text-sm leading-relaxed">
              Going back will release the lane we&apos;re holding for you. Someone else may take it
              before you return.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setPendingRelease(null)}
                className="flex-1 py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider border border-white/20 text-white/70 hover:text-white hover:border-white/40 transition-colors"
              >
                Keep my lane
              </button>
              <button
                type="button"
                onClick={() => {
                  releaseHold();
                  setStep(pendingRelease);
                  setPendingRelease(null);
                }}
                className="flex-1 py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white"
                style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
              >
                Release &amp; go back
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
