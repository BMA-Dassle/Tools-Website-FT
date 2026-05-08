"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import HeadPinzNav from "@/components/headpinz/Nav";
import BowlingPaymentStep from "@/components/bowling/BowlingPaymentStep";
import ClickwrapCheckbox from "@/components/booking/ClickwrapCheckbox";
import { CURRENT_POLICY_VERSION } from "@/lib/clickwrap";
import {
  bookableDateRange,
  isKbfBookableDate,
  isKbfPreLaunchPeriod,
  KBF_PROGRAM_START_YMD,
} from "@/lib/kbf-schedule";
import {
  getBookingLocation,
  setBookingLocation,
  syncLocationFromUrl,
} from "@/lib/booking-location";

/**
 * Kids Bowl Free V2 booking wizard.
 *
 * Parallel deployment — V1 at /hp/book/kids-bowl-free/ stays untouched.
 * This page will replace it after ops sign-off (PR 2 cutover).
 *
 * Key differences from V1:
 *  - Uses QAMF Internal API (/api/bowling/v2/*) instead of legacy proxy
 *  - Single createReservation call at submit (no book-for-later session hold)
 *  - Shoe rental is a paid Square add-on (not QAMF ShoesSocks line item)
 *  - Two Square orders: deposit (closed) + day-of (open for center redemption)
 *  - BMI attraction/food add-on steps stubbed — activated via Neon catalog
 *
 * Wizard steps:
 *  location → lookup → verify → bowlers → slots → shoes →
 *  [attractions (stub)] → [food (stub)] → review → details →
 *  [payment] → submitting
 */

const CORAL = "#fd5b56";
const GOLD = "#FFD700";
const BG = "#0a1628";

/** QAMF web offer IDs for the KBF program. */
const KBF_REGULAR_OFFER_ID = 152; // standard bowling lanes
const KBF_VIP_OFFER_ID     = 153; // NeoVerse / HyperBowling suite

const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";

const KBF_OFFERS = [
  {
    id: KBF_REGULAR_OFFER_ID,
    type: "regular" as const,
    label: "Kids Bowl Free Regular",
    accent: CORAL,
    videoUrl: `${BLOB}/videos/headpinz-bowling.mp4`,
    description: "Two free games per kid per day on participating weekdays. Bring your KBF coupon to the front desk.",
    features: [
      "Standard HeadPinz lanes",
      "Up to 6 bowlers per lane",
      "Glow lighting in the evenings",
      "Bring your KBF coupon to check in",
    ],
  },
  {
    id: KBF_VIP_OFFER_ID,
    type: "vip" as const,
    label: "Kids Bowl Free VIP",
    accent: GOLD,
    videoUrl: `${BLOB}/videos/headpinz-neoverse-v2.mp4`,
    description: "Upgrade your free bowling to the VIP suite — same coupon, premium lanes with NeoVerse + HyperBowling.",
    features: [
      "VIP lounge & dedicated lanes",
      "NeoVerse video walls",
      "Priority check-in",
      "Up to 6 bowlers per lane",
    ],
  },
];

// ── Center metadata ────────────────────────────────────────────────────────

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

/** Reverse lookup: Square center code → center metadata */
const CENTER_BY_CODE: Record<string, (typeof CENTERS)[0]> = Object.fromEntries(
  CENTERS.map((c) => [c.squareCenterCode, c]),
);

// ── Types ──────────────────────────────────────────────────────────────────

type Step =
  | "location"
  | "lookup"
  | "verify"
  | "existing"    // future reservation detected — show it + offer reschedule
  | "reschedule"  // pick a new date/time for an existing reservation
  | "bowlers"
  | "slots"
  | "shoes"
  | "attractions" // stub — skipped when no active products
  | "food"        // stub — skipped when no active products
  | "review"
  | "details"
  | "payment"
  | "submitting";

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
}

interface AvailabilitySlot {
  bookedAt: string;   // ISO datetime
  webOfferId: number;
  webOfferTitle: string;
  webOfferDescription?: string;
  /** QAMF option ID — required on createReservation. For KBF = the 2-game Game option. */
  optionId?: number;
  optionType?: "Game" | "Time" | "Unlimited";
}

interface ShoeProduct {
  id: number;
  label: string;
  squareCatalogObjectId: string;
  priceCents: number;
  depositPct: number;
}

/** Existing KBF reservation returned by /api/bowling/v2/my-reservations */
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
  return dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function ymdFromDate(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

function todayYmd(): string {
  return ymdFromDate(new Date());
}

/** Build an ISO datetime with ET offset from a YMD + time string like "14:00" */
function buildBookedAt(ymd: string, timeSlot: string): string {
  // Use the BookedAt from the availability response directly
  return timeSlot; // already ISO from QAMF
}

// ── Component ──────────────────────────────────────────────────────────────

export default function KidsBowlFreeV2Page() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Center
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

  // Wizard state
  const [step, setStep] = useState<Step>("location");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Lookup + verify
  const [contact, setContact] = useState("");
  const [code, setCode] = useState("");
  const [channel, setChannel] = useState<"email" | "sms" | null>(null);
  const [maskedDest, setMaskedDest] = useState("");
  const [pass, setPass] = useState<PassWithMembers | null>(null);

  // Bowler selection
  const [bowlerSelections, setBowlerSelections] = useState<BowlerSelection[]>([]);

  // Slot selection
  const [selectedDate, setSelectedDate] = useState(() => bookableDateRange()[0] ?? todayYmd());
  const [availableSlots, setAvailableSlots] = useState<AvailabilitySlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlot | null>(null);
  // Offer type selection (Regular vs VIP) — drives which slots are shown
  const [selectedOfferType, setSelectedOfferType] = useState<"regular" | "vip">("regular");

  // Shoe products + selection
  const [shoeProducts, setShoeProducts] = useState<ShoeProduct[]>([]);
  const [shoeQty, setShoeQty] = useState<Record<number, number>>({}); // productId → qty

  // Existing future reservation (detected at verify time)
  const [existingReservation, setExistingReservation] = useState<ExistingReservation | null>(null);
  // Inline cancel-confirm state for the "existing" step
  const [cancelConfirming, setCancelConfirming] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);

  // Square day-of order quote (fetched when entering review step)
  // Gives us the tax-inclusive total before the customer enters their card.
  const [quoteDayofOrderId, setQuoteDayofOrderId] = useState<string | null>(null);
  const [quoteTotalCents, setQuoteTotalCents] = useState<number>(0);
  const [quoteDepositCents, setQuoteDepositCents] = useState<number>(0);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  // Review + payment
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [clickwrapAccepted, setClickwrapAccepted] = useState(false);

  // Square payment
  const [paymentError, setPaymentError] = useState<string | null>(null);

  // ── Computed values ──────────────────────────────────────────────

  const center = CENTER_BY_ID[centerId] ?? CENTERS[0];
  const selectedBowlers = bowlerSelections.filter((b) => b.selected);
  const playerCount = selectedBowlers.length;

  const shoeTotal = Object.entries(shoeQty).reduce((sum, [pidStr, qty]) => {
    const p = shoeProducts.find((sp) => sp.id === Number(pidStr));
    return sum + (p ? p.priceCents * qty : 0);
  }, 0);

  const preTaxDepositCents = Object.entries(shoeQty).reduce((sum, [pidStr, qty]) => {
    const p = shoeProducts.find((sp) => sp.id === Number(pidStr));
    if (!p) return sum;
    return sum + Math.round(p.priceCents * qty * (p.depositPct / 100));
  }, 0);

  // Use Square's tax-inclusive quote once loaded; fall back to pre-tax estimate.
  const depositCents = quoteDepositCents > 0 ? quoteDepositCents : preTaxDepositCents;
  // Tax-inclusive shoe total for display (from quote; falls back to pre-tax)
  const displayShoeTotal = quoteTotalCents > 0 ? quoteTotalCents : shoeTotal;

  const lineItems = shoeProducts
    .filter((p) => (shoeQty[p.id] ?? 0) > 0)
    .map((p) => ({ squareProductId: p.id, quantity: shoeQty[p.id] }));

  // ── Step: Location ───────────────────────────────────────────────

  function handleSelectCenter(id: string) {
    setCenterId(id);
    const loc = CENTER_BY_ID[id];
    if (loc) setBookingLocation(loc.locationKey);
  }

  // ── Step: Lookup ─────────────────────────────────────────────────

  async function handleLookup() {
    if (!contact.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/kbf/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contact: contact.trim(), centerId }),
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

      // Auto-build bowler selections from members
      const selections: BowlerSelection[] = (p.members ?? []).map((m) => ({
        key: `${m.relation}:${m.passId}:${m.slot}`,
        displayName: `${m.firstName} ${m.lastName}`,
        relation: m.relation,
        selected: true, // default to all selected
        wantBumpers: m.prefs?.wantBumpers ?? true,
      }));
      // Add parent
      selections.unshift({
        key: "parent",
        displayName: `${p.firstName} ${p.lastName}`,
        relation: "parent",
        selected: false, // parent not selected by default
        wantBumpers: false,
      });
      setBowlerSelections(selections);
      setGuestName(`${p.firstName} ${p.lastName}`);
      setGuestEmail(p.email);
      setGuestPhone(p.phone ?? "");

      // Check whether this guest already has a future KBF reservation.
      // Non-fatal: if the check fails we proceed to the bowlers step normally.
      try {
        const checkRes = await fetch(
          `/api/bowling/v2/my-reservations?email=${encodeURIComponent(p.email)}`,
        );
        if (checkRes.ok) {
          const checkData = (await checkRes.json()) as { reservation: ExistingReservation | null };
          if (checkData.reservation) {
            setExistingReservation(checkData.reservation);
            // Snap the wizard's center to match the existing booking's center
            const existingCenter = CENTER_BY_CODE[checkData.reservation.centerCode];
            if (existingCenter) setCenterId(existingCenter.id);
            setStep("existing");
            return;
          }
        }
      } catch {
        // Non-fatal — network/DB error; proceed to bowlers step as normal
      }

      setStep("bowlers");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  // ── Step: Slots ──────────────────────────────────────────────────

  const fetchSlots = useCallback(
    async (date: string, forPlayerCount?: number) => {
      const count = forPlayerCount ?? playerCount;
      setSlotsLoading(true);
      setSlotsError(null);
      setAvailableSlots([]);
      setSelectedSlot(null);
      try {
        type RawSlot = {
          BookedAt: string;
          WebOffer: {
            Id: number;
            Title: string;
            Description?: string;
            Options?: {
              Game?: { Id: number; GamesPerPlayer?: number }[];
              Time?: { Id: number; Minutes?: number }[];
              Unlimited?: { Id: number }[];
            };
          };
        };

        const parseRaw = (raw: RawSlot[]): AvailabilitySlot[] =>
          raw.map((a) => {
            const gameOpts = a.WebOffer.Options?.Game ?? [];
            // Prefer the 2-games-per-player option; fall back to first
            const twoGame = gameOpts.find((g) => g.GamesPerPlayer === 2) ?? gameOpts[0];
            return {
              bookedAt: a.BookedAt,
              webOfferId: a.WebOffer.Id,
              webOfferTitle: a.WebOffer.Title,
              webOfferDescription: a.WebOffer.Description,
              optionId: twoGame ? Number(twoGame.Id) : undefined,
              optionType: "Game" as const,
            };
          });

        // Fetch Regular and VIP in parallel
        const base = `/api/bowling/v2/availability?centerId=${center.qamfId}&players=${Math.max(count, 1)}&startDate=${date}`;
        const [regRes, vipRes] = await Promise.all([
          fetch(`${base}&webOfferId=${KBF_REGULAR_OFFER_ID}`),
          fetch(`${base}&webOfferId=${KBF_VIP_OFFER_ID}`),
        ]);

        const [regData, vipData] = await Promise.all([
          regRes.json() as Promise<{ Availabilities?: RawSlot[]; error?: string }>,
          vipRes.json() as Promise<{ Availabilities?: RawSlot[]; error?: string }>,
        ]);

        // Merge — keep all slots; UI filters by selectedOfferType
        const regSlots = parseRaw(
          (regData.Availabilities ?? []).filter((a) => a.WebOffer.Id === KBF_REGULAR_OFFER_ID),
        );
        const vipSlots = parseRaw(
          (vipData.Availabilities ?? []).filter((a) => a.WebOffer.Id === KBF_VIP_OFFER_ID),
        );

        const merged = [...regSlots, ...vipSlots];
        setAvailableSlots(merged);

        if (regSlots.length === 0 && vipSlots.length === 0) {
          setSlotsError("No slots available for this date. Try another date.");
        }
      } catch (err) {
        setSlotsError(err instanceof Error ? err.message : "Failed to load slots");
      } finally {
        setSlotsLoading(false);
      }
    },
    [center.qamfId, playerCount],
  );

  // Auto-fetch when entering the slots or reschedule step
  useEffect(() => {
    if (step === "slots") {
      void fetchSlots(selectedDate);
    } else if (step === "reschedule") {
      // Use the existing reservation's player count (selectedBowlers isn't populated)
      void fetchSlots(selectedDate, existingReservation?.playerCount ?? 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // KBF rule: adults (parent / family-pass) need a kid on the lane.
  // Auto-deselect any adults the moment the last kid is unchecked.
  useEffect(() => {
    const anyKid = bowlerSelections.some((b) => b.relation === "kid" && b.selected);
    if (anyKid) return;
    const hasSelectedAdult = bowlerSelections.some((b) => b.relation !== "kid" && b.selected);
    if (!hasSelectedAdult) return;
    setBowlerSelections((prev) =>
      prev.map((b) => (b.relation !== "kid" && b.selected ? { ...b, selected: false } : b)),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bowlerSelections.map((b) => `${b.key}:${b.selected}`).join(",")]);

  // ── Step: Shoes ──────────────────────────────────────────────────

  useEffect(() => {
    if (step !== "shoes") return;
    (async () => {
      try {
        const res = await fetch(
          `/api/bowling/v2/square-products?centerCode=${center.squareCenterCode}&kind=addon_shoe`,
        );
        const data = await res.json();
        if (!res.ok) return;
        setShoeProducts(data as ShoeProduct[]);
        // Default: offer shoes for all selected bowlers
        if ((data as ShoeProduct[]).length > 0) {
          const first = (data as ShoeProduct[])[0];
          setShoeQty({ [first.id]: playerCount });
        }
      } catch {
        // Non-fatal — no shoes available
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ── Fetch Square day-of order quote when entering the review step ─
  // Clears any stale quote when re-entering the shoes step (user went back).
  useEffect(() => {
    if (step === "shoes") {
      // Clear stale quote so review re-fetches if user changes qty then returns
      setQuoteDayofOrderId(null);
      setQuoteTotalCents(0);
      setQuoteDepositCents(0);
      setQuoteError(null);
      return;
    }
    if (step !== "review") return;
    if (lineItems.length === 0) return; // $0 booking — no Square order needed

    setQuoteLoading(true);
    setQuoteError(null);

    const sqLineItems = shoeProducts
      .filter((p) => (shoeQty[p.id] ?? 0) > 0)
      .map((p) => ({
        name: p.label,
        quantity: String(shoeQty[p.id]),
        catalogObjectId: p.squareCatalogObjectId,
      }));

    void (async () => {
      try {
        const res = await fetch("/api/square/bowling-orders/quote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            locationId: center.squareCenterCode,
            lineItems: sqLineItems,
            depositPct: 100,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to get price");
        setQuoteDayofOrderId(data.dayofOrderId as string);
        setQuoteTotalCents(data.dayofTotalCents as number);
        setQuoteDepositCents(data.depositCents as number);
      } catch (err) {
        setQuoteError(err instanceof Error ? err.message : "Failed to load price");
      } finally {
        setQuoteLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ── Submit ────────────────────────────────────────────────────────
  //
  // Called in two ways:
  //   handleSubmit()         — $0 flow (no payment step, no token needed)
  //   handleSubmit(token)    — paid flow: BowlingPaymentStep tokenizes
  //                           internally, then calls onPay(token) which
  //                           invokes this with the nonce already in hand.
  //
  // Tokenization is NEVER done here. BowlingPaymentStep owns the card
  // widget and tokenizes before calling this, matching the pattern used
  // by PaymentForm in the karting flow.

  const handleSubmit = useCallback(async (squareToken?: string) => {
    if (!selectedSlot) return;
    setBusy(true);
    setPaymentError(null);
    setStep("submitting");

    try {
      // Fire clickwrap record (non-fatal)
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

      const res = await fetch("/api/bowling/v2/reserve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          centerId: center.qamfId,
          webOfferId: selectedSlot.webOfferId,
          optionId: selectedSlot.optionId,
          optionType: selectedSlot.optionType,
          bookedAt: selectedSlot.bookedAt,
          service: "BookForLater",
          players: selectedBowlers.map((b) => ({ name: b.displayName })),
          guest: { name: guestName, email: guestEmail, phone: guestPhone },
          lineItems,
          squareToken,
          locationId: center.squareCenterCode,
          notes: `${pass?.fpass ? "Families Bowl Free" : "Kids Bowl Free"} - ${selectedBowlers.map((b) => b.displayName).join(" - ")}. Coupons verified online.`,
          // Pass pre-created day-of order + exact deposit amount from the quote.
          // This prevents bowling-orders from recalculating the deposit and
          // guarantees the charged amount = the amount shown on the payment step.
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
        // Surface the Square error code/detail when available so ops can diagnose
        const detail = data.code ? ` (${data.code}${data.detail ? `: ${data.detail}` : ""})` : "";
        throw new Error((data.error ?? "Reservation failed") + detail);
      }

      // Navigate to confirmation
      const params = new URLSearchParams({
        neonId: String(data.neonId),
        qamfId: data.qamfReservationId ?? "",
        centerId: center.id,
        depositPaid: String(data.depositPaidCents ?? 0),
        remaining: String(data.remainingCents ?? 0),
      });
      router.push(`/hp/book/kids-bowl-free-v2/confirmation?${params.toString()}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Reservation failed";
      if (depositCents > 0) {
        // Payment errors go to the inline payment-step banner only — not the global
        // header banner — so the message appears right next to the card form.
        setPaymentError(msg);
      } else {
        setError(msg);
      }
      setStep(depositCents > 0 ? "payment" : "details");
    } finally {
      setBusy(false);
    }
  }, [
    selectedSlot,
    depositCents,
    center,
    selectedBowlers,
    guestName,
    guestEmail,
    guestPhone,
    lineItems,
    pass,
    router,
    quoteDayofOrderId,
    quoteTotalCents,
  ]);

  // ── Cancel existing reservation ─────────────────────────────────

  const handleCancelReservation = useCallback(async () => {
    if (!existingReservation) return;
    setCancelBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/bowling/v2/reservations/${existingReservation.id}`,
        { method: "DELETE" },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Cancel failed");
      // Clear the existing reservation — user can now make a fresh booking
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

  // ── Reschedule existing reservation ─────────────────────────────

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
      router.push(`/hp/book/kids-bowl-free-v2/confirmation?${params.toString()}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Reschedule failed";
      setError(msg);
      setStep("reschedule");
    } finally {
      setBusy(false);
    }
  }, [existingReservation, selectedSlot, center.id, router]);

  // ── Pre-launch gate ──────────────────────────────────────────────

  const preLaunch = isKbfPreLaunchPeriod() && searchParams.get("preview") !== "1";
  if (preLaunch) {
    return (
      <>
        <HeadPinzNav />
        <main className="min-h-screen flex items-center justify-center px-4" style={{ backgroundColor: BG }}>
          <div className="text-center max-w-sm">
            <h1 className="font-heading uppercase text-white text-2xl mb-3">Coming Soon</h1>
            <p className="font-body text-white/50 text-sm">
              Kids Bowl Free online booking opens {KBF_PROGRAM_START_YMD}.
            </p>
          </div>
        </main>
      </>
    );
  }

  // ── Date range helpers ───────────────────────────────────────────

  const bookableDates = bookableDateRange();
  const minDate = bookableDates[0] ?? "";
  const maxDate = bookableDates[bookableDates.length - 1] ?? "";

  // ── Render ───────────────────────────────────────────────────────

  return (
    <>
      <HeadPinzNav />
      <main
        className="min-h-screen pt-28 sm:pt-32 pb-16 px-4"
        style={{ backgroundColor: BG }}
      >
        {/* Container widens on steps that have rich two-column layouts (slots, reschedule) */}
        <div className={`mx-auto ${step === "slots" || step === "reschedule" ? "max-w-4xl" : "max-w-md"}`}>
          {/* Header */}
          {step !== "submitting" && (
            <div className="text-center mb-8">
              <div
                className="inline-block uppercase font-bold mb-2"
                style={{ color: CORAL, fontSize: "11px", letterSpacing: "2.5px" }}
              >
                Kids Bowl Free
              </div>
              <h1
                className="font-heading font-black uppercase italic text-white"
                style={{ fontSize: "clamp(26px, 6vw, 36px)", lineHeight: 1.1 }}
              >
                Reserve Your Lanes
              </h1>
              {step === "location" && (
                <p className="font-body text-white/45 text-sm mt-2">{center.name}</p>
              )}
            </div>
          )}

          {/* Error banner */}
          {error && step !== "submitting" && (
            <div
              className="mb-4 rounded-xl p-3 text-sm font-body"
              style={{
                backgroundColor: "rgba(253,91,86,0.12)",
                border: "1.5px solid rgba(253,91,86,0.35)",
                color: "#fd5b56",
              }}
            >
              {error}
            </div>
          )}

          {/* ── STEP: Location ──────────────────────────────────────── */}
          {step === "location" && (
            <div className="space-y-3">
              <p className="font-body text-white/55 text-sm text-center mb-4">
                Choose your HeadPinz location
              </p>
              {CENTERS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => handleSelectCenter(c.id)}
                  className="w-full rounded-2xl p-5 text-left transition-all"
                  style={{
                    backgroundColor:
                      centerId === c.id ? "rgba(253,91,86,0.12)" : "rgba(255,255,255,0.04)",
                    border: `1.78px dashed ${
                      centerId === c.id ? `${CORAL}55` : "rgba(255,255,255,0.12)"
                    }`,
                  }}
                >
                  <div className="font-body font-bold text-white text-base">{c.name}</div>
                  <div className="font-body text-white/40 text-xs mt-0.5">{c.address}</div>
                </button>
              ))}
              <button
                type="button"
                onClick={() => setStep("lookup")}
                className="w-full rounded-full px-6 py-3.5 font-body font-bold text-sm uppercase tracking-wider text-white mt-2"
                style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
              >
                Continue
              </button>
            </div>
          )}

          {/* ── STEP: Lookup ────────────────────────────────────────── */}
          {step === "lookup" && (
            <div className="space-y-4">
              <p className="font-body text-white/55 text-sm text-center">
                Enter your Kids Bowl Free email or phone to sign in
              </p>
              <input
                type="text"
                placeholder="Email or phone"
                autoComplete="email"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleLookup()}
                className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3.5 text-white font-body text-sm placeholder:text-white/25 focus:outline-none focus:border-[#fd5b56]/50"
              />
              <button
                type="button"
                onClick={() => void handleLookup()}
                disabled={busy || !contact.trim()}
                className="w-full rounded-full px-6 py-3.5 font-body font-bold text-sm uppercase tracking-wider text-white disabled:opacity-50"
                style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
              >
                {busy ? "Looking up…" : "Continue"}
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

          {/* ── STEP: Verify ────────────────────────────────────────── */}
          {step === "verify" && (
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
                onClick={() => { setCode(""); setStep("lookup"); }}
                className="w-full font-body text-white/35 text-sm"
              >
                ← Back
              </button>
            </div>
          )}

          {/* ── STEP: Existing reservation ──────────────────────────── */}
          {step === "existing" && existingReservation && (() => {
            const ex = existingReservation;
            const exCenter = CENTER_BY_CODE[ex.centerCode] ?? center;
            const hasPaid = ex.depositCents > 0;
            const remaining = ex.totalCents - ex.depositCents;
            return (
              <div className="space-y-4">
                {/* You already have a booking */}
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
                      <span className="font-body text-white font-semibold">{ex.playerCount ?? "—"}</span>
                    </div>

                    {ex.lines.length > 0 && (
                      <>
                        <div className="h-px bg-white/10 my-1" />
                        {ex.lines.map((line, i) => (
                          <div key={i} className="flex justify-between text-sm">
                            <span className="font-body text-white/50">
                              {line.label}{line.quantity > 1 ? ` ×${line.quantity}` : ""}
                            </span>
                            <span className="font-body text-white">
                              {line.unitPriceCents === 0
                                ? "Free"
                                : `$${((line.unitPriceCents * line.quantity) / 100).toFixed(2)}`}
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
                            ${(ex.depositCents / 100).toFixed(2)}
                          </span>
                        </div>
                        {remaining > 0 && (
                          <div className="flex justify-between text-sm">
                            <span className="font-body text-white/50">Due at center</span>
                            <span className="font-body text-white">${(remaining / 100).toFixed(2)}</span>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                <p className="font-body text-white/45 text-xs text-center leading-relaxed">
                  Kids Bowl Free allows one active reservation at a time.
                  Change the date &amp; time, or cancel to start a new booking.
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

                {/* Cancel — inline confirm flow */}
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
                          A deposit of ${(ex.depositCents / 100).toFixed(2)} was paid.
                          Refunds are processed by the center — call to confirm.
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
                  onClick={() => { setCancelConfirming(false); setStep("verify"); }}
                  className="w-full font-body text-white/35 text-sm"
                >
                  ← Back
                </button>
              </div>
            );
          })()}

          {/* ── STEP: Reschedule ─────────────────────────────────────── */}
          {step === "reschedule" && existingReservation && (() => {
            const ex = existingReservation;
            const exCenter = CENTER_BY_CODE[ex.centerCode] ?? center;
            return (
              <div className="space-y-4">
                <div className="md:grid md:grid-cols-[260px_1fr] md:gap-6 md:items-start">

                  {/* ── Left panel ── */}
                  <div className="space-y-4">
                    {/* Mini existing booking header */}
                    <div
                      className="rounded-xl px-4 py-3"
                      style={{
                        backgroundColor: "rgba(255,255,255,0.04)",
                        border: "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      <div
                        className="uppercase font-bold mb-1"
                        style={{ color: "rgba(255,255,255,0.35)", fontSize: "10px", letterSpacing: "2px" }}
                      >
                        Rescheduling · {exCenter.name}
                      </div>
                      <div className="font-body text-white/55 text-xs line-through">
                        {formatDate(ex.bookedAt.slice(0, 10))} · {formatTime(ex.bookedAt)}
                      </div>
                    </div>

                    {/* Date picker */}
                    <div>
                      <label htmlFor="reschedule-date-picker" className="font-body text-white/55 text-xs uppercase tracking-wider block mb-2">
                        Pick a new date
                      </label>
                      <input
                        id="reschedule-date-picker"
                        type="date"
                        min={bookableDates[0] ?? ""}
                        max={bookableDates[bookableDates.length - 1] ?? ""}
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

                    {/* Selected time summary — desktop */}
                    {selectedSlot && (
                      <div
                        className="hidden md:block rounded-xl px-4 py-3"
                        style={{
                          backgroundColor: "rgba(253,91,86,0.08)",
                          border: `1px solid ${CORAL}40`,
                        }}
                      >
                        <div className="font-body text-white/45 text-[10px] uppercase tracking-wider mb-1">New time</div>
                        <div className="font-body text-white font-bold text-sm">{formatTime(selectedSlot.bookedAt)}</div>
                        <div className="font-body text-white/50 text-xs mt-0.5">
                          {selectedOfferType === "vip" ? "VIP Suite" : "Regular Lanes"}
                        </div>
                      </div>
                    )}

                    {/* CTA — desktop */}
                    <div className="hidden md:flex md:flex-col md:gap-2">
                      <button
                        type="button"
                        onClick={() => void handleReschedule()}
                        disabled={!selectedSlot || slotsLoading || busy}
                        className="w-full rounded-full px-6 py-3.5 font-body font-bold text-sm uppercase tracking-wider text-white disabled:opacity-50"
                        style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                      >
                        {busy ? "Rescheduling…" : selectedSlot ? `Confirm — ${formatTime(selectedSlot.bookedAt)}` : "Select a time"}
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

                  {/* ── Right panel: offer cards ── */}
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
                          color: "#fd5b56",
                        }}
                      >
                        {slotsError}
                      </div>
                    )}

                    {!slotsLoading && (
                      <div className="space-y-3 md:grid md:grid-cols-2 md:gap-4 md:space-y-0">
                        {KBF_OFFERS.map((offer) => {
                          const offerSlots = availableSlots.filter((s) => s.webOfferId === offer.id);
                          const isSelected = selectedOfferType === offer.type;
                          const accent = offer.accent;
                          const hasSlotsAvailable = offerSlots.length > 0;

                          return (
                            <div
                              key={offer.id}
                              className={`w-full rounded-xl overflow-hidden transition-all flex flex-col ${!hasSlotsAvailable && availableSlots.length > 0 ? "opacity-50" : ""}`}
                              style={{
                                backgroundColor: "rgba(7,16,39,0.5)",
                                border: `1.78px dashed ${
                                  !hasSlotsAvailable && availableSlots.length > 0
                                    ? `${accent}30`
                                    : isSelected
                                    ? `${accent}AA`
                                    : `${accent}35`
                                }`,
                                boxShadow: isSelected ? `0 0 24px ${accent}20` : undefined,
                              }}
                            >
                              <button
                                type="button"
                                className="w-full text-left p-4"
                                onClick={() => {
                                  if (!hasSlotsAvailable && availableSlots.length > 0) return;
                                  setSelectedOfferType(offer.type);
                                  if (selectedSlot && selectedSlot.webOfferId !== offer.id) {
                                    setSelectedSlot(null);
                                  }
                                }}
                              >
                                <div className="flex items-center gap-2 mb-1">
                                  <h3
                                    className="font-heading uppercase text-white text-sm tracking-wider"
                                    style={{ textShadow: `0 0 15px ${accent}25` }}
                                  >
                                    {offer.label}
                                  </h3>
                                  {hasSlotsAvailable && (
                                    <span
                                      className="font-body text-xs uppercase tracking-wider px-2 py-0.5 rounded-full font-bold"
                                      style={{
                                        backgroundColor: "rgba(34,197,94,0.18)",
                                        color: "#4ade80",
                                        border: "1px solid rgba(74,222,128,0.4)",
                                      }}
                                    >
                                      Free
                                    </span>
                                  )}
                                  {!hasSlotsAvailable && availableSlots.length > 0 && (
                                    <span
                                      className="font-body text-xs uppercase tracking-wider px-2 py-0.5 rounded-full font-bold"
                                      style={{
                                        backgroundColor: "rgba(253,91,86,0.2)",
                                        color: CORAL,
                                        border: `1px solid ${CORAL}40`,
                                      }}
                                    >
                                      Sold out
                                    </span>
                                  )}
                                </div>
                                <p className="font-body text-white/45 text-xs">{offer.description}</p>
                              </button>

                              {hasSlotsAvailable && (
                                <div
                                  className={isSelected ? "block" : "hidden md:block"}
                                  style={{ borderTop: `1px solid ${accent}20` }}
                                >
                                  <div className="px-4 pb-4 pt-3">
                                    <p className="font-body text-white/40 text-xs uppercase tracking-wider mb-2">
                                      {formatDate(selectedDate)}
                                    </p>
                                    <div className="flex flex-wrap gap-1.5">
                                      {offerSlots.map((s) => {
                                        const on = selectedSlot?.bookedAt === s.bookedAt && selectedSlot?.webOfferId === s.webOfferId;
                                        return (
                                          <button
                                            key={s.bookedAt}
                                            type="button"
                                            onClick={() => {
                                              setSelectedOfferType(offer.type);
                                              setSelectedSlot(s);
                                            }}
                                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold font-body transition-all"
                                            style={{
                                              backgroundColor: on ? accent : "rgba(255,255,255,0.08)",
                                              color: on ? (offer.type === "vip" ? BG : "white") : "rgba(255,255,255,0.7)",
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

                              {!isSelected && hasSlotsAvailable && (
                                <div className="md:hidden px-4 pb-3 pt-1" style={{ borderTop: `1px solid ${accent}15` }}>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedOfferType(offer.type);
                                      if (selectedSlot && selectedSlot.webOfferId !== offer.id) {
                                        setSelectedSlot(null);
                                      }
                                    }}
                                    className="font-body text-xs font-bold uppercase tracking-wider"
                                    style={{ color: accent }}
                                  >
                                    Select {offer.type === "vip" ? "VIP" : "Regular"} →
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* CTA — mobile only */}
                <div className="md:hidden space-y-2">
                  <button
                    type="button"
                    onClick={() => void handleReschedule()}
                    disabled={!selectedSlot || slotsLoading || busy}
                    className="w-full rounded-full px-6 py-3.5 font-body font-bold text-sm uppercase tracking-wider text-white disabled:opacity-50"
                    style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                  >
                    {busy ? "Rescheduling…" : selectedSlot ? `Confirm — ${formatTime(selectedSlot.bookedAt)}` : "Select a time"}
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

          {/* ── STEP: Bowlers ───────────────────────────────────────── */}
          {step === "bowlers" && (() => {
            const KBF_BLUE = "#4fa3e0";
            const hasFamilyPass = pass?.fpass ?? false;
            const anyKidSelected = bowlerSelections.some(
              (b) => b.relation === "kid" && b.selected,
            );
            const bowlerCount = selectedBowlers.length;

            const relationLabel = (rel: BowlerSelection["relation"]) => {
              if (rel === "parent") return hasFamilyPass ? "Family Pass Adult" : "Account holder";
              if (rel === "kid") return "Kids Bowl Free";
              return "Family Pass Adult";
            };

            return (
              <div className="space-y-3">
                {/* Program banner */}
                <div
                  className="rounded-2xl px-4 py-3 flex items-center gap-3"
                  style={{
                    backgroundColor: `${KBF_BLUE}14`,
                    border: `1.78px solid ${KBF_BLUE}55`,
                  }}
                >
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center font-heading font-black shrink-0"
                    style={{ backgroundColor: `${KBF_BLUE}26`, color: KBF_BLUE }}
                  >
                    ★
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      className="font-heading uppercase tracking-[3px] text-[10px] mb-0.5"
                      style={{ color: KBF_BLUE }}
                    >
                      {hasFamilyPass ? "Families Bowl Free" : "Kids Bowl Free"}
                    </div>
                    <div className="text-white/85 text-sm font-semibold truncate">
                      {pass ? `${pass.firstName} ${pass.lastName}` : ""}
                    </div>
                  </div>
                </div>

                <p className="font-body text-white/65 text-sm leading-relaxed">
                  Check who&apos;s bowling today. At least one registered kid is required.
                </p>
                {!hasFamilyPass && (
                  <p className="font-body text-white/45 text-xs leading-relaxed">
                    Kids Bowl Free covers your registered kids.{" "}
                    <a
                      href="https://www.kidsbowlfree.com/family.php"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-white"
                    >
                      Add Families Bowl Free
                    </a>{" "}
                    to put yourself on a lane too.
                  </p>
                )}

                {bowlerSelections.map((b, i) => {
                  const isAdult = b.relation !== "kid";
                  const adultLocked = isAdult && !anyKidSelected;
                  const accent = isAdult ? KBF_BLUE : CORAL;
                  return (
                    <button
                      key={b.key}
                      type="button"
                      disabled={adultLocked}
                      title={adultLocked ? "Add a kid first — adults need a registered kid bowling with them." : undefined}
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
                      {/* Avatar */}
                      <div
                        className="w-10 h-10 rounded-full flex items-center justify-center font-heading font-black text-sm shrink-0"
                        style={{
                          backgroundColor: `${accent}22`,
                          color: accent,
                          border: `1.78px solid ${accent}55`,
                        }}
                      >
                        {b.displayName.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="text-white font-semibold text-sm truncate">{b.displayName}</div>
                        <span
                          className="inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full mt-0.5"
                          style={{ backgroundColor: `${accent}22`, color: accent }}
                        >
                          {relationLabel(b.relation)}
                        </span>
                      </div>

                      {/* State pill */}
                      <div
                        className="text-[10px] uppercase tracking-[2px] font-bold px-3 py-1.5 rounded-full shrink-0"
                        style={{
                          backgroundColor: b.selected ? `${accent}26` : "rgba(255,255,255,0.06)",
                          color: b.selected ? accent : "rgba(255,255,255,0.45)",
                          border: b.selected ? `1px solid ${accent}80` : "1px solid rgba(255,255,255,0.10)",
                        }}
                      >
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

          {/* ── STEP: Slots ─────────────────────────────────────────── */}
          {step === "slots" && (
            <div className="space-y-4">
              {/*
                Desktop layout: two-column grid — date/controls left, offer cards right.
                Mobile: single column, stacked.
              */}
              <div className="md:grid md:grid-cols-[260px_1fr] md:gap-6 md:items-start">

                {/* ── Left panel: date picker + CTA (desktop) ── */}
                <div className="space-y-4">
                  <div>
                    <label htmlFor="kbf-date-picker" className="font-body text-white/55 text-xs uppercase tracking-wider block mb-2">
                      Select a date
                    </label>
                    <input
                      id="kbf-date-picker"
                      type="date"
                      min={minDate}
                      max={maxDate}
                      value={selectedDate}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (!isKbfBookableDate(v)) return;
                        setSelectedDate(v);
                        void fetchSlots(v);
                      }}
                      className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white font-body text-sm focus:outline-none focus:border-[#fd5b56]/50"
                    />
                  </div>

                  {/* Selected time summary — desktop sidebar */}
                  {selectedSlot && (
                    <div
                      className="hidden md:block rounded-xl px-4 py-3"
                      style={{
                        backgroundColor: "rgba(253,91,86,0.08)",
                        border: `1px solid ${CORAL}40`,
                      }}
                    >
                      <div className="font-body text-white/45 text-[10px] uppercase tracking-wider mb-1">Selected</div>
                      <div className="font-body text-white font-bold text-sm">{formatTime(selectedSlot.bookedAt)}</div>
                      <div className="font-body text-white/50 text-xs mt-0.5">
                        {selectedOfferType === "vip" ? "VIP Suite" : "Regular Lanes"}
                      </div>
                    </div>
                  )}

                  {/* CTA buttons — desktop sidebar */}
                  <div className="hidden md:flex md:flex-col md:gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (!selectedSlot) { setError("Please select a time slot"); return; }
                        setError(null);
                        setStep("shoes");
                      }}
                      disabled={!selectedSlot || slotsLoading}
                      className="w-full rounded-full px-6 py-3.5 font-body font-bold text-sm uppercase tracking-wider text-white disabled:opacity-50"
                      style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                    >
                      {selectedSlot ? `Continue — ${formatTime(selectedSlot.bookedAt)}` : "Select a time"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setStep("bowlers")}
                      className="w-full font-body text-white/35 text-sm py-1"
                    >
                      ← Back
                    </button>
                  </div>
                </div>

                {/* ── Right panel: offer cards ── */}
                <div className="space-y-3 mt-4 md:mt-0">
                  {slotsLoading && (
                    <div className="flex items-center gap-2 font-body text-white/40 text-sm py-8 justify-center">
                      <div className="w-4 h-4 border border-white/20 border-t-[#fd5b56] rounded-full animate-spin" />
                      Loading available times…
                    </div>
                  )}

                  {slotsError && !slotsLoading && availableSlots.length === 0 && (
                    <div
                      className="rounded-xl p-3 text-sm font-body"
                      style={{
                        backgroundColor: "rgba(253,91,86,0.08)",
                        border: "1.5px solid rgba(253,91,86,0.25)",
                        color: "#fd5b56",
                      }}
                    >
                      {slotsError}
                    </div>
                  )}

                  {/* Regular / VIP cards — side-by-side on desktop */}
                  {!slotsLoading && (
                    <div className="space-y-3 md:grid md:grid-cols-2 md:gap-4 md:space-y-0">
                      {KBF_OFFERS.map((offer) => {
                        const offerSlots = availableSlots.filter((s) => s.webOfferId === offer.id);
                        const isSelected = selectedOfferType === offer.type;
                        const accent = offer.accent;
                        const hasSlotsAvailable = offerSlots.length > 0;

                        return (
                          <div
                            key={offer.id}
                            className={`w-full rounded-xl overflow-hidden transition-all flex flex-col ${!hasSlotsAvailable && availableSlots.length > 0 ? "opacity-50" : ""}`}
                            style={{
                              backgroundColor: "rgba(7,16,39,0.5)",
                              border: `1.78px dashed ${
                                !hasSlotsAvailable && availableSlots.length > 0
                                  ? `${accent}30`
                                  : isSelected
                                  ? `${accent}AA`
                                  : `${accent}35`
                              }`,
                              boxShadow: isSelected ? `0 0 24px ${accent}20` : undefined,
                            }}
                          >
                            {/* Card header — video + info */}
                            <button
                              type="button"
                              className="w-full text-left"
                              onClick={() => {
                                if (!hasSlotsAvailable && availableSlots.length > 0) return;
                                setSelectedOfferType(offer.type);
                                if (selectedSlot && selectedSlot.webOfferId !== offer.id) {
                                  setSelectedSlot(null);
                                }
                              }}
                            >
                              {/* On desktop (side-by-side cards) video stacks on top; on mobile it's sm:flex-row */}
                              <div className="flex flex-col">
                                <div className="relative w-full h-32 overflow-hidden">
                                  <video
                                    autoPlay
                                    muted
                                    loop
                                    playsInline
                                    preload="metadata"
                                    className="absolute inset-0 w-full h-full object-cover"
                                    key={offer.videoUrl}
                                  >
                                    <source src={offer.videoUrl} type="video/mp4" />
                                  </video>
                                  <div className="absolute inset-0 bg-gradient-to-t from-[#071027]/80 to-transparent pointer-events-none" />
                                </div>
                                <div className="p-4">
                                  <div className="flex items-center gap-2 mb-1">
                                    <h3
                                      className="font-heading uppercase text-white text-sm tracking-wider"
                                      style={{ textShadow: `0 0 15px ${accent}25` }}
                                    >
                                      {offer.label}
                                    </h3>
                                    {hasSlotsAvailable && (
                                      <span
                                        className="font-body text-xs uppercase tracking-wider px-2 py-0.5 rounded-full font-bold"
                                        style={{
                                          backgroundColor: "rgba(34,197,94,0.18)",
                                          color: "#4ade80",
                                          border: "1px solid rgba(74,222,128,0.4)",
                                        }}
                                      >
                                        Free
                                      </span>
                                    )}
                                    {!hasSlotsAvailable && availableSlots.length > 0 && (
                                      <span
                                        className="font-body text-xs uppercase tracking-wider px-2 py-0.5 rounded-full font-bold"
                                        style={{
                                          backgroundColor: "rgba(253,91,86,0.2)",
                                          color: CORAL,
                                          border: `1px solid ${CORAL}40`,
                                        }}
                                      >
                                        Sold out
                                      </span>
                                    )}
                                  </div>
                                  <p className="font-body text-white/55 text-xs leading-relaxed mb-2">
                                    {offer.description}
                                  </p>
                                  <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                                    {offer.features.map((f) => (
                                      <span key={f} className="font-body text-white/40 text-xs flex items-center gap-1">
                                        <span style={{ color: accent }}>·</span> {f}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </button>

                            {/* Time pills:
                                Mobile — only shown when this offer is selected (saves space).
                                Desktop — always shown so both grids are visible side-by-side.
                                Clicking any pill also selects this offer type. */}
                            {hasSlotsAvailable && (
                              <div
                                className={isSelected ? "block" : "hidden md:block"}
                                style={{ borderTop: `1px solid ${accent}20` }}
                              >
                                <div className="px-4 pb-4 pt-3">
                                  <p className="font-body text-white/40 text-xs uppercase tracking-wider mb-2">
                                    {formatDate(selectedDate)}
                                  </p>
                                  <div className="flex flex-wrap gap-1.5">
                                    {offerSlots.map((s) => {
                                      const on = selectedSlot?.bookedAt === s.bookedAt && selectedSlot?.webOfferId === s.webOfferId;
                                      return (
                                        <button
                                          key={s.bookedAt}
                                          type="button"
                                          onClick={() => {
                                            setSelectedOfferType(offer.type);
                                            setSelectedSlot(s);
                                          }}
                                          className="px-2.5 py-1.5 rounded-lg text-xs font-bold font-body transition-all"
                                          style={{
                                            backgroundColor: on ? accent : "rgba(255,255,255,0.08)",
                                            color: on ? (offer.type === "vip" ? BG : "white") : "rgba(255,255,255,0.7)",
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

                            {/* "Select X →" prompt — mobile only (desktop shows pills directly) */}
                            {!isSelected && hasSlotsAvailable && (
                              <div className="md:hidden px-4 pb-3 pt-1" style={{ borderTop: `1px solid ${accent}15` }}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedOfferType(offer.type);
                                    if (selectedSlot && selectedSlot.webOfferId !== offer.id) {
                                      setSelectedSlot(null);
                                    }
                                  }}
                                  className="font-body text-xs font-bold uppercase tracking-wider"
                                  style={{ color: accent }}
                                >
                                  Select {offer.type === "vip" ? "VIP" : "Regular"} →
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* CTA buttons — mobile only (desktop renders them in the left sidebar) */}
              <div className="md:hidden space-y-2">
                <button
                  type="button"
                  onClick={() => {
                    if (!selectedSlot) { setError("Please select a time slot"); return; }
                    setError(null);
                    setStep("shoes");
                  }}
                  disabled={!selectedSlot || slotsLoading}
                  className="w-full rounded-full px-6 py-3.5 font-body font-bold text-sm uppercase tracking-wider text-white disabled:opacity-50"
                  style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                >
                  {selectedSlot ? `Continue — ${formatTime(selectedSlot.bookedAt)}` : "Select a time"}
                </button>
                <button
                  type="button"
                  onClick={() => setStep("bowlers")}
                  className="w-full font-body text-white/35 text-sm"
                >
                  ← Back
                </button>
              </div>
            </div>
          )}

          {/* ── STEP: Shoes ──────────────────────────────────────────── */}
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
                        backgroundColor: qty > 0 ? "rgba(253,91,86,0.08)" : "rgba(255,255,255,0.04)",
                        border: `1.78px dashed ${qty > 0 ? `${CORAL}40` : "rgba(255,255,255,0.10)"}`,
                      }}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className="font-body font-bold text-white text-sm">{p.label}</div>
                          <div className="font-body text-white/40 text-xs">
                            ${(p.priceCents / 100).toFixed(2)} / person · 100% deposit at booking
                          </div>
                        </div>
                        <div className="font-body font-bold text-sm" style={{ color: CORAL }}>
                          ${((p.priceCents * qty) / 100).toFixed(2)}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setShoeQty((q) => ({ ...q, [p.id]: Math.max(0, (q[p.id] ?? 0) - 1) }))}
                          className="w-8 h-8 rounded border border-white/20 text-white/60 hover:text-white flex items-center justify-center"
                        >
                          −
                        </button>
                        <span className="w-6 text-center text-white font-bold text-sm">{qty}</span>
                        <button
                          type="button"
                          onClick={() => setShoeQty((q) => ({ ...q, [p.id]: (q[p.id] ?? 0) + 1 }))}
                          className="w-8 h-8 rounded border border-white/20 text-white/60 hover:text-white flex items-center justify-center"
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
                  onClick={() => setStep("slots")}
                  className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 border border-white/15"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setStep("review");
                  }}
                  className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white"
                  style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                >
                  {shoeTotal > 0
                    ? `Continue — $${(shoeTotal / 100).toFixed(2)}`
                    : "Skip shoes"}
                </button>
              </div>
            </div>
          )}

          {/* ── STEP: Attractions (stub) ────────────────────────────── */}
          {step === "attractions" && (
            <div className="space-y-4">
              <p className="font-body text-white/55 text-sm text-center">
                Add attraction experiences
              </p>
              <div
                className="rounded-xl p-6 text-center"
                style={{ border: "1.78px dashed rgba(255,255,255,0.08)" }}
              >
                <p className="font-body text-white/35 text-sm">Coming soon — laser tag, gel blasters, and more.</p>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setStep("shoes")} className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 border border-white/15">Back</button>
                <button type="button" onClick={() => setStep("food")} className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white" style={{ backgroundColor: CORAL }}>Skip</button>
              </div>
            </div>
          )}

          {/* ── STEP: Food (stub) ────────────────────────────────────── */}
          {step === "food" && (
            <div className="space-y-4">
              <p className="font-body text-white/55 text-sm text-center">
                Add food &amp; beverages
              </p>
              <div
                className="rounded-xl p-6 text-center"
                style={{ border: "1.78px dashed rgba(255,255,255,0.08)" }}
              >
                <p className="font-body text-white/35 text-sm">Food packages coming soon.</p>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setStep("attractions")} className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 border border-white/15">Back</button>
                <button type="button" onClick={() => setStep("review")} className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white" style={{ backgroundColor: CORAL }}>Skip</button>
              </div>
            </div>
          )}

          {/* ── STEP: Review ─────────────────────────────────────────── */}
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
                  <span className="font-body text-white font-bold">{formatTime(selectedSlot.bookedAt)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="font-body text-white/55">Package</span>
                  <span className="font-body text-white font-bold">{selectedSlot.webOfferTitle}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="font-body text-white/55">Bowlers</span>
                  <span className="font-body text-white font-bold">{playerCount}</span>
                </div>
                <div className="h-px bg-white/10" />
                <div className="flex justify-between text-sm">
                  <span className="font-body text-white/55">Bowling</span>
                  <span className="font-body text-white font-bold">Free (KBF)</span>
                </div>
                {shoeTotal > 0 && (
                  <>
                    <div className="flex justify-between text-sm">
                      <span className="font-body text-white/55">Shoe rental</span>
                      {quoteLoading ? (
                        <span className="font-body text-white/35 text-xs italic">calculating…</span>
                      ) : (
                        <span className="font-body font-bold" style={{ color: CORAL }}>
                          ${(displayShoeTotal / 100).toFixed(2)}
                        </span>
                      )}
                    </div>
                    {quoteTotalCents > shoeTotal && !quoteLoading && (
                      <div className="flex justify-between text-xs">
                        <span className="font-body text-white/35">Incl. sales tax</span>
                        <span className="font-body text-white/35">
                          +${((quoteTotalCents - shoeTotal) / 100).toFixed(2)}
                        </span>
                      </div>
                    )}
                  </>
                )}
                {quoteError && (
                  <div className="text-xs font-body" style={{ color: CORAL }}>
                    {quoteError} — amount shown is pre-tax estimate.
                  </div>
                )}
                <div className="h-px bg-white/10" />
                <div className="flex justify-between">
                  <span className="font-body text-white/55 text-sm">Due today (deposit)</span>
                  {quoteLoading ? (
                    <span className="font-body text-white/35 text-sm italic">calculating…</span>
                  ) : (
                    <span className="font-body text-white font-bold text-base">
                      ${(depositCents / 100).toFixed(2)}
                    </span>
                  )}
                </div>
                {depositCents < displayShoeTotal && !quoteLoading && (
                  <div className="flex justify-between text-xs">
                    <span className="font-body text-white/35">Remaining due at center</span>
                    <span className="font-body text-white/35">${((displayShoeTotal - depositCents) / 100).toFixed(2)}</span>
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setStep("shoes")} className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 border border-white/15">Back</button>
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

          {/* ── STEP: Details ─────────────────────────────────────────── */}
          {step === "details" && (
            <div className="space-y-4">
              <h2 className="font-heading uppercase text-white text-lg tracking-wider text-center">
                Your Details
              </h2>
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
                    if (!guestName || !guestEmail || !guestPhone) {
                      setError("Please fill in all contact details");
                      return;
                    }
                    if (!clickwrapAccepted) {
                      setError("Please accept the cancellation policy");
                      return;
                    }
                    setError(null);
                    if (depositCents > 0) {
                      setStep("payment");
                    } else {
                      void handleSubmit();
                    }
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

          {/* ── STEP: Payment ────────────────────────────────────────── */}
          {step === "payment" && (
            <BowlingPaymentStep
              depositCents={depositCents}
              totalCents={displayShoeTotal}
              locationId={center.locationKey}
              paymentError={paymentError}
              busy={busy}
              onBack={() => setStep("details")}
              onPay={(token) => void handleSubmit(token)}
            />
          )}

          {/* ── STEP: Submitting ─────────────────────────────────────── */}
          {step === "submitting" && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-10 text-center">
              <div
                className="w-10 h-10 border-2 border-white/15 border-t-[#fd5b56] rounded-full animate-spin mx-auto mb-4"
              />
              <p className="font-body text-white/60 text-sm">Reserving your lane…</p>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
