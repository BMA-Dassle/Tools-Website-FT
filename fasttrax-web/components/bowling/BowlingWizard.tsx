"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import HeadPinzNav from "@/components/headpinz/Nav";
import BowlingPaymentStep from "@/components/bowling/BowlingPaymentStep";
import ClickwrapCheckbox from "@/components/booking/ClickwrapCheckbox";
import { CURRENT_POLICY_VERSION } from "@/lib/clickwrap";
import { bookableDateRange, isKbfBookableDate } from "@/lib/kbf-schedule";
import {
  getBookingLocation,
  setBookingLocation,
  syncLocationFromUrl,
} from "@/lib/booking-location";
import type { BowlingSquareProduct, BowlingExperienceWithDetails } from "@/lib/bowling-db";

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
const GOLD  = "#FFD700";
const BG    = "#0a1628";
const BLOB  = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";

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
}

const EXPERIENCE_DISPLAY: Record<string, ExperienceDisplay> = {
  "kbf-regular": {
    videoUrl: `${BLOB}/videos/headpinz-bowling.mp4`,
    accent: CORAL,
    description:
      "Two free games per kid per day on participating weekdays. Bring your KBF coupon to the front desk.",
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
      "Upgrade your free bowling to the VIP suite — same coupon, premium lanes with NeoVerse + HyperBowling.",
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
    description: "1.5 hours of bowling Monday through Thursday — shoes included!",
    features: [
      "Bowling shoes included",
      "Up to 6 bowlers per lane",
      "Standard HeadPinz lanes",
      "Glow bowling in the evenings",
    ],
    includesShoes: true,
  },
  "fun-4-all-vip": {
    videoUrl: `${BLOB}/videos/headpinz-neoverse-v2.mp4`,
    accent: GOLD,
    description:
      "The premium Mon-Thur experience — VIP suite with NeoVerse, HyperBowling, shoes & chips included.",
    features: [
      "Bowling shoes included",
      "VIP lounge & dedicated lanes",
      "NeoVerse video walls",
      "Complimentary chips & salsa",
    ],
    includesShoes: true,
  },
  "regular-mon-thur": {
    videoUrl: `${BLOB}/videos/headpinz-bowling.mp4`,
    accent: CORAL,
    description: "Reserve a lane by the hour — Monday through Thursday.",
    features: ["Standard HeadPinz lanes", "Up to 6 bowlers per lane", "Flexible hourly rate"],
  },
  "vip-mon-thur": {
    videoUrl: `${BLOB}/videos/headpinz-neoverse-v2.mp4`,
    accent: GOLD,
    description:
      "Premium hourly lane in the VIP suite — includes chips & salsa and NeoVerse technology.",
    features: [
      "VIP lounge & dedicated lanes",
      "NeoVerse video walls",
      "Chips & salsa included",
      "Up to 6 bowlers per lane",
    ],
  },
  "regular-fri-sun": {
    videoUrl: `${BLOB}/videos/headpinz-bowling.mp4`,
    accent: CORAL,
    description: "Reserve a lane by the hour — Friday through Sunday.",
    features: ["Standard HeadPinz lanes", "Up to 6 bowlers per lane", "Flexible hourly rate"],
  },
  "vip-fri-sun": {
    videoUrl: `${BLOB}/videos/headpinz-neoverse-v2.mp4`,
    accent: GOLD,
    description:
      "Premium VIP lane rental — Friday through Sunday. Includes chips & salsa and NeoVerse technology.",
    features: [
      "VIP lounge & dedicated lanes",
      "NeoVerse video walls",
      "Chips & salsa included",
      "Up to 6 bowlers per lane",
    ],
  },
  "pizza-bowl": {
    videoUrl: `${BLOB}/videos/headpinz-bowling.mp4`,
    accent: CORAL,
    description: "Sunday special — bowling + pizza + shoes all included!",
    features: [
      "Bowling shoes included",
      "Pizza included",
      "Up to 6 bowlers per lane",
    ],
    includesShoes: true,
  },
  "pizza-bowl-vip": {
    videoUrl: `${BLOB}/videos/headpinz-neoverse-v2.mp4`,
    accent: GOLD,
    description:
      "Sunday VIP special — premium lanes, pizza, shoes & NeoVerse technology included.",
    features: [
      "Bowling shoes included",
      "Pizza included",
      "VIP lounge & dedicated lanes",
      "NeoVerse video walls",
    ],
    includesShoes: true,
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
    name: "HeadPinz Fort Myers",
    address: "14513 Global Pkwy, Fort Myers",
    phone: "(239) 302-2155",
  },
  {
    id: "3148",
    qamfId: 3148,
    squareCenterCode: "PPTR5G2N0QXF7",
    locationKey: "naples" as const,
    name: "HeadPinz Naples",
    address: "8525 Radio Ln, Naples",
    phone: "(239) 455-3755",
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
  | "lookup"       // KBF only
  | "verify"       // KBF only
  | "existing"     // KBF only — future reservation detected
  | "reschedule"   // KBF only — pick a new date/time
  | "bowlers"      // KBF only — select members
  | "players"      // Open only — player count
  | "slots"        // Both — calendar + hour chips
  | "tier"         // Both — Regular vs VIP picker
  | "offer"        // Both — video cards + exact time chips
  | "shoes"        // Both
  | "attractions"  // Both (stub)
  | "food"         // Both (stub)
  | "review"       // Both
  | "details"      // Both
  | "payment"      // Both
  | "submitting";  // Both

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

function ymdFromDate(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

function todayYmd(): string {
  return ymdFromDate(new Date());
}

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function slotHourET(iso: string): number {
  try {
    const h = parseInt(
      new Date(iso).toLocaleString("en-US", {
        hour: "2-digit",
        hourCycle: "h23",
        timeZone: "America/New_York",
      }),
      10,
    );
    return isNaN(h) ? -1 : h;
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
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 || 12;
  return `${hr} ${ampm}`;
}

function formatHourMinute(h: number, m: number): string {
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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
    kind === "kbf"
      ? "/hp/book/kids-bowl-free-v2/confirmation"
      : "/hp/book/open-bowling/confirmation";

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

  // ── Wizard core ──────────────────────────────────────────────────

  const [step, setStep] = useState<Step>("location");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ── QAMF hold state ──────────────────────────────────────────────
  // A Temporary hold is created when the user confirms their slot on
  // the offer step. The hold is extended every 8 min and released when
  // the user navigates back to offer or the wizard unmounts.
  // holdRef / holdTimerRef use refs to avoid stale closures in the timer.

  const holdRef = useRef<{ qamfId: string; centerId: number } | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [holdBusy, setHoldBusy] = useState(false);
  const [holdActive, setHoldActive] = useState(false);
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

  const initialDate = kind === "kbf" ? (bookableDateRange()[0] ?? todayYmd()) : todayYmd();
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [availableSlots, setAvailableSlots] = useState<AvailabilitySlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlot | null>(null);
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [selectedMinute, setSelectedMinute] = useState<number | null>(null);

  // Calendar nav
  const initCal = new Date(`${initialDate}T12:00:00`);
  const [calMonth, setCalMonth] = useState(initCal.getMonth());
  const [calYear, setCalYear] = useState(initCal.getFullYear());

  // ── Tier picker (Regular vs VIP) ────────────────────────────────

  const [selectedTier, setSelectedTier] = useState<"regular" | "vip" | null>(null);

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

  // ── Guest details ────────────────────────────────────────────────

  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [clickwrapAccepted, setClickwrapAccepted] = useState(false);

  // ── Payment ──────────────────────────────────────────────────────

  const [paymentError, setPaymentError] = useState<string | null>(null);

  // ── Computed values ──────────────────────────────────────────────

  const center = CENTER_BY_ID[centerId] ?? CENTERS[0];

  const kbfBowlers = bowlerSelections.filter((b) => b.selected);
  const activePlayerCount = kind === "kbf" ? kbfBowlers.length : playerCount;

  // Experience matching the selected QAMF slot
  const selectedExperience = selectedSlot
    ? (experiences.find((e) => e.qamfWebOfferId === selectedSlot.webOfferId) ?? null)
    : null;

  // Whether the selected experience already includes shoes (skip shoes step)
  const selectedIncludesShoes =
    selectedExperience
      ? (getExperienceDisplay(selectedExperience.slug, selectedExperience.isVip).includesShoes ?? false)
      : false;

  // VIP counterpart experience for the upgrade modal
  const vipUpgradeExperience =
    selectedTier === "regular" && selectedExperience && !selectedExperience.isVip
      ? (experiences.find((e) => e.isVip && e.kind === selectedExperience.kind) ?? null)
      : null;
  const vipUpgradeSlot = vipUpgradeExperience && selectedSlot
    ? (availableSlots.find(
        (s) =>
          s.webOfferId === vipUpgradeExperience.qamfWebOfferId &&
          slotHourET(s.bookedAt) === slotHourET(selectedSlot.bookedAt) &&
          slotMinuteET(s.bookedAt) === slotMinuteET(selectedSlot.bookedAt),
      ) ?? null)
    : null;

  // Bundled items auto-included in the selected experience (the combo)
  const baseItems = selectedExperience?.items ?? [];

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
  const basePreTaxTotal = baseItems.reduce(
    (s, item) => s + item.priceCents * item.quantity,
    0,
  );
  const basePreTaxDeposit = baseItems.reduce(
    (s, item) => s + Math.round(item.priceCents * item.quantity * (item.depositPct / 100)),
    0,
  );

  const preTaxTotalCents   = basePreTaxTotal + shoePreTaxTotal;
  const preTaxDepositCents = basePreTaxDeposit + shoePreTaxDeposit;

  // Use Square's tax-inclusive quote once loaded
  const depositCents = quoteDepositCents > 0 ? quoteDepositCents : preTaxDepositCents;
  const displayTotal = quoteTotalCents   > 0 ? quoteTotalCents   : preTaxTotalCents;

  // Line items sent to /api/bowling/v2/reserve
  const lineItems = [
    ...baseItems.map((item) => ({ squareProductId: item.squareProductId, quantity: item.quantity })),
    ...shoeProducts
      .filter((p) => (shoeQty[p.id] ?? 0) > 0)
      .map((p) => ({ squareProductId: p.id, quantity: shoeQty[p.id] })),
  ];

  // ── Date bookability helpers ─────────────────────────────────────

  function isBookableDate(dateStr: string): boolean {
    if (kind === "kbf") return isKbfBookableDate(dateStr);
    const today = todayYmd();
    const max = addDays(today, 30);
    return dateStr >= today && dateStr <= max;
  }

  function getFilteredHours(dateStr: string): number[] {
    const HOURS = Array.from({ length: 13 }, (_, i) => i + 11); // 11 AM – 11 PM
    let filtered = HOURS;

    // KBF Friday: cut off at 5 PM
    if (kind === "kbf") {
      const dow = dateStr ? new Date(`${dateStr}T12:00:00`).getDay() : 4;
      if (dow === 5) filtered = filtered.filter((h) => h < 17);
    }

    // Today: hide hours that are already past (+ 30-min lookahead buffer)
    if (dateStr === todayYmd()) {
      const parts = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
        timeZone: "America/New_York",
      }).formatToParts(new Date());
      const etH = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
      const etM = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
      const cutoffMins = etH * 60 + etM + 30; // must be bookable at least 30 min from now
      filtered = filtered.filter((h) => h * 60 >= cutoffMins);
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
    async (date: string, forPlayerCount?: number) => {
      const count = forPlayerCount ?? activePlayerCount;
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

      function parseRaw(raw: RawSlot[], offerId: number): AvailabilitySlot[] {
        return raw
          .filter((a) => a.WebOffer.Id === offerId)
          .map((a) => {
            const gameOpts = a.WebOffer.Options?.Game ?? [];
            const twoGame = gameOpts.find((g) => g.GamesPerPlayer === 2) ?? gameOpts[0];
            const timeOpts = a.WebOffer.Options?.Time ?? [];
            const unlimOpts = a.WebOffer.Options?.Unlimited ?? [];
            let optionId: number | undefined;
            let optionType: "Game" | "Time" | "Unlimited" | undefined;
            if (twoGame) { optionId = twoGame.Id; optionType = "Game"; }
            else if (timeOpts[0]) { optionId = timeOpts[0].Id; optionType = "Time"; }
            else if (unlimOpts[0]) { optionId = unlimOpts[0].Id; optionType = "Unlimited"; }
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

      try {
        // Filter to only experiences valid on the requested day of week.
        // e.g. Mon-Thur hourly (daysOfWeek=[1,2,3,4]) won't probe QAMF on a Saturday.
        const dow = new Date(`${date}T12:00:00`).getDay(); // 0=Sun … 6=Sat
        const validExperiences = experiences.filter(
          (e) => !e.daysOfWeek.length || e.daysOfWeek.includes(dow),
        );
        const offerIds = validExperiences.map((e) => e.qamfWebOfferId);
        if (offerIds.length === 0) {
          setSlotsError("No experiences are available on this day.");
          setSlotsLoading(false);
          return;
        }

        // Single call — no webOfferId filter. QAMF returns all enabled offers
        // in every probe response regardless, so one round-trip covers all
        // experiences. Dedup on the server is keyed on (BookedAt + WebOffer.Id)
        // so every offer × time combination arrives correctly.
        const base = `/api/bowling/v2/availability?centerId=${center.qamfId}&players=${Math.max(count, 1)}&startDate=${date}`;
        const data = await fetch(base).then(
          (r) => r.json() as Promise<{ Availabilities?: RawSlot[]; error?: string }>,
        );

        // Parse once, distribute to each experience by offer ID
        const merged = offerIds.flatMap((id) =>
          parseRaw(data.Availabilities ?? [], id),
        );
        setAvailableSlots(merged);

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
    [center.qamfId, activePlayerCount, kind, experiences],
  );

  // On entering the slots step: reset time selection and clear stale slot data.
  // Availability is NOT fetched here — it's deferred to the "See Packages" click
  // so the calendar renders instantly with no loading spinner.
  // Reschedule (KBF only) still fetches immediately since it needs slots inline.
  useEffect(() => {
    if (step !== "slots" && !(step === "reschedule" && kind === "kbf")) return;
    if (experiencesLoading) return;

    setSelectedHour(null);
    setSelectedMinute(null);
    setAvailableSlots([]);
    setSlotsError(null);

    if (step === "reschedule") {
      void fetchSlots(selectedDate, existingReservation?.playerCount ?? 1);
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
        const data = await res.json() as BowlingSquareProduct[];
        if (!res.ok) return;
        setShoeProducts(Array.isArray(data) ? data : []);
        if (kind === "kbf" && Array.isArray(data) && data.length > 0) {
          // KBF default: one pair per selected bowler
          setShoeQty({ [data[0].id]: activePlayerCount });
        }
        // Open bowling: leave at 0 — user opts in
      } catch {
        // Non-fatal
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ── Clear stale quote when user backs up to shoes step ────────────

  useEffect(() => {
    if (step === "shoes") {
      setQuoteDayofOrderId(null);
      setQuoteTotalCents(0);
      setQuoteDepositCents(0);
      setQuoteError(null);
      return;
    }
    if (step !== "review") return;
    if (lineItems.length === 0) return;

    setQuoteLoading(true);
    setQuoteError(null);

    const sqLineItems = [
      ...baseItems.map((item) => ({
        name: item.label,
        quantity: String(item.quantity),
        catalogObjectId: item.squareCatalogObjectId,
      })),
      ...shoeProducts
        .filter((p) => (shoeQty[p.id] ?? 0) > 0)
        .map((p) => ({
          name: p.label,
          quantity: String(shoeQty[p.id]),
          catalogObjectId: p.squareCatalogObjectId,
        })),
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
          }),
        });
        const data = await res.json() as {
          dayofOrderId?: string;
          dayofTotalCents?: number;
          depositCents?: number;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? "Failed to get price");
        setQuoteDayofOrderId(data.dayofOrderId ?? null);
        setQuoteTotalCents(data.dayofTotalCents ?? 0);
        setQuoteDepositCents(data.depositCents ?? 0);
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
    const resolved =
      lookupTab === "phone" ? phoneInput.replace(/\D/g, "") : emailInput.trim();
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

      const selections: BowlerSelection[] = (p.members ?? []).map((m) => ({
        key: `${m.relation}:${m.passId}:${m.slot}`,
        displayName: `${m.firstName} ${m.lastName}`,
        relation: m.relation,
        selected: true,
        wantBumpers: m.prefs?.wantBumpers ?? true,
        kbfPassId: m.passId,
        kbfMemberSlot: m.slot,
        kbfRelation: m.relation,
      }));
      selections.unshift({
        key: "parent",
        displayName: `${p.firstName} ${p.lastName}`,
        relation: "parent",
        selected: false,
        wantBumpers: false,
      });
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
      const res = await fetch(
        `/api/bowling/v2/reservations/${existingReservation.id}/reschedule`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bookedAt: selectedSlot.bookedAt,
            webOfferId: selectedSlot.webOfferId,
            optionId: selectedSlot.optionId,
            optionType: selectedSlot.optionType,
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Reschedule failed");

      const params = new URLSearchParams({
        neonId: String(existingReservation.id),
        qamfId: data.qamfReservationId ?? "",
        centerId: center.id,
        depositPaid: String(existingReservation.depositCents),
        remaining: String(existingReservation.totalCents - existingReservation.depositCents),
      });
      router.push(`${confirmationBase}?${params.toString()}`);
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
    setHoldActive(false);
    void fetch(`/api/bowling/v2/reserve/hold/${qamfId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ centerId: hCenterId }),
    }).catch(() => {});
  }, []);

  // ── Hold: create + advance ───────────────────────────────────────
  // Called when the user confirms their slot on the offer step (including
  // after the VIP upgrade modal). Creates a QAMF Temporary hold for the
  // selected slot, starts the 8-min extend timer, then navigates forward.
  // Non-fatal: if the hold API fails we log and advance anyway — /reserve
  // will create a fresh reservation at submit time.

  const createHoldAndAdvance = useCallback(
    async (slot: AvailabilitySlot, incShoes: boolean) => {
      // Release any existing hold before creating a new one
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
        const data = await res.json() as { qamfReservationId?: string; error?: string };
        if (!res.ok) throw new Error(data.error ?? "Hold failed");

        holdRef.current = { qamfId: data.qamfReservationId!, centerId: center.qamfId };
        setHoldActive(true);

        // Extend every 8 min so the 10-min QAMF TTL never expires while the user fills in details
        holdTimerRef.current = setInterval(() => {
          if (!holdRef.current) return;
          void fetch(`/api/bowling/v2/reserve/hold/${holdRef.current.qamfId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ centerId: holdRef.current.centerId }),
          }).catch(() => {});
        }, 8 * 60 * 1000);
      } catch (err) {
        // Non-fatal — submit will fall back to fresh createReservation
        console.warn("[BowlingWizard] hold creation failed:", err);
      } finally {
        setHoldBusy(false);
      }

      setStep(incShoes ? "review" : "shoes");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [center.qamfId, activePlayerCount, releaseHold],
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

  // ── Submit ────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (squareToken?: string) => {
      if (!selectedSlot) return;
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
            amountCents: depositCents,
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
              }))
            : Array.from({ length: playerCount }, (_, i) => ({ name: `Bowler ${i + 1}` }));

        const notes =
          kind === "kbf"
            ? `${pass?.fpass ? "Families Bowl Free" : "Kids Bowl Free"} - ${kbfBowlers.map((b) => b.displayName).join(" - ")}. Coupons verified online.`
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
            squareToken,
            locationId: center.squareCenterCode,
            notes,
            // Pass existing hold ID so reserve route confirms it instead of
            // creating a duplicate QAMF reservation
            ...(holdRef.current?.qamfId
              ? { qamfReservationId: holdRef.current.qamfId }
              : {}),
            ...(quoteDayofOrderId
              ? {
                  dayofOrderId: quoteDayofOrderId,
                  dayofTotalCents: quoteTotalCents,
                  depositCents: quoteDepositCents,
                }
              : {}),
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          const detail = data.code
            ? ` (${data.code}${data.detail ? `: ${data.detail}` : ""})`
            : "";
          throw new Error((data.error ?? "Reservation failed") + detail);
        }

        const params = new URLSearchParams({
          neonId: String(data.neonId),
          qamfId: data.qamfReservationId ?? "",
          centerId: center.id,
          depositPaid: String(data.depositPaidCents ?? 0),
          remaining: String(data.remainingCents ?? 0),
        });
        router.push(`${confirmationBase}?${params.toString()}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Reservation failed";
        if (depositCents > 0) {
          setPaymentError(msg);
        } else {
          setError(msg);
        }
        setStep(depositCents > 0 ? "payment" : "details");
      } finally {
        setBusy(false);
      }
    },
    [
      selectedSlot,
      depositCents,
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
    ],
  );

  // ── KBF bookable dates for reschedule picker ─────────────────────

  const kbfBookableDates = kind === "kbf" ? bookableDateRange() : [];

  // ── Step title ───────────────────────────────────────────────────

  const programLabel = kind === "kbf" ? "Kids Bowl Free" : "Open Bowling";

  function stepTitle(): string {
    if (step === "location")   return "Confirm Your Center";
    if (step === "lookup")     return "Sign In";
    if (step === "verify")     return "Verify";
    if (step === "existing")   return "You're Already Booked";
    if (step === "reschedule") return "Change Date & Time";
    if (step === "bowlers")    return "Who's Bowling?";
    if (step === "players")    return "How Many Bowlers?";
    if (step === "slots")      return "When Do You Want to Bowl?";
    if (step === "tier")       return "Choose Your Experience";
    if (step === "offer")      return "Choose a Package";
    if (step === "shoes")      return "Add Shoe Rentals";
    if (step === "attractions")return "Level Up Your Visit";
    if (step === "food")       return "Add Food & Drinks";
    if (step === "review")     return "Review Your Booking";
    if (step === "details")    return "Your Details";
    if (step === "payment")    return "Payment";
    return "";
  }

  // ── Calendar helpers ─────────────────────────────────────────────

  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const firstDay    = new Date(calYear, calMonth, 1).getDay();
  const monthName   = new Date(calYear, calMonth).toLocaleString("en-US", {
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
                    style={{ backgroundColor: `${GOLD}18`, color: GOLD, border: `1px solid ${GOLD}45` }}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full animate-pulse"
                      style={{ backgroundColor: GOLD }}
                    />
                    Lane held
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
          {step === "location" && (() => {
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
                <div className="flex gap-1 bg-white/5 rounded-lg p-1">
                  {(["email", "phone", "new"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => { setLookupTab(m); setError(null); }}
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
                    <div className="font-heading uppercase text-[10px] tracking-[3px] mb-1" style={{ color: CORAL }}>
                      New to Kids Bowl Free?
                    </div>
                    <p className="text-white/65 text-xs leading-relaxed mb-3">
                      Sign up at{" "}
                      <a href="https://www.kidsbowlfree.com/bowland" target="_blank" rel="noopener noreferrer" className="underline hover:text-white">
                        kidsbowlfree.com/bowland
                      </a>{" "}
                      — new accounts take about an hour to be reservable here. Once registered, come back and use the Email tab.
                    </p>
                    <a
                      href="https://www.kidsbowlfree.com/bowland"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center w-full py-2.5 rounded-full font-body font-bold text-xs uppercase tracking-wider transition-all hover:scale-[1.01]"
                      style={{ backgroundColor: "rgba(253,91,86,0.20)", border: `1px solid ${CORAL}60`, color: CORAL }}
                    >
                      Register at kidsbowlfree.com →
                    </a>
                  </div>
                )}
              </div>
              <button type="button" onClick={() => setStep("location")} className="w-full font-body text-white/35 text-sm py-1">
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
                We sent a 6-digit code to {maskedDest} via{" "}
                {channel === "sms" ? "text" : "email"}. Enter it below.
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
                onClick={() => { setCode(""); setStep("lookup"); }}
                className="w-full font-body text-white/35 text-sm"
              >
                ← Back
              </button>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════
              STEP: Existing reservation (KBF only)
          ═══════════════════════════════════════════════════════ */}
          {step === "existing" && kind === "kbf" && existingReservation && (() => {
            const ex = existingReservation;
            const exCenter = CENTER_BY_CODE[ex.centerCode] ?? center;
            const hasPaid = ex.depositCents > 0;
            const remaining = ex.totalCents - ex.depositCents;
            return (
              <div className="space-y-4">
                <div className="rounded-2xl p-5" style={{ backgroundColor: "rgba(253,91,86,0.08)", border: `1.78px solid ${CORAL}55` }}>
                  <div className="uppercase font-bold mb-3" style={{ color: CORAL, fontSize: "10px", letterSpacing: "2.5px" }}>
                    You&apos;re already booked
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="font-body text-white/50">Center</span>
                      <span className="font-body text-white font-semibold">{exCenter.name}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="font-body text-white/50">Date</span>
                      <span className="font-body text-white font-semibold">{formatDate(ex.bookedAt.slice(0, 10))}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="font-body text-white/50">Time</span>
                      <span className="font-body text-white font-semibold">{formatTime(ex.bookedAt)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="font-body text-white/50">Bowlers</span>
                      <span className="font-body text-white font-semibold">{ex.playerCount ?? "—"}</span>
                    </div>
                    {ex.lines.length > 0 && (
                      <>
                        <div className="h-px bg-white/10 my-1" />
                        {ex.lines.map((line, i) => (
                          <div key={i} className="flex justify-between text-sm">
                            <span className="font-body text-white/50">{line.label}{line.quantity > 1 ? ` ×${line.quantity}` : ""}</span>
                            <span className="font-body text-white">
                              {line.unitPriceCents === 0 ? "Free" : centsToDollars(line.unitPriceCents * line.quantity)}
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
                          <span className="font-body font-semibold" style={{ color: "#4ade80" }}>{centsToDollars(ex.depositCents)}</span>
                        </div>
                        {remaining > 0 && (
                          <div className="flex justify-between text-sm">
                            <span className="font-body text-white/50">Due at center</span>
                            <span className="font-body text-white">{centsToDollars(remaining)}</span>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                <p className="font-body text-white/45 text-xs text-center leading-relaxed">
                  Kids Bowl Free allows one active reservation at a time. Change the date &amp; time, or cancel to start a new booking.
                </p>

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
                  <button type="button" onClick={() => setCancelConfirming(true)} className="w-full font-body text-white/35 text-xs py-1">
                    Cancel this reservation
                  </button>
                ) : (
                  <div className="rounded-xl p-4 space-y-3" style={{ backgroundColor: "rgba(253,91,86,0.08)", border: "1.5px solid rgba(253,91,86,0.3)" }}>
                    <p className="font-body text-white/75 text-sm text-center">
                      Cancel this reservation?
                      {ex.depositCents > 0 && (
                        <span className="block text-xs text-white/45 mt-1">
                          A full {centsToDollars(ex.depositCents)} refund will be returned to your original payment method automatically.
                        </span>
                      )}
                    </p>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setCancelConfirming(false)} className="flex-1 rounded-full px-4 py-2.5 font-body font-bold text-sm uppercase tracking-wider text-white/70 border border-white/20">
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

                <button type="button" onClick={() => { setCancelConfirming(false); setStep("verify"); }} className="w-full font-body text-white/35 text-sm">
                  ← Back
                </button>
              </div>
            );
          })()}

          {/* ═══════════════════════════════════════════════════════
              STEP: Reschedule (KBF only)
          ═══════════════════════════════════════════════════════ */}
          {step === "reschedule" && kind === "kbf" && existingReservation && (() => {
            const ex = existingReservation;
            const exCenter = CENTER_BY_CODE[ex.centerCode] ?? center;
            return (
              <div className="space-y-4">
                <div className="md:grid md:grid-cols-[260px_1fr] md:gap-6 md:items-start">
                  <div className="space-y-4">
                    <div className="rounded-xl px-4 py-3" style={{ backgroundColor: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                      <div className="uppercase font-bold mb-1" style={{ color: "rgba(255,255,255,0.35)", fontSize: "10px", letterSpacing: "2px" }}>
                        Rescheduling · {exCenter.name}
                      </div>
                      <div className="font-body text-white/55 text-xs line-through">
                        {formatDate(ex.bookedAt.slice(0, 10))} · {formatTime(ex.bookedAt)}
                      </div>
                    </div>
                    <div>
                      <label htmlFor="reschedule-date" className="font-body text-white/55 text-xs uppercase tracking-wider block mb-2">Pick a new date</label>
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
                          void fetchSlots(v, ex.playerCount ?? 1);
                        }}
                        className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white font-body text-sm focus:outline-none focus:border-[#fd5b56]/50"
                      />
                    </div>
                    {selectedSlot && (
                      <div className="hidden md:block rounded-xl px-4 py-3" style={{ backgroundColor: "rgba(253,91,86,0.08)", border: `1px solid ${CORAL}40` }}>
                        <div className="font-body text-white/45 text-[10px] uppercase tracking-wider mb-1">New time</div>
                        <div className="font-body text-white font-bold text-sm">{formatTime(selectedSlot.bookedAt)}</div>
                        <div className="font-body text-white/50 text-xs mt-0.5">{selectedExperience?.isVip ? "VIP Suite" : "Regular Lanes"}</div>
                      </div>
                    )}
                    <div className="hidden md:flex md:flex-col md:gap-2">
                      <button type="button" onClick={() => void handleReschedule()} disabled={!selectedSlot || slotsLoading || busy} className="w-full rounded-full px-6 py-3.5 font-body font-bold text-sm uppercase tracking-wider text-white disabled:opacity-50" style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}>
                        {busy ? "Rescheduling…" : selectedSlot ? `Confirm — ${formatTime(selectedSlot.bookedAt)}` : "Select a time"}
                      </button>
                      <button type="button" onClick={() => setStep("existing")} className="w-full font-body text-white/35 text-sm py-1">← Keep existing time</button>
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
                      <div className="rounded-xl p-3 text-sm font-body" style={{ backgroundColor: "rgba(253,91,86,0.08)", border: "1.5px solid rgba(253,91,86,0.25)", color: CORAL }}>
                        {slotsError}
                      </div>
                    )}
                    {!slotsLoading && (
                      <div className="space-y-3 md:grid md:grid-cols-2 md:gap-4 md:space-y-0">
                        {experiences.map((exp) => {
                          const display = getExperienceDisplay(exp.slug, exp.isVip);
                          const accent = display.accent;
                          const offerSlots = availableSlots.filter((s) => s.webOfferId === exp.qamfWebOfferId);
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
                                  if (selectedSlot?.webOfferId !== exp.qamfWebOfferId) setSelectedSlot(null);
                                }}
                              >
                                <h3 className="font-heading uppercase text-white text-sm tracking-wider">{exp.label}</h3>
                                <p className="font-body text-white/45 text-xs mt-0.5">{display.description}</p>
                              </button>
                              {hasSlots && (
                                <div className={isSelected ? "block" : "hidden md:block"} style={{ borderTop: `1px solid ${accent}20` }}>
                                  <div className="px-4 pb-4 pt-3">
                                    <div className="flex flex-wrap gap-1.5">
                                      {offerSlots.map((s) => {
                                        const on = selectedSlot?.bookedAt === s.bookedAt && selectedSlot?.webOfferId === s.webOfferId;
                                        return (
                                          <button
                                            key={s.bookedAt}
                                            type="button"
                                            onClick={() => setSelectedSlot(s)}
                                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold font-body transition-all"
                                            style={{
                                              backgroundColor: on ? accent : "rgba(255,255,255,0.08)",
                                              color: on ? (exp.isVip ? BG : "white") : "rgba(255,255,255,0.7)",
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
                  <button type="button" onClick={() => void handleReschedule()} disabled={!selectedSlot || slotsLoading || busy} className="w-full rounded-full px-6 py-3.5 font-body font-bold text-sm uppercase tracking-wider text-white disabled:opacity-50" style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}>
                    {busy ? "Rescheduling…" : selectedSlot ? `Confirm — ${formatTime(selectedSlot.bookedAt)}` : "Select a time"}
                  </button>
                  <button type="button" onClick={() => setStep("existing")} className="w-full font-body text-white/35 text-sm">← Keep existing time</button>
                </div>
              </div>
            );
          })()}

          {/* ═══════════════════════════════════════════════════════
              STEP: Bowlers (KBF only)
          ═══════════════════════════════════════════════════════ */}
          {step === "bowlers" && kind === "kbf" && (() => {
            const KBF_BLUE = "#4fa3e0";
            const hasFamilyPass = pass?.fpass ?? false;
            const anyKidSelected = bowlerSelections.some((b) => b.relation === "kid" && b.selected);
            const bowlerCount = kbfBowlers.length;

            const relationLabel = (rel: BowlerSelection["relation"]) => {
              if (rel === "parent") return hasFamilyPass ? "Family Pass Adult" : "Account holder";
              if (rel === "kid") return "Kids Bowl Free";
              return "Family Pass Adult";
            };

            return (
              <div className="space-y-3">
                <div className="rounded-2xl px-4 py-3 flex items-center gap-3" style={{ backgroundColor: `${KBF_BLUE}14`, border: `1.78px solid ${KBF_BLUE}55` }}>
                  <div className="w-9 h-9 rounded-full flex items-center justify-center font-heading font-black shrink-0" style={{ backgroundColor: `${KBF_BLUE}26`, color: KBF_BLUE }}>★</div>
                  <div className="flex-1 min-w-0">
                    <div className="font-heading uppercase tracking-[3px] text-[10px] mb-0.5" style={{ color: KBF_BLUE }}>{hasFamilyPass ? "Families Bowl Free" : "Kids Bowl Free"}</div>
                    <div className="text-white/85 text-sm font-semibold truncate">{pass ? `${pass.firstName} ${pass.lastName}` : ""}</div>
                  </div>
                </div>

                <p className="font-body text-white/65 text-sm leading-relaxed">
                  Check who&apos;s bowling today. At least one registered kid is required.
                </p>

                {bowlerSelections.map((b, i) => {
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
                        updated[i] = { ...b, selected: !b.selected };
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
                      <div className="w-10 h-10 rounded-full flex items-center justify-center font-heading font-black text-sm shrink-0" style={{ backgroundColor: `${accent}22`, color: accent, border: `1.78px solid ${accent}55` }}>
                        {b.displayName.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-white font-semibold text-sm truncate">{b.displayName}</div>
                        <span className="inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full mt-0.5" style={{ backgroundColor: `${accent}22`, color: accent }}>
                          {relationLabel(b.relation)}
                        </span>
                      </div>
                      <div className="text-[10px] uppercase tracking-[2px] font-bold px-3 py-1.5 rounded-full shrink-0" style={{ backgroundColor: b.selected ? `${accent}26` : "rgba(255,255,255,0.06)", color: b.selected ? accent : "rgba(255,255,255,0.45)", border: b.selected ? `1px solid ${accent}80` : "1px solid rgba(255,255,255,0.10)" }}>
                        {adultLocked ? "Kid required" : b.selected ? "Bowling" : "Add"}
                      </div>
                    </button>
                  );
                })}

                <button
                  type="button"
                  onClick={() => {
                    if (bowlerCount === 0) { setError("Select at least one bowler"); return; }
                    if (!anyKidSelected) { setError("At least one kid must be bowling"); return; }
                    setError(null);
                    setStep("slots");
                  }}
                  className="w-full rounded-full px-6 py-3.5 font-body font-bold text-sm uppercase tracking-wider text-white"
                  style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                >
                  Continue with {bowlerCount} bowler{bowlerCount === 1 ? "" : "s"}
                </button>
                <button type="button" onClick={() => setStep("verify")} className="w-full font-body text-white/35 text-sm">← Back</button>
              </div>
            );
          })()}

          {/* ═══════════════════════════════════════════════════════
              STEP: Players (Open only)
          ═══════════════════════════════════════════════════════ */}
          {step === "players" && kind === "open" && (
            <div className="space-y-6">
              <p className="font-body text-white/55 text-sm text-center">Up to 6 bowlers per lane</p>
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
                  onClick={() => setPlayerCount((n) => Math.min(6, n + 1))}
                  className="w-14 h-14 rounded-full flex items-center justify-center font-heading font-black text-2xl transition-all hover:scale-105"
                  style={{
                    backgroundColor: playerCount < 6 ? `${CORAL}22` : "rgba(255,255,255,0.07)",
                    border: `1.78px solid ${playerCount < 6 ? `${CORAL}60` : "rgba(255,255,255,0.18)"}`,
                    color: playerCount < 6 ? CORAL : "rgba(255,255,255,0.75)",
                    boxShadow: playerCount < 6 ? `0 0 14px ${CORAL}30` : undefined,
                  }}
                >
                  +
                </button>
              </div>
              <button
                type="button"
                onClick={() => setStep("slots")}
                className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.02]"
                style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
              >
                Continue with {playerCount} {playerCount === 1 ? "bowler" : "bowlers"}
              </button>
              <button type="button" onClick={() => setStep("location")} className="w-full font-body text-white/35 text-sm">← Back</button>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════
              STEP: Slots — calendar + hour chips
          ═══════════════════════════════════════════════════════ */}
          {step === "slots" && (() => {
            const filteredHours = getFilteredHours(selectedDate);

            return (
              <div className="space-y-6">
                {/* Context bar */}
                <div className="flex flex-wrap items-center justify-center gap-3 text-xs uppercase tracking-wider text-white/55 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5">
                  <span style={{ color: CORAL }}>📍 {center.name}</span>
                  {selectedDate && (
                    <>
                      <span className="text-white/20">·</span>
                      <span>📅 {new Date(`${selectedDate}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</span>
                    </>
                  )}
                  {selectedHour !== null && selectedMinute !== null && (
                    <>
                      <span className="text-white/20">·</span>
                      <span style={{ color: GOLD }}>🕐 {formatHourMinute(selectedHour, selectedMinute)}</span>
                    </>
                  )}
                </div>

                <div className={`grid grid-cols-1 md:grid-cols-2 gap-6 transition-opacity${slotsLoading ? " opacity-40 pointer-events-none" : ""}`}>
                  {/* Calendar */}
                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                    <div className="text-white/35 text-xs uppercase tracking-[3px] mb-3 text-center">Date</div>
                    <div className="flex items-center justify-between mb-3">
                      <button type="button" onClick={() => { if (calMonth === 0) { setCalMonth(11); setCalYear(calYear - 1); } else setCalMonth(calMonth - 1); }} className="text-white/50 hover:text-white p-2" aria-label="Previous month">←</button>
                      <span className="font-body text-white font-bold text-sm">{monthName}</span>
                      <button type="button" onClick={() => { if (calMonth === 11) { setCalMonth(0); setCalYear(calYear + 1); } else setCalMonth(calMonth + 1); }} className="text-white/50 hover:text-white p-2" aria-label="Next month">→</button>
                    </div>
                    <div className="grid grid-cols-7 mb-1">
                      {["Su","Mo","Tu","We","Th","Fr","Sa"].map((d) => (
                        <div key={d} className="text-center text-[12px] text-white/30 py-1">{d}</div>
                      ))}
                    </div>
                    <div className="grid grid-cols-7 gap-1">
                      {Array.from({ length: firstDay }).map((_, i) => <div key={`pad-${i}`} />)}
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
                            onClick={() => { setSelectedDate(dateStr); setSelectedHour(null); setSelectedMinute(null); setAvailableSlots([]); setSlotsError(null); }}
                            className="aspect-square rounded-lg text-sm font-medium transition-all duration-150"
                            style={{
                              backgroundColor: isSelected ? CORAL : bookable ? "rgba(253,91,86,0.15)" : "transparent",
                              color: isSelected ? "#0a1628" : bookable ? CORAL : "rgba(255,255,255,0.18)",
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
                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                    {!selectedDate ? (
                      <div className="flex items-center justify-center h-full min-h-[200px]">
                        <p className="font-body text-white/30 text-sm">Pick a date first</p>
                      </div>
                    ) : (
                      <>
                        <div className="text-white/35 text-xs uppercase tracking-[3px] mb-3 text-center">Time</div>
                        <div className="flex flex-wrap justify-center gap-2">
                          {filteredHours.map((h) => {
                            const isActive = selectedHour === h;
                            return (
                              <button
                                key={h}
                                type="button"
                                onClick={() => { setSelectedHour(h); setSelectedMinute(null); }}
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
                        {selectedHour !== null && (() => {
                          // Always offer :00 / :15 / :30 / :45 — no availability
                          // pre-check needed; actual slot existence is verified when
                          // the user hits "See Packages" and availability loads.
                          const distinctMinutes = [0, 15, 30, 45];
                          return (
                            <div className="mt-4 pt-3 border-t border-white/8">
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
                                      onClick={() => setSelectedMinute(m)}
                                      className="rounded-lg px-3 py-2 text-sm font-medium transition-all hover:scale-[1.02]"
                                      style={{
                                        backgroundColor: isActive ? GOLD : "rgba(255,215,0,0.10)",
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
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setStep(kind === "kbf" ? "bowlers" : "players")}
                    className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setSelectedTier(null);
                      void (async () => {
                        await fetchSlots(selectedDate);
                        setStep("tier");
                      })();
                    }}
                    disabled={selectedHour === null || selectedMinute === null || slotsLoading}
                    className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-50"
                    style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                  >
                    {slotsLoading
                      ? "Finding packages…"
                      : selectedHour !== null && selectedMinute !== null
                        ? `See Packages — ${formatHourMinute(selectedHour, selectedMinute)}`
                        : selectedHour !== null
                          ? "Pick a time above"
                          : "See Available Packages"}
                  </button>
                </div>
              </div>
            );
          })()}

          {/* ═══════════════════════════════════════════════════════
              STEP: Tier — Regular vs VIP picker
          ═══════════════════════════════════════════════════════ */}
          {step === "tier" && (() => {
            const dateLabel = selectedDate
              ? new Date(`${selectedDate}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
              : "";

            // Only show tiers that have at least one experience valid for today's day-of-week
            const tierDow = new Date(`${selectedDate}T12:00:00`).getDay();
            const tiersToShow = ([
              {
                id: "regular" as const,
                label: "Regular",
                subtitle: "Standard HeadPinz lanes — great for families and groups.",
                accent: CORAL,
                videoUrl: `${BLOB}/videos/headpinz-bowling.mp4`,
                features: ["Standard lanes", "Up to 6 bowlers per lane", "Glow lighting evenings"],
              },
              {
                id: "vip" as const,
                label: "VIP",
                subtitle: "Premium VIP suite with NeoVerse video walls and HyperBowling.",
                accent: GOLD,
                videoUrl: `${BLOB}/videos/headpinz-neoverse-v2.mp4`,
                features: ["VIP lounge & dedicated lanes", "NeoVerse video walls", "HyperBowling technology"],
              },
            ] as const).filter((t) =>
              experiences.some(
                (e) =>
                  (t.id === "vip" ? e.isVip : !e.isVip) &&
                  (!e.daysOfWeek.length || e.daysOfWeek.includes(tierDow)),
              ),
            );

            return (
              <div className="space-y-6">
                <p className="text-center text-white/45 text-xs">
                  {selectedHour !== null && selectedMinute !== null
                    ? `Available at ${formatHourMinute(selectedHour, selectedMinute)}`
                    : "Available"}{" "}
                  on {dateLabel}
                </p>

                {tiersToShow.length === 0 ? (
                  <div className="text-center py-10">
                    <p className="font-body text-white/50 text-sm">No packages available at the selected time.</p>
                    <button type="button" onClick={() => setStep("slots")} className="mt-4 font-body text-white/60 text-sm underline underline-offset-2">← Choose a different time</button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {tiersToShow.map((tier) => (
                      <button
                        key={tier.id}
                        type="button"
                        onClick={() => { setSelectedTier(tier.id); setStep("offer"); }}
                        className="w-full rounded-xl overflow-hidden transition-all text-left hover:scale-[1.01] active:scale-[0.99]"
                        style={{
                          backgroundColor: "rgba(7,16,39,0.5)",
                          border: `1.78px solid ${tier.accent}50`,
                          boxShadow: `0 0 24px ${tier.accent}18`,
                        }}
                      >
                        <div className="flex flex-col sm:flex-row">
                          {/* Video thumbnail */}
                          <div className="relative w-full sm:w-52 h-36 sm:h-auto shrink-0 overflow-hidden">
                            <video
                              autoPlay muted loop playsInline preload="metadata"
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
                                  style={{ backgroundColor: `${GOLD}22`, color: GOLD, border: `1px solid ${GOLD}50` }}
                                >
                                  Premium
                                </span>
                              )}
                            </div>
                            <p className="font-body text-white/55 text-sm mb-3">{tier.subtitle}</p>
                            <div className="flex flex-wrap gap-x-4 gap-y-1 mb-4">
                              {tier.features.map((f) => (
                                <span key={f} className="flex items-center gap-1.5">
                                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: tier.accent }} />
                                  <span className="font-body text-white/40 text-xs">{f}</span>
                                </span>
                              ))}
                            </div>
                            <div
                              className="inline-flex items-center gap-1.5 font-body text-xs font-bold uppercase tracking-wider"
                              style={{ color: tier.accent }}
                            >
                              Select {tier.label} →
                            </div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setStep("slots")}
                  className="w-full rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/70 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
                >
                  Back
                </button>
              </div>
            );
          })()}

          {/* ═══════════════════════════════════════════════════════
              STEP: Offer — video cards + time chips
          ═══════════════════════════════════════════════════════ */}
          {step === "offer" && (() => {
            // Filter experiences for offer cards:
            //   1. Must be valid for the selected day-of-week
            //   2. Must match the selected tier (Regular vs VIP)
            //   3. 'open' kind (Fun 4 All, Pizza Bowl) — hide when QAMF has no slots on this day
            //   4. 'hourly' kind — always show (may be genuinely sold out; show SOLD OUT badge)
            const selectedDow = new Date(`${selectedDate}T12:00:00`).getDay();
            const offerExperiences = experiences.filter((exp) => {
              // Day-of-week gate — skip if this experience doesn't run today
              if (exp.daysOfWeek.length && !exp.daysOfWeek.includes(selectedDow)) return false;
              const tierMatch = selectedTier === null || (selectedTier === "vip" ? exp.isVip : !exp.isVip);
              if (!tierMatch) return false;
              if (exp.kind === "open") {
                // Fun 4 All / Pizza Bowl — only show when QAMF confirms availability
                return availableSlots.some(
                  (s) =>
                    s.webOfferId === exp.qamfWebOfferId &&
                    (selectedHour === null || slotHourET(s.bookedAt) === selectedHour) &&
                    (selectedMinute === null || slotMinuteET(s.bookedAt) === selectedMinute),
                );
              }
              return true; // hourly: always show, may show SOLD OUT
            });

            return (
              <div className="space-y-6">
                <p className="text-center text-white/45 text-xs">
                  {selectedHour !== null && selectedMinute !== null
                    ? `Showing packages at ${formatHourMinute(selectedHour, selectedMinute)}`
                    : "Showing packages"}{" "}
                  on{" "}
                  {selectedDate
                    ? new Date(`${selectedDate}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
                    : ""}
                </p>

                <div className="space-y-4">
                  {offerExperiences.map((exp) => {
                    const display = getExperienceDisplay(exp.slug, exp.isVip);
                    const accent = display.accent;
                    const isHourly = exp.kind === "hourly";
                    const offerSlots = availableSlots.filter(
                      (s) =>
                        s.webOfferId === exp.qamfWebOfferId &&
                        (selectedHour === null || slotHourET(s.bookedAt) === selectedHour) &&
                        (selectedMinute === null || slotMinuteET(s.bookedAt) === selectedMinute),
                    );
                    const hasSlots = offerSlots.length > 0;
                    const isExpSelected = selectedSlot?.webOfferId === exp.qamfWebOfferId;
                    const includesShoes = display.includesShoes ?? false;

                    // Base lane/game item for pricing
                    const baseItem = exp.items[0];
                    const baseItemCents = (baseItem?.priceCents ?? 0) * (baseItem?.quantity ?? 1);
                    const baseTotalCents = exp.items.reduce((s, i) => s + i.priceCents * i.quantity, 0);

                    // For KBF with no items it's free
                    const isFree = exp.items.length === 0 && kind === "kbf";

                    return (
                      <div key={exp.qamfWebOfferId} className="w-full rounded-xl overflow-hidden" style={{ border: `1.78px solid ${isExpSelected ? `${accent}88` : `${accent}28`}`, boxShadow: isExpSelected ? `0 0 28px ${accent}20` : undefined }}>
                        {/* Shoes included banner */}
                        {includesShoes && hasSlots && (
                          <div className="w-full py-2 px-4 text-center font-body font-bold text-xs uppercase tracking-widest" style={{ backgroundColor: `${accent}22`, color: accent, borderBottom: `1px solid ${accent}30` }}>
                            ★ Bowling Shoes Included ★
                          </div>
                        )}

                        <div className="flex flex-col sm:flex-row" style={{ backgroundColor: "rgba(7,16,39,0.55)" }}>
                          {/* Video */}
                          <div className="relative w-full sm:w-52 shrink-0 overflow-hidden" style={{ minHeight: "10rem" }}>
                            <video autoPlay muted loop playsInline preload="metadata" className="absolute inset-0 w-full h-full object-cover" key={display.videoUrl}>
                              <source src={display.videoUrl} type="video/mp4" />
                            </video>
                            <div className="absolute inset-0 bg-gradient-to-b sm:bg-gradient-to-r from-transparent to-[#071027]/60 pointer-events-none" />
                            {/* Per-person / per-lane badge */}
                            <div className="absolute top-3 left-3">
                              <span className="font-body font-bold text-[10px] uppercase tracking-widest px-2.5 py-1 rounded-full" style={{ backgroundColor: accent, color: "#0a1628" }}>
                                {isHourly ? "Per Lane" : "Per Person"}
                              </span>
                            </div>
                          </div>

                          {/* Content */}
                          <div className="flex-1 p-5">
                            <div className="flex items-center gap-2 flex-wrap mb-1">
                              <h3 className="font-heading uppercase text-white text-base tracking-wider" style={{ textShadow: `0 0 15px ${accent}25` }}>
                                {exp.label}
                              </h3>
                              {!hasSlots && (
                                <span className="font-body text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ backgroundColor: "rgba(253,91,86,0.18)", color: CORAL, border: `1px solid ${CORAL}40` }}>
                                  Sold Out
                                </span>
                              )}
                            </div>
                            <p className="font-body text-white/55 text-sm mb-4">{display.description}</p>

                            {isHourly && exp.durationOptions.length > 0 ? (
                              /* Duration tiles (Open Bowling Mon-Thur style) */
                              <div className="flex gap-3 flex-wrap">
                                {exp.durationOptions.map((opt) => {
                                  const optCents = Math.round(baseItemCents * opt.squareMultiplier);
                                  const isOn =
                                    isExpSelected &&
                                    selectedSlot?.optionId === opt.qamfOptionId;
                                  const firstSlot = offerSlots[0];
                                  return (
                                    <button
                                      key={opt.qamfOptionId}
                                      type="button"
                                      disabled={!hasSlots}
                                      onClick={() => {
                                        if (!firstSlot) return;
                                        setSelectedSlot({ ...firstSlot, optionId: opt.qamfOptionId });
                                      }}
                                      className="flex flex-col items-center rounded-xl p-4 min-w-[110px] transition-all hover:scale-[1.02] disabled:opacity-40 disabled:cursor-not-allowed"
                                      style={{
                                        backgroundColor: isOn ? accent : `${accent}14`,
                                        border: `1.5px solid ${isOn ? accent : `${accent}45`}`,
                                        boxShadow: isOn ? `0 0 14px ${accent}40` : undefined,
                                      }}
                                    >
                                      <span className="font-body font-bold text-sm uppercase tracking-wider" style={{ color: isOn ? "#0a1628" : "rgba(255,255,255,0.7)" }}>
                                        {opt.label}
                                      </span>
                                      <span className="font-heading text-xl font-bold mt-1" style={{ color: isOn ? "#0a1628" : accent }}>
                                        {centsToDollars(optCents)}
                                      </span>
                                      <span className="font-body text-[11px] mt-0.5" style={{ color: isOn ? "#0a162890" : "rgba(255,255,255,0.35)" }}>
                                        per lane
                                      </span>
                                      {isOn && <span className="text-xs mt-1" style={{ color: "#0a1628" }}>✓ Selected</span>}
                                    </button>
                                  );
                                })}
                              </div>
                            ) : isHourly ? (
                              /* Hourly but no duration options — just time chips */
                              hasSlots ? (
                                <div className="flex flex-wrap gap-2">
                                  {offerSlots.map((s) => {
                                    const on = selectedSlot?.bookedAt === s.bookedAt && selectedSlot?.webOfferId === s.webOfferId;
                                    return (
                                      <button key={s.bookedAt} type="button" onClick={() => setSelectedSlot(s)} className="inline-flex items-center font-body text-sm font-bold uppercase tracking-wider px-4 py-2 rounded-full transition-all hover:scale-[1.02]" style={{ backgroundColor: on ? accent : `${accent}1a`, color: on ? "#0a1628" : accent, border: `1px solid ${on ? accent : `${accent}55`}`, boxShadow: on ? `0 0 10px ${accent}40` : undefined }}>
                                        {formatTime(s.bookedAt)}{on && <span className="ml-1.5">✓</span>}
                                      </button>
                                    );
                                  })}
                                </div>
                              ) : null
                            ) : (
                              /* 'open' kind (Fun 4 All) — per-person with time chips */
                              hasSlots && (
                                <div>
                                  {/* Price row */}
                                  <div className="flex items-baseline gap-2 mb-3">
                                    <span className="font-heading text-2xl font-bold" style={{ color: accent }}>
                                      {isFree ? "Free" : centsToDollars(baseTotalCents * activePlayerCount)}
                                    </span>
                                    {!isFree && (
                                      <span className="font-body text-white/40 text-sm">
                                        {centsToDollars(baseTotalCents)}/person
                                      </span>
                                    )}
                                  </div>
                                  {/* Time chips */}
                                  <div className="flex flex-wrap gap-2">
                                    {offerSlots.map((s) => {
                                      const on = selectedSlot?.bookedAt === s.bookedAt && selectedSlot?.webOfferId === s.webOfferId;
                                      return (
                                        <button key={s.bookedAt} type="button" onClick={() => setSelectedSlot(s)} className="inline-flex items-center font-body text-sm font-bold uppercase tracking-wider px-4 py-2 rounded-full transition-all hover:scale-[1.02]" style={{ backgroundColor: on ? accent : `${accent}1a`, color: on ? "#0a1628" : accent, border: `1px solid ${on ? accent : `${accent}55`}`, boxShadow: on ? `0 0 10px ${accent}40` : undefined }}>
                                          {formatTime(s.bookedAt)}{on && <span className="ml-1.5">✓</span>}
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
                  <button type="button" onClick={() => { setSelectedSlot(null); setStep("tier"); }} className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/15 hover:border-white/30 transition-colors">Back</button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!selectedSlot) { setError("Please select a time slot"); return; }
                      setError(null);
                      // Show VIP upgrade modal when Regular selected and VIP slot exists.
                      // Hold is created AFTER the user resolves the modal (in "No Thanks" / "Upgrade").
                      if (selectedTier === "regular" && vipUpgradeSlot) {
                        setShowVipUpgrade(true);
                        return;
                      }
                      // Create hold and advance
                      void createHoldAndAdvance(selectedSlot, selectedIncludesShoes);
                    }}
                    disabled={!selectedSlot || holdBusy}
                    className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-50"
                    style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                  >
                    {holdBusy ? "Holding lane…" : selectedSlot ? `Continue — ${formatTime(selectedSlot.bookedAt)}` : "Select a time"}
                  </button>
                </div>
              </div>
            );
          })()}

          {/* ═══════════════════════════════════════════════════════
              VIP UPGRADE MODAL
          ═══════════════════════════════════════════════════════ */}
          {showVipUpgrade && vipUpgradeExperience && vipUpgradeSlot && selectedExperience && selectedSlot && (() => {
            const vipDisplay = getExperienceDisplay(vipUpgradeExperience.slug, true);
            const regTotal = selectedExperience.items.reduce((s, i) => s + i.priceCents * i.quantity, 0);
            const vipTotal = vipUpgradeExperience.items.reduce((s, i) => s + i.priceCents * i.quantity, 0);
            const delta = vipTotal - regTotal;
            const isHourly = vipUpgradeExperience.kind === "hourly";
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
                    <video autoPlay muted loop playsInline preload="metadata" className="absolute inset-0 w-full h-full object-cover">
                      <source src={vipDisplay.videoUrl} type="video/mp4" />
                    </video>
                    <div className="absolute inset-0" style={{ background: "linear-gradient(to bottom, transparent 30%, #0d1f3c 100%)" }} />
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
                    <h3 className="font-heading uppercase text-white text-xl tracking-wider mb-1" style={{ textShadow: `0 0 20px ${GOLD}40` }}>
                      Upgrade to VIP?
                    </h3>
                    <p className="font-body text-white/55 text-sm mb-4">{vipDisplay.description}</p>

                    {/* Feature list */}
                    <div className="space-y-2 mb-5">
                      {vipDisplay.features.map((f) => (
                        <div key={f} className="flex items-center gap-2">
                          <span className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0" style={{ backgroundColor: `${GOLD}25`, color: GOLD }}>✓</span>
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
                          +{centsToDollars(delta)}<span className="font-body text-sm font-normal text-white/40">/{isHourly ? "lane" : "person"}</span>
                        </span>
                      </div>
                    )}

                    {/* Buttons */}
                    <div className="flex gap-3">
                      <button
                        type="button"
                        disabled={holdBusy}
                        onClick={() => {
                          setShowVipUpgrade(false);
                          // Create hold on the regular slot and advance
                          void createHoldAndAdvance(selectedSlot, selectedIncludesShoes);
                        }}
                        className="flex-1 py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider border border-white/20 text-white/60 hover:text-white hover:border-white/40 transition-colors disabled:opacity-50"
                      >
                        {holdBusy ? "Holding…" : "No Thanks"}
                      </button>
                      <button
                        type="button"
                        disabled={holdBusy}
                        onClick={() => {
                          // Switch to VIP slot and create hold on it
                          setSelectedTier("vip");
                          setSelectedSlot(vipUpgradeSlot);
                          setShowVipUpgrade(false);
                          const vipIncludesShoes = vipDisplay.includesShoes ?? false;
                          void createHoldAndAdvance(vipUpgradeSlot, vipIncludesShoes);
                        }}
                        className="flex-1 py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider text-[#0a1628] transition-all hover:scale-[1.02] disabled:opacity-50"
                        style={{ backgroundColor: GOLD, boxShadow: `0 0 18px ${GOLD}40` }}
                      >
                        {holdBusy ? "Holding…" : delta > 0 ? `Upgrade +${centsToDollars(delta)}` : "Upgrade to VIP"}
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
                <div className="rounded-xl p-4 text-center" style={{ border: "1.78px dashed rgba(255,255,255,0.08)" }}>
                  <p className="font-body text-white/35 text-sm">No shoe rental available — bring your own or rent at the center.</p>
                </div>
              ) : (
                shoeProducts.map((p) => {
                  const qty = shoeQty[p.id] ?? 0;
                  return (
                    <div
                      key={p.id}
                      className="rounded-xl p-4"
                      style={{
                        backgroundColor: qty > 0 ? "rgba(253,91,86,0.08)" : "rgba(255,255,255,0.04)",
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
                          onClick={() => setShoeQty((q) => ({ ...q, [p.id]: Math.max(0, (q[p.id] ?? 0) - 1) }))}
                          className="w-9 h-9 rounded-full border border-white/20 text-white/60 hover:text-white hover:border-white/40 flex items-center justify-center text-lg leading-none transition-colors"
                        >
                          −
                        </button>
                        <span className="w-6 text-center text-white font-bold text-sm">{qty}</span>
                        <button
                          type="button"
                          onClick={() => setShoeQty((q) => ({ ...q, [p.id]: Math.min(activePlayerCount, (q[p.id] ?? 0) + 1) }))}
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
                <button type="button" onClick={() => { if (holdActive) { setPendingRelease("offer"); } else { setStep("offer"); } }} className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 border border-white/15">Back</button>
                <button
                  type="button"
                  onClick={() => { setError(null); setStep("review"); }}
                  className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white"
                  style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                >
                  {shoePreTaxTotal > 0 ? `Continue — ${centsToDollars(shoePreTaxTotal)}` : "Skip Shoes"}
                </button>
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════
              STEP: Attractions (stub)
          ═══════════════════════════════════════════════════════ */}
          {step === "attractions" && (
            <div className="space-y-4">
              <div className="rounded-xl p-6 text-center" style={{ border: "1.78px dashed rgba(255,255,255,0.08)" }}>
                <p className="font-body text-white/35 text-sm">Coming soon — laser tag, gel blasters, and more.</p>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setStep("shoes")} className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 border border-white/15">Back</button>
                <button type="button" onClick={() => setStep("food")} className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white" style={{ backgroundColor: CORAL }}>Skip</button>
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════
              STEP: Food (stub)
          ═══════════════════════════════════════════════════════ */}
          {step === "food" && (
            <div className="space-y-4">
              <div className="rounded-xl p-6 text-center" style={{ border: "1.78px dashed rgba(255,255,255,0.08)" }}>
                <p className="font-body text-white/35 text-sm">Food packages coming soon.</p>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setStep("attractions")} className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 border border-white/15">Back</button>
                <button type="button" onClick={() => setStep("review")} className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white" style={{ backgroundColor: CORAL }}>Skip</button>
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════
              STEP: Review
          ═══════════════════════════════════════════════════════ */}
          {step === "review" && selectedSlot && (
            <div className="space-y-4">
              <h2 className="font-heading uppercase text-white text-lg tracking-wider text-center">Order Summary</h2>
              <div
                className="rounded-xl p-4 space-y-3"
                style={{ backgroundColor: "rgba(255,255,255,0.04)", border: `1.78px dashed ${GOLD}35` }}
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
                  <span className="font-body text-white font-bold">{formatTime(selectedSlot.bookedAt)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="font-body text-white/55">Package</span>
                  <span className="font-body text-white font-bold">{selectedSlot.webOfferTitle}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="font-body text-white/55">Bowlers</span>
                  <span className="font-body text-white font-bold">{activePlayerCount}</span>
                </div>
                <div className="h-px bg-white/10" />

                {/* Base experience line items */}
                {baseItems.length === 0 ? (
                  <div className="flex justify-between text-sm">
                    <span className="font-body text-white/55">Bowling</span>
                    <span className="font-body text-white font-bold">
                      {kind === "kbf" ? "Free (KBF)" : "—"}
                    </span>
                  </div>
                ) : (
                  baseItems.map((item, idx) => (
                    <div key={idx} className="flex justify-between text-sm">
                      <span className="font-body text-white/55">{item.label}</span>
                      {quoteLoading ? (
                        <span className="font-body text-white/35 text-xs italic">calculating…</span>
                      ) : (
                        <span className="font-body font-bold" style={{ color: CORAL }}>
                          {centsToDollars(item.priceCents * item.quantity)}
                        </span>
                      )}
                    </div>
                  ))
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

                {/* Tax line */}
                {quoteTotalCents > preTaxTotalCents && !quoteLoading && (
                  <div className="flex justify-between text-xs">
                    <span className="font-body text-white/35">Incl. sales tax</span>
                    <span className="font-body text-white/35">+{centsToDollars(quoteTotalCents - preTaxTotalCents)}</span>
                  </div>
                )}

                {quoteError && (
                  <div className="text-xs font-body" style={{ color: CORAL }}>{quoteError} — amount shown is pre-tax estimate.</div>
                )}

                {preTaxTotalCents > 0 && (
                  <>
                    <div className="h-px bg-white/10" />
                    <div className="flex justify-between">
                      <span className="font-body text-white/55 text-sm">Due today (deposit)</span>
                      {quoteLoading ? (
                        <span className="font-body text-white/35 text-sm italic">calculating…</span>
                      ) : (
                        <span className="font-body text-white font-bold text-base">{centsToDollars(depositCents)}</span>
                      )}
                    </div>
                    {displayTotal > depositCents && !quoteLoading && (
                      <div className="flex justify-between text-xs">
                        <span className="font-body text-white/35">Remaining due at center</span>
                        <span className="font-body text-white/35">{centsToDollars(displayTotal - depositCents)}</span>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const backTo = selectedIncludesShoes ? "offer" : "shoes";
                    // Going back to offer releases the hold — warn first.
                    if (selectedIncludesShoes && holdActive) {
                      setPendingRelease("offer");
                    } else {
                      setStep(backTo);
                    }
                  }}
                  className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 border border-white/15"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => setStep("details")}
                  disabled={quoteLoading}
                  className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white disabled:opacity-50"
                  style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                >
                  {quoteLoading ? "Calculating…" : "Continue"}
                </button>
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════
              STEP: Details
          ═══════════════════════════════════════════════════════ */}
          {step === "details" && (
            <div className="space-y-4">
              <h2 className="font-heading uppercase text-white text-lg tracking-wider text-center">Your Details</h2>
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
              <input
                type="tel"
                placeholder="Phone Number"
                autoComplete="tel"
                value={guestPhone}
                onChange={(e) => setGuestPhone(e.target.value)}
                className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3.5 text-white font-body text-sm placeholder:text-white/25 focus:outline-none focus:border-[#fd5b56]/50"
              />
              <ClickwrapCheckbox
                checked={clickwrapAccepted}
                onChange={setClickwrapAccepted}
                cancellationHours={1}
              />
              <div className="flex gap-2">
                <button type="button" onClick={() => setStep("review")} className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 border border-white/15">Back</button>
                <button
                  type="button"
                  onClick={() => {
                    if (!guestName || !guestEmail || !guestPhone) { setError("Please fill in all contact details"); return; }
                    if (!clickwrapAccepted) { setError("Please accept the cancellation policy"); return; }
                    setError(null);
                    // Rename the hold in Conqueror so staff see the guest name
                    // instead of "Hold (Np)" while the customer is in checkout.
                    if (holdRef.current) {
                      void fetch(`/api/bowling/v2/reserve/hold/${holdRef.current.qamfId}`, {
                        method: "PATCH",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                          centerId: holdRef.current.centerId,
                          title: `${guestName} (${activePlayerCount}p)`,
                        }),
                      }).catch(() => {});
                    }
                    if (depositCents > 0) setStep("payment");
                    else void handleSubmit();
                  }}
                  disabled={busy || !clickwrapAccepted || !guestName || !guestEmail || !guestPhone}
                  className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider disabled:opacity-50"
                  style={{ backgroundColor: GOLD, color: BG }}
                >
                  {depositCents > 0 ? "Continue to payment" : "Confirm reservation"}
                </button>
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════
              STEP: Payment
          ═══════════════════════════════════════════════════════ */}
          {step === "payment" && (
            <BowlingPaymentStep
              depositCents={depositCents}
              totalCents={displayTotal}
              locationId={center.locationKey}
              paymentError={paymentError}
              busy={busy}
              onBack={() => setStep("details")}
              onPay={(token) => void handleSubmit(token)}
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
              Going back will release the lane we&apos;re holding for you. Someone else
              may take it before you return.
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
