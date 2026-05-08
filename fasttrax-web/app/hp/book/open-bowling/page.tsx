"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import HeadPinzNav from "@/components/headpinz/Nav";
import BowlingPaymentStep from "@/components/bowling/BowlingPaymentStep";
import ClickwrapCheckbox from "@/components/booking/ClickwrapCheckbox";
import {
  getBookingLocation,
  setBookingLocation,
  syncLocationFromUrl,
} from "@/lib/booking-location";
import type { BowlingSquareProduct } from "@/lib/bowling-db";

/**
 * Open Bowling V2 booking wizard.
 *
 * Parallel deployment — V1 at /hp/book/bowling/ stays untouched.
 * Replaces it after ops sign-off (PR 2 cutover).
 *
 * Key differences from V1:
 *  - Uses QAMF Internal API (/api/bowling/v2/*) — no legacy proxy
 *  - Square two-order pattern: deposit closed at booking, full order
 *    left open for center redemption
 *  - Open bowling always has a deposit (never $0)
 *  - Base bowling price comes from Neon 'open' products (ops-managed),
 *    matched to QAMF web offer by qamfWebOfferId
 *  - Shoes, attractions, food add-ons from Neon catalog
 *
 * Wizard steps:
 *  location → players → date → slots → shoes →
 *  [attractions (stub)] → [food (stub)] → details → review →
 *  payment → submitting
 */

const CORAL = "#fd5b56";
const GOLD = "#FFD700";
const NAVY = "#123075";
const BG = "#0a1628";

// ── Center metadata ────────────────────────────────────────────────

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

type Step =
  | "location"
  | "players"
  | "date"
  | "slots"
  | "shoes"
  | "attractions"
  | "food"
  | "details"
  | "review"
  | "payment"
  | "submitting";

interface AvailabilitySlot {
  bookedAt: string;   // ISO 8601 with offset
  webOfferId: number;
  webOfferTitle: string;
  openType: string;
  optionId?: number;
  optionType?: "Game" | "Time" | "Unlimited";
}

interface LineItem {
  squareProductId: number;
  label: string;
  quantity: number;
  unitPriceCents: number;
  depositCents: number;
}

// ── Helpers ────────────────────────────────────────────────────────

function centsToDollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatSlotTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatSlotDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Component ──────────────────────────────────────────────────────

export default function OpenBowlingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── Location ──────────────────────────────────────────────────────
  const [centerId, setCenterId] = useState<string>(() => {
    syncLocationFromUrl();
    return getBookingLocation() === "naples" ? "3148" : "9172";
  });
  const center = CENTERS.find((c) => c.id === centerId) ?? CENTERS[0];

  // ── Wizard state ─────────────────────────────────────────────────
  const [step, setStep] = useState<Step>("location");
  const [playerCount, setPlayerCount] = useState(2);
  const [selectedDate, setSelectedDate] = useState(todayYmd());
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState("");
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlot | null>(null);
  // The Neon product backing the selected slot (priced from ops catalog)
  const [baseProduct, setBaseProduct] = useState<BowlingSquareProduct | null>(null);

  // ── Add-on state ─────────────────────────────────────────────────
  const [shoeProducts, setShoeProducts] = useState<BowlingSquareProduct[]>([]);
  const [shoeQty, setShoeQty] = useState(0);  // starts at 0 for open bowling (not auto-filled)
  const [attractionProducts, setAttractionProducts] = useState<BowlingSquareProduct[]>([]);
  const [foodProducts, setFoodProducts] = useState<BowlingSquareProduct[]>([]);

  // ── Guest details ─────────────────────────────────────────────────
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");

  // ── Square day-of order quote (fetched on review step entry) ────────
  // Gives us the tax-inclusive total before the customer enters a card.
  const [quoteDayofOrderId, setQuoteDayofOrderId] = useState<string | null>(null);
  const [quoteTotalCents, setQuoteTotalCents] = useState(0);
  const [quoteDepositCents, setQuoteDepositCents] = useState(0);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");

  // ── Payment + submission ──────────────────────────────────────────
  const [agreed, setAgreed] = useState(false);
  const [paymentError, setPaymentError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // ── URL param init ────────────────────────────────────────────────
  useEffect(() => {
    const loc = searchParams.get("location") ?? searchParams.get("center");
    if (loc === "naples" || loc === "3148") {
      setCenterId("3148");
      setBookingLocation("naples");
    } else if (loc === "fortmyers" || loc === "9172") {
      setCenterId("9172");
      setBookingLocation("headpinz");
    }
  }, [searchParams]);

  // ── Quote fetch: tax-inclusive totals from Square ────────────────
  // Clear stale quote when the user backs up to the shoes step.
  // Re-fetch when entering the review step with priced items.
  useEffect(() => {
    if (step === "shoes") {
      setQuoteDayofOrderId(null);
      setQuoteTotalCents(0);
      setQuoteDepositCents(0);
      setQuoteError("");
      return;
    }
    if (step !== "review") return;
    if (lineItems.length === 0) return; // no-op for $0 bookings

    setQuoteLoading(true);
    setQuoteError("");

    const sqLineItems = lineItems.map((l) => {
      const prod =
        l.squareProductId === baseProduct?.id ? baseProduct :
        l.squareProductId === shoeProducts[0]?.id ? shoeProducts[0] : null;
      return {
        name: l.label,
        quantity: String(l.quantity),
        ...(prod?.squareCatalogObjectId
          ? { catalogObjectId: prod.squareCatalogObjectId }
          : { basePriceMoney: { amount: l.unitPriceCents, currency: "USD" as const } }),
      };
    });

    // Compute weighted deposit pct — same logic as /api/bowling/v2/reserve
    const preTaxTotal = lineItems.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
    const preTaxDeposit = lineItems.reduce((s, l) => s + l.depositCents, 0);
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

  // ── Derived totals ────────────────────────────────────────────────
  const lineItems: LineItem[] = [];

  // Base open bowling product
  if (baseProduct && selectedSlot) {
    lineItems.push({
      squareProductId: baseProduct.id,
      label: baseProduct.label,
      quantity: 1,
      unitPriceCents: baseProduct.priceCents,
      depositCents: Math.round(baseProduct.priceCents * (baseProduct.depositPct / 100)),
    });
  }

  // Shoes
  const shoeProd = shoeProducts[0];
  if (shoeProd && shoeQty > 0) {
    lineItems.push({
      squareProductId: shoeProd.id,
      label: shoeProd.label,
      quantity: shoeQty,
      unitPriceCents: shoeProd.priceCents,
      depositCents: Math.round(shoeProd.priceCents * shoeQty * (shoeProd.depositPct / 100)),
    });
  }

  const totalCents = lineItems.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  const depositCents = lineItems.reduce((s, l) => s + l.depositCents, 0);
  const remainingCents = totalCents - depositCents;

  // ── Load slots ─────────────────────────────────────────────────────
  const loadSlots = useCallback(async () => {
    setSlotsLoading(true);
    setSlotsError("");
    setSlots([]);
    try {
      const params = new URLSearchParams({
        centerId: center.qamfId.toString(),
        players: String(playerCount),
        startDate: selectedDate,
        endDate: selectedDate,
        service: "BookForLater",
      });
      const res = await fetch(`/api/bowling/v2/availability?${params.toString()}`);
      // Route returns PascalCase QAMF fields: { Availabilities: [...] }
      const data = await res.json() as {
        Availabilities?: Array<{
          BookedAt: string;
          WebOffer: {
            Id: number;
            Title: string;
            OpenType?: string;
            Options?: {
              Game?: { Id: number }[];
              Time?: { Id: number }[];
              Unlimited?: { Id: number }[];
            };
          };
        }>;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to load slots");

      const raw = data.Availabilities ?? [];
      const mapped: AvailabilitySlot[] = raw.map((a) => {
        // Pick the first option ID from the web offer
        const opts = a.WebOffer.Options ?? {};
        let optionId: number | undefined;
        let optionType: "Game" | "Time" | "Unlimited" | undefined;
        if (opts.Game?.[0]) { optionId = opts.Game[0].Id; optionType = "Game"; }
        else if (opts.Time?.[0]) { optionId = opts.Time[0].Id; optionType = "Time"; }
        else if (opts.Unlimited?.[0]) { optionId = opts.Unlimited[0].Id; optionType = "Unlimited"; }

        return {
          bookedAt: a.BookedAt,
          webOfferId: a.WebOffer.Id,
          webOfferTitle: a.WebOffer.Title,
          openType: a.WebOffer.OpenType ?? "",
          optionId,
          optionType,
        };
      });
      setSlots(mapped);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not load available times";
      setSlotsError(msg);
    } finally {
      setSlotsLoading(false);
    }
  }, [center.qamfId, playerCount, selectedDate]);

  // ── Load shoe products ────────────────────────────────────────────
  // Route returns a plain BowlingSquareProduct[] array (not { products: [] }).
  const loadShoeProducts = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/bowling/v2/square-products?centerCode=${center.squareCenterCode}&kind=addon_shoe`,
      );
      const data = await res.json() as BowlingSquareProduct[];
      setShoeProducts(Array.isArray(data) ? data : []);
    } catch {
      setShoeProducts([]);
    }
  }, [center.squareCenterCode]);

  // ── Load open bowling base product for selected slot ──────────────
  const loadBaseProduct = useCallback(async (slot: AvailabilitySlot) => {
    try {
      const res = await fetch(
        `/api/bowling/v2/square-products?centerCode=${center.squareCenterCode}&kind=open`,
      );
      const data = await res.json() as BowlingSquareProduct[];
      const prods = Array.isArray(data) ? data : [];
      // Match by qamfWebOfferId; fall back to first active open product
      const match =
        prods.find((p) => p.qamfWebOfferId === slot.webOfferId) ?? prods[0] ?? null;
      setBaseProduct(match);
    } catch {
      setBaseProduct(null);
    }
  }, [center.squareCenterCode]);

  // ── Load attraction / food products ──────────────────────────────
  const loadAddonProducts = useCallback(async () => {
    try {
      const [attrRes, foodRes] = await Promise.all([
        fetch(`/api/bowling/v2/square-products?centerCode=${center.squareCenterCode}&kind=addon_attraction`),
        fetch(`/api/bowling/v2/square-products?centerCode=${center.squareCenterCode}&kind=addon_food`),
      ]);
      const attrData = await attrRes.json() as BowlingSquareProduct[];
      const foodData = await foodRes.json() as BowlingSquareProduct[];
      setAttractionProducts(Array.isArray(attrData) ? attrData : []);
      setFoodProducts(Array.isArray(foodData) ? foodData : []);
    } catch {
      setAttractionProducts([]);
      setFoodProducts([]);
    }
  }, [center.squareCenterCode]);

  // ── Submit ────────────────────────────────────────────────────────
  // Tokenization is owned by BowlingPaymentStep (matching PaymentForm
  // pattern in karting). This receives the token as a parameter.
  const handleSubmit = useCallback(async (squareToken?: string) => {
    if (!selectedSlot) return;
    setBusy(true);
    setPaymentError("");
    setError("");
    setStep("submitting");

    const reserveLineItems = lineItems.map((l) => ({
      squareProductId: l.squareProductId,
      quantity: l.quantity,
    }));

    try {
      const res = await fetch("/api/bowling/v2/reserve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          centerCode: center.squareCenterCode,
          webOfferId: selectedSlot.webOfferId,
          optionId: selectedSlot.optionId,
          optionType: selectedSlot.optionType,
          bookedAt: selectedSlot.bookedAt,
          service: "BookForLater",
          players: Array.from({ length: playerCount }, (_, i) => ({ name: `Bowler ${i + 1}` })),
          guest: { name: guestName, email: guestEmail, phone: guestPhone },
          lineItems: reserveLineItems,
          squareToken,
          locationId: center.squareCenterCode,
          // Pass pre-created day-of order + exact deposit so bowling-orders
          // uses the amount shown to the customer rather than recalculating.
          ...(quoteDayofOrderId
            ? { dayofOrderId: quoteDayofOrderId, dayofTotalCents: quoteTotalCents, depositCents: quoteDepositCents }
            : {}),
        }),
      });
      const data = await res.json() as {
        neonId?: number;
        qamfReservationId?: string;
        depositPaidCents?: number;
        remainingCents?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Reservation failed");

      const params = new URLSearchParams({
        neonId: String(data.neonId ?? 0),
        qamfId: data.qamfReservationId ?? "",
        centerId: center.id,
        depositPaid: String(data.depositPaidCents ?? 0),
        remaining: String(data.remainingCents ?? 0),
      });
      router.push(`/hp/book/open-bowling/confirmation?${params.toString()}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Reservation failed";
      setPaymentError(msg);
      setError(msg);
      setStep("payment");
    } finally {
      setBusy(false);
    }
  }, [
    selectedSlot,
    depositCents,
    lineItems,
    center,
    playerCount,
    guestName,
    guestEmail,
    guestPhone,
    router,
    quoteDayofOrderId,
    quoteTotalCents,
    quoteDepositCents,
  ]);

  // ── Render ────────────────────────────────────────────────────────

  const minDate = todayYmd();
  const maxDate = addDays(minDate, 30);

  return (
    <>
      <HeadPinzNav />
      <main className="min-h-screen pt-28 sm:pt-32 pb-16 px-4" style={{ backgroundColor: BG }}>
        <div className="max-w-md mx-auto">

          {/* Header */}
          {step !== "submitting" && (
            <div className="text-center mb-8">
              <div
                className="inline-block uppercase font-bold mb-2"
                style={{ color: CORAL, fontSize: "11px", letterSpacing: "2.5px" }}
              >
                Open Bowling
              </div>
              <h1
                className="font-heading font-black uppercase italic text-white"
                style={{ fontSize: "clamp(26px, 6vw, 36px)", lineHeight: 1.1 }}
              >
                Reserve Your Lane
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
                color: "#fd5b56",
              }}
            >
              {error}
            </div>
          )}

          {/* ── STEP: location ── */}
          {step === "location" && (
            <div className="space-y-3">
              {CENTERS.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    setCenterId(c.id);
                    setBookingLocation(c.locationKey);
                    setStep("players");
                  }}
                  className="w-full text-left rounded-2xl p-5 border transition-all hover:scale-[1.01]"
                  style={{
                    backgroundColor: centerId === c.id ? "rgba(253,91,86,0.12)" : "rgba(255,255,255,0.04)",
                    borderColor: centerId === c.id ? `${CORAL}80` : "rgba(255,255,255,0.1)",
                  }}
                >
                  <div className="font-body font-bold text-white text-base">{c.name}</div>
                  <div className="font-body text-white/50 text-sm mt-0.5">{c.address}</div>
                </button>
              ))}
            </div>
          )}

          {/* ── STEP: players ── */}
          {step === "players" && (
            <div>
              <h2 className="font-heading font-black uppercase italic text-white text-xl mb-6">
                How many bowlers?
              </h2>
              <div className="grid grid-cols-3 gap-3 mb-6">
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <button
                    key={n}
                    onClick={() => setPlayerCount(n)}
                    className="py-4 rounded-xl text-lg font-heading font-black uppercase italic transition-all"
                    style={{
                      backgroundColor: playerCount === n ? CORAL : "rgba(255,255,255,0.06)",
                      color: playerCount === n ? "white" : "rgba(255,255,255,0.6)",
                      border: `1.5px solid ${playerCount === n ? CORAL : "rgba(255,255,255,0.1)"}`,
                    }}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <p className="text-white/40 text-xs text-center mb-6">
                Up to 6 bowlers per lane
              </p>
              <button
                onClick={() => setStep("date")}
                className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01]"
                style={{ backgroundColor: CORAL }}
              >
                Continue
              </button>
            </div>
          )}

          {/* ── STEP: date ── */}
          {step === "date" && (
            <div>
              <h2 className="font-heading font-black uppercase italic text-white text-xl mb-6">
                Pick a date
              </h2>
              <input
                type="date"
                value={selectedDate}
                min={minDate}
                max={maxDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="w-full rounded-xl px-4 py-3 font-body text-white text-base bg-white/8 border border-white/15 focus:outline-none focus:border-white/40 mb-6"
                style={{ colorScheme: "dark" }}
              />
              <button
                onClick={async () => {
                  setStep("slots");
                  await loadSlots();
                }}
                className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01]"
                style={{ backgroundColor: CORAL }}
              >
                Find Available Times
              </button>
              <button
                onClick={() => setStep("players")}
                className="w-full mt-2 py-2 text-sm font-body text-white/40 hover:text-white/70 transition-colors"
              >
                ← Back
              </button>
            </div>
          )}

          {/* ── STEP: slots ── */}
          {step === "slots" && (
            <div>
              <h2 className="font-heading font-black uppercase italic text-white text-xl mb-1">
                Available Times
              </h2>
              <p className="text-white/45 text-sm mb-5">
                {formatSlotDate(selectedDate + "T12:00:00")} · {playerCount} bowler{playerCount !== 1 ? "s" : ""}
              </p>

              {slotsLoading && (
                <div className="text-center py-8">
                  <div className="inline-block w-6 h-6 rounded-full border-2 border-white/20 border-t-white/80 animate-spin" />
                  <p className="text-white/40 text-sm mt-3">Finding available times…</p>
                </div>
              )}

              {slotsError && (
                <div className="rounded-xl p-4 text-sm" style={{ backgroundColor: "rgba(253,91,86,0.1)", color: CORAL }}>
                  {slotsError}
                  <button
                    onClick={loadSlots}
                    className="block mt-2 underline text-xs hover:opacity-80"
                  >
                    Try again
                  </button>
                </div>
              )}

              {!slotsLoading && !slotsError && slots.length === 0 && (
                <div className="text-center py-8">
                  <p className="text-white/50 text-sm">No times available for this date.</p>
                  <button
                    onClick={() => setStep("date")}
                    className="mt-3 text-sm text-white/60 underline hover:text-white"
                  >
                    Choose another date
                  </button>
                </div>
              )}

              {!slotsLoading && slots.length > 0 && (
                <>
                  <div className="space-y-2 mb-5">
                    {slots.map((slot, i) => {
                      const isSelected =
                        selectedSlot?.bookedAt === slot.bookedAt &&
                        selectedSlot?.webOfferId === slot.webOfferId;
                      return (
                        <button
                          key={i}
                          onClick={() => setSelectedSlot(slot)}
                          className="w-full text-left rounded-xl p-4 border transition-all"
                          style={{
                            backgroundColor: isSelected ? "rgba(253,91,86,0.12)" : "rgba(255,255,255,0.04)",
                            borderColor: isSelected ? `${CORAL}80` : "rgba(255,255,255,0.1)",
                          }}
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="font-body font-bold text-white text-base">
                                {formatSlotTime(slot.bookedAt)}
                              </div>
                              <div className="font-body text-white/50 text-xs mt-0.5">
                                {slot.webOfferTitle}
                              </div>
                            </div>
                            {isSelected && (
                              <div
                                className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
                                style={{ backgroundColor: CORAL }}
                              >
                                <span className="text-white text-xs font-bold">✓</span>
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  <button
                    disabled={!selectedSlot}
                    onClick={async () => {
                      if (!selectedSlot) return;
                      await Promise.all([
                        loadShoeProducts(),
                        loadAddonProducts(),
                        loadBaseProduct(selectedSlot),
                      ]);
                      setStep("shoes");
                    }}
                    className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
                    style={{ backgroundColor: CORAL }}
                  >
                    Continue
                  </button>
                </>
              )}

              <button
                onClick={() => setStep("date")}
                className="w-full mt-2 py-2 text-sm font-body text-white/40 hover:text-white/70 transition-colors"
              >
                ← Back
              </button>
            </div>
          )}

          {/* ── STEP: shoes ── */}
          {step === "shoes" && (
            <div>
              <h2 className="font-heading font-black uppercase italic text-white text-xl mb-2">
                Shoe Rental
              </h2>
              <p className="text-white/45 text-sm mb-5">
                Add shoe rental for any bowlers who need it.
              </p>

              {shoeProducts.length === 0 ? (
                <div
                  className="rounded-xl p-4 mb-5 text-sm"
                  style={{ backgroundColor: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.1)" }}
                >
                  <p className="text-white/50">Shoe rental not available for online booking at this time.</p>
                </div>
              ) : (
                <>
                  {shoeProducts.map((prod) => (
                    <div
                      key={prod.id}
                      className="rounded-xl p-5 border border-white/10 bg-white/[0.03] mb-4"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className="font-body font-bold text-white">{prod.label}</div>
                          <div className="font-body text-white/50 text-sm">
                            {centsToDollars(prod.priceCents)} per pair
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => setShoeQty((q) => Math.max(0, q - 1))}
                            className="w-8 h-8 rounded-full border border-white/20 text-white/60 hover:text-white hover:border-white/40 transition-colors text-lg leading-none"
                          >
                            −
                          </button>
                          <span className="font-body font-bold text-white w-6 text-center">
                            {shoeQty}
                          </span>
                          <button
                            onClick={() => setShoeQty((q) => Math.min(playerCount, q + 1))}
                            className="w-8 h-8 rounded-full border border-white/20 text-white/60 hover:text-white hover:border-white/40 transition-colors text-lg leading-none"
                          >
                            +
                          </button>
                        </div>
                      </div>
                      {shoeQty > 0 && (
                        <div className="text-xs text-white/40">
                          {shoeQty} pair{shoeQty !== 1 ? "s" : ""} ·{" "}
                          {centsToDollars(prod.priceCents * shoeQty)}
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}

              <button
                onClick={() => {
                  if (attractionProducts.length > 0) setStep("attractions");
                  else if (foodProducts.length > 0) setStep("food");
                  else setStep("details");
                }}
                className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01]"
                style={{ backgroundColor: CORAL }}
              >
                {shoeQty > 0 ? "Add Shoes & Continue" : "Skip — Continue"}
              </button>
              <button
                onClick={() => setStep("slots")}
                className="w-full mt-2 py-2 text-sm font-body text-white/40 hover:text-white/70 transition-colors"
              >
                ← Back
              </button>
            </div>
          )}

          {/* ── STEP: attractions (stub) ── */}
          {step === "attractions" && (
            <div>
              <h2 className="font-heading font-black uppercase italic text-white text-xl mb-2">
                Attraction Add-Ons
              </h2>
              <p className="text-white/45 text-sm mb-5">
                Enhance your visit with extra activities.
              </p>

              {attractionProducts.length === 0 ? (
                <div
                  className="rounded-xl p-5 border text-center mb-5"
                  style={{ backgroundColor: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.1)" }}
                >
                  <p className="text-white/40 text-sm">Attraction add-ons coming soon.</p>
                </div>
              ) : (
                <div className="space-y-2 mb-4">
                  {attractionProducts.map((p) => (
                    <div key={p.id} className="rounded-xl p-4 border border-white/10 bg-white/[0.03]">
                      <div className="font-body font-bold text-white">{p.label}</div>
                      <div className="text-white/50 text-sm">{centsToDollars(p.priceCents)} per person</div>
                    </div>
                  ))}
                </div>
              )}

              <button
                onClick={() => {
                  if (foodProducts.length > 0) setStep("food");
                  else setStep("details");
                }}
                className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01]"
                style={{ backgroundColor: CORAL }}
              >
                Continue
              </button>
              <button
                onClick={() => setStep("shoes")}
                className="w-full mt-2 py-2 text-sm font-body text-white/40 hover:text-white/70 transition-colors"
              >
                ← Back
              </button>
            </div>
          )}

          {/* ── STEP: food (stub) ── */}
          {step === "food" && (
            <div>
              <h2 className="font-heading font-black uppercase italic text-white text-xl mb-2">
                Food & Beverage
              </h2>
              <p className="text-white/45 text-sm mb-5">
                Pre-order food & drinks for your group.
              </p>

              {foodProducts.length === 0 ? (
                <div
                  className="rounded-xl p-5 border text-center mb-5"
                  style={{ backgroundColor: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.1)" }}
                >
                  <p className="text-white/40 text-sm">Food packages coming soon.</p>
                </div>
              ) : (
                <div className="space-y-2 mb-4">
                  {foodProducts.map((p) => (
                    <div key={p.id} className="rounded-xl p-4 border border-white/10 bg-white/[0.03]">
                      <div className="font-body font-bold text-white">{p.label}</div>
                      <div className="text-white/50 text-sm">{centsToDollars(p.priceCents)}</div>
                    </div>
                  ))}
                </div>
              )}

              <button
                onClick={() => setStep("details")}
                className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01]"
                style={{ backgroundColor: CORAL }}
              >
                Continue
              </button>
              <button
                onClick={() => setStep("attractions")}
                className="w-full mt-2 py-2 text-sm font-body text-white/40 hover:text-white/70 transition-colors"
              >
                ← Back
              </button>
            </div>
          )}

          {/* ── STEP: details ── */}
          {step === "details" && (
            <div>
              <h2 className="font-heading font-black uppercase italic text-white text-xl mb-6">
                Your Details
              </h2>
              <div className="space-y-4 mb-6">
                {[
                  { label: "Full name", value: guestName, onChange: setGuestName, type: "text", placeholder: "Jane Smith" },
                  { label: "Email", value: guestEmail, onChange: setGuestEmail, type: "email", placeholder: "jane@example.com" },
                  { label: "Phone", value: guestPhone, onChange: setGuestPhone, type: "tel", placeholder: "(555) 000-0000" },
                ].map((f) => (
                  <div key={f.label}>
                    <label className="block text-white/60 text-xs uppercase tracking-wider mb-1.5 font-body">
                      {f.label}
                    </label>
                    <input
                      type={f.type}
                      value={f.value}
                      onChange={(e) => f.onChange(e.target.value)}
                      placeholder={f.placeholder}
                      className="w-full rounded-xl px-4 py-3 font-body text-white text-base bg-white/8 border border-white/15 placeholder-white/25 focus:outline-none focus:border-white/40"
                    />
                  </div>
                ))}
              </div>
              <button
                disabled={!guestName || !guestEmail || !guestPhone}
                onClick={() => setStep("review")}
                className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
                style={{ backgroundColor: CORAL }}
              >
                Review Order
              </button>
              <button
                onClick={() => {
                  if (foodProducts.length > 0) setStep("food");
                  else if (attractionProducts.length > 0) setStep("attractions");
                  else setStep("shoes");
                }}
                className="w-full mt-2 py-2 text-sm font-body text-white/40 hover:text-white/70 transition-colors"
              >
                ← Back
              </button>
            </div>
          )}

          {/* ── STEP: review ── */}
          {step === "review" && selectedSlot && (
            <div>
              <h2 className="font-heading font-black uppercase italic text-white text-xl mb-5">
                Review Your Order
              </h2>

              {/* Booking summary */}
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-4 space-y-2 text-sm">
                <ReviewRow label="Center" value={center.name} />
                <ReviewRow
                  label="Date & Time"
                  value={new Date(selectedSlot.bookedAt).toLocaleString("en-US", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                />
                <ReviewRow label="Bowlers" value={String(playerCount)} />
                {selectedSlot.webOfferTitle && (
                  <ReviewRow label="Package" value={selectedSlot.webOfferTitle} />
                )}
              </div>

              {/* Pricing */}
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-4 space-y-2 text-sm">
                {baseProduct ? (
                  <ReviewRow label={baseProduct.label} value={centsToDollars(baseProduct.priceCents)} />
                ) : (
                  <div className="text-yellow-400/80 text-xs">
                    Open bowling pricing not yet configured — contact the center for rates.
                  </div>
                )}
                {shoeProd && shoeQty > 0 && (
                  <ReviewRow
                    label={`${shoeProd.label} ×${shoeQty}`}
                    value={centsToDollars(shoeProd.priceCents * shoeQty)}
                  />
                )}
                {totalCents > 0 && (
                  <>
                    <div className="border-t border-white/10 pt-2 mt-1">
                      {/* Show tax-inclusive total from Square quote; fall back to pre-tax estimate */}
                      <ReviewRow
                        label="Total"
                        value={quoteLoading ? "calculating…" : centsToDollars(quoteTotalCents > 0 ? quoteTotalCents : totalCents)}
                      />
                      {quoteTotalCents > totalCents && !quoteLoading && (
                        <div className="flex justify-between text-xs text-white/35">
                          <span>Incl. sales tax</span>
                          <span>+{centsToDollars(quoteTotalCents - totalCents)}</span>
                        </div>
                      )}
                      <ReviewRow
                        label="Due now (deposit)"
                        value={quoteLoading ? "calculating…" : centsToDollars(quoteDepositCents > 0 ? quoteDepositCents : depositCents)}
                        highlight
                      />
                      {(() => {
                        const displayTotal = quoteTotalCents > 0 ? quoteTotalCents : totalCents;
                        const displayDeposit = quoteDepositCents > 0 ? quoteDepositCents : depositCents;
                        const displayRemaining = displayTotal - displayDeposit;
                        return displayRemaining > 0 && !quoteLoading ? (
                          <ReviewRow label="Balance at center" value={centsToDollars(displayRemaining)} />
                        ) : null;
                      })()}
                      {quoteError && (
                        <div className="text-xs mt-1" style={{ color: CORAL }}>
                          {quoteError} — amount shown is pre-tax estimate.
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* Guest */}
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-5 space-y-2 text-sm">
                <ReviewRow label="Name" value={guestName} />
                <ReviewRow label="Email" value={guestEmail} />
              </div>

              <button
                onClick={() => setStep("payment")}
                disabled={(depositCents === 0 && !baseProduct) || quoteLoading}
                className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ backgroundColor: CORAL }}
              >
                {quoteLoading
                  ? "Calculating…"
                  : (quoteDepositCents > 0 || depositCents > 0)
                    ? `Pay Deposit — ${centsToDollars(quoteDepositCents > 0 ? quoteDepositCents : depositCents)}`
                    : "Confirm Booking"}
              </button>
              <button
                onClick={() => setStep("details")}
                className="w-full mt-2 py-2 text-sm font-body text-white/40 hover:text-white/70 transition-colors"
              >
                ← Back
              </button>
            </div>
          )}

          {/* ── STEP: payment ── */}
          {step === "payment" && (
            <BowlingPaymentStep
              depositCents={quoteDepositCents > 0 ? quoteDepositCents : depositCents}
              totalCents={quoteTotalCents > 0 ? quoteTotalCents : totalCents}
              locationId={center.squareCenterCode}
              paymentError={paymentError}
              busy={busy}
              heading="Payment"
              payLabel={`Pay ${centsToDollars(quoteDepositCents > 0 ? quoteDepositCents : depositCents)} & Reserve`}
              payDisabled={!agreed}
              onBack={() => setStep("review")}
              onPay={(token) => { handleSubmit(token); }}
            >
              <ClickwrapCheckbox checked={agreed} onChange={setAgreed} />
            </BowlingPaymentStep>
          )}

          {/* ── STEP: submitting ── */}
          {step === "submitting" && (
            <div className="text-center py-16">
              <div className="inline-block w-10 h-10 rounded-full border-2 border-white/20 border-t-white/80 animate-spin mb-5" />
              <p className="font-heading font-black uppercase italic text-white text-xl">
                Reserving your lane…
              </p>
              <p className="text-white/40 text-sm mt-2">Please don&apos;t close this page.</p>
            </div>
          )}

        </div>
      </main>
    </>
  );
}

// ── Helper sub-components ──────────────────────────────────────────

function ReviewRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex justify-between gap-2 text-sm">
      <span className="text-white/50 shrink-0">{label}</span>
      <span className={highlight ? "text-green-400 font-semibold" : "text-white text-right"}>
        {value}
      </span>
    </div>
  );
}
