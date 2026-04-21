"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { RacerType, RaceCategory, ClassifiedProduct, SmsPage, SmsProposal, SmsBlock } from "./data";
import { classifyProducts, filterProducts } from "./data";
import type { PackBookingResult } from "./components/PackHeatPicker";

/** A completed race booking for one category (adult or junior) */
interface Booking {
  product: ClassifiedProduct;
  quantity: number;
  proposal: SmsProposal;
  block: SmsBlock;
}
import type { ContactInfo } from "./components/ContactForm";
import ExperiencePicker from "./components/ExperiencePicker";
import PartySizePicker from "./components/PartySizePicker";
import DatePicker from "./components/DatePicker";
import ProductPicker from "./components/ProductPicker";
import HeatPicker from "./components/HeatPicker";
import PackHeatPicker from "./components/PackHeatPicker";
import ContactForm from "./components/ContactForm";
import OrderSummary from "./components/OrderSummary";

type Step = "experience" | "party" | "date" | "product" | "heat" | "contact" | "summary";

const STEPS: Step[] = ["experience", "party", "date", "product", "heat", "contact", "summary"];
const STEP_LABELS: Record<Step, string> = {
  experience: "Type",
  party: "Party",
  date: "Date",
  product: "Race",
  heat: "Heat",
  contact: "Details",
  summary: "Pay",
};

export default function BookRacingPage() {
  // Redirect to /book/race — this route is disabled
  useEffect(() => { window.location.href = "/book/race"; }, []);

  const [step, setStep] = useState<Step>("experience");
  const [racerType, setRacerType] = useState<RacerType | null>(null);
  const [adults, setAdults] = useState(1);
  const [juniors, setJuniors] = useState(0);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [catalogProducts, setCatalogProducts] = useState<ClassifiedProduct[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  // Multi-booking: track which category we're currently booking for
  const [bookingCategory, setBookingCategory] = useState<RaceCategory>("adult");
  const [bookings, setBookings] = useState<Booking[]>([]);
  // Current in-progress selection
  const [selectedProduct, setSelectedProduct] = useState<ClassifiedProduct | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [selectedProposal, setSelectedProposal] = useState<SmsProposal | null>(null);
  const [selectedBlock, setSelectedBlock] = useState<SmsBlock | null>(null);
  const [contact, setContact] = useState<ContactInfo | null>(null);
  // Pack booking state — when a pack is booked, the bill is already created
  const [packResult, setPackResult] = useState<PackBookingResult | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);
  const nextBtnRef = useRef<HTMLDivElement>(null);

  const currentIdx = STEPS.indexOf(step);

  // Scroll to top of content when step changes
  useEffect(() => {
    contentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [step]);

  // Fetch product catalog when date is selected
  const fetchCatalog = useCallback(async (date: string) => {
    setCatalogLoading(true);
    try {
      const dateOnly = date.split("T")[0];
      const isoDate = `${dateOnly}T00:00:00.000Z`;
      const res = await fetch(`/api/sms?endpoint=page&date=${encodeURIComponent(isoDate)}`);
      if (!res.ok) throw new Error("Failed to fetch products");
      const pages: SmsPage[] = await res.json();
      const classified = classifyProducts(pages);
      setCatalogProducts(classified);
    } catch (err) {
      console.error("Failed to fetch catalog:", err);
      setCatalogProducts([]);
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  // ── Handlers ─────────────────────────────────────────────────────────────

  function handleExperienceSelect(type: RacerType) {
    setRacerType(type);
    // Auto-advance to party size
    setTimeout(() => setStep("party"), 300);
  }

  function handlePartyNext() {
    setStep("date");
  }

  function handleDateSelect(date: string) {
    setSelectedDate(date);
    setSelectedProduct(null);
    setSelectedProposal(null);
    setSelectedBlock(null);
    setBookings([]);
    // Start with adults if any, otherwise juniors
    setBookingCategory(adults > 0 ? "adult" : "junior");
    fetchCatalog(date);

    // Mega Tuesday + first-time Junior racers → no qualifying product.
    // Hold on the date step so the inline warning renders and the
    // guest can adjust before progressing.
    const [y, m, d] = date.split("T")[0].split("-").map(Number);
    const isTuesday = new Date(y, m - 1, d).getDay() === 2;
    const hasNewJuniors = racerType === "new" && juniors > 0;
    if (isTuesday && hasNewJuniors) return;

    setStep("product");
  }

  function handleProductSelect(product: ClassifiedProduct) {
    setSelectedProduct(product);
    // Set quantity based on party size for this category
    const q = product.category === "adult" ? adults : juniors;
    setQuantity(Math.max(1, q));
    // Auto-advance to heat selection
    setTimeout(() => setStep("heat"), 300);
  }

  function handlePackComplete(result: PackBookingResult) {
    setPackResult(result);
    // Pack bookings create the bill during heat selection, so skip straight to contact
    // (We still need contact info for the reservation)
    setStep("contact");
  }

  function handleConfirmHeat(proposal: SmsProposal, block: SmsBlock) {
    // Save this booking
    const booking: Booking = {
      product: selectedProduct!,
      quantity,
      proposal,
      block,
    };
    const updatedBookings = [...bookings, booking];
    setBookings(updatedBookings);
    setSelectedProposal(proposal);
    setSelectedBlock(block);

    // Check if we need to book another category
    const bookedCategories = new Set(updatedBookings.map(b => b.product.category));
    const needAdult = adults > 0 && !bookedCategories.has("adult");
    const needJunior = juniors > 0 && !bookedCategories.has("junior");

    if (needAdult) {
      setBookingCategory("adult");
      setSelectedProduct(null);
      setSelectedProposal(null);
      setSelectedBlock(null);
      setStep("product");
    } else if (needJunior) {
      setBookingCategory("junior");
      setSelectedProduct(null);
      setSelectedProposal(null);
      setSelectedBlock(null);
      setStep("product");
    } else {
      // All categories booked — proceed to contact
      setStep("contact");
    }
  }

  function handleContactSubmit(info: ContactInfo) {
    setContact(info);
    setStep("summary");
  }

  function goToStep(s: Step) {
    const targetIdx = STEPS.indexOf(s);
    if (targetIdx < currentIdx) {
      setStep(s);
      // Reset downstream selections when going back
      if (targetIdx < STEPS.indexOf("product")) {
        setSelectedProduct(null);
        setSelectedProposal(null);
        setSelectedBlock(null);
        setBookings([]);
        setPackResult(null);
        setBookingCategory(adults > 0 ? "adult" : "junior");
      }
    }
  }

  // Filter catalog products based on racer type + party composition + current booking category
  const filteredProducts = racerType
    ? filterProducts(catalogProducts, racerType, adults, juniors)
        .filter(p => p.category === bookingCategory)
    : [];

  const partyTotal = adults + juniors;

  return (
    <div className="min-h-screen bg-[#000418] pt-[180px]">
      {/* Sticky header: steps + banner */}
      <div className="sticky top-[128px] z-30">
        <div className="border-b border-white/8 bg-[#000418]">
          {/* Step indicator */}
          <div className="max-w-4xl mx-auto px-4 py-3 overflow-x-auto">
            <div className="flex items-center gap-0 min-w-max">
              {STEPS.map((s, i) => {
                const isPast = i < currentIdx;
                const isCurrent = i === currentIdx;
                const isFuture = i > currentIdx;
                return (
                  <div key={s} className="flex items-center">
                    <button
                      onClick={() => isPast && goToStep(s)}
                      disabled={isFuture}
                      className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
                        isCurrent ? "text-[#00E2E5]" :
                        isPast ? "text-white/60 hover:text-white/80 cursor-pointer" :
                        "text-white/20 cursor-not-allowed"
                      }`}
                    >
                      <span className={`w-5 h-5 rounded-full text-xs flex items-center justify-center font-bold ${
                        isCurrent ? "bg-[#00E2E5] text-[#000418]" :
                        isPast ? "bg-white/20 text-white" :
                        "bg-white/8 text-white/20"
                      }`}>
                        {isPast ? "✓" : i + 1}
                      </span>
                      <span className="hidden sm:inline">{STEP_LABELS[s]}</span>
                    </button>
                    {i < STEPS.length - 1 && <span className="text-white/15 mx-0.5">›</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

      </div>

      {/* Main content */}
      <div ref={contentRef} className="max-w-4xl mx-auto px-4 py-8 scroll-mt-[180px]">

        {/* STEP 1: Experience level — auto-advances on selection */}
        {step === "experience" && (
          <ExperiencePicker selected={racerType} onSelect={handleExperienceSelect} />
        )}

        {/* STEP 2: Party composition */}
        {step === "party" && (
          <div className="space-y-8">
            <PartySizePicker
              adults={adults}
              juniors={juniors}
              onAdultsChange={setAdults}
              onJuniorsChange={setJuniors}
            />
            <div className="flex items-center justify-between">
              <button onClick={() => setStep("experience")} className="text-sm text-white/40 hover:text-white/70 transition-colors">
                ← Back
              </button>
              {partyTotal > 0 && (
                <button
                  onClick={handlePartyNext}
                  className="inline-flex items-center gap-2 px-8 py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25"
                >
                  Next: Pick a Date →
                </button>
              )}
            </div>
          </div>
        )}

        {/* STEP 3: Date */}
        {step === "date" && (() => {
          // Tuesday = Mega Day; first-time Junior races aren't run on
          // Mega. Show an inline warning + offer a way back.
          const isMegaTuesday = (() => {
            if (!selectedDate) return false;
            const [y, m, d] = selectedDate.split("T")[0].split("-").map(Number);
            return new Date(y, m - 1, d).getDay() === 2;
          })();
          const hasNewJuniors = racerType === "new" && juniors > 0;
          const blockedForJuniors = isMegaTuesday && hasNewJuniors;
          return (
            <div className="space-y-6">
              <DatePicker selected={selectedDate} onSelect={handleDateSelect} />
              {blockedForJuniors && (
                <div className="rounded-xl border-2 border-amber-400/50 bg-amber-400/10 p-5">
                  <div className="flex items-start gap-3">
                    <svg className="w-6 h-6 text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                    </svg>
                    <div className="flex-1">
                      <p className="text-amber-400 font-bold text-sm uppercase tracking-wider mb-1">
                        Heads up — Mega Tuesday
                      </p>
                      <p className="text-white/80 text-sm leading-relaxed mb-3">
                        Tuesdays run on the Mega Track only, and first-time Junior
                        races aren&apos;t offered on Mega. Your{" "}
                        {juniors === 1 ? "junior racer" : `${juniors} junior racers`}{" "}
                        won&apos;t have a race to book on this date.
                      </p>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <button
                          type="button"
                          onClick={() => setSelectedDate(null)}
                          className="flex-1 px-4 py-2.5 rounded-lg font-body font-bold text-sm uppercase tracking-wider bg-amber-400 text-[#010A20] hover:bg-amber-300 transition-colors cursor-pointer"
                        >
                          Pick a different date
                        </button>
                        <button
                          type="button"
                          onClick={() => setStep("party")}
                          className="flex-1 px-4 py-2.5 rounded-lg font-body font-bold text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/20 hover:border-white/40 transition-colors cursor-pointer"
                        >
                          Change party
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              <button onClick={() => setStep("party")} className="text-sm text-white/40 hover:text-white/70 transition-colors">
                ← Change party size
              </button>
            </div>
          );
        })()}

        {/* STEP 4: Product selection */}
        {step === "product" && racerType && (
          <div className="space-y-8">
            {/* Show what's already been booked */}
            {bookings.length > 0 && (
              <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-4">
                <p className="text-green-400 text-xs font-semibold uppercase tracking-wider mb-2">Booked</p>
                {bookings.map((b, i) => (
                  <div key={i} className="flex justify-between text-sm text-white/70">
                    <span>{b.product.name} x{b.quantity}</span>
                    <span className="text-white/40">{new Date(b.block.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Category header when booking for a specific group */}
            {adults > 0 && juniors > 0 && (
              <div className="text-center">
                <p className="text-[#00E2E5] text-sm font-semibold">
                  Now pick a race for your {bookingCategory === "adult" ? `adult racer${adults > 1 ? "s" : ""} (${adults})` : `junior racer${juniors > 1 ? "s" : ""} (${juniors})`}
                </p>
              </div>
            )}

            {catalogLoading ? (
              <div className="flex flex-col items-center justify-center gap-4 min-h-[200px]">
                <div className="w-10 h-10 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
                <p className="text-white/50 text-sm">Loading available races…</p>
              </div>
            ) : (
              <>
                <ProductPicker
                  products={filteredProducts}
                  racerType={racerType}
                  adults={adults}
                  juniors={juniors}
                  selected={selectedProduct}
                  onSelect={handleProductSelect}
                />
              </>
            )}
            <button onClick={() => setStep("date")} className="text-sm text-white/40 hover:text-white/70 transition-colors">
              ← Change date
            </button>
          </div>
        )}

        {/* STEP 5: Heat + Quantity */}
        {step === "heat" && selectedProduct && selectedDate && (
          selectedProduct.packType !== "none" ? (
            <PackHeatPicker
              race={selectedProduct}
              date={selectedDate}
              quantity={quantity}
              onComplete={handlePackComplete}
              onBack={() => setStep("product")}
            />
          ) : (
            <HeatPicker
              race={selectedProduct}
              date={selectedDate}
              quantity={quantity}
              onQuantityChange={setQuantity}
              onConfirm={handleConfirmHeat}
              onBack={() => setStep("product")}
            />
          )
        )}

        {/* STEP 6: Contact info */}
        {step === "contact" && (
          <ContactForm
            initial={contact}
            onSubmit={handleContactSubmit}
            onBack={() => setStep("heat")}
          />
        )}

        {/* STEP 7: Order summary + payment */}
        {step === "summary" && selectedDate && contact && (packResult || bookings.length > 0) && (
          <OrderSummary
            bookings={bookings}
            date={selectedDate}
            contact={contact}
            onBack={() => setStep("contact")}
            packResult={packResult ?? undefined}
            packProduct={packResult ? selectedProduct ?? undefined : undefined}
            onRemovePack={async () => {
              // All 3 heats of a pack live on one orderId, so a single
              // bill cancel clears them all. Reset pack state + return
              // to the picker so the guest can pick something else
              // without going all the way back via "Start over".
              if (packResult?.billId) {
                try {
                  await fetch(
                    `/api/bmi?endpoint=${encodeURIComponent(`bill/${packResult.billId}/cancel`)}`,
                    { method: "DELETE" },
                  );
                } catch { /* best-effort */ }
              }
              setPackResult(null);
              setSelectedProduct(null);
              setStep("product");
            }}
          />
        )}
        {/* Dev tag */}
        <p className="text-white/10 text-xs text-center mt-12">SMS-Timing API</p>
      </div>
    </div>
  );
}
