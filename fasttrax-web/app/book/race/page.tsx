"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { RacerType, RaceCategory, ClassifiedProduct, BmiPage, BmiProposal, BmiBlock } from "./data";
import { classifyProducts, filterProducts, bmiGet, bmiDelete, bookRaceHeat, removeBookingLine } from "./data";
import type { PackBookingResult } from "./components/OrderSummary";

/** A completed race booking for one category (adult or junior) */
interface Booking {
  product: ClassifiedProduct;
  quantity: number;
  proposal: BmiProposal;
  block: BmiBlock;
  blockPrice?: number;
  /** BMI bill line ID — used to remove/swap individual races without cancelling the whole order */
  billLineId?: string;
}
import type { ContactInfo } from "./components/ContactForm";
import type { PersonData } from "./components/ReturningRacerLookup";
import ExperiencePicker from "./components/ExperiencePicker";
import ReturningRacerLookup from "./components/ReturningRacerLookup";
import PartySizePicker from "./components/PartySizePicker";
import DatePicker from "./components/DatePicker";
import ProductPicker from "./components/ProductPicker";
import HeatPicker from "./components/HeatPicker";
import PackHeatPicker from "./components/PackHeatPicker";
import ContactForm from "./components/ContactForm";
import AddOnsPage from "./components/AddOnsPage";
import type { AddOnItem } from "./components/AddOnsPage";
import PovUpsell from "./components/PovUpsell";
import type { PovSelection } from "./components/PovUpsell";
import OrderSummary from "./components/OrderSummary";
import FloatingCart from "./components/FloatingCart";

type Step = "experience" | "party" | "date" | "product" | "heat" | "addons" | "pov" | "contact" | "summary";

const STEPS: Step[] = ["experience", "party", "date", "product", "heat", "pov", "addons", "contact", "summary"];
const STEP_LABELS: Record<Step, string> = {
  experience: "Type",
  party: "Party",
  date: "Date",
  product: "Race",
  heat: "Heat",
  pov: "POV",
  addons: "Extras",
  contact: "Details",
  summary: "Pay",
};

export default function BookRacePage() {
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
  const [selectedProposal, setSelectedProposal] = useState<BmiProposal | null>(null);
  const [selectedBlock, setSelectedBlock] = useState<BmiBlock | null>(null);
  const [contact, setContact] = useState<ContactInfo | null>(null);
  const [heatPickerKey, setHeatPickerKey] = useState(0); // Force remount on each visit
  const [selectedAddOns, setSelectedAddOns] = useState<AddOnItem[]>([]);
  const [selectedPov, setSelectedPov] = useState<PovSelection | null>(null);
  // Returning racer person data from BMI lookup
  const [verifiedPerson, setVerifiedPerson] = useState<PersonData | null>(null);
  // Pack booking state — when a pack is booked, the bill is already created
  const [packResult, setPackResult] = useState<PackBookingResult | null>(null);
  // Active BMI order ID — cancel when going back
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);

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
      const isoDate = `${date}T00:00:00.000Z`;
      const pages: BmiPage[] = await bmiGet("page", { date: isoDate });
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
    setVerifiedPerson(null);
    if (type === "new") {
      // New racers auto-advance to party size
      setTimeout(() => setStep("party"), 300);
    }
    // Returning racers stay on experience step — ReturningRacerLookup will show
  }

  function handlePersonVerified(person: PersonData) {
    setVerifiedPerson(person);
    // Pre-fill contact from verified person
    const nameParts = person.fullName.split(" ");
    setContact({
      firstName: nameParts[0] || "",
      lastName: nameParts.slice(1).join(" ") || "",
      email: person.email,
      phone: "",
    });
    // Auto-advance to party
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
    // Don't clear bookings — "Add Another Race" loops back to date
    setBookingCategory(adults > 0 ? "adult" : "junior");
    fetchCatalog(date);
    setStep("product");
  }

  function handleProductSelect(product: ClassifiedProduct) {
    setSelectedProduct(product);
    // Set quantity based on party size for this category
    const q = product.category === "adult" ? adults : juniors;
    setQuantity(Math.max(1, q));
    // Auto-advance to heat selection
    setHeatPickerKey(k => k + 1); // Force fresh HeatPicker mount
    setTimeout(() => setStep("heat"), 300);
  }

  function handlePackComplete(result: PackBookingResult) {
    setPackResult(result);
    // Pack bookings create the bill during heat selection, so skip straight to contact
    // (We still need contact info for the reservation)
    setStep("contact");
  }

  async function handleConfirmHeat(proposal: BmiProposal, block: BmiBlock) {
    const blockPrice = block.prices?.find(p => p.depositKind === 0)?.amount ?? undefined;
    try {
      // If replacing an existing booking for this category, remove the old line first
      const existingIdx = bookings.findIndex(b => b.product.category === selectedProduct!.category);
      if (existingIdx >= 0 && bookings[existingIdx].billLineId) {
        await removeBookingLine(bookings[existingIdx].billLineId!).catch(() => {});
      }

      const { rawOrderId, billLineId } = await bookRaceHeat(selectedProduct!, quantity, proposal, activeOrderId);
      if (!activeOrderId) {
        setActiveOrderId(rawOrderId);
      }

      const booking: Booking = {
        product: selectedProduct!,
        quantity,
        proposal,
        block,
        blockPrice,
        billLineId: billLineId ?? undefined,
      };

      // Replace existing same-category booking or append
      const updatedBookings = existingIdx >= 0
        ? bookings.map((b, i) => i === existingIdx ? booking : b)
        : [...bookings, booking];
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
        setStep("pov");
      }
    } catch (err) {
      console.error("[handleConfirmHeat] booking failed:", err);
      alert("Failed to reserve heat. Please try again.");
    }
  }

  async function handleAddAnother(proposal: BmiProposal, block: BmiBlock) {
    const blockPrice = block.prices?.find(p => p.depositKind === 0)?.amount ?? undefined;
    try {
      const { rawOrderId, billLineId } = await bookRaceHeat(selectedProduct!, quantity, proposal, activeOrderId);
      if (!activeOrderId) {
        setActiveOrderId(rawOrderId);
      }

      const booking: Booking = {
        product: selectedProduct!,
        quantity,
        proposal,
        block,
        blockPrice,
        billLineId: billLineId ?? undefined,
      };
      setBookings(prev => [...prev, booking]);

      setSelectedProduct(null);
      setSelectedProposal(null);
      setSelectedBlock(null);
      setStep("date");
    } catch (err) {
      console.error("[handleAddAnother] booking failed:", err);
      alert("Failed to reserve heat. Please try again.");
    }
  }

  function handleContactSubmit(info: ContactInfo) {
    setContact(info);
    setStep("summary");
  }

  function cancelActiveOrder() {
    if (activeOrderId) {
      bmiDelete(`bill/${activeOrderId}/cancel`).catch(() => {});
      setActiveOrderId(null);
    }
  }

  function goToStep(s: Step) {
    const targetIdx = STEPS.indexOf(s);
    if (targetIdx < currentIdx) {
      // Only cancel BMI order if going back PAST heat selection (to product/date/party)
      if (targetIdx < STEPS.indexOf("heat")) {
        cancelActiveOrder();
        setBookings([]);
      }
      setStep(s);
      // Reset downstream selections when going back
      if (targetIdx < STEPS.indexOf("product")) {
        setSelectedProduct(null);
        setSelectedProposal(null);
        setSelectedBlock(null);
        setPackResult(null);
        setBookingCategory(adults > 0 ? "adult" : "junior");
        // Only clear cart when going all the way back to start
        if (targetIdx <= STEPS.indexOf("party")) {
          cancelActiveOrder();
          setBookings([]);
        }
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
      {/* Sticky header: steps */}
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
                      <span className={`w-5 h-5 rounded-full text-[10px] flex items-center justify-center font-bold ${
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

        {/* Floating cart */}

        {/* STEP 1: Experience level */}
        {step === "experience" && (
          <div className="space-y-8">
            <ExperiencePicker selected={racerType} onSelect={handleExperienceSelect} />
            {racerType === "existing" && !verifiedPerson && (
              <ReturningRacerLookup
                onVerified={handlePersonVerified}
                onSwitchToNew={() => handleExperienceSelect("new")}
              />
            )}
          </div>
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
        {step === "date" && (
          <div className="space-y-8">
            <DatePicker selected={selectedDate} onSelect={handleDateSelect} />
            <button onClick={() => setStep("party")} className="text-sm text-white/40 hover:text-white/70 transition-colors">
              ← Change party size
            </button>
          </div>
        )}

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
              key={heatPickerKey}
              race={selectedProduct}
              date={selectedDate}
              quantity={quantity}
              onQuantityChange={setQuantity}
              onConfirm={handleConfirmHeat}
              onAddAnother={handleAddAnother}
              onBack={() => setStep("product")}
              confirmLabel={
                bookingCategory === "adult" && juniors > 0
                  ? `Continue to Junior Race${juniors > 1 ? "s" : ""} →`
                  : undefined
              }
              bookedHeats={
                bookings
                  .filter(b => b.product.category === selectedProduct.category)
                  .map(b => ({ start: b.block.start, stop: b.block.stop, track: b.product.track }))
              }
            />
          )
        )}

        {/* STEP 6: Contact info */}
        {/* STEP 6: Add-ons upsell */}
        {/* STEP 6: POV Camera upsell */}
        {step === "pov" && (
          <PovUpsell
            racerCount={bookings.reduce((s, b) => s + b.quantity, 0)}
            initial={selectedPov}
            onContinue={(pov) => {
              setSelectedPov(pov);
              setStep("addons");
            }}
            onBack={() => setStep("heat")}
          />
        )}

        {/* STEP 7: Activity add-ons */}
        {step === "addons" && (
          <AddOnsPage
            racerCount={bookings.reduce((s, b) => s + b.quantity, 0)}
            date={selectedDate || ""}
            bookedHeats={bookings.map(b => ({ start: b.block.start, stop: b.block.stop, track: b.product.track }))}
            initialAddOns={selectedAddOns}
            onContinue={(addOns) => {
              setSelectedAddOns(addOns);
              if (verifiedPerson && contact) {
                setStep("summary");
              } else {
                setStep("contact");
              }
            }}
            onBack={() => setStep("pov")}
          />
        )}

        {/* STEP 7: Contact info */}
        {step === "contact" && (
          <ContactForm
            initial={contact}
            onSubmit={handleContactSubmit}
            onBack={() => setStep("addons")}
            // ContactForm back goes to addons
          />
        )}

        {/* STEP 7: Order summary + payment */}
        {step === "summary" && selectedDate && contact && activeOrderId && (packResult || bookings.length > 0) && (
          <OrderSummary
            bookings={bookings}
            date={selectedDate}
            contact={contact}
            billId={activeOrderId}
            onBack={() => setStep("contact")}
            packResult={packResult ?? undefined}
            packProduct={packResult ? selectedProduct ?? undefined : undefined}
            personId={verifiedPerson?.personId}
            addOns={selectedAddOns.map(a => ({ id: a.id, name: a.name, price: a.price, quantity: a.quantity, perPerson: a.perPerson, proposal: a.proposal, block: a.block, selectedTime: a.selectedTime }))}
            pov={selectedPov}
            onRemoveBooking={(index) => {
              const toRemove = bookings[index];
              // Remove just this line from the BMI bill (not the whole order)
              if (toRemove?.billLineId) {
                removeBookingLine(toRemove.billLineId).catch(() => {});
              }
              setBookings(prev => {
                const updated = prev.filter((_, i) => i !== index);
                if (updated.length === 0) {
                  cancelActiveOrder();
                  setStep("date");
                } else {
                  setStep("heat");
                  setTimeout(() => setStep("summary"), 100);
                }
                return updated;
              });
            }}
            onRemoveAddOn={(index) => {
              setSelectedAddOns(prev => prev.filter((_, i) => i !== index));
              // Re-enter summary to re-process add-ons
              setStep("heat");
              setTimeout(() => setStep("summary"), 100);
            }}
            onRemovePov={() => {
              setSelectedPov(null);
              // Re-enter summary to re-process
              setStep("heat");
              setTimeout(() => setStep("summary"), 100);
            }}
          />
        )}

        {/* Dev tag */}
        <p className="text-white/10 text-[10px] text-center mt-12">BMI Public API</p>
      </div>

      {/* Floating cart */}
      {step !== "summary" && (
        <FloatingCart
          items={[
            ...bookings.map(b => ({
              name: b.product.name,
              quantity: b.quantity,
              time: b.block.start,
              date: b.block.start,
              price: b.blockPrice,
            })),
            ...(selectedPov && selectedPov.quantity > 0 ? [{
              name: "POV Video Footage",
              quantity: selectedPov.quantity,
              time: "",
              date: "",
              price: selectedPov.price,
            }] : []),
            ...selectedAddOns.filter(a => a.quantity > 0).map(a => ({
              name: a.shortName,
              quantity: a.quantity,
              time: a.selectedTime || "",
              date: a.selectedTime || "",
              price: a.price,
            })),
          ].sort((a, b) => (a.time || "z").localeCompare(b.time || "z"))}
          onCheckout={() => {
            if (contact) {
              setStep("summary");
            } else {
              setStep("contact");
            }
          }}
          onRemove={(index) => {
            // Only remove race bookings (first N items), not add-ons
            if (index < bookings.length) {
              setBookings(prev => prev.filter((_, i) => i !== index));
            } else {
              const addOnIdx = index - bookings.length;
              const povCount = (selectedPov && selectedPov.quantity > 0) ? 1 : 0;
              if (addOnIdx < povCount) {
                setSelectedPov(null);
              } else {
                const aoIdx = addOnIdx - povCount;
                setSelectedAddOns(prev => prev.filter((_, i) => i !== aoIdx));
              }
            }
          }}
        />
      )}
    </div>
  );
}
