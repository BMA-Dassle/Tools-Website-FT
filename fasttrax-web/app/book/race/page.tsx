"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import type { RacerType, RaceCategory, ClassifiedProduct, BmiPage, BmiProposal, BmiBlock } from "./data";
import { classifyProducts, filterProducts, bmiGet, bmiDelete, bookRaceHeat, removeBookingLine } from "./data";
import { trackBookingExperience, trackBookingParty, trackBookingDate, trackBookingProduct, trackBookingHeat, trackBookingPov, trackBookingAddOns, trackBookingContact, trackBookingReview, trackBookingPayment } from "@/lib/analytics";
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
  /** Line IDs for each race on each bill (for removal) */
  billLineIds?: { billId: string; lineId: string }[];
  /** Racer names assigned to this heat (returning racer flow) */
  racerNames?: string[];
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
import RacerSelector from "./components/RacerSelector";
import OrderSummary from "./components/OrderSummary";
import MiniCart from "@/components/booking/MiniCart";

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
  // Linked racers (family members from Pandora)
  const [linkedPersons, setLinkedPersons] = useState<{ id: string; firstName: string; lastName: string; birthdate: string | null }[]>([]);
  const [showLinkedModal, setShowLinkedModal] = useState(false);
  const [linkedLoading, setLinkedLoading] = useState(false);
  // Racer selector: pending heat waiting for racer selection (returning racers only)
  const [pendingHeat, setPendingHeat] = useState<{ proposal: BmiProposal; block: BmiBlock } | null>(null);
  const [showRacerSelector, setShowRacerSelector] = useState(false);
  // Pack booking state — when a pack is booked, the bill is already created
  const [packResult, setPackResult] = useState<PackBookingResult | null>(null);
  // Active BMI bills — one per racer. First bill is the "primary" for add-ons/POV.
  // Check sessionStorage for existing bill from attractions flow (multi-activity cart)
  const [activeBills, setActiveBills] = useState<RacerBill[]>(() => {
    if (typeof window === "undefined") return [];
    const existingOrderId = sessionStorage.getItem("attractionOrderId");
    if (existingOrderId) return [{ billId: existingOrderId, racerName: "Cart", category: "adult" as const }];
    return [];
  });
  // Convenience: primary bill ID (first bill, used for add-ons/POV/overview)
  const activeOrderId = activeBills.length > 0 ? activeBills[0].billId : null;

  const contentRef = useRef<HTMLDivElement>(null);
  const nextBtnRef = useRef<HTMLDivElement>(null);

  const currentIdx = STEPS.indexOf(step);

  // Scroll to top of content when step changes
  useEffect(() => {
    contentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [step]);

  // Sync racing bookings to sessionStorage so the unified MiniCart can display them
  useEffect(() => {
    const existingCart: unknown[] = (() => {
      try { return JSON.parse(sessionStorage.getItem("attractionCart") || "[]"); } catch { return []; }
    })();
    // Remove old racing items (re-sync)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nonRacing = existingCart.filter((item: any) => item.attraction !== "racing");
    // Add current racing items
    const racingItems = bookings.map(b => ({
      attraction: "racing",
      attractionName: "Racing",
      product: { name: b.product.name, price: b.blockPrice || 0, bookingMode: "per-person" },
      date: b.block.start.split("T")[0],
      time: { block: { start: b.block.start } },
      quantity: b.quantity,
      billLineId: b.billLineIds?.[0]?.lineId || null,
      color: "#E41C1D",
      racerNames: b.racerNames,
    }));
    sessionStorage.setItem("attractionCart", JSON.stringify([...nonRacing, ...racingItems]));
  }, [bookings]);

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

  /** Fetch credit/deposit balances for a racer and update their PersonData */
  async function fetchRacerCredits(person: PersonData): Promise<PersonData> {
    try {
      const res = await fetch(`/api/bmi-office?action=deposits&personId=${person.personId}`);
      if (!res.ok) return person;
      const deposits: { depositKind: string; balance: number }[] = await res.json();
      const racingCredits = deposits.filter(d =>
        d.balance > 0 && (d.depositKind.toLowerCase().includes("credit") || d.depositKind.toLowerCase().includes("pass"))
      );
      return {
        ...person,
        hasCredits: racingCredits.length > 0,
        creditBalances: racingCredits.map(d => ({ kind: d.depositKind, balance: d.balance })),
      };
    } catch {
      return person;
    }
  }

  function handleExperienceSelect(type: RacerType) {
    trackBookingExperience(type);
    setRacerType(type);
    setVerifiedPerson(null);
    if (type === "new") {
      setTimeout(() => setStep("party"), 300);
    }
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
    // Fetch credits in background (non-blocking)
    fetchRacerCredits(person).then(updated => {
      setVerifiedRacers(prev => prev.map(r => r.personId === updated.personId ? { ...r, hasCredits: updated.hasCredits, creditBalances: updated.creditBalances } : r));
    });
    // Fetch related persons from Pandora (family members)
    fetch(`/api/pandora?personId=${person.personId}&picture=false`).then(async res => {
      if (!res.ok) return;
      const data = await res.json();
      const relatedIds: string[] = data.related || [];
      if (relatedIds.length === 0) return;
      // Fetch each related person's details
      const related = await Promise.all(relatedIds.map(async (rid: string) => {
        try {
          const r = await fetch(`/api/pandora?personId=${rid}&picture=false`);
          if (!r.ok) return null;
          const p = await r.json();
          return { id: rid, firstName: p.firstName || "", lastName: p.lastName || "", birthdate: p.birthdate || null };
        } catch { return null; }
      }));
      setLinkedPersons(related.filter((p): p is { id: string; firstName: string; lastName: string; birthdate: string | null } => p !== null));
    }).catch(() => { /* non-fatal */ });
    // Go to party step — will show category choice for primary
    setTimeout(() => setStep("party"), 300);
  }

  async function handleAddLinkedRacer(pandoraId: string, category: "adult" | "junior") {
    // Look up the person in Office API using their Pandora/BMI ID
    setLinkedLoading(true);
    try {
      const searchRes = await fetch(`/api/bmi-office?action=search&q=${pandoraId}&max=5`);
      const results = await searchRes.json();
      if (!Array.isArray(results) || results.length === 0) {
        alert("Could not find this person's racing account.");
        setLinkedLoading(false);
        return;
      }
      // Get person details
      const detailRes = await fetch(`/api/bmi-office?action=person&id=${results[0].localId}`);
      const p = await detailRes.json();
      const RELEVANT_MEMBERSHIPS = ["license fee", "qualified intermediate", "qualified pro", "turbo pass", "employee pass", "race credit"];
      const tags = (p.tags || []).sort((a: { lastSeen: string }, b: { lastSeen: string }) =>
        (b.lastSeen || "").localeCompare(a.lastSeen || "")
      );
      const memberships = (p.memberships || [])
        .filter((m: { stops: string; name: string }) =>
          (!m.stops || new Date(m.stops) > new Date()) &&
          RELEVANT_MEMBERSHIPS.some(rel => m.name.toLowerCase().includes(rel))
        )
        .map((m: { name: string }) => m.name)
        .filter((name: string, i: number, arr: string[]) => arr.indexOf(name) === i);

      const person: PersonData = {
        personId: String(p.id),
        fullName: `${p.firstName || ""} ${p.name || ""}`.trim(),
        email: (p.addresses?.[0]?.email) || "",
        races: (p.tags || []).length,
        maxExpiry: null,
        tag: tags[0]?.tag || "",
        loginCode: tags[0]?.tag || "",
        personReference: "",
        memberships,
      };

      handleAddRacer(person, category);
      setShowLinkedModal(false);
    } catch {
      alert("Failed to load racer details.");
    } finally {
      setLinkedLoading(false);
    }
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
    // Fetch credits in background (non-blocking)
    fetchRacerCredits(person).then(updated => {
      setVerifiedRacers(prev => prev.map(r => r.personId === updated.personId ? { ...r, hasCredits: updated.hasCredits, creditBalances: updated.creditBalances } : r));
    });
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
    trackBookingParty(adults, juniors);
    setStep("date");
  }

  function handleDateSelect(date: string) {
    trackBookingDate(date);
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
    trackBookingProduct(product.name, product.track, product.tier);
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
    trackBookingHeat(block.start, selectedProduct?.track ?? null);
    console.log("[handleConfirmHeat]", { racerType, verifiedRacersCount: verifiedRacers.length, productCategory: selectedProduct?.category });

    // Returning racers: show racer selector before booking
    if (racerType === "existing" && verifiedRacers.length > 0) {
      console.log("[handleConfirmHeat] showing racer selector");
      setPendingHeat({ proposal, block });
      setShowRacerSelector(true);
      return;
    }

    // New racers: book immediately as group (unchanged)
    await bookHeatForRacers(proposal, block, null);
  }

  /** Book a heat for selected racers (or as group for new racers) */
  async function bookHeatForRacers(proposal: BmiProposal, block: BmiBlock, selectedRacers: PersonData[] | null) {
    const blockPrice = block.prices?.find(p => p.depositKind === 0)?.amount ?? undefined;
    const cat = selectedProduct!.category;
    const bookingBillLineIds: { billId: string; lineId: string }[] = [];
    const racerCount = selectedRacers ? selectedRacers.length : (cat === "adult" ? adults : juniors);

    try {
      let createdBills: RacerBill[] = [];
      const existingBillId = activeBills.length > 0 ? activeBills[0].billId : null;

      if (selectedRacers && selectedRacers.length > 0) {
        // Returning racers: book each racer individually with personId, all on one bill
        let orderId = existingBillId;
        for (const racer of selectedRacers) {
          const { rawOrderId, billLineId } = await bookRaceHeat(
            selectedProduct!, 1, proposal, orderId, racer.personId
          );
          if (!orderId) {
            // First racer created the bill — reuse for the rest
            orderId = rawOrderId;
            createdBills.push({ billId: rawOrderId, personId: racer.personId, racerName: racer.fullName, category: cat });
          }
          if (billLineId) bookingBillLineIds.push({ billId: orderId, lineId: billLineId });
        }
        // Only add to activeBills if we created a new bill
        if (!existingBillId && createdBills.length > 0) {
          setActiveBills(prev => [...prev, ...createdBills]);
          sessionStorage.setItem("attractionOrderId", createdBills[0].billId);
        }
        console.log("[bookHeatForRacers] returning racers:", selectedRacers.map(r => r.fullName).join(", "), "on bill:", orderId);
      } else {
        // New racers: one bill for the group (unchanged)
        const { rawOrderId, billLineId } = await bookRaceHeat(selectedProduct!, racerCount, proposal, existingBillId);
        if (!existingBillId) {
          createdBills.push({ billId: rawOrderId, racerName: "Group", category: cat });
          setActiveBills(prev => [...prev, ...createdBills]);
          sessionStorage.setItem("attractionOrderId", rawOrderId);
        } else {
          createdBills = activeBills.filter(b => b.category === cat);
        }
        if (billLineId) bookingBillLineIds.push({ billId: rawOrderId, lineId: billLineId });
      }

      const booking: Booking = {
        product: selectedProduct!,
        quantity: racerCount,
        proposal,
        block,
        blockPrice,
        bills: createdBills.length > 0 ? createdBills : activeBills.filter(b => b.category === cat),
        billLineIds: bookingBillLineIds,
        racerNames: selectedRacers ? selectedRacers.map(r => r.fullName) : undefined,
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
        setStep("pov");
      }
    } catch (err) {
      console.error("[bookHeatForRacers] booking failed:", err);
      alert("Failed to reserve heat. Please try again.");
    }
  }

  /** Called when racer selector confirms which racers to add */
  function handleRacerSelectorConfirm(selectedRacers: PersonData[]) {
    if (!pendingHeat) return;
    setShowRacerSelector(false);
    bookHeatForRacers(pendingHeat.proposal, pendingHeat.block, selectedRacers);
    setPendingHeat(null);
  }

  async function handleAddAnother(proposal: BmiProposal, block: BmiBlock) {
    // "Add Another Race" — for returning racers, show racer selector
    if (racerType === "existing" && verifiedRacers.length > 0) {
      setPendingHeat({ proposal, block });
      setShowRacerSelector(true);
      return;
    }

    // New racers: add to existing bill as group
    const blockPrice = block.prices?.find(p => p.depositKind === 0)?.amount ?? undefined;
    const cat = selectedProduct!.category;
    const existingBillId = activeBills.length > 0 ? activeBills[0].billId : null;

    try {
      const racerCount = cat === "adult" ? adults : juniors;
      const { rawOrderId, billLineId } = await bookRaceHeat(selectedProduct!, racerCount, proposal, existingBillId);
      const usedBills = existingBillId ? activeBills : [{ billId: rawOrderId, racerName: "Group", category: cat } as RacerBill];
      if (!existingBillId) setActiveBills(prev => [...prev, ...usedBills]);

      setBookings(prev => [...prev, {
        product: selectedProduct!,
        quantity: racerCount,
        proposal,
        block,
        blockPrice,
        bills: usedBills,
        billLineIds: billLineId ? [{ billId: rawOrderId, lineId: billLineId }] : [],
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
    trackBookingContact();
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
    // Use the HIGHEST tier in the group so all race types show.
    // The RacerSelector handles per-racer qualification gating.
    const tiers = catRacers.map(r => {
      const mems = (r.memberships || []).map(m => m.toLowerCase());
      if (mems.some(m => m.includes("qualified pro"))) return 2;
      if (mems.some(m => m.includes("qualified intermediate"))) return 1;
      return 0;
    });
    const highestTier = Math.max(...tiers);
    if (highestTier >= 2) return ["Qualified Pro"];
    if (highestTier >= 1) return ["Qualified Intermediate"];
    return [];
  }

  const filteredProducts = racerType
    ? filterProducts(catalogProducts, racerType, adults, juniors, getCategoryMemberships(bookingCategory))
        .filter(p => p.category === bookingCategory)
    : [];

  const partyTotal = adults + juniors;

  return (
    <div className="min-h-screen bg-[#000418]">
      {/* Hero banner */}
      <div className="relative overflow-hidden pt-[140px] pb-6">
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/red-track-1Fsl8rQ5rVIHi6hXkkvUraGEqr4WM2.jpg"
          alt="FastTrax Racing"
          fill
          className="object-cover object-center"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-b from-[#000418]/70 via-[#000418]/80 to-[#000418]" />
        <div className="relative z-10 text-center px-4 pt-6 pb-2">
          <h1 className="text-3xl md:text-4xl font-display uppercase tracking-widest text-white mb-2">
            Book Your Race
          </h1>
          <p className="text-white/40 text-sm max-w-md mx-auto">
            Florida&apos;s largest indoor go-kart racing experience
          </p>
        </div>
      </div>

      {/* Sticky header: steps */}
      <div className="sticky top-[72px] sm:top-[80px] z-30">
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
                      {/* Credit balances */}
                      {r.hasCredits && r.creditBalances && r.creditBalances.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {r.creditBalances.map((cb, ci) => (
                            <span key={ci} className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-400/80">
                              {cb.kind.replace("Credit - ", "").replace("Race ", "")}: {cb.balance}
                            </span>
                          ))}
                        </div>
                      )}
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

              {/* Add racer buttons */}
              {!addingRacer ? (
                <div className="flex gap-2">
                  {linkedPersons.length > 0 && (
                    <button
                      onClick={() => setShowLinkedModal(true)}
                      className="flex-1 py-3 rounded-xl border border-dashed border-[#8652FF]/40 text-[#8652FF]/70 text-sm font-semibold hover:border-[#8652FF]/70 hover:text-[#8652FF] transition-colors"
                    >
                      + Linked Racer
                    </button>
                  )}
                  <button
                    onClick={() => { setAddingRacer(true); setAddingCategory(null); }}
                    className={`${linkedPersons.length > 0 ? "flex-1" : "w-full"} py-3 rounded-xl border border-dashed border-white/20 text-white/40 text-sm font-semibold hover:border-[#00E2E5]/50 hover:text-[#00E2E5] transition-colors`}
                  >
                    + Add Racer
                  </button>
                </div>
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

            {/* Category banner — prominent when booking for adults vs juniors */}
            {adults > 0 && juniors > 0 && (
              <div className={`rounded-xl border-2 p-4 text-center ${
                bookingCategory === "adult"
                  ? "border-[#00E2E5]/50 bg-[#00E2E5]/10"
                  : "border-amber-400/50 bg-amber-400/10"
              }`}>
                <p className={`font-display text-xl uppercase tracking-widest ${
                  bookingCategory === "adult" ? "text-[#00E2E5]" : "text-amber-400"
                }`}>
                  {bookingCategory === "adult" ? "Adult Races" : "Junior Races"}
                </p>
                <p className="text-white/50 text-sm mt-1">
                  {bookingCategory === "adult"
                    ? `Pick a race for your ${adults} adult${adults !== 1 ? " racers" : " racer"}`
                    : `Pick a race for your ${juniors} junior${juniors !== 1 ? " racers" : " racer"}`}
                </p>
                {racerType === "existing" && (() => {
                  const catRacers = verifiedRacers.filter(r => r.category === bookingCategory);
                  if (catRacers.length === 0) return null;
                  return (
                    <p className="text-white/30 text-xs mt-1">
                      {catRacers.map(r => r.fullName).join(", ")}
                    </p>
                  );
                })()}
              </div>
            )}

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
              immediateConfirm={racerType === "existing" && verifiedRacers.length > 0}
            />
          )
        )}

        {/* Racer Selector overlay — shown after heat selected for returning racers */}
        {showRacerSelector && pendingHeat && selectedProduct && (
          <RacerSelector
            racers={verifiedRacers.filter(r => r.category === selectedProduct.category)}
            raceTier={selectedProduct.tier}
            alreadyBookedPersonIds={[]}
            onConfirm={handleRacerSelectorConfirm}
            onCancel={() => { setShowRacerSelector(false); setPendingHeat(null); }}
          />
        )}

        {/* STEP 6: Contact info */}
        {/* STEP 6: Add-ons upsell */}
        {/* STEP 6: POV Camera upsell */}
        {step === "pov" && (
          <PovUpsell
            racerCount={bookings.reduce((s, b) => s + b.quantity, 0)}
            initial={selectedPov}
            onContinue={async (pov) => {
              trackBookingPov(pov?.quantity ?? 0);
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
              trackBookingAddOns(addOns.filter(a => a.quantity > 0).map(a => a.shortName));
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
            verifiedRacers={verifiedRacers.filter(r => r.personId).map(r => ({ personId: r.personId, fullName: r.fullName }))}
            addOns={selectedAddOns.map(a => ({ id: a.id, name: a.name, price: a.price, quantity: a.quantity, perPerson: a.perPerson, proposal: a.proposal, block: a.block, selectedTime: a.selectedTime }))}
            pov={selectedPov}
            onRemoveBooking={async (index) => {
              const toRemove = bookings[index];
              // Remove this booking's lines from BMI bills
              if (toRemove?.billLineIds && toRemove.billLineIds.length > 0) {
                for (const { billId, lineId } of toRemove.billLineIds) {
                  // Check if other bookings share this bill
                  const otherBookingsOnBill = bookings.filter((b, i) => i !== index && b.bills?.some(bb => bb.billId === billId));
                  if (otherBookingsOnBill.length > 0) {
                    // Shared bill — just remove this line
                    await removeBookingLine(billId, lineId).catch(() => {});
                  } else {
                    // Bill only has this booking — cancel the whole bill
                    await bmiDelete(`bill/${billId}/cancel`).catch(() => {});
                    setActiveBills(prev => prev.filter(b => b.billId !== billId));
                  }
                }
              } else if (toRemove?.bills) {
                // Fallback: cancel all bills for this booking
                for (const bill of toRemove.bills) {
                  const otherBookingsOnBill = bookings.filter((b, i) => i !== index && b.bills?.some(bb => bb.billId === bill.billId));
                  if (otherBookingsOnBill.length === 0) {
                    await bmiDelete(`bill/${bill.billId}/cancel`).catch(() => {});
                    setActiveBills(prev => prev.filter(b => b.billId !== bill.billId));
                  }
                }
              }
              setBookings(prev => {
                const updated = prev.filter((_, i) => i !== index);
                if (updated.length === 0) {
                  cancelActiveOrder();
                  setStep("date");
                } else {
                  setStep("heat");
                  setTimeout(() => setStep("summary"), 200);
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

      {/* Unified floating cart */}
      {step !== "summary" && <MiniCart />}

      {/* Linked Racer Modal */}
      {showLinkedModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowLinkedModal(false); }}
        >
          <div className="max-w-md w-full rounded-2xl border border-white/10 bg-[#000418] p-6 space-y-4 shadow-2xl max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-white font-display text-lg uppercase tracking-wider">Linked Racers</h3>
                <p className="text-white/40 text-xs">Family members on the same account</p>
              </div>
              <button onClick={() => setShowLinkedModal(false)} className="text-white/30 hover:text-white/60 text-sm">Close</button>
            </div>

            {linkedPersons.length === 0 && (
              <p className="text-white/40 text-sm text-center py-4">No linked racers found.</p>
            )}

            {linkedPersons.map(lp => {
              const alreadyAdded = verifiedRacers.some(r => r.personId === lp.id);
              const age = lp.birthdate ? Math.floor((Date.now() - new Date(lp.birthdate).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : null;
              const suggestedCategory = age !== null && age < 13 ? "junior" : "adult";

              return (
                <div key={lp.id} className={`rounded-xl border p-4 ${alreadyAdded ? "border-green-500/30 bg-green-500/5" : "border-white/10 bg-white/5"}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-white font-semibold text-sm">{lp.firstName} {lp.lastName}</p>
                      {age !== null && (
                        <p className="text-white/40 text-xs mt-0.5">Age: {age} · {suggestedCategory === "junior" ? "Junior" : "Adult"}</p>
                      )}
                    </div>
                    {alreadyAdded ? (
                      <span className="text-green-400 text-xs font-bold">Added ✓</span>
                    ) : (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleAddLinkedRacer(lp.id, "adult")}
                          disabled={linkedLoading}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white/10 text-white/70 hover:bg-[#00E2E5]/20 hover:text-[#00E2E5] transition-colors disabled:opacity-40"
                        >
                          Adult
                        </button>
                        <button
                          onClick={() => handleAddLinkedRacer(lp.id, "junior")}
                          disabled={linkedLoading}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white/10 text-white/70 hover:bg-[#8652FF]/20 hover:text-[#8652FF] transition-colors disabled:opacity-40"
                        >
                          Junior
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {linkedLoading && (
              <div className="flex items-center justify-center gap-2 py-2">
                <div className="w-4 h-4 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
                <span className="text-white/40 text-xs">Loading racer details...</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
