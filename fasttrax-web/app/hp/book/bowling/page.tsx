"use client";

import { useState, useEffect, useCallback, useRef } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type Step = "location" | "date" | "players" | "offer" | "extras" | "review" | "details";

interface OpenDate {
  Date: string;
  IsOpen: boolean;
  StartBookingTime: string | null;
  EndBookingTime: string | null;
}

interface Tariff {
  Id: number;
  Name: string;
  Price: number;
  Duration: string;
  PlayerType: { Id: number; Name: string };
}

interface Offer {
  OfferId: number;
  Name: string;
  Description: string;
  ImageUrl: string;
  Tariffs: Tariff[];
}

interface ShoeOption {
  Name: string;
  Price: number;
  PriceKeyId: number;
  PlayerTypeId: number;
}

interface Extra {
  Id: number;
  Name: string;
  Price: number;
  ImageUrl: string;
  Description: string;
  ItemType: string;
}

interface CartSummary {
  TotalWithoutTaxes: number;
  TotalItems: number;
  AddedTaxes: number;
  TotalWithTaxes: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const API = "/api/qamf";
const LOCATIONS = [
  { id: "9172", name: "HeadPinz Fort Myers", address: "14513 Global Pkwy, Fort Myers" },
  { id: "3148", name: "HeadPinz Naples", address: "8525 Radio Ln, Naples" },
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

function formatDate(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function formatTime(iso: string) {
  const t = iso.split("T")[1];
  if (!t) return iso;
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function stripHtml(html: string) {
  return html.replace(/<[^>]*>/g, "").trim();
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function BowlingBookingPage() {
  const [step, setStep] = useState<Step>("location");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Booking state
  const [centerId, setCenterId] = useState("");
  const [centerName, setCenterName] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedTime, setSelectedTime] = useState("");
  const [playerCount, setPlayerCount] = useState(2);
  const [selectedOffer, setSelectedOffer] = useState<Offer | null>(null);
  const [selectedTariff, setSelectedTariff] = useState<Tariff | null>(null);
  const [reservationKey, setReservationKey] = useState("");

  // Data from API
  const [openDates, setOpenDates] = useState<OpenDate[]>([]);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [shoes, setShoes] = useState<ShoeOption[]>([]);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [cartSummary, setCartSummary] = useState<CartSummary | null>(null);

  // Cart selections
  const [wantShoes, setWantShoes] = useState(true);
  const [selectedExtras, setSelectedExtras] = useState<Map<number, number>>(new Map());

  // Guest details
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");

  // Keep-alive timer
  const keepAliveRef = useRef<NodeJS.Timeout | null>(null);

  const startKeepAlive = useCallback((key: string, cid: string) => {
    if (keepAliveRef.current) clearInterval(keepAliveRef.current);
    keepAliveRef.current = setInterval(() => {
      qamf(`centers/${cid}/reservations/${key}/lifetime`, { method: "PATCH" }).catch(() => {});
    }, 120000); // every 2 min
  }, []);

  useEffect(() => {
    return () => { if (keepAliveRef.current) clearInterval(keepAliveRef.current); };
  }, []);

  /* ── Step handlers ───────────────────────────────────────────── */

  async function selectLocation(loc: typeof LOCATIONS[0]) {
    setCenterId(loc.id);
    setCenterName(loc.name);
    setLoading(true);
    setError("");
    try {
      const today = new Date().toISOString().split("T")[0];
      const end = new Date(Date.now() + 90 * 86400000).toISOString().split("T")[0];
      const data = await qamf(`centers/${loc.id}/opening-times/bookforlater/range?fromDate=${today}&toDate=${end}`);
      setOpenDates((data.Dates || []).filter((d: OpenDate) => d.IsOpen));
      setStep("date");
    } catch {
      setError("Failed to load dates");
    } finally {
      setLoading(false);
    }
  }

  async function selectDate(date: string, startTime: string) {
    setSelectedDate(date);
    setSelectedTime(startTime);
    setStep("players");
  }

  async function selectPlayers() {
    setLoading(true);
    setError("");
    try {
      const dt = selectedTime || `${selectedDate}T12:00`;
      const data = await qamf(
        `centers/${centerId}/offers-availability?systemId=${centerId}&datetime=${encodeURIComponent(dt)}&players=1-${playerCount}&page=1&itemsPerPage=50`
      );
      setOffers(Array.isArray(data) ? data : []);
      setStep("offer");
    } catch {
      setError("Failed to load offers");
    } finally {
      setLoading(false);
    }
  }

  async function selectOffer(offer: Offer, tariff: Tariff) {
    setSelectedOffer(offer);
    setSelectedTariff(tariff);
    setLoading(true);
    setError("");
    try {
      // Create temp reservation
      const reservation = await qamf(`centers/${centerId}/reservations/temporary-request/book-for-later`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          DateFrom: selectedTime || `${selectedDate}T12:00`,
          WebOfferId: offer.OfferId,
          WebOfferTariffId: tariff.Id,
          PlayersList: [{ TypeId: 1, Number: playerCount }],
        }),
      });
      setReservationKey(reservation.ReservationKey);
      startKeepAlive(reservation.ReservationKey, centerId);

      // Fetch shoes and extras in parallel
      const dt = encodeURIComponent(selectedTime || `${selectedDate}T12:00`);
      const [shoesData, extrasData] = await Promise.all([
        qamf(`centers/${centerId}/offers/${offer.OfferId}/shoes-socks-offer?systemId=${centerId}&datetime=${dt}`).catch(() => ({ Shoes: [] })),
        qamf(`centers/${centerId}/offers/extras?systemId=${centerId}&datetime=${dt}&offerId=${offer.OfferId}&page=1&itemsPerPage=50`).catch(() => []),
      ]);
      setShoes(shoesData.Shoes || []);
      setExtras(Array.isArray(extrasData) ? extrasData : []);
      setStep("extras");
    } catch {
      setError("Failed to create reservation");
    } finally {
      setLoading(false);
    }
  }

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
          Time: selectedTime || `${selectedDate}T12:00`,
          Items: { Extra: extraItems, FoodAndBeverage: [], Shoes: shoeItems },
          Bumpers: [],
          OfferId: selectedOffer!.OfferId,
          TariffId: selectedTariff!.Id,
          NumberOfPlayers: playerCount,
          ReservationKey: reservationKey,
        }),
      });
      setCartSummary(summary);
      setStep("review");
    } catch {
      setError("Failed to calculate total");
    } finally {
      setLoading(false);
    }
  }

  async function submitBooking() {
    if (!guestName || !guestEmail || !guestPhone) {
      setError("Please fill in all fields");
      return;
    }
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

      const cartItems = [
        { Name: selectedOffer!.Name, Quantity: 1, UnitPrice: selectedTariff!.Price, IsOffer: true },
        ...shoeItems.map(s => ({ Name: "Bowling Shoes", Quantity: s.Quantity, UnitPrice: s.UnitPrice, IsOffer: false })),
        ...extraItems.map(e => {
          const ex = extras.find(x => x.Id === e.PriceKeyId);
          return { Name: ex?.Name || "Extra", Quantity: e.Quantity, UnitPrice: e.UnitPrice, IsOffer: false };
        }),
      ];

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
          },
        }),
      });

      if (result.NeedPayment && result.ApprovePayment?.Url) {
        // Store reservation info for confirmation page
        sessionStorage.setItem("qamf_reservation", JSON.stringify({
          key: reservationKey,
          centerId,
          centerName,
          operationId: result.OperationId,
          offer: selectedOffer?.Name,
          date: selectedDate,
          time: selectedTime,
          players: playerCount,
        }));
        // Redirect to Square payment
        window.location.href = result.ApprovePayment.Url;
      }
    } catch {
      setError("Failed to submit booking");
    } finally {
      setLoading(false);
    }
  }

  /* ── Render helpers ──────────────────────────────────────────── */

  const stepIndex = ["location", "date", "players", "offer", "extras", "review", "details"].indexOf(step);
  const stepLabels = ["Location", "Date", "Bowlers", "Package", "Extras", "Review", "Pay"];

  function goBack() {
    const steps: Step[] = ["location", "date", "players", "offer", "extras", "review", "details"];
    const idx = steps.indexOf(step);
    if (idx > 0) setStep(steps[idx - 1]);
    setError("");
  }

  function toggleExtra(id: number) {
    const next = new Map(selectedExtras);
    if (next.has(id) && next.get(id)! > 0) {
      next.delete(id);
    } else {
      next.set(id, 1);
    }
    setSelectedExtras(next);
  }

  /* ── Render ──────────────────────────────────────────────────── */

  return (
    <div className="min-h-screen bg-[#0a1628]">
      {/* Header */}
      <section className="pt-28 pb-6 px-4 text-center">
        <h1
          className="font-[var(--font-hp-hero)] font-black uppercase text-white"
          style={{ fontSize: "clamp(24px, 5vw, 40px)", textShadow: `0 0 30px ${coral}30` }}
        >
          Book Bowling
        </h1>
        {centerName && (
          <p className="font-[var(--font-hp-body)] text-white/50 text-sm mt-1">{centerName}</p>
        )}

        {/* Progress bar */}
        <div className="max-w-md mx-auto mt-6 flex items-center gap-1">
          {stepLabels.map((label, i) => (
            <div key={label} className="flex-1 text-center">
              <div
                className="h-1 rounded-full mb-1 transition-all"
                style={{ backgroundColor: i <= stepIndex ? coral : "rgba(255,255,255,0.1)" }}
              />
              <span
                className="font-[var(--font-hp-body)] text-[10px] uppercase tracking-wider"
                style={{ color: i <= stepIndex ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.2)" }}
              >
                {label}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Error */}
      {error && (
        <div className="max-w-lg mx-auto px-4 mb-4">
          <div className="bg-[#fd5b56]/10 border border-[#fd5b56]/30 rounded-lg px-4 py-3 text-center">
            <p className="font-[var(--font-hp-body)] text-[#fd5b56] text-sm">{error}</p>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="text-center py-12">
          <div className="inline-block w-8 h-8 border-2 border-white/20 border-t-[#fd5b56] rounded-full animate-spin" />
        </div>
      )}

      {/* Steps */}
      <section className="max-w-lg mx-auto px-4 pb-20">
        {/* ── LOCATION ── */}
        {step === "location" && !loading && (
          <div className="space-y-3">
            {LOCATIONS.map(loc => (
              <button
                key={loc.id}
                onClick={() => selectLocation(loc)}
                className="w-full rounded-lg p-5 text-left transition-all hover:scale-[1.01] cursor-pointer"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${coral}30` }}
              >
                <h3 className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider">{loc.name}</h3>
                <p className="font-[var(--font-hp-body)] text-white/50 text-sm">{loc.address}</p>
              </button>
            ))}
          </div>
        )}

        {/* ── DATE ── */}
        {step === "date" && !loading && (
          <div>
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-4 text-center">Select a Date</h2>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-[60vh] overflow-y-auto pr-1">
              {openDates.slice(0, 28).map(d => (
                <button
                  key={d.Date}
                  onClick={() => selectDate(d.Date, d.StartBookingTime || `${d.Date}T12:00`)}
                  className="rounded-lg p-3 text-center transition-all hover:scale-[1.02] cursor-pointer"
                  style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${gold}25` }}
                >
                  <span className="font-[var(--font-hp-body)] text-white text-sm font-bold block">{formatDate(d.Date)}</span>
                  {d.StartBookingTime && (
                    <span className="font-[var(--font-hp-body)] text-white/40 text-xs">{formatTime(d.StartBookingTime)}</span>
                  )}
                </button>
              ))}
            </div>
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer">&larr; Back</button>
          </div>
        )}

        {/* ── PLAYERS ── */}
        {step === "players" && !loading && (
          <div className="text-center">
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-2">How Many Bowlers?</h2>
            <p className="font-[var(--font-hp-body)] text-white/40 text-sm mb-6">Up to 6 per lane</p>
            <div className="flex items-center justify-center gap-6 mb-8">
              <button
                onClick={() => setPlayerCount(Math.max(1, playerCount - 1))}
                className="w-14 h-14 rounded-full flex items-center justify-center text-2xl text-white cursor-pointer transition-all hover:scale-105"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${coral}30` }}
              >
                -
              </button>
              <span className="font-[var(--font-hp-display)] text-white text-5xl" style={{ color: gold }}>{playerCount}</span>
              <button
                onClick={() => setPlayerCount(Math.min(24, playerCount + 1))}
                className="w-14 h-14 rounded-full flex items-center justify-center text-2xl text-white cursor-pointer transition-all hover:scale-105"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${coral}30` }}
              >
                +
              </button>
            </div>
            <button
              onClick={selectPlayers}
              className="w-full py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
              style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}
            >
              Continue
            </button>
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
          </div>
        )}

        {/* ── OFFER ── */}
        {step === "offer" && !loading && (
          <div>
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-4 text-center">Choose a Package</h2>
            <div className="space-y-3">
              {offers.map(offer => (
                <div
                  key={offer.OfferId}
                  className="rounded-lg overflow-hidden"
                  style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${coral}25` }}
                >
                  <div className="p-4">
                    <h3 className="font-[var(--font-hp-display)] uppercase text-white text-sm tracking-wider mb-1">{offer.Name}</h3>
                    {offer.Description && (
                      <p className="font-[var(--font-hp-body)] text-white/50 text-xs mb-3">{stripHtml(offer.Description)}</p>
                    )}
                    <div className="space-y-2">
                      {offer.Tariffs?.map(tariff => (
                        <button
                          key={tariff.Id}
                          onClick={() => selectOffer(offer, tariff)}
                          className="w-full flex items-center justify-between rounded-lg p-3 cursor-pointer transition-all hover:bg-white/5"
                          style={{ border: `1px solid rgba(255,255,255,0.1)` }}
                        >
                          <div className="text-left">
                            <span className="font-[var(--font-hp-body)] text-white text-sm font-bold">{tariff.Name}</span>
                            {tariff.Duration && (
                              <span className="font-[var(--font-hp-body)] text-white/40 text-xs ml-2">{tariff.Duration}</span>
                            )}
                          </div>
                          <span className="font-[var(--font-hp-display)] text-lg" style={{ color: gold }}>${tariff.Price}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer">&larr; Back</button>
          </div>
        )}

        {/* ── EXTRAS ── */}
        {step === "extras" && !loading && (
          <div>
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-4 text-center">Add Extras</h2>

            {/* Shoes */}
            {shoes.length > 0 && (
              <div
                className="rounded-lg p-4 mb-4"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${cyan}25` }}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-[var(--font-hp-body)] text-white font-bold text-sm">Bowling Shoes</h3>
                    <p className="font-[var(--font-hp-body)] text-white/40 text-xs">${shoes[0].Price}/person</p>
                  </div>
                  <button
                    onClick={() => setWantShoes(!wantShoes)}
                    className="w-12 h-7 rounded-full transition-all cursor-pointer"
                    style={{ backgroundColor: wantShoes ? coral : "rgba(255,255,255,0.1)" }}
                  >
                    <div
                      className="w-5 h-5 rounded-full bg-white transition-all"
                      style={{ marginLeft: wantShoes ? "26px" : "2px" }}
                    />
                  </button>
                </div>
              </div>
            )}

            {/* Other extras */}
            {extras.length > 0 && (
              <div className="space-y-2 mb-6">
                {extras.map(ex => {
                  const isSelected = selectedExtras.has(ex.Id) && selectedExtras.get(ex.Id)! > 0;
                  return (
                    <button
                      key={ex.Id}
                      onClick={() => toggleExtra(ex.Id)}
                      className="w-full rounded-lg p-4 text-left transition-all cursor-pointer"
                      style={{
                        backgroundColor: isSelected ? `${coral}10` : "rgba(7,16,39,0.5)",
                        border: `1.78px dashed ${isSelected ? coral : "rgba(255,255,255,0.1)"}`,
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="font-[var(--font-hp-body)] text-white font-bold text-sm">{ex.Name}</h3>
                          {ex.Description && <p className="font-[var(--font-hp-body)] text-white/40 text-xs">{stripHtml(ex.Description)}</p>}
                        </div>
                        <span className="font-[var(--font-hp-display)] text-base" style={{ color: isSelected ? coral : gold }}>${ex.Price}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            <button
              onClick={goToReview}
              className="w-full py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
              style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}
            >
              Review Order
            </button>
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
          </div>
        )}

        {/* ── REVIEW ── */}
        {step === "review" && !loading && cartSummary && (
          <div>
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-4 text-center">Order Summary</h2>

            <div
              className="rounded-lg p-5 mb-6"
              style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${gold}30` }}
            >
              <div className="space-y-2 mb-4 pb-4 border-b border-white/10">
                <div className="flex justify-between">
                  <span className="font-[var(--font-hp-body)] text-white text-sm">{selectedOffer?.Name}</span>
                  <span className="font-[var(--font-hp-body)] text-white text-sm">${selectedTariff?.Price}</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-[var(--font-hp-body)] text-white/50 text-xs">{formatDate(selectedDate)} &bull; {playerCount} bowlers</span>
                </div>
              </div>

              <div className="space-y-1 mb-4 pb-4 border-b border-white/10">
                <div className="flex justify-between">
                  <span className="font-[var(--font-hp-body)] text-white/60 text-sm">Subtotal</span>
                  <span className="font-[var(--font-hp-body)] text-white text-sm">${cartSummary.TotalItems.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-[var(--font-hp-body)] text-white/60 text-sm">Tax</span>
                  <span className="font-[var(--font-hp-body)] text-white text-sm">${cartSummary.AddedTaxes.toFixed(2)}</span>
                </div>
              </div>

              <div className="flex justify-between">
                <span className="font-[var(--font-hp-body)] text-white font-bold">Total</span>
                <span className="font-[var(--font-hp-display)] text-xl" style={{ color: gold }}>
                  ${cartSummary.TotalWithTaxes?.toFixed(2) || cartSummary.TotalWithoutTaxes?.toFixed(2)}
                </span>
              </div>
            </div>

            <button
              onClick={() => setStep("details")}
              className="w-full py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-white cursor-pointer transition-all hover:scale-[1.02]"
              style={{ backgroundColor: coral, boxShadow: `0 0 16px ${coral}30` }}
            >
              Continue to Payment
            </button>
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
          </div>
        )}

        {/* ── DETAILS ── */}
        {step === "details" && !loading && (
          <div>
            <h2 className="font-[var(--font-hp-display)] uppercase text-white text-lg tracking-wider mb-4 text-center">Your Details</h2>

            <div className="space-y-3 mb-6">
              <input
                type="text"
                placeholder="Full Name"
                value={guestName}
                onChange={e => setGuestName(e.target.value)}
                className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3.5 text-white font-[var(--font-hp-body)] text-sm placeholder:text-white/20 focus:outline-none focus:border-[#fd5b56]/50 transition-colors"
              />
              <input
                type="email"
                placeholder="Email"
                value={guestEmail}
                onChange={e => setGuestEmail(e.target.value)}
                className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3.5 text-white font-[var(--font-hp-body)] text-sm placeholder:text-white/20 focus:outline-none focus:border-[#fd5b56]/50 transition-colors"
              />
              <input
                type="tel"
                placeholder="Phone Number"
                value={guestPhone}
                onChange={e => setGuestPhone(e.target.value)}
                className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3.5 text-white font-[var(--font-hp-body)] text-sm placeholder:text-white/20 focus:outline-none focus:border-[#fd5b56]/50 transition-colors"
              />
            </div>

            <button
              onClick={submitBooking}
              disabled={loading}
              className="w-full py-3.5 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider text-[#0a1628] cursor-pointer transition-all hover:scale-[1.02] disabled:opacity-50"
              style={{ backgroundColor: gold, boxShadow: `0 0 16px ${gold}30` }}
            >
              {loading ? "Processing..." : "Pay & Confirm"}
            </button>
            <button onClick={goBack} className="mt-4 font-[var(--font-hp-body)] text-white/40 text-sm cursor-pointer block mx-auto">&larr; Back</button>
          </div>
        )}
      </section>
    </div>
  );
}
