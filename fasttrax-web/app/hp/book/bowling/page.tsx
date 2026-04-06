"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type Step = "location" | "date" | "players" | "lane-type" | "offer" | "extras" | "review" | "details";
type LaneType = "regular" | "vip" | "oldtime";

interface OpenDate {
  Date: string;
  IsOpen: boolean;
  StartBookingTime: string | null;
  EndBookingTime: string | null;
}

interface OfferItem {
  ItemId: number;
  Quantity: number;
  QuantityType: string;
  Time: string;
  Total: number;
  Remaining: number;
  Lanes: number;
  Reason?: string;
  Alternatives?: { DateTime: string; Time: string; Total: number; Remaining: number }[];
}

interface Offer {
  OfferId: number;
  Name: string;
  Description: string;
  ImageUrl: string;
  Tariffs: { Id: number; Name: string; Price: number; Duration: string }[];
  Items: OfferItem[];
}

interface ShoeOption { Name: string; Price: number; PriceKeyId: number; PlayerTypeId: number }
interface Extra { Id: number; Name: string; Price: number; ImageUrl: string; Description: string; ItemType: string }
interface CartSummary { TotalWithoutTaxes: number; TotalItems: number; AddedTaxes: number; TotalWithTaxes: number }

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const API = "/api/qamf";
const LOCATIONS = [
  { id: "9172", name: "HeadPinz Fort Myers", address: "14513 Global Pkwy, Fort Myers", hasOldTime: true },
  { id: "3148", name: "HeadPinz Naples", address: "8525 Radio Ln, Naples", hasOldTime: false },
];

const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";
const LANE_TYPES: { key: LaneType; label: string; desc: string; accent: string; fmOnly?: boolean; videos?: string[]; details?: string[] }[] = [
  {
    key: "regular",
    label: "Regular Lanes",
    desc: "24 classic bowling lanes with cosmic glow lighting, big screens, and a full bar steps away.",
    accent: "#fd5b56",
    videos: [`${BLOB}/videos/headpinz-bowling.mp4`],
    details: ["24 state-of-the-art lanes", "Cosmic glow atmosphere", "Up to 6 bowlers per lane", "Full bar & food service"],
  },
  {
    key: "vip",
    label: "VIP Lanes",
    desc: "The ultimate bowling experience. Private VIP suite with NeoVerse interactive LED walls and HyperBowling LED target scoring.",
    accent: "#FFD700",
    videos: [`${BLOB}/videos/headpinz-neoverse.mp4`, `${BLOB}/videos/headpinz-hyperbowling.mp4`],
    details: ["NeoVerse interactive video wall", "HyperBowling LED targets in bumpers", "Private lounge seating", "Premium experience"],
  },
  {
    key: "oldtime",
    label: "Old Time Lanes",
    desc: "Pinboyz retro duckpin bowling — smaller balls, no finger holes, pure classic fun.",
    accent: "#00E2E5",
    fmOnly: true,
    details: ["Retro duckpin bowling", "No finger holes — just throw!", "Perfect for all ages", "Fort Myers exclusive"],
  },
];

const coral = "#fd5b56";
const gold = "#FFD700";
const cyan = "#00E2E5";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function qamf(path: string, options?: RequestInit) {
  const res = await fetch(`${API}/${path}`, options);
  if (!res.ok) throw new Error(`QAMF ${res.status}`);
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

function stripHtml(html: string) { return html.replace(/<[^>]*>/g, "").trim(); }

function isPerPerson(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("fun 4") || n.includes("fun4");
}

function formatDuration(qty: number, qtyType: string): string {
  if (qtyType === "Minutes") return `${qty} min`;
  if (qtyType === "Games") return `${qty} game${qty > 1 ? "s" : ""}`;
  return `${qty}`;
}

function classifyOffer(name: string): LaneType {
  const n = name.toLowerCase();
  if (n.includes("old time") || n.includes("pinboyz")) return "oldtime";
  if (n.includes("vip")) return "vip";
  return "regular";
}

function getAvailableTimes(offer: Offer): string[] {
  const times: string[] = [];
  for (const item of offer.Items || []) {
    if (!item.Reason && item.Remaining > 0) {
      times.push(item.Time);
    }
    for (const alt of item.Alternatives || []) {
      if (alt.Remaining > 0) times.push(alt.Time);
    }
  }
  return [...new Set(times)].sort();
}

function formatTimeStr(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function BowlingBookingPage() {
  const searchParams = useSearchParams();
  const [step, setStep] = useState<Step>("location");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Booking state
  const [centerId, setCenterId] = useState("");
  const [centerName, setCenterName] = useState("");
  const [hasOldTime, setHasOldTime] = useState(false);

  // Auto-detect location from query param or referrer
  useEffect(() => {
    const locParam = searchParams.get("location");
    if (locParam === "naples") {
      const loc = LOCATIONS.find(l => l.id === "3148")!;
      setCenterId(loc.id);
      setCenterName(loc.name);
      setHasOldTime(loc.hasOldTime);
    } else {
      // Default to Fort Myers
      const loc = LOCATIONS.find(l => l.id === "9172")!;
      setCenterId(loc.id);
      setCenterName(loc.name);
      setHasOldTime(loc.hasOldTime);
    }
  }, [searchParams]);
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedTime, setSelectedTime] = useState("");
  const [playerCount, setPlayerCount] = useState(2);
  const [laneType, setLaneType] = useState<LaneType>("regular");
  const [selectedOffer, setSelectedOffer] = useState<Offer | null>(null);
  const [selectedTariff, setSelectedTariff] = useState<{ Id: number; Name: string; Price: number; Duration: string } | null>(null);
  const [reservationKey, setReservationKey] = useState("");

  // Calendar state
  const [calMonth, setCalMonth] = useState(new Date().getMonth());
  const [calYear, setCalYear] = useState(new Date().getFullYear());

  // API data
  const [openDates, setOpenDates] = useState<OpenDate[]>([]);
  const [allOffers, setAllOffers] = useState<Offer[]>([]);
  const [shoes, setShoes] = useState<ShoeOption[]>([]);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [cartSummary, setCartSummary] = useState<CartSummary | null>(null);

  // Extras selections
  const [wantShoes, setWantShoes] = useState(true);
  const [selectedExtras, setSelectedExtras] = useState<Map<number, number>>(new Map());

  // Guest details
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");

  // Refs
  const timePickerRef = useRef<HTMLDivElement>(null);

  // Keep-alive
  const keepAliveRef = useRef<NodeJS.Timeout | null>(null);
  const startKeepAlive = useCallback((key: string, cid: string) => {
    if (keepAliveRef.current) clearInterval(keepAliveRef.current);
    keepAliveRef.current = setInterval(() => {
      qamf(`centers/${cid}/reservations/${key}/lifetime`, { method: "PATCH" }).catch(() => {});
    }, 120000);
  }, []);
  useEffect(() => () => { if (keepAliveRef.current) clearInterval(keepAliveRef.current); }, []);

  // Filtered offers by lane type
  const filteredOffers = allOffers.filter(o => classifyOffer(o.Name) === laneType);

  /* ── Step: Location ──────────────────────────────────────────── */

  async function selectLocation(loc: typeof LOCATIONS[0]) {
    setCenterId(loc.id);
    setCenterName(loc.name);
    setHasOldTime(loc.hasOldTime);
    setLoading(true);
    setError("");
    try {
      const today = new Date().toISOString().split("T")[0];
      const end = new Date(Date.now() + 90 * 86400000).toISOString().split("T")[0];
      const data = await qamf(`centers/${loc.id}/opening-times/bookforlater/range?fromDate=${today}&toDate=${end}`);
      setOpenDates((data.Dates || []).filter((d: OpenDate) => d.IsOpen));
      setStep("date");
    } catch { setError("Failed to load dates"); }
    finally { setLoading(false); }
  }

  /* ── Step: Date + Time ───────────────────────────────────────── */

  const openDateSet = new Set(openDates.map(d => d.Date));

  function getOpenDate(dateStr: string): OpenDate | undefined {
    return openDates.find(d => d.Date === dateStr);
  }

  function selectDateAndTime(date: string, time: string) {
    setSelectedDate(date);
    setSelectedTime(time);
    setStep("players");
  }

  // Generate time slots for selected date
  const selectedOpenDate = selectedDate ? getOpenDate(selectedDate) : null;
  const timeSlots: string[] = [];
  if (selectedOpenDate?.StartBookingTime && selectedOpenDate?.EndBookingTime) {
    const start = selectedOpenDate.StartBookingTime.split("T")[1];
    const end = selectedOpenDate.EndBookingTime.split("T")[1];
    const [sh, sm] = start.split(":").map(Number);
    let [eh] = end.split(":").map(Number);
    // If end is midnight (00:00) or next day, treat as 23:30
    if (eh === 0) eh = 23;
    // If end is before start (crosses midnight), go to 23
    if (eh < sh) eh = 23;
    for (let h = sh; h <= eh; h++) {
      for (const m of [0, 30]) {
        if (h === sh && m < sm) continue;
        timeSlots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
      }
    }
  }

  // Calendar rendering
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const monthName = new Date(calYear, calMonth).toLocaleString("en-US", { month: "long", year: "numeric" });

  /* ── Step: Players → fetch offers ────────────────────────────── */

  async function fetchOffers() {
    setLoading(true);
    setError("");
    try {
      const dt = `${selectedDate}T${selectedTime}`;
      const data = await qamf(
        `centers/${centerId}/offers-availability?systemId=${centerId}&datetime=${encodeURIComponent(dt)}&players=1-${playerCount}&page=1&itemsPerPage=50`
      );
      setAllOffers(Array.isArray(data) ? data : []);
      setStep("lane-type");
    } catch { setError("Failed to load packages"); }
    finally { setLoading(false); }
  }

  /* ── Step: Select offer → create reservation ─────────────────── */

  async function selectOffer(offer: Offer, tariff: { Id: number; Name: string; Price: number; Duration: string }) {
    setSelectedOffer(offer);
    setSelectedTariff(tariff);
    setLoading(true);
    setError("");
    try {
      const dt = `${selectedDate}T${selectedTime}`;
      const reservation = await qamf(`centers/${centerId}/reservations/temporary-request/book-for-later`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          DateFrom: dt,
          WebOfferId: offer.OfferId,
          WebOfferTariffId: tariff.Id,
          PlayersList: [{ TypeId: 1, Number: playerCount }],
        }),
      });
      setReservationKey(reservation.ReservationKey);
      startKeepAlive(reservation.ReservationKey, centerId);

      const dte = encodeURIComponent(dt);
      const [shoesData, extrasData] = await Promise.all([
        qamf(`centers/${centerId}/offers/${offer.OfferId}/shoes-socks-offer?systemId=${centerId}&datetime=${dte}`).catch(() => ({ Shoes: [] })),
        qamf(`centers/${centerId}/offers/extras?systemId=${centerId}&datetime=${dte}&offerId=${offer.OfferId}&page=1&itemsPerPage=50`).catch(() => []),
      ]);
      setShoes(shoesData.Shoes || []);
      setExtras(Array.isArray(extrasData) ? extrasData : []);
      setStep("extras");
    } catch { setError("Failed to create reservation"); }
    finally { setLoading(false); }
  }

  /* ── Step: Review cart ───────────────────────────────────────── */

  async function goToReview() {
    setLoading(true);
    setError("");
    try {
      const shoeItems = wantShoes && shoes.length > 0
        ? shoes.map(s => ({ PriceKeyId: s.PriceKeyId, Quantity: playerCount, UnitPrice: s.Price }))
        : [];
      const extraItems = Array.from(selectedExtras.entries())
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => {
          const ex = extras.find(e => e.Id === id);
          return { PriceKeyId: id, Quantity: qty, UnitPrice: ex?.Price || 0, Note: "" };
        });

      const summary = await qamf(`centers/${centerId}/Cart/CreateSummary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          Time: `${selectedDate}T${selectedTime}`,
          Items: {
            Extra: extraItems,
            FoodAndBeverage: [],
            ShoesSocks: shoeItems,
            WebOffer: {
              Id: selectedOffer!.OfferId,
              UnitPrice: selectedTariff!.Price,
              WebOfferTariffId: selectedTariff!.Id,
            },
          },
          Players: [{ TypeId: 1, Number: playerCount }],
        }),
      });
      setCartSummary(summary);
      setStep("review");
    } catch { setError("Failed to calculate total"); }
    finally { setLoading(false); }
  }

  /* ── Step: Submit booking ────────────────────────────────────── */

  async function submitBooking() {
    if (!guestName || !guestEmail || !guestPhone) { setError("Please fill in all fields"); return; }
    setLoading(true);
    setError("");
    try {
      // Build cart items in QAMF format with Type + PriceKeyId
      const cartItems: { Name: string; Type: string; PriceKeyId: number; Quantity: number; UnitPrice: number; Modifiers?: never[] }[] = [];

      // WebOffer (the bowling package)
      cartItems.push({
        Name: selectedOffer!.Name,
        Type: "WebOffer",
        PriceKeyId: selectedOffer!.OfferId,
        Quantity: 1,
        UnitPrice: selectedTariff!.Price,
      });

      // Shoes
      if (wantShoes && shoes.length > 0) {
        shoes.forEach(s => {
          cartItems.push({
            Name: s.Name || "Bowling Shoes",
            Type: "ShoesSocks",
            PriceKeyId: s.PriceKeyId,
            Quantity: playerCount,
            UnitPrice: s.Price,
          });
        });
      }

      // Extras
      selectedExtras.forEach((qty, id) => {
        if (qty > 0) {
          const ex = extras.find(e => e.Id === id);
          cartItems.push({
            Name: ex?.Name || "Extra",
            Type: "Extras",
            PriceKeyId: id,
            Quantity: qty,
            UnitPrice: ex?.Price || 0,
          });
        }
      });

      const returnUrl = `${window.location.origin}/hp/book/bowling/confirmation?key=${reservationKey}&center=${centerId}`;

      const result = await qamf(`centers/${centerId}/reservations/${reservationKey}/guest/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          GuestDetails: {
            Email: guestEmail,
            PhoneNumber: guestPhone.replace(/\D/g, ""),
            ReferentName: guestName,
          },
          Cart: {
            ReturnUrl: returnUrl,
            Items: cartItems,
            Summary: cartSummary ? {
              AddedTaxes: cartSummary.AddedTaxes,
              Deposit: cartSummary.TotalWithTaxes || cartSummary.TotalWithoutTaxes,
              Fee: 0,
              Total: cartSummary.TotalWithTaxes || cartSummary.TotalWithoutTaxes,
              TotalItems: cartSummary.TotalItems,
              AutoGratuity: 0,
              TotalWithoutTaxes: cartSummary.TotalWithoutTaxes,
            } : undefined,
          },
        }),
      });

      if (result.NeedPayment && result.ApprovePayment?.Url) {
        sessionStorage.setItem("qamf_reservation", JSON.stringify({
          key: reservationKey, centerId, centerName, operationId: result.OperationId,
          offer: selectedOffer?.Name, date: selectedDate, time: selectedTime, players: playerCount,
        }));
        window.location.href = result.ApprovePayment.Url;
      }
    } catch { setError("Failed to submit booking"); }
    finally { setLoading(false); }
  }

  /* ── Navigation ──────────────────────────────────────────────── */

  const allSteps: Step[] = ["location", "date", "players", "lane-type", "offer", "extras", "review", "details"];
  const stepLabels = ["Location", "Date", "Bowlers", "Type", "Package", "Extras", "Review", "Pay"];
  const stepIndex = allSteps.indexOf(step);

  function goBack() {
    if (stepIndex > 0) { setStep(allSteps[stepIndex - 1]); setError(""); }
  }

  function toggleExtra(id: number) {
    const next = new Map(selectedExtras);
    next.has(id) && next.get(id)! > 0 ? next.delete(id) : next.set(id, 1);
    setSelectedExtras(next);
  }

  /* ── Render ──────────────────────────────────────────────────── */

  return (
    <div className="min-h-screen bg-[#0a1628]">
      {/* Header + Progress */}
      <section className="pt-28 pb-6 px-4 text-center">
        <h1 className="font-[var(--font-hp-hero)] font-black uppercase text-white" style={{ fontSize: "clamp(24px, 5vw, 40px)", textShadow: `0 0 30px ${coral}30` }}>
          Book Bowling
        </h1>
        {centerName && <p className="font-[var(--font-hp-body)] text-white/50 text-sm mt-1">{centerName}</p>}

        <div className="max-w-2xl mx-auto mt-6 flex items-center gap-1">
          {stepLabels.map((label, i) => (
            <div key={label} className="flex-1 text-center">
              <div className="h-1 rounded-full mb-1 transition-all" style={{ backgroundColor: i <= stepIndex ? coral : "rgba(255,255,255,0.1)" }} />
              <span className="font-[var(--font-hp-body)] text-[9px] uppercase tracking-wider" style={{ color: i <= stepIndex ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.2)" }}>
                {label}
              </span>
            </div>
          ))}
        </div>
      </section>

      {error && (
        <div className="max-w-lg mx-auto px-4 mb-4">
          <div className="bg-[#fd5b56]/10 border border-[#fd5b56]/30 rounded-lg px-4 py-3 text-center">
            <p className="font-[var(--font-hp-body)] text-[#fd5b56] text-sm">{error}</p>
          </div>
        </div>
      )}

      {loading && (
        <div className="text-center py-12">
          <div className="inline-block w-8 h-8 border-2 border-white/20 border-t-[#fd5b56] rounded-full animate-spin" />
        </div>
      )}

      <section className="max-w-3xl mx-auto px-4 pb-24">

        {/* ── LOCATION CONFIRM ── */}
        {step === "location" && !loading && centerId && (
          <div className="text-center">
            <div className="rounded-lg p-6 mb-6" style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${gold}30` }}>
              <p className="font-[var(--font-hp-body)] text-white/50 text-xs uppercase tracking-wider mb-2">You&apos;re booking at</p>
              <h3 className="font-[var(--font-hp-display)] uppercase text-white text-xl tracking-wider" style={{ textShadow: `0 0 20px ${gold}25` }}>
                {centerName}
              </h3>
              <p className="font-[var(--font-hp-body)] text-white/40 text-sm mt-1">
                {LOCATIONS.find(l => l.id === centerId)?.address}
              </p>
            </div>
            <button
              onClick={() => selectLocation(LOCATIONS.find(l => l.id === centerId)!)}
              className="w-full py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
              style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}
            >
              Continue
            </button>
            <button
              onClick={() => {
                const other = LOCATIONS.find(l => l.id !== centerId)!;
                setCenterId(other.id); setCenterName(other.name); setHasOldTime(other.hasOldTime);
              }}
              className="mt-3 font-[var(--font-hp-body)] text-white/40 text-xs cursor-pointer hover:text-white/60 transition-colors"
            >
              Switch to {LOCATIONS.find(l => l.id !== centerId)?.name}
            </button>
          </div>
        )}

        {/* ── DATE + TIME (Calendar) ── */}
        {step === "date" && !loading && (
          <div>
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-4 text-center">Select Date &amp; Time</h2>

            {/* Month navigation */}
            <div className="flex items-center justify-between mb-4">
              <button onClick={() => { if (calMonth === 0) { setCalMonth(11); setCalYear(calYear - 1); } else setCalMonth(calMonth - 1); }}
                className="text-white/50 hover:text-white p-2 cursor-pointer">&larr;</button>
              <span className="font-[var(--font-hp-body)] text-white font-bold text-sm">{monthName}</span>
              <button onClick={() => { if (calMonth === 11) { setCalMonth(0); setCalYear(calYear + 1); } else setCalMonth(calMonth + 1); }}
                className="text-white/50 hover:text-white p-2 cursor-pointer">&rarr;</button>
            </div>

            {/* Day headers */}
            <div className="grid grid-cols-7 gap-1 mb-1">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => (
                <div key={d} className="text-center font-[var(--font-hp-body)] text-white/30 text-xs py-1">{d}</div>
              ))}
            </div>

            {/* Calendar grid */}
            <div className="grid grid-cols-7 gap-1 mb-6">
              {Array.from({ length: firstDay }).map((_, i) => <div key={`pad-${i}`} />)}
              {Array.from({ length: daysInMonth }).map((_, i) => {
                const day = i + 1;
                const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                const isOpen = openDateSet.has(dateStr);
                const isSelected = dateStr === selectedDate;
                return (
                  <button
                    key={day}
                    disabled={!isOpen}
                    onClick={() => { setSelectedDate(dateStr); setSelectedTime(""); setTimeout(() => timePickerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); }}
                    className="aspect-square rounded-lg flex items-center justify-center text-sm font-[var(--font-hp-body)] font-bold transition-all cursor-pointer disabled:cursor-default disabled:opacity-20"
                    style={{
                      backgroundColor: isSelected ? coral : isOpen ? "rgba(7,16,39,0.5)" : "transparent",
                      border: isSelected ? `2px solid ${coral}` : isOpen ? "1px solid rgba(255,255,255,0.1)" : "none",
                      color: isSelected ? "#fff" : isOpen ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.2)",
                    }}
                  >
                    {day}
                  </button>
                );
              })}
            </div>

            {/* Time picker */}
            {selectedDate && (
              <div ref={timePickerRef}>
                <h3 className="font-[var(--font-hp-body)] text-white/60 text-sm mb-3 text-center">Select a Time</h3>
                <div className="grid grid-cols-4 gap-2 max-h-48 overflow-y-auto">
                  {timeSlots.map(t => {
                    const isSelected = t === selectedTime;
                    return (
                      <button
                        key={t}
                        onClick={() => setSelectedTime(t)}
                        className="rounded-lg py-2.5 text-center text-sm font-[var(--font-hp-body)] font-bold transition-all cursor-pointer"
                        style={{
                          backgroundColor: isSelected ? gold : "rgba(7,16,39,0.5)",
                          color: isSelected ? "#0a1628" : "rgba(255,255,255,0.7)",
                          border: isSelected ? `2px solid ${gold}` : "1px solid rgba(255,255,255,0.1)",
                        }}
                      >
                        {formatTimeStr(t)}
                      </button>
                    );
                  })}
                </div>

                {selectedTime && (
                  <button
                    onClick={() => setStep("players")}
                    className="w-full mt-6 py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
                    style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}
                  >
                    Continue
                  </button>
                )}
              </div>
            )}

            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer">&larr; Back</button>
          </div>
        )}

        {/* ── PLAYERS ── */}
        {step === "players" && !loading && (
          <div className="text-center">
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-2">How Many Bowlers?</h2>
            <p className="font-[var(--font-hp-body)] text-white/40 text-sm mb-6">Up to 6 per lane</p>
            <div className="flex items-center justify-center gap-6 mb-8">
              <button onClick={() => setPlayerCount(Math.max(1, playerCount - 1))}
                className="w-14 h-14 rounded-full flex items-center justify-center text-2xl text-white cursor-pointer transition-all hover:scale-105"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${coral}30` }}>-</button>
              <span className="font-[var(--font-hp-display)] text-white text-5xl" style={{ color: gold }}>{playerCount}</span>
              <button onClick={() => setPlayerCount(Math.min(24, playerCount + 1))}
                className="w-14 h-14 rounded-full flex items-center justify-center text-2xl text-white cursor-pointer transition-all hover:scale-105"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${coral}30` }}>+</button>
            </div>
            <button onClick={fetchOffers}
              className="w-full py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
              style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}>Continue</button>
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
          </div>
        )}

        {/* ── LANE TYPE ── */}
        {step === "lane-type" && !loading && (
          <div>
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-4 text-center">Choose Your Experience</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {LANE_TYPES.filter(lt => !lt.fmOnly || hasOldTime).map(lt => {
                const count = allOffers.filter(o => classifyOffer(o.Name) === lt.key).length;
                return (
                  <button
                    key={lt.key}
                    onClick={() => { setLaneType(lt.key); setStep("offer"); }}
                    disabled={count === 0}
                    className="w-full rounded-lg overflow-hidden text-left transition-all hover:scale-[1.01] cursor-pointer disabled:opacity-30 disabled:cursor-default"
                    style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${lt.accent}35` }}
                  >
                    {/* Video preview */}
                    {lt.videos && lt.videos.length > 0 && (
                      <div className="relative h-36 overflow-hidden">
                        <video autoPlay muted loop playsInline preload="metadata" className="absolute inset-0 w-full h-full object-cover">
                          <source src={lt.videos[0]} type="video/mp4" />
                        </video>
                        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[#071027]/90" />
                        {lt.key === "vip" && lt.videos.length > 1 && (
                          <div className="absolute bottom-2 left-3 flex gap-1">
                            <span className="font-[var(--font-hp-body)] text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ backgroundColor: `${lt.accent}30`, color: lt.accent }}>NeoVerse</span>
                            <span className="font-[var(--font-hp-body)] text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ backgroundColor: `${cyan}30`, color: cyan }}>HyperBowling</span>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="p-5">
                      <h3 className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider mb-1" style={{ textShadow: `0 0 15px ${lt.accent}25` }}>
                        {lt.label}
                      </h3>
                      <p className="font-[var(--font-hp-body)] text-white/60 text-sm mb-3">{lt.desc}</p>

                      {/* Feature bullets */}
                      {lt.details && (
                        <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3">
                          {lt.details.map(d => (
                            <span key={d} className="flex items-center gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: lt.accent }} />
                              <span className="font-[var(--font-hp-body)] text-white/40 text-xs">{d}</span>
                            </span>
                          ))}
                        </div>
                      )}

                      <span className="font-[var(--font-hp-body)] text-xs font-bold uppercase tracking-wider" style={{ color: lt.accent }}>
                        {count} package{count !== 1 ? "s" : ""} available&nbsp;&rarr;
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer">&larr; Back</button>
          </div>
        )}

        {/* ── OFFER ── */}
        {step === "offer" && !loading && (
          <div>
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-4 text-center">Choose a Package</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredOffers.map(offer => {
                const perPerson = isPerPerson(offer.Name);
                const hasMultipleItems = (offer.Items?.length || 0) > 1;
                const firstItem = offer.Items?.[0];
                const basePrice = firstItem?.Total || 0;
                const perPersonPrice = perPerson && playerCount > 0 ? basePrice / playerCount : 0;

                return (
                  <div
                    key={offer.OfferId}
                    className="rounded-lg overflow-hidden"
                    style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${coral}25` }}
                  >
                    {offer.ImageUrl && (
                      <div className="relative h-32 overflow-hidden">
                        <img src={offer.ImageUrl} alt={offer.Name} className="w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[#071027]/80" />
                        <span className="absolute top-2 right-2 font-[var(--font-hp-body)] text-[10px] uppercase tracking-wider px-2 py-1 rounded-full font-bold"
                          style={{ backgroundColor: perPerson ? `${coral}90` : `${gold}90`, color: "#fff" }}>
                          {perPerson ? "Per Person" : "Per Lane"}
                        </span>
                      </div>
                    )}
                    <div className="p-4">
                      <h3 className="font-[var(--font-hp-display)] uppercase text-white text-sm tracking-wider mb-1">{offer.Name}</h3>
                      {offer.Description && <p className="font-[var(--font-hp-body)] text-white/50 text-xs mb-3">{stripHtml(offer.Description)}</p>}

                      {/* Duration/price options */}
                      <div className="space-y-2">
                        {(offer.Items || []).filter(item => !item.Reason || item.Remaining > 0).map(item => (
                          <button
                            key={item.ItemId}
                            onClick={() => selectOffer(offer, { Id: item.ItemId, Name: offer.Name, Price: item.Total, Duration: formatDuration(item.Quantity, item.QuantityType) })}
                            className="w-full flex items-center justify-between rounded-lg p-3 cursor-pointer transition-all hover:bg-white/5"
                            style={{ border: "1px solid rgba(255,255,255,0.1)" }}
                          >
                            <div className="text-left">
                              {hasMultipleItems && (
                                <span className="font-[var(--font-hp-body)] text-white text-sm font-bold">{formatDuration(item.Quantity, item.QuantityType)}</span>
                              )}
                              {!hasMultipleItems && item.Quantity > 0 && (
                                <span className="font-[var(--font-hp-body)] text-white/50 text-xs">{formatDuration(item.Quantity, item.QuantityType)}</span>
                              )}
                              {item.Remaining > 0 && (
                                <span className="font-[var(--font-hp-body)] text-white/30 text-xs ml-2">{item.Remaining} lanes left</span>
                              )}
                            </div>
                            <div className="text-right">
                              <span className="font-[var(--font-hp-display)] text-lg" style={{ color: gold }}>${item.Total.toFixed(2)}</span>
                              {perPerson && (
                                <span className="font-[var(--font-hp-body)] text-white/40 text-[10px] block">${perPersonPrice.toFixed(2)}/person</span>
                              )}
                              {!perPerson && (
                                <span className="font-[var(--font-hp-body)] text-white/40 text-[10px] block">per lane</span>
                              )}
                            </div>
                          </button>
                        ))}
                        {/* Show alternatives if main items unavailable */}
                        {offer.Items?.every(i => i.Reason && i.Remaining === 0) && offer.Items?.[0]?.Alternatives?.length > 0 && (
                          <div>
                            <p className="font-[var(--font-hp-body)] text-white/40 text-xs mb-2">Not available at selected time. Try:</p>
                            {offer.Items[0].Alternatives.filter(a => a.Remaining > 0).slice(0, 3).map(alt => (
                              <button
                                key={alt.Time}
                                onClick={() => {
                                  setSelectedTime(alt.Time);
                                  selectOffer(offer, { Id: offer.OfferId, Name: offer.Name, Price: alt.Total, Duration: "" });
                                }}
                                className="w-full flex items-center justify-between rounded-lg p-2 mb-1 cursor-pointer transition-all hover:bg-white/5"
                                style={{ border: "1px solid rgba(255,255,255,0.08)" }}
                              >
                                <span className="font-[var(--font-hp-body)] text-white text-sm">{formatTimeStr(alt.Time)}</span>
                                <span className="font-[var(--font-hp-display)] text-base" style={{ color: gold }}>${alt.Total.toFixed(2)}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {filteredOffers.length === 0 && (
              <p className="font-[var(--font-hp-body)] text-white/40 text-sm text-center py-8">No packages available for this time and lane type.</p>
            )}
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer">&larr; Back</button>
          </div>
        )}

        {/* ── EXTRAS ── */}
        {step === "extras" && !loading && (
          <div>
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-4 text-center">Add Extras</h2>
            {shoes.length > 0 && (
              <div className="rounded-lg p-4 mb-4" style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${cyan}25` }}>
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-[var(--font-hp-body)] text-white font-bold text-sm">Bowling Shoes</h3>
                    <p className="font-[var(--font-hp-body)] text-white/40 text-xs">${shoes[0].Price}/person</p>
                  </div>
                  <button onClick={() => setWantShoes(!wantShoes)}
                    className="w-12 h-7 rounded-full transition-all cursor-pointer" style={{ backgroundColor: wantShoes ? coral : "rgba(255,255,255,0.1)" }}>
                    <div className="w-5 h-5 rounded-full bg-white transition-all" style={{ marginLeft: wantShoes ? "26px" : "2px" }} />
                  </button>
                </div>
              </div>
            )}
            {extras.length > 0 && (
              <div className="space-y-2 mb-6">
                {extras.map(ex => {
                  const isSel = selectedExtras.has(ex.Id) && selectedExtras.get(ex.Id)! > 0;
                  return (
                    <button key={ex.Id} onClick={() => toggleExtra(ex.Id)}
                      className="w-full rounded-lg p-4 text-left transition-all cursor-pointer"
                      style={{ backgroundColor: isSel ? `${coral}10` : "rgba(7,16,39,0.5)", border: `1.78px dashed ${isSel ? coral : "rgba(255,255,255,0.1)"}` }}>
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="font-[var(--font-hp-body)] text-white font-bold text-sm">{ex.Name}</h3>
                          {ex.Description && <p className="font-[var(--font-hp-body)] text-white/40 text-xs">{stripHtml(ex.Description)}</p>}
                        </div>
                        <span className="font-[var(--font-hp-display)] text-base" style={{ color: isSel ? coral : gold }}>${ex.Price}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            <button onClick={goToReview}
              className="w-full py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
              style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}>Review Order</button>
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
          </div>
        )}

        {/* ── REVIEW ── */}
        {step === "review" && !loading && cartSummary && (
          <div>
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-4 text-center">Order Summary</h2>
            <div className="rounded-lg p-5 mb-6" style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${gold}30` }}>
              <div className="space-y-2 mb-4 pb-4 border-b border-white/10">
                <div className="flex justify-between">
                  <span className="font-[var(--font-hp-body)] text-white text-sm">{selectedOffer?.Name}</span>
                  <span className="font-[var(--font-hp-body)] text-white text-sm">${selectedTariff?.Price}</span>
                </div>
                <p className="font-[var(--font-hp-body)] text-white/50 text-xs">
                  {new Date(calYear, calMonth, parseInt(selectedDate.split("-")[2])).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} at {formatTimeStr(selectedTime)} &bull; {playerCount} bowlers
                </p>
              </div>
              <div className="space-y-1 mb-4 pb-4 border-b border-white/10">
                <div className="flex justify-between"><span className="font-[var(--font-hp-body)] text-white/60 text-sm">Subtotal</span><span className="font-[var(--font-hp-body)] text-white text-sm">${cartSummary.TotalItems.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="font-[var(--font-hp-body)] text-white/60 text-sm">Tax</span><span className="font-[var(--font-hp-body)] text-white text-sm">${cartSummary.AddedTaxes.toFixed(2)}</span></div>
              </div>
              <div className="flex justify-between">
                <span className="font-[var(--font-hp-body)] text-white font-bold">Total</span>
                <span className="font-[var(--font-hp-display)] text-xl" style={{ color: gold }}>${(cartSummary.TotalWithTaxes || cartSummary.TotalWithoutTaxes).toFixed(2)}</span>
              </div>
            </div>
            <button onClick={() => setStep("details")}
              className="w-full py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
              style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}>Continue to Payment</button>
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
          </div>
        )}

        {/* ── DETAILS ── */}
        {step === "details" && !loading && (
          <div>
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-4 text-center">Your Details</h2>
            <div className="space-y-3 mb-6">
              <input type="text" placeholder="Full Name" value={guestName} onChange={e => setGuestName(e.target.value)}
                className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3.5 text-white font-[var(--font-hp-body)] text-sm placeholder:text-white/20 focus:outline-none focus:border-[#fd5b56]/50 transition-colors" />
              <input type="email" placeholder="Email" value={guestEmail} onChange={e => setGuestEmail(e.target.value)}
                className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3.5 text-white font-[var(--font-hp-body)] text-sm placeholder:text-white/20 focus:outline-none focus:border-[#fd5b56]/50 transition-colors" />
              <input type="tel" placeholder="Phone Number" value={guestPhone} onChange={e => setGuestPhone(e.target.value)}
                className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3.5 text-white font-[var(--font-hp-body)] text-sm placeholder:text-white/20 focus:outline-none focus:border-[#fd5b56]/50 transition-colors" />
            </div>
            <button onClick={submitBooking} disabled={loading}
              className="w-full py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-[#0a1628] cursor-pointer transition-all hover:scale-[1.02] disabled:opacity-50"
              style={{ backgroundColor: gold, boxShadow: `0 0 16px ${gold}30` }}>
              {loading ? "Processing..." : "Pay & Confirm"}
            </button>
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
          </div>
        )}
      </section>
    </div>
  );
}
