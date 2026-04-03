"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { RacerType, RaceCategory, ClassifiedProduct, BmiPage, BmiProposal, BmiBlock } from "./data";
import { classifyProducts, filterProducts, bmiGet, bmiDelete, bookRaceHeat, removeBookingLine } from "./data";
import type { PackBookingResult } from "./components/OrderSummary";

/** A per-person bill in BMI */
interface RacerBill {
  billId: string;
  personId?: string;
  racerName: string;
  category: "adult" | "junior";
}

/** A completed race booking for one category (adult or junior) */
interface Booking {
  product: ClassifiedProduct;
  quantity: number;
  proposal: BmiProposal;
  block: BmiBlock;
  blockPrice?: number;
  /** BMI bill line ID — used to remove/swap individual races without cancelling the whole order */
  billLineId?: string;
  /** Which bills this booking spans (one per racer) */
  bills?: RacerBill[];
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
  // All verified racers in the party (for returning racer flow)
  const [verifiedRacers, setVerifiedRacers] = useState<PersonData[]>([]);
  const [addingRacer, setAddingRacer] = useState(false);
  const [addingCategory, setAddingCategory] = useState<"adult" | "junior" | null>(null);
  // Pack booking state — when a pack is booked, the bill is already created
  const [packResult, setPackResult] = useState<PackBookingResult | null>(null);
  // Active BMI bills — one per racer. First bill is the "primary" for add-ons/POV.
  const [activeBills, setActiveBills] = useState<RacerBill[]>([]);
  // Convenience: primary bill ID (first bill, used for add-ons/POV/overview)
  const activeOrderId = activeBills.length > 0 ? activeBills[0].billId : null;

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
    // Don't set category yet — will be asked on party step
    setVerifiedRacers([{ ...person, category: undefined }]);
    setAdults(0);
    setJuniors(0);
    // Pre-fill contact from verified person
    const nameParts = person.fullName.split(" ");
    setContact({
      firstName: nameParts[0] || "",
      lastName: nameParts.slice(1).join(" ") || "",
      email: person.email,
      phone: "",
    });
    // Go to party step — will show category choice for primary
    setTimeout(() => setStep("party"), 300);
  }

  function handlePrimaryCategorySelect(cat: "adult" | "junior") {
    setVerifiedRacers(prev => prev.map((r, i) => i === 0 ? { ...r, category: cat } : r));
    if (cat === "junior") {
      setAdults(0);
      setJuniors(1);
    } else {
      setAdults(1);
      setJuniors(0);
    }
  }

  function handleAddRacer(person: PersonData, category: "adult" | "junior") {
    // Don't add duplicates
    if (verifiedRacers.some(r => r.personId === person.personId)) return;
    const racerWithCat = { ...person, category };
    setVerifiedRacers(prev => [...prev, racerWithCat]);
    if (category === "junior") {
      setJuniors(prev => prev + 1);
    } else {
      setAdults(prev => prev + 1);
    }
  }

  function handleRemoveRacer(personId: string) {
    // Can't remove the primary racer
    if (verifiedPerson?.personId === personId) return;
    const racer = verifiedRacers.find(r => r.personId === personId);
    setVerifiedRacers(prev => prev.filter(r => r.personId !== personId));
    if (racer?.category === "junior") {
      setJuniors(prev => Math.max(0, prev - 1));
    } else {
      setAdults(prev => Math.max(1, prev - 1));
    }
  }

  // Get the highest tier label for a racer's memberships
  function getRacerTier(memberships: string[]): string {
    const mems = memberships.map(m => m.toLowerCase());
    if (mems.some(m => m.includes("qualified pro"))) return "Pro";
    if (mems.some(m => m.includes("qualified intermediate"))) return "Intermediate";
    return "Starter";
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
    const cat = selectedProduct!.category;
    try {
      // Only cancel old bills if we have exactly one booking for this category
      // (re-selecting the heat). If there are multiple (via Add Another Race), don't cancel.
      const existingCatBookings = bookings.filter(b => b.product.category === cat);
      if (existingCatBookings.length === 1) {
        const oldBills = activeBills.filter(b => b.category === cat);
        for (const ob of oldBills) {
          await bmiDelete(`bill/${ob.billId}/cancel`).catch(() => {});
        }
        setActiveBills(prev => prev.filter(b => b.category !== cat));
        setBookings(prev => prev.filter(b => b.product.category !== cat));
      }

      // Book race(s) — add to existing bills if available, create new if not
      const catRacers = racerType === "existing"
        ? verifiedRacers.filter(r => r.category === cat)
        : [];
      const racerCount = cat === "adult" ? adults : juniors;
      const existingCatBills = activeBills.filter(b => b.category === cat);
      const newBills: RacerBill[] = [];

      if (existingCatBills.length > 0) {
        // Add to existing bills (same person = same bill)
        for (const bill of existingCatBills) {
          await bookRaceHeat(selectedProduct!, 1, proposal, bill.billId);
        }
        // Keep existing bills, no new ones needed
      } else if (racerType === "existing" && catRacers.length > 0) {
        // First booking for returning racers: each gets their own bill
        for (const racer of catRacers) {
          const { rawOrderId } = await bookRaceHeat(selectedProduct!, 1, proposal, null);
          newBills.push({ billId: rawOrderId, personId: racer.personId, racerName: racer.fullName, category: cat });
        }
      } else {
        // First booking for new racers: one bill for the group
        const { rawOrderId } = await bookRaceHeat(selectedProduct!, racerCount, proposal, null);
        newBills.push({ billId: rawOrderId, racerName: "Group", category: cat });
      }

      if (newBills.length > 0) {
        setActiveBills(prev => [...prev.filter(b => b.category !== cat), ...newBills]);
      }

      const booking: Booking = {
        product: selectedProduct!,
        quantity: racerCount,
        proposal,
        block,
        blockPrice,
        bills: newBills,
      };

      // If we cancelled existing (single re-select), bookings was already cleaned.
      // Always append the new booking.
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
        setStep("pov");
      }
    } catch (err) {
      console.error("[handleConfirmHeat] booking failed:", err);
      alert("Failed to reserve heat. Please try again.");
    }
  }

  async function handleAddAnother(proposal: BmiProposal, block: BmiBlock) {
    // "Add Another Race" — add to EXISTING bills (same person = same bill)
    const blockPrice = block.prices?.find(p => p.depositKind === 0)?.amount ?? undefined;
    const cat = selectedProduct!.category;
    const existingCatBills = activeBills.filter(b => b.category === cat);
    console.log("[handleAddAnother]", { cat, existingCatBills: existingCatBills.map(b => b.billId), totalBills: activeBills.length });

    try {
      const usedBills: RacerBill[] = [];
      if (existingCatBills.length > 0) {
        // Add to existing bills (one per racer already created)
        for (const bill of existingCatBills) {
          console.log("[handleAddAnother] booking on existing bill:", bill.billId);
          await bookRaceHeat(selectedProduct!, 1, proposal, bill.billId);
          usedBills.push(bill);
        }
      } else {
        // No existing bills — create new (shouldn't normally happen)
        const racerCount = cat === "adult" ? adults : juniors;
        const { rawOrderId } = await bookRaceHeat(selectedProduct!, racerCount, proposal, null);
        const newBill: RacerBill = { billId: rawOrderId, racerName: "Group", category: cat };
        usedBills.push(newBill);
        setActiveBills(prev => [...prev, newBill]);
      }

      setBookings(prev => [...prev, {
        product: selectedProduct!,
        quantity: existingCatBills.length || (cat === "adult" ? adults : juniors),
        proposal,
        block,
        blockPrice,
        bills: usedBills,
      }]);

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
    for (const bill of activeBills) {
      bmiDelete(`bill/${bill.billId}/cancel`).catch(() => {});
    }
    setActiveBills([]);
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
        setPackResult(null);
        setBookingCategory(adults > 0 ? "adult" : "junior");
      }
      // Only cancel the entire bill when going back to party/experience (starting over)
      if (targetIdx <= STEPS.indexOf("party")) {
        cancelActiveOrder();
        setBookings([]);
      }
    }
  }

  // Per-category: find lowest tier among racers in each category
  function getCategoryMemberships(cat: "adult" | "junior"): string[] | undefined {
    if (racerType !== "existing") return undefined;
    const catRacers = verifiedRacers.filter(r => r.category === cat);
    if (catRacers.length === 0) return verifiedPerson?.memberships;
    const tiers = catRacers.map(r => {
      const mems = (r.memberships || []).map(m => m.toLowerCase());
      if (mems.some(m => m.includes("qualified pro"))) return 2;
      if (mems.some(m => m.includes("qualified intermediate"))) return 1;
      return 0;
    });
    const lowestTier = Math.min(...tiers);
    if (lowestTier >= 2) return ["Qualified Pro"];
    if (lowestTier >= 1) return ["Qualified Intermediate"];
    return [];
  }

  const filteredProducts = racerType
    ? filterProducts(catalogProducts, racerType, adults, juniors, getCategoryMemberships(bookingCategory))
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
        {step === "party" && racerType === "new" && (
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

        {/* STEP 2: Returning racer party — verified racer roster */}
        {step === "party" && racerType === "existing" && (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <h2 className="text-2xl font-display uppercase tracking-widest text-white">Your Race Party</h2>
              <p className="text-white/40 text-sm max-w-md mx-auto">
                Everyone in your party needs a FastTrax account. Add racers below.
              </p>
            </div>

            {/* Primary racer category choice (if not set) */}
            {verifiedRacers.length > 0 && !verifiedRacers[0]?.category && (
              <div className="max-w-md mx-auto rounded-xl border border-[#8652FF]/30 bg-[#8652FF]/5 p-4 space-y-3">
                <p className="text-white font-semibold text-sm text-center">{verifiedRacers[0].fullName}, are you racing as...</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => handlePrimaryCategorySelect("adult")}
                    className="py-3 rounded-lg border border-white/15 bg-white/5 text-white text-sm font-semibold hover:border-[#00E2E5]/50 transition-colors"
                  >
                    <span className="block">Adult</span>
                    <span className="text-white/30 text-[10px]">13+ &middot; 59&quot;+ tall</span>
                  </button>
                  <button
                    onClick={() => handlePrimaryCategorySelect("junior")}
                    className="py-3 rounded-lg border border-white/15 bg-white/5 text-white text-sm font-semibold hover:border-[#00E2E5]/50 transition-colors"
                  >
                    <span className="block">Junior</span>
                    <span className="text-white/30 text-[10px]">7-13 &middot; 49&quot;+ tall</span>
                  </button>
                </div>
              </div>
            )}

            {/* Verified racers list */}
            {verifiedRacers[0]?.category && (
            <div className="max-w-md mx-auto space-y-2">
              {verifiedRacers.map((r, i) => (
                <div key={r.personId} className="rounded-xl border border-white/10 bg-white/5 p-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-[#8652FF]/20 text-[#8652FF] text-xs font-bold flex items-center justify-center shrink-0">
                      {i + 1}
                    </div>
                    <div className="min-w-0">
                      <p className="text-white font-semibold text-sm truncate">
                        {r.fullName}
                        {i === 0 && <span className="text-white/30 text-xs ml-2">(primary)</span>}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/10 text-white/50">
                          {r.category === "junior" ? "Junior" : "Adult"}
                        </span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          getRacerTier(r.memberships || []) === "Pro"
                            ? "bg-red-500/20 text-red-400"
                            : getRacerTier(r.memberships || []) === "Intermediate"
                            ? "bg-blue-500/20 text-blue-400"
                            : "bg-green-500/20 text-green-400"
                        }`}>
                          {getRacerTier(r.memberships || [])}
                        </span>
                        {(r.memberships || []).some(m => m.toLowerCase().includes("license fee")) && (
                          <span className="text-[10px] text-green-400/60">License ✓</span>
                        )}
                      </div>
                    </div>
                  </div>
                  {i > 0 && (
                    <button
                      onClick={() => handleRemoveRacer(r.personId)}
                      className="text-red-400/40 hover:text-red-400 transition-colors p-1 shrink-0"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}

              {/* Add racer button / inline lookup */}
              {!addingRacer ? (
                <button
                  onClick={() => { setAddingRacer(true); setAddingCategory(null); }}
                  className="w-full py-3 rounded-xl border border-dashed border-white/20 text-white/40 text-sm font-semibold hover:border-[#00E2E5]/50 hover:text-[#00E2E5] transition-colors"
                >
                  + Add Another Racer
                </button>
              ) : (
                <div className="rounded-xl border border-[#00E2E5]/30 bg-[#00E2E5]/5 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[#00E2E5] text-xs font-bold uppercase tracking-wider">Add Racer</p>
                    <button onClick={() => { setAddingRacer(false); setAddingCategory(null); }} className="text-white/30 text-xs hover:text-white/50">Cancel</button>
                  </div>

                  {/* Step 1: Pick adult or junior */}
                  {!addingCategory && (
                    <div className="space-y-2">
                      <p className="text-white/50 text-xs">What type of racer?</p>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => setAddingCategory("adult")}
                          className="py-3 rounded-lg border border-white/15 bg-white/5 text-white text-sm font-semibold hover:border-[#00E2E5]/50 transition-colors"
                        >
                          <span className="block">Adult</span>
                          <span className="text-white/30 text-[10px]">13+ &middot; 59&quot;+ tall</span>
                        </button>
                        <button
                          onClick={() => setAddingCategory("junior")}
                          className="py-3 rounded-lg border border-white/15 bg-white/5 text-white text-sm font-semibold hover:border-[#00E2E5]/50 transition-colors"
                        >
                          <span className="block">Junior</span>
                          <span className="text-white/30 text-[10px]">7-13 &middot; 49&quot;+ tall</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Step 2: Look up the racer */}
                  {addingCategory && (
                    <ReturningRacerLookup
                      onVerified={(person) => {
                        handleAddRacer(person, addingCategory);
                        setAddingRacer(false);
                        setAddingCategory(null);
                      }}
                      onSwitchToNew={() => { setAddingRacer(false); setAddingCategory(null); }}
                    />
                  )}
                </div>
              )}
            </div>
            )}

            {verifiedRacers[0]?.category && (
              <>
                <div className="max-w-md mx-auto rounded-xl border border-white/8 bg-white/3 p-3 text-xs text-white/40 text-center">
                  {verifiedRacers.length} racer{verifiedRacers.length !== 1 ? "s" : ""} in your party
                </div>

                <div className="flex items-center justify-between max-w-md mx-auto">
                  <button onClick={() => { setStep("experience"); setVerifiedPerson(null); setVerifiedRacers([]); }} className="text-sm text-white/40 hover:text-white/70 transition-colors">
                    ← Back
                  </button>
                  <button
                    onClick={handlePartyNext}
                    className="inline-flex items-center gap-2 px-8 py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25"
                  >
                    Next: Pick a Date →
                  </button>
                </div>
              </>
            )}
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

            {/* Category header — always show for returning racers or mixed parties */}
            {(adults > 0 && juniors > 0) || (racerType === "existing" && verifiedRacers.length > 0) ? (
              <div className="text-center space-y-1">
                <p className="text-[#00E2E5] text-sm font-semibold">
                  {bookingCategory === "adult"
                    ? `Scheduling for ${adults} adult${adults !== 1 ? "s" : ""}`
                    : `Scheduling for ${juniors} junior${juniors !== 1 ? "s" : ""}`}
                </p>
                {racerType === "existing" && (() => {
                  const catRacers = verifiedRacers.filter(r => r.category === bookingCategory);
                  if (catRacers.length === 0) return null;
                  return (
                    <p className="text-white/40 text-xs">
                      {catRacers.map(r => r.fullName).join(", ")}
                    </p>
                  );
                })()}
              </div>
            ) : null}

            {catalogLoading ? (
              <div className="flex flex-col items-center justify-center gap-4 min-h-[200px]">
                <div className="w-10 h-10 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
                <p className="text-white/50 text-sm">Loading available races…</p>
              </div>
            ) : (
              <>
                {racerType === "existing" && verifiedRacers.length > 1 && (() => {
                  const catRacers = verifiedRacers.filter(r => r.category === bookingCategory);
                  const catMems = getCategoryMemberships(bookingCategory) || [];
                  const hasPro = catMems.some(m => m.toLowerCase().includes("qualified pro"));
                  const hasInt = catMems.some(m => m.toLowerCase().includes("qualified intermediate"));
                  const tierLabel = hasPro ? null : hasInt ? "Intermediate" : "Starter";
                  if (!tierLabel || catRacers.length <= 1) return null;
                  return (
                    <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-center mb-4">
                      <p className="text-amber-400 text-xs">
                        Showing <strong>{tierLabel}</strong> and below for {bookingCategory}s — not everyone has qualified for higher tiers.
                      </p>
                    </div>
                  );
                })()}
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
            onContinue={async (pov) => {
              // Remove old POV from bill if changing
              if (selectedPov?.billLineId) {
                await removeBookingLine(activeOrderId!,selectedPov.billLineId).catch(() => {});
              }
              // Book POV onto bill now (if selected)
              if (pov && pov.quantity > 0 && activeOrderId) {
                try {
                  const povRes = await fetch("/api/sms?endpoint=booking%2Fsell", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify([{
                      productId: pov.id,
                      pageId: null,
                      quantity: pov.quantity,
                      billId: activeOrderId,
                      dynamicLines: null,
                      sellKind: 0,
                    }]),
                  });
                  const povResult = await povRes.json();
                  console.log("[POV sell]", povResult);
                  // Track the bill line ID for removal
                  const lineId = povResult.parentBillLineId ? String(povResult.parentBillLineId) : undefined;
                  setSelectedPov({ ...pov, billLineId: lineId });
                } catch {
                  setSelectedPov(pov);
                }
              } else {
                setSelectedPov(pov);
              }
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
            onContinue={async (addOns) => {
              // Remove old add-on lines from bill
              for (const old of selectedAddOns.filter(a => a.billLineId)) {
                await removeBookingLine(activeOrderId!,old.billLineId!).catch(() => {});
              }
              // Book new add-ons onto bill
              const bookedAddOns: AddOnItem[] = [];
              for (const addon of addOns.filter(a => a.quantity > 0 && a.proposal)) {
                try {
                  const addonBody: Record<string, unknown> = {
                    productId: String(addon.id),
                    quantity: addon.quantity,
                    resourceId: Number((addon.block as { resourceId?: string })?.resourceId) || -1,
                    proposal: {
                      blocks: (addon.proposal as { blocks: { block: Record<string, unknown>; productLineIds?: string[] }[] }).blocks.map(b => ({
                        productLineIds: b.productLineIds || [],
                        block: {
                          ...b.block,
                          resourceId: Number((b.block as Record<string, unknown>).resourceId) || -1,
                        },
                      })),
                      productLineId: (addon.proposal as { productLineId?: string }).productLineId ?? null,
                    },
                  };
                  const addonJson = `{"orderId":${activeOrderId},` + JSON.stringify(addonBody).slice(1);
                  const qs = new URLSearchParams({ endpoint: "booking/book" });
                  const res = await fetch(`/api/bmi?${qs.toString()}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: addonJson,
                  });
                  const raw = await res.text();
                  const lineMatch = raw.match(/"orderItemId"\s*:\s*(\d+)/);
                  console.log("[add-on book]", addon.name, "lineId:", lineMatch?.[1]);
                  bookedAddOns.push({ ...addon, billLineId: lineMatch?.[1] });
                } catch (err) {
                  console.error("[add-on book error]", addon.name, err);
                  bookedAddOns.push(addon);
                }
              }
              // Also keep add-ons with quantity but no proposal (no time slot needed)
              for (const addon of addOns.filter(a => a.quantity > 0 && !a.proposal)) {
                bookedAddOns.push(addon);
              }
              setSelectedAddOns(bookedAddOns);
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
            bills={activeBills}
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
                removeBookingLine(activeOrderId!,toRemove.billLineId).catch(() => {});
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
            onRemoveAddOn={async (index) => {
              const toRemove = selectedAddOns[index];
              if (toRemove?.billLineId) {
                await removeBookingLine(activeOrderId!, toRemove.billLineId).catch(() => {});
              }
              setSelectedAddOns(prev => prev.filter((_, i) => i !== index));
              // Re-enter summary to refresh totals (after removal completes)
              setStep("heat");
              setTimeout(() => setStep("summary"), 200);
            }}
            onRemovePov={async () => {
              if (selectedPov?.billLineId) {
                await removeBookingLine(activeOrderId!, selectedPov.billLineId).catch(() => {});
              }
              setSelectedPov(null);
              setStep("heat");
              setTimeout(() => setStep("summary"), 200);
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
