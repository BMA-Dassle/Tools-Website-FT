"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import HeadPinzNav from "@/components/headpinz/Nav";
import CardCaptureForm, {
  type CardCaptureHandle,
} from "@/components/square/CardCaptureForm";
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

/** QAMF web offer ID for the KBF program. Only slots from this offer are shown. */
const KBF_WEB_OFFER_ID = 152;

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

// ── Types ──────────────────────────────────────────────────────────────────

type Step =
  | "location"
  | "lookup"
  | "verify"
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
}

interface ShoeProduct {
  id: number;
  label: string;
  squareCatalogObjectId: string;
  priceCents: number;
  depositPct: number;
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
  const [selectedDate, setSelectedDate] = useState(todayYmd());
  const [availableSlots, setAvailableSlots] = useState<AvailabilitySlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlot | null>(null);

  // Shoe products + selection
  const [shoeProducts, setShoeProducts] = useState<ShoeProduct[]>([]);
  const [shoeQty, setShoeQty] = useState<Record<number, number>>({}); // productId → qty

  // Review + payment
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [clickwrapAccepted, setClickwrapAccepted] = useState(false);

  // Square payment
  const cardRef = useRef<CardCaptureHandle>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  // ── Computed values ──────────────────────────────────────────────

  const center = CENTER_BY_ID[centerId] ?? CENTERS[0];
  const selectedBowlers = bowlerSelections.filter((b) => b.selected);
  const playerCount = selectedBowlers.length;

  const shoeTotal = Object.entries(shoeQty).reduce((sum, [pidStr, qty]) => {
    const p = shoeProducts.find((sp) => sp.id === Number(pidStr));
    return sum + (p ? p.priceCents * qty : 0);
  }, 0);

  const depositCents = Object.entries(shoeQty).reduce((sum, [pidStr, qty]) => {
    const p = shoeProducts.find((sp) => sp.id === Number(pidStr));
    if (!p) return sum;
    return sum + Math.round(p.priceCents * qty * (p.depositPct / 100));
  }, 0);

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
      setStep("bowlers");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  // ── Step: Slots ──────────────────────────────────────────────────

  const fetchSlots = useCallback(
    async (date: string) => {
      setSlotsLoading(true);
      setSlotsError(null);
      setAvailableSlots([]);
      setSelectedSlot(null);
      try {
        const res = await fetch(
          `/api/bowling/v2/availability?centerId=${center.qamfId}&players=${Math.max(playerCount, 1)}&startDate=${date}&endDate=${date}&service=BookForLater`,
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load slots");

        const slots: AvailabilitySlot[] = (
          data.Availabilities as Array<{
            BookedAt: string;
            WebOffer: { Id: number; Title: string; Description?: string };
          }>
        )
          .filter((a) => a.WebOffer.Id === KBF_WEB_OFFER_ID)
          .map((a) => ({
            bookedAt: a.BookedAt,
            webOfferId: a.WebOffer.Id,
            webOfferTitle: a.WebOffer.Title,
            webOfferDescription: a.WebOffer.Description,
          }));

        setAvailableSlots(slots);
        if (slots.length === 0) {
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

  // Auto-fetch when entering the slots step
  useEffect(() => {
    if (step === "slots") {
      void fetchSlots(selectedDate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

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

  // ── Submit ────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    if (!selectedSlot) return;
    setBusy(true);
    setPaymentError(null);
    setStep("submitting");

    try {
      // Get Square token if payment required
      let squareToken: string | undefined;
      if (depositCents > 0) {
        if (!cardRef.current) throw new Error("Payment form not ready");
        const result = await cardRef.current.tokenize();
        if ("error" in result) throw new Error(result.error);
        squareToken = result.token;
      }

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
          bookedAt: selectedSlot.bookedAt,
          service: "BookForLater",
          players: selectedBowlers.map((b) => ({ name: b.displayName })),
          guest: { name: guestName, email: guestEmail, phone: guestPhone },
          lineItems,
          squareToken,
          locationId: center.locationKey,
          notes: `KBF V2 – ${pass?.id ?? ""}`,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Reservation failed");

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
      setPaymentError(msg);
      setError(msg);
      // Back to payment or details step
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
  ]);

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
        className="min-h-screen pt-20 pb-16 px-4"
        style={{ backgroundColor: BG }}
      >
        <div className="max-w-md mx-auto">
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

          {/* ── STEP: Bowlers ───────────────────────────────────────── */}
          {step === "bowlers" && (
            <div className="space-y-3">
              <p className="font-body text-white/55 text-sm text-center mb-2">
                Select who&apos;s bowling today
              </p>
              {bowlerSelections.map((b, i) => (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => {
                    const updated = [...bowlerSelections];
                    updated[i] = { ...b, selected: !b.selected };
                    setBowlerSelections(updated);
                  }}
                  className="w-full rounded-xl p-4 text-left flex items-center gap-3 transition-all"
                  style={{
                    backgroundColor: b.selected
                      ? "rgba(253,91,86,0.10)"
                      : "rgba(255,255,255,0.04)",
                    border: `1.78px dashed ${b.selected ? `${CORAL}50` : "rgba(255,255,255,0.10)"}`,
                  }}
                >
                  <div
                    className="w-5 h-5 rounded border-2 flex items-center justify-center shrink-0"
                    style={{
                      borderColor: b.selected ? CORAL : "rgba(255,255,255,0.2)",
                      backgroundColor: b.selected ? CORAL : "transparent",
                    }}
                  >
                    {b.selected && (
                      <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  <div>
                    <div className="font-body font-bold text-white text-sm">{b.displayName}</div>
                    <div className="font-body text-white/35 text-xs capitalize">{b.relation}</div>
                  </div>
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  if (selectedBowlers.length === 0) {
                    setError("Select at least one bowler");
                    return;
                  }
                  setError(null);
                  setStep("slots");
                }}
                className="w-full rounded-full px-6 py-3.5 font-body font-bold text-sm uppercase tracking-wider text-white"
                style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
              >
                Continue with {playerCount} bowler{playerCount === 1 ? "" : "s"}
              </button>
              <button
                type="button"
                onClick={() => setStep("verify")}
                className="w-full font-body text-white/35 text-sm"
              >
                ← Back
              </button>
            </div>
          )}

          {/* ── STEP: Slots ─────────────────────────────────────────── */}
          {step === "slots" && (
            <div className="space-y-4">
              <div>
                <label className="font-body text-white/55 text-xs uppercase tracking-wider block mb-2">
                  Select a date
                </label>
                <input
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

              {slotsLoading && (
                <div className="flex items-center gap-2 font-body text-white/40 text-sm py-4 justify-center">
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

              {!slotsLoading && availableSlots.length > 0 && (
                <div className="space-y-2">
                  <p className="font-body text-white/55 text-xs uppercase tracking-wider">
                    Available times — {formatDate(selectedDate)}
                  </p>
                  {/* Group by offer */}
                  {Array.from(new Set(availableSlots.map((s) => s.webOfferId))).map((offerId) => {
                    const offerSlots = availableSlots.filter((s) => s.webOfferId === offerId);
                    const offerTitle = offerSlots[0].webOfferTitle;
                    return (
                      <div key={offerId} className="rounded-xl p-3" style={{ backgroundColor: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                        <div className="font-body text-white/70 text-xs font-bold mb-2 uppercase tracking-wider">
                          {offerTitle}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {offerSlots.map((s) => {
                            const on = selectedSlot?.bookedAt === s.bookedAt && selectedSlot?.webOfferId === s.webOfferId;
                            return (
                              <button
                                key={s.bookedAt}
                                type="button"
                                onClick={() => setSelectedSlot(s)}
                                className="px-4 py-2 rounded-lg text-sm font-bold font-body transition-all"
                                style={{
                                  backgroundColor: on ? CORAL : "rgba(255,255,255,0.08)",
                                  color: on ? "white" : "rgba(255,255,255,0.7)",
                                  border: `1px solid ${on ? CORAL : "rgba(255,255,255,0.12)"}`,
                                  boxShadow: on ? `0 0 12px ${CORAL}40` : "none",
                                }}
                              >
                                {formatTime(s.bookedAt)}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <button
                type="button"
                onClick={() => {
                  if (!selectedSlot) {
                    setError("Please select a time slot");
                    return;
                  }
                  setError(null);
                  setStep("shoes");
                }}
                disabled={!selectedSlot || slotsLoading}
                className="w-full rounded-full px-6 py-3.5 font-body font-bold text-sm uppercase tracking-wider text-white disabled:opacity-50"
                style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
              >
                Continue
              </button>
              <button
                type="button"
                onClick={() => setStep("bowlers")}
                className="w-full font-body text-white/35 text-sm"
              >
                ← Back
              </button>
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
                  <div className="flex justify-between text-sm">
                    <span className="font-body text-white/55">Shoe rental</span>
                    <span className="font-body font-bold" style={{ color: CORAL }}>
                      ${(shoeTotal / 100).toFixed(2)}
                    </span>
                  </div>
                )}
                <div className="h-px bg-white/10" />
                <div className="flex justify-between">
                  <span className="font-body text-white/55 text-sm">Due today (deposit)</span>
                  <span className="font-body text-white font-bold text-base">
                    ${(depositCents / 100).toFixed(2)}
                  </span>
                </div>
                {depositCents < shoeTotal && (
                  <div className="flex justify-between text-xs">
                    <span className="font-body text-white/35">Remaining due at center</span>
                    <span className="font-body text-white/35">${((shoeTotal - depositCents) / 100).toFixed(2)}</span>
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setStep("shoes")} className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 border border-white/15">Back</button>
                <button type="button" onClick={() => setStep("details")} className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white" style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}>Continue</button>
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
            <div className="space-y-5">
              <h2 className="font-heading uppercase text-white text-lg tracking-wider text-center">
                Secure Payment
              </h2>
              <div
                className="rounded-xl p-4 text-sm"
                style={{
                  backgroundColor: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <div className="flex justify-between font-body">
                  <span className="text-white/55">Deposit due now</span>
                  <span className="text-white font-bold">${(depositCents / 100).toFixed(2)}</span>
                </div>
                {shoeTotal - depositCents > 0 && (
                  <div className="flex justify-between font-body mt-1">
                    <span className="text-white/35 text-xs">Remaining at center</span>
                    <span className="text-white/35 text-xs">${((shoeTotal - depositCents) / 100).toFixed(2)}</span>
                  </div>
                )}
              </div>

              <CardCaptureForm
                ref={cardRef}
                locationId={center.locationKey}
              />

              {paymentError && (
                <div
                  className="rounded-xl p-3 text-sm font-body"
                  style={{
                    backgroundColor: "rgba(253,91,86,0.12)",
                    border: "1.5px solid rgba(253,91,86,0.35)",
                    color: "#fd5b56",
                  }}
                >
                  {paymentError}
                </div>
              )}

              <div className="flex gap-2">
                <button type="button" onClick={() => setStep("details")} className="flex-1 rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 border border-white/15">Back</button>
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={busy}
                  className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white disabled:opacity-50"
                  style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
                >
                  {busy ? "Processing…" : `Pay $${(depositCents / 100).toFixed(2)}`}
                </button>
              </div>
              <p className="text-center font-body text-white/20 text-xs">
                Secured by Square. Your card details never touch our servers.
              </p>
            </div>
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
