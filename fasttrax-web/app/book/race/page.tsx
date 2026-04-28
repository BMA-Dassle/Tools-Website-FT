"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import type { RacerType, RaceCategory, ClassifiedProduct, BmiProposal, BmiBlock } from "./data";
import { getStaticProducts, filterProducts, bmiGet, bmiDelete, bookRaceHeat, removeBookingLine, isRelevantMembership, getRacerTier } from "./data";
import { trackBookingExperience, trackBookingParty, trackBookingDate, trackBookingProduct, trackBookingHeat, trackBookingPov, trackBookingAddOns, trackBookingContact, trackBookingReview, trackBookingPayment } from "@/lib/analytics";
import type { PackBookingResult } from "./components/OrderSummary";
import BrandNav from "@/components/BrandNav";
import { modalBackdropProps } from "@/lib/a11y";

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
import PackageHeatPicker from "./components/PackageHeatPicker";
import type { PackagePick } from "./components/PackageHeatPicker";
import type { PackageDefinition } from "@/lib/packages";
import { eligiblePackages, scheduleForDate, packagePerRacerPrice } from "@/lib/packages";
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
  const searchParams = useSearchParams();
  const autoCodeRef = useRef<string | null>(searchParams.get("code"));
  const licenseSoldRef = useRef(false); // Track whether FastTrax license has been sold on this bill
  const [licenseSold, setLicenseSold] = useState<{ quantity: number; billLineId: string | null } | null>(null);
  const [step, setStepRaw] = useState<Step>("experience");
  /** Update step state AND push to URL for browser back/forward support */
  function changeStep(s: Step) {
    setStepRaw(s);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("step", s);
      window.history.pushState({ step: s }, "", url.toString());
    }
  }
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
  // When a package was picked instead of a single race. Mutually
  // exclusive with `selectedProduct` — picking one clears the other.
  // Drives the PackageHeatPicker render path, the cart line collapse,
  // and the booking-record `package` field for downstream features
  // (e.g. the "did they qualify?" cron we'll wire up later).
  const [selectedPackage, setSelectedPackage] = useState<PackageDefinition | null>(null);
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
  const [addingFoundPerson, setAddingFoundPerson] = useState<PersonData | null>(null);
  const [addingAge, setAddingAge] = useState<number | null>(null);
  // Linked racers (family members from Pandora)
  const [linkedPersons, setLinkedPersons] = useState<{ id: string; firstName: string; lastName: string; birthdate: string | null }[]>([]);
  const [linkedFetching, setLinkedFetching] = useState(false);
  const [showLinkedModal, setShowLinkedModal] = useState(false);
  const [linkedLoading, setLinkedLoading] = useState(false);
  const [linkedSelected, setLinkedSelected] = useState<{ id: string; name: string; age: number | null } | null>(null);
  // Height/age confirmation modal for new racers
  const [showHeightConfirm, setShowHeightConfirm] = useState(false);
  // Racer selector: pending heat waiting for racer selection (returning racers only)
  const [pendingHeat, setPendingHeat] = useState<{ proposal: BmiProposal; block: BmiBlock } | null>(null);
  const [showRacerSelector, setShowRacerSelector] = useState(false);
  // After returning racers book a heat, show choice: continue or add another
  const [showPostBookChoice, setShowPostBookChoice] = useState(false);
  // Pack booking state — when a pack is booked, the bill is already created
  const [packResult, setPackResult] = useState<PackBookingResult | null>(null);
  // Active BMI bills — one per racer. First bill is the "primary" for add-ons/POV.
  // Always start fresh — bills are created during heat selection.
  // Stale sessionStorage bills from prior sessions caused license bleed-through.
  const [activeBills, setActiveBills] = useState<RacerBill[]>([]);
  // Convenience: primary bill ID (first bill, used for add-ons/POV/overview)
  const activeOrderId = activeBills.length > 0 ? activeBills[0].billId : null;

  const contentRef = useRef<HTMLDivElement>(null);
  const nextBtnRef = useRef<HTMLDivElement>(null);

  const currentIdx = STEPS.indexOf(step);

  // Load existing bill from sessionStorage (shared with attractions for multi-booking)
  useEffect(() => {
    const existingOrderId = sessionStorage.getItem("attractionOrderId");
    if (existingOrderId) {
      setActiveBills([{ billId: existingOrderId, racerName: "Cart", category: "adult" as const }]);
      console.log("[mount] loaded existing bill from sessionStorage:", existingOrderId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize step from URL query param on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlStep = params.get("step") as Step | null;
    if (urlStep && STEPS.includes(urlStep)) {
      // Only restore early steps that don't need prior state
      const safeSteps: Step[] = ["experience", "party", "date"];
      if (safeSteps.includes(urlStep)) {
        setStepRaw(urlStep);
      }
    }
    // Set initial history state so popstate works on first back
    window.history.replaceState({ step: urlStep || "experience" }, "");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browser back/forward button support
  useEffect(() => {
    function handlePopState(e: PopStateEvent) {
      const s = e.state?.step as Step;
      if (s && STEPS.includes(s)) {
        setStepRaw(s); // Direct set — don't push to history again
      } else {
        setStepRaw("experience");
      }
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Scroll to top of content when step changes
  useEffect(() => {
    contentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [step]);

  // Listen for MiniCart "Checkout" button — jump to contact/details step
  useEffect(() => {
    function handleMiniCartCheckout() {
      if (bookings.length > 0 || packResult) {
        changeStep("contact");
      }
    }
    window.addEventListener("miniCartCheckout", handleMiniCartCheckout);
    return () => window.removeEventListener("miniCartCheckout", handleMiniCartCheckout);
  }, [bookings, packResult]);

  // Sync racing bookings to sessionStorage so the unified MiniCart can display them
  useEffect(() => {
    const existingCart: unknown[] = (() => {
      try { return JSON.parse(sessionStorage.getItem("attractionCart") || "[]"); } catch { return []; }
    })();
    // Remove old racing items (re-sync)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nonRacing = existingCart.filter((item: any) => item.attraction !== "racing");

    // When a package owns the races (Ultimate Qualifier-style), the
    // mini cart should show ONE bundle line (added below) instead of
    // a separate per-heat row for each component. Without this guard
    // we'd double-render: race-A, race-B, AND "Ultimate Qualifier".
    const packageOwnsRaces = !!(selectedPackage && selectedPackage.races.length > 0);

    // Add current racing items
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const racingItems: any[] = packageOwnsRaces
      ? []
      : bookings.map(b => ({
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
    // Pack/combo bookings live in packResult, not bookings[] — add them too so
    // the MiniCart shows the reservation.
    if (packResult && selectedProduct && packResult.schedules.length > 0) {
      const firstStart = packResult.schedules[0]?.start || "";
      racingItems.push({
        attraction: "racing",
        attractionName: "Racing",
        product: { name: selectedProduct.name, price: selectedProduct.price, bookingMode: "per-pack" },
        date: firstStart.split("T")[0],
        time: { block: { start: firstStart } },
        quantity: 1,
        billLineId: null,
        color: "#E41C1D",
        racerNames: undefined,
        packSchedules: packResult.schedules.map(s => ({ start: s.start, name: s.name })),
      });
    }
    // License + POV handling.
    // If the racer picked the Rookie Pack we collapse license + POV into a
    // single "Rookie Pack" cart row — matches how the review screen and
    // confirmation page already present the bundle. Otherwise show the
    // separate license / POV lines.
    const baseDate = bookings[0]?.block.start.split("T")[0] || "";

    // Package with owned races (Ultimate Qualifier) — render ONE
    // bundled cart line representing the whole package + skip the
    // license/POV/individual-race lines that the package owns.
    // The per-booking race lines were already filtered out at the
    // top of this effect (see packageOwnsRaces guard there).
    if (packageOwnsRaces && selectedPackage) {
      const racerCount = quantity || 1;
      racingItems.push({
        attraction: "racing",
        attractionName: "Racing",
        product: {
          name: selectedPackage.name,
          price: packagePerRacerPrice(selectedPackage),
          bookingMode: "per-person",
        },
        date: baseDate,
        time: { block: { start: "" } },
        quantity: racerCount,
        // No cart × button — package teardown is multi-step (cancel
        // bookings + reset state). Done via OrderSummary's hero card.
        billLineId: null,
        color: "#F59E0B",
        racerNames: undefined,
      });
    }
    const isRookieBundle = !packageOwnsRaces && !!(selectedPov && selectedPov.quantity > 0 && selectedPov.rookiePack);
    if (isRookieBundle && selectedPov) {
      const LICENSE_PRICE = 4.99;
      racingItems.push({
        attraction: "racing",
        attractionName: "Racing",
        product: {
          name: "Rookie Pack (License + POV + Free App)",
          price: LICENSE_PRICE + (selectedPov.price || 0),
          bookingMode: "per-person",
        },
        date: baseDate,
        time: { block: { start: "" } },
        quantity: selectedPov.quantity,
        // Removing the bundle is a multi-step undo (cancel from review or
        // step-back to PovUpsell) — don't expose the cart × button for it.
        billLineId: null,
        color: "#F59E0B",
        racerNames: undefined,
      });
    } else if (!packageOwnsRaces) {
      // Skip itemized license/POV when an Ultimate-Qualifier-style
      // package owns them — the bundle line above represents both.
      if (licenseSold) {
        racingItems.push({
          attraction: "racing",
          attractionName: "Racing",
          product: { name: "FastTrax License", price: 4.99, bookingMode: "per-person" },
          date: baseDate,
          time: { block: { start: "" } },
          quantity: licenseSold.quantity,
          billLineId: licenseSold.billLineId,
          color: "#3B82F6",
          racerNames: undefined,
        });
      }
      if (selectedPov && selectedPov.quantity > 0) {
        racingItems.push({
          attraction: "racing",
          attractionName: "Racing",
          product: {
            name: "POV Race Video",
            price: selectedPov.price || 0,
            bookingMode: "per-person",
          },
          date: baseDate,
          time: { block: { start: "" } },
          quantity: selectedPov.quantity,
          billLineId: selectedPov.billLineId || null,
          color: "#A855F7",
          racerNames: undefined,
        });
      }
    }
    // Add-ons (Shuffly, Duck Pin, etc) — also need to surface in the
    // floating cart. Filter to ones the racer actually selected.
    for (const ao of selectedAddOns.filter(a => a.quantity > 0)) {
      const aoStart = ao.selectedTime || (ao.block as { start?: string } | undefined)?.start || "";
      racingItems.push({
        attraction: "racing",
        attractionName: ao.location === "headpinz" ? "HeadPinz" : "FastTrax",
        product: {
          name: ao.name,
          price: ao.price,
          bookingMode: ao.perPerson ? "per-person" : "per-table",
        },
        date: aoStart.split("T")[0] || baseDate,
        time: { block: { start: aoStart } },
        quantity: ao.quantity,
        billLineId: ao.billLineId || null,
        color: ao.color,
        racerNames: undefined,
      });
    }
    sessionStorage.setItem("attractionCart", JSON.stringify([...nonRacing, ...racingItems]));
    // Nudge MiniCart immediately. It also polls as a fallback, but the
    // poll interval is up to 1.5s which felt sluggish — broadcast a
    // synchronous event so the cart reflects state changes the instant
    // the page state changes.
    try { window.dispatchEvent(new CustomEvent("cart:changed")); } catch { /* SSR / no DOM */ }

    // Also store full racer assignments for the booking record
    // (needed when checkout page creates the booking record)
    const assignments = bookings.flatMap(b =>
      (b.racerNames || []).map(name => {
        const racer = verifiedRacers.find(r => r.fullName === name);
        return {
          racerName: name,
          personId: racer?.personId || null,
          product: b.product.name,
          productId: String(b.product.productId),
          tier: b.product.tier,
          track: b.product.track,
          category: b.product.category,
          heatName: b.block.name,
          heatStart: b.block.start,
          heatStop: b.block.stop || null,
        };
      })
    );
    console.log("[cart sync] racerAssignments:", assignments.length, "bookings:", bookings.length, "verifiedRacers:", verifiedRacers.length);
    if (assignments.length > 0) {
      sessionStorage.setItem("racerAssignments", JSON.stringify(assignments));
      console.log("[cart sync] saved racerAssignments to sessionStorage");
    }
    // Store personId for returning racer detection
    if (verifiedPerson?.personId) {
      sessionStorage.setItem("primaryPersonId", verifiedPerson.personId);
      console.log("[cart sync] saved primaryPersonId:", verifiedPerson.personId);
    }
  }, [bookings, licenseSold, verifiedRacers, verifiedPerson, packResult, selectedProduct, selectedPov, selectedAddOns, selectedPackage, quantity]);

  // Load product catalog from static registry based on day-of-week and racer type
  const fetchCatalog = useCallback((date: string) => {
    setCatalogLoading(true);
    try {
      const classified = getStaticProducts(date, racerType || "new");
      setCatalogProducts(classified);
    } catch (err) {
      console.error("Failed to load catalog:", err);
      setCatalogProducts([]);
    } finally {
      setCatalogLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [racerType]);

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

  // Auto-select "existing" if login code is in URL
  useEffect(() => {
    if (autoCodeRef.current && !racerType) {
      setRacerType("existing");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleExperienceSelect(type: RacerType) {
    trackBookingExperience(type);
    setRacerType(type);
    setVerifiedPerson(null);
    // Clear racing bookings but keep the shared bill (may have attraction items)
    setBookings([]);
    if (type === "new") {
      setTimeout(() => changeStep("party"), 300);
    }
  }

  function handlePersonVerified(person: PersonData) {
    setVerifiedPerson(person);
    // Don't set category yet — will be asked on party step
    setVerifiedRacers([{ ...person, category: undefined }]);
    setAdults(0);
    setJuniors(0);
    // Pre-fill contact from verified person (phone/email from OTP-verified lookup)
    const nameParts = person.fullName.split(" ");
    setContact({
      firstName: nameParts[0] || "",
      lastName: nameParts.slice(1).join(" ") || "",
      email: person.email || "",
      phone: person.phone || "",
      smsOptIn: true,
    });
    // Fetch credits in background (non-blocking)
    fetchRacerCredits(person).then(updated => {
      setVerifiedRacers(prev => prev.map(r => r.personId === updated.personId ? { ...r, hasCredits: updated.hasCredits, creditBalances: updated.creditBalances } : r));
    });
    // Fetch related persons from Pandora (family members)
    setLinkedFetching(true);
    fetch(`/api/pandora?personId=${person.personId}&picture=false`).then(async res => {
      if (!res.ok) { setLinkedFetching(false); return; }
      const data = await res.json();
      // Store waiver status on primary racer
      if (typeof data.valid === "boolean") {
        setVerifiedRacers(prev => prev.map(r => r.personId === person.personId ? { ...r, waiverValid: data.valid } : r));
      }
      const relatedIds: string[] = data.related || [];
      if (relatedIds.length === 0) { setLinkedFetching(false); return; }
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
      setLinkedFetching(false);
    }).catch(() => { setLinkedFetching(false); });
    // Go to party step — will show category choice for primary
    setTimeout(() => changeStep("party"), 300);
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
      const tags = (p.tags || []).sort((a: { lastSeen: string }, b: { lastSeen: string }) =>
        (b.lastSeen || "").localeCompare(a.lastSeen || "")
      );
      const memberships = (p.memberships || [])
        .filter((m: { stops: string; name: string }) =>
          (!m.stops || new Date(m.stops) > new Date()) &&
          isRelevantMembership(m.name)
        )
        .map((m: { name: string }) => m.name)
        .filter((name: string, i: number, arr: string[]) => arr.indexOf(name) === i);

      // Check waiver via Pandora
      let waiverValid = false;
      try {
        const pandoraRes = await fetch(`/api/pandora?personId=${pandoraId}&picture=false`);
        if (pandoraRes.ok) {
          const pandoraData = await pandoraRes.json();
          waiverValid = pandoraData.valid === true;
        }
      } catch { /* non-fatal */ }

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
        waiverValid,
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

  function handlePartyNext() {
    if (racerType === "new") {
      setShowHeightConfirm(true);
      return;
    }
    trackBookingParty(adults, juniors);
    changeStep("date");
  }

  function handleHeightConfirmed() {
    setShowHeightConfirm(false);
    trackBookingParty(adults, juniors);
    changeStep("date");
  }

  function handleDateSelect(date: string) {
    trackBookingDate(date);
    setSelectedDate(date);
    setSelectedProduct(null);
    setSelectedProposal(null);
    setSelectedBlock(null);
    // Don't clear bookings — prior bookings persist so "Add Another Race"
    // (and manual back-nav) can stack onto the same bill.
    setBookingCategory(adults > 0 ? "adult" : "junior");
    fetchCatalog(date);

    // Mega Tuesday + first-time Junior racers = no qualifying product.
    // Hold the step on `date` so the warning banner below renders and
    // the guest can pick a different date or adjust their party before
    // progressing.
    const [y, m, d] = date.split("T")[0].split("-").map(Number);
    const isTuesday = new Date(y, m - 1, d).getDay() === 2;
    const hasNewJuniors = racerType === "new" && juniors > 0;
    if (isTuesday && hasNewJuniors) {
      return; // stay on "date" step — warning is rendered inline
    }

    changeStep("product");
  }

  function handleProductSelect(product: ClassifiedProduct) {
    trackBookingProduct(product.name, product.track, product.tier);
    // Picking a plain race clears any in-flight package selection.
    setSelectedPackage(null);
    setSelectedProduct(product);
    // Set quantity based on party size for this category
    const q = product.category === "adult" ? adults : juniors;
    setQuantity(Math.max(1, q));
    // Auto-advance to heat selection
    setHeatPickerKey(k => k + 1); // Force fresh HeatPicker mount
    setTimeout(() => changeStep("heat"), 300);
  }

  /** User picked a package on the product step. Clears any in-flight
   *  single-race state, sets `selectedPackage`, and advances to the
   *  heat step. The PackageHeatPicker takes over from there for any
   *  package whose `races` array is non-empty. */
  function handleSelectPackage(pkg: PackageDefinition) {
    trackBookingProduct(pkg.name, null, "starter");
    setSelectedProduct(null);
    setSelectedPackage(pkg);
    // Heats book per-racer × N seats (the package is "all share heats"
    // multi-racer pattern). Use the total racer count.
    const total = adults + juniors;
    setQuantity(Math.max(1, total));
    setTimeout(() => changeStep("heat"), 300);
  }

  /** Tear down a package selection mid-flow. Cancels any heat lines
   *  the PackageHeatPicker booked, clears state, and bounces the user
   *  back to the product picker. Mirrors the rookie-pack cancel
   *  pattern so customers can change their mind without restarting. */
  async function handleRemovePackage() {
    // Remove any BMI bill lines that came from package heats.
    for (const b of bookings) {
      if (b.billLineIds && b.billLineIds.length > 0) {
        for (const ll of b.billLineIds) {
          try { await removeBookingLine(ll.billId, ll.lineId); } catch { /* non-fatal */ }
        }
      }
    }
    setBookings([]);
    setActiveBills([]);
    setSelectedPackage(null);
    setSelectedProduct(null);
    setSelectedProposal(null);
    setSelectedBlock(null);
    setSelectedPov(null);
    changeStep("product");
  }

  /** All package heats picked. Books each one as a BMI bill line and
   *  populates `bookings` so the existing downstream flow (POV, add-
   *  ons, contact, summary) works unchanged. After booking, advances
   *  past POV when the package already includes it. */
  async function handlePackageHeatsConfirm({ picks }: { picks: PackagePick[] }) {
    if (!selectedPackage) return;

    // Book each component sequentially on the same bill so BMI sees
    // them as one order. Mirrors the PackHeatPicker's same-bill
    // pattern (re-uses orderId after the first booking).
    let billId: string | undefined;
    const newBookings: Booking[] = [];
    try {
      for (const pick of picks) {
        // Synthesize a ClassifiedProduct shape for bookRaceHeat —
        // mirrors what PackageHeatPicker uses internally.
        const race: ClassifiedProduct = {
          productId: pick.component.productId,
          pageId: pick.component.pageId,
          name: pick.component.label,
          tier: pick.component.tier,
          category: "adult",
          track: pick.component.track,
          price: pick.component.price,
          isCombo: false,
          packType: "none",
          raceCount: 1,
          sessionGroup: "",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          raw: {} as any,
        };
        const result = await bookRaceHeat(race, quantity, pick.proposal, billId);
        if (!billId) billId = result.rawOrderId;
        newBookings.push({
          product: race,
          quantity,
          proposal: pick.proposal,
          block: pick.block,
          blockPrice: pick.component.price,
          billLineIds: result.billLineId
            ? [{ billId: result.rawOrderId, lineId: result.billLineId }]
            : undefined,
        });
      }
    } catch (err) {
      console.error("[handlePackageHeatsConfirm] booking failed", err);
      // Bail out — leave state where it was so the user can retry.
      return;
    }

    if (billId) {
      setActiveBills([{ billId, racerName: "Package", category: "adult" as const }]);
      sessionStorage.setItem("attractionOrderId", billId);
    }
    setBookings(newBookings);

    // ── Auto-add License + POV to the BMI bill ────────────────────
    //
    // The package's bundle price INCLUDES license + POV, so they
    // need to be on the bill as line items — otherwise BMI's payment
    // step undercharges by ~$10/racer. Mirrors the auto-adds that
    // run in handleConfirmHeat (license) and handleContinue (POV)
    // for the regular-race / PovUpsell flows.
    const totalRacers = quantity || (adults + juniors) || 1;
    if (selectedPackage.includesLicense && billId && !licenseSoldRef.current) {
      try {
        const sellBody = `{"ProductId":43473520,"Quantity":${totalRacers},"orderId":${billId}}`;
        const sellQs = new URLSearchParams({ endpoint: "booking/sell" });
        const sellRes = await fetch(`/api/bmi?${sellQs.toString()}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: sellBody,
        });
        const sellRaw = await sellRes.text();
        const sellResult = JSON.parse(sellRaw);
        if (sellResult.success !== false) {
          licenseSoldRef.current = true;
          const lineId = String(sellRaw.match(/"orderItemId"\s*:\s*(\d+)/)?.[1] || "");
          setLicenseSold({ quantity: totalRacers, billLineId: lineId || null });
        }
      } catch (err) {
        console.warn("[package license sell] error (non-fatal):", err);
      }
    }
    if (selectedPackage.includesPov && billId) {
      try {
        const povRes = await fetch("/api/sms?endpoint=booking%2Fsell", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify([{
            productId: "43746981", // POV product
            pageId: null,
            quantity: totalRacers,
            billId,
            dynamicLines: null,
            sellKind: 0,
          }]),
        });
        const povResult = await povRes.json();
        const povLineId = povResult?.parentBillLineId ? String(povResult.parentBillLineId) : undefined;
        // Mirror the rookie-pack PovSelection shape so cart-sync,
        // OrderSummary, and the booking-record write all see a
        // populated POV. `rookiePack: true` keeps confirmation-page
        // back-compat for any code path that still reads it.
        setSelectedPov({
          id: "43746981",
          quantity: totalRacers,
          price: 5,
          billLineId: povLineId,
          rookiePack: selectedPackage.id.startsWith("rookie-pack"),
        });
      } catch (err) {
        console.warn("[package POV sell] error (non-fatal):", err);
      }
    }

    // Skip the POV step when the package already bundles POV — for
    // both Rookie Pack and Ultimate Qualifier this means jumping
    // straight to add-ons.
    if (selectedPackage.includesPov) {
      changeStep("addons");
    } else {
      changeStep("pov");
    }
  }

  function handlePackComplete(result: PackBookingResult) {
    setPackResult(result);
    // The pack booking already created the bill during heat selection.
    // Register it in activeBills so the summary/payment step can render — it keys off activeOrderId.
    if (result.billId) {
      setActiveBills(prev =>
        prev.some(b => b.billId === result.billId)
          ? prev
          : [...prev, { billId: result.billId, racerName: "Pack", category: selectedProduct?.category ?? "adult" }]
      );
      sessionStorage.setItem("attractionOrderId", result.billId);
    }
    // Follow the same upsell sequence as single-race bookings: POV → add-ons → contact.
    changeStep("pov");
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
      const existingBillId = activeBills.length > 0 ? activeBills[0].billId : (sessionStorage.getItem("attractionOrderId") || null);

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
        // New racers: one bill for the group
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

      // Sell FastTrax License — ONLY for new racers, never returning racers
      // Triple guard: no selectedRacers (structural), racerType check, and once-per-session ref
      const primaryBillId = activeBills[0]?.billId || createdBills[0]?.billId;
      console.log("[license check]", { selectedRacers: !!selectedRacers, selectedRacersLen: selectedRacers?.length, racerType, licenseSold: licenseSoldRef.current, primaryBillId });
      if (!selectedRacers && racerType === "new" && !licenseSoldRef.current && primaryBillId) {
        try {
          const totalRacers = adults + juniors;
          const sellBody = `{"ProductId":43473520,"Quantity":${totalRacers},"orderId":${primaryBillId}}`;
          const sellQs = new URLSearchParams({ endpoint: "booking/sell" });
          const sellRes = await fetch(`/api/bmi?${sellQs.toString()}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: sellBody,
          });
          const sellRaw = await sellRes.text();
          const sellResult = JSON.parse(sellRaw);
          if (sellResult.success !== false) {
            licenseSoldRef.current = true;
            const lineId = String(sellRaw.match(/"orderItemId"\s*:\s*(\d+)/)?.[1] || "");
            setLicenseSold({ quantity: totalRacers, billLineId: lineId || null });
            console.log("[license sell] sold", totalRacers, "license(s) on bill", primaryBillId, "lineId:", lineId);
          } else {
            console.warn("[license sell] failed:", sellResult.errorMessage);
          }
        } catch (err) {
          console.warn("[license sell] error (non-fatal):", err);
        }
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

      // Immediately sync racer assignments to sessionStorage (don't wait for effect)
      const allAssignments = updatedBookings.flatMap(b =>
        (b.racerNames || []).map(name => {
          const racer = verifiedRacers.find(r => r.fullName === name);
          return {
            racerName: name,
            personId: racer?.personId || null,
            product: b.product.name,
            productId: String(b.product.productId),
            tier: b.product.tier,
            track: b.product.track,
            category: b.product.category,
            heatName: b.block.name,
            heatStart: b.block.start,
            heatStop: b.block.stop || null,
          };
        })
      );
      if (allAssignments.length > 0) {
        sessionStorage.setItem("racerAssignments", JSON.stringify(allAssignments));
      }

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
        changeStep("product");
      } else if (needJunior) {
        setBookingCategory("junior");
        setSelectedProduct(null);
        setSelectedProposal(null);
        setSelectedBlock(null);
        changeStep("product");
      } else if (selectedRacers && selectedRacers.length > 0) {
        // Returning racers: show choice to continue or add another race
        setShowPostBookChoice(true);
      } else {
        changeStep("pov");
      }
    } catch (err) {
      console.error("[bookHeatForRacers] booking failed:", err);
      alert("Failed to reserve heat. Please try again.");
    }
  }

  /** Called when racer selector confirms which racers to add */
  async function handleRacerSelectorConfirm(selectedRacers: PersonData[]) {
    if (!pendingHeat) return;
    // Keep racer selector visible as overlay while heat books — don't clear pendingHeat yet
    await bookHeatForRacers(pendingHeat.proposal, pendingHeat.block, selectedRacers);
    // Now close both — post-book choice modal is already showing
    setShowRacerSelector(false);
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
    const existingBillId = activeBills.length > 0 ? activeBills[0].billId : (sessionStorage.getItem("attractionOrderId") || null);

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
      // Return to the product (race) step rather than the date step —
      // the new racer keeps the same date and just picks another race.
      // Going back to "date" forced them to re-pick the day, which was
      // unnecessary friction.
      changeStep("product");
    } catch (err) {
      console.error("[handleAddAnother] booking failed:", err);
      alert("Failed to reserve heat. Please try again.");
    }
  }

  function handleContactSubmit(info: ContactInfo) {
    trackBookingContact();
    setContact(info);
    changeStep("summary");
  }

  function cancelActiveOrder() {
    for (const bill of activeBills) {
      bmiDelete(`bill/${bill.billId}/cancel`).catch(() => {});
    }
    // Also cancel bill from sessionStorage (may be from attraction flow)
    const storedBill = sessionStorage.getItem("attractionOrderId");
    if (storedBill && !activeBills.some(b => b.billId === storedBill)) {
      bmiDelete(`bill/${storedBill}/cancel`).catch(() => {});
    }
    setActiveBills([]);
    sessionStorage.removeItem("attractionOrderId");
    sessionStorage.removeItem("attractionCart");
    licenseSoldRef.current = false;
    setLicenseSold(null);
  }

  function goToStep(s: Step) {
    const targetIdx = STEPS.indexOf(s);
    if (targetIdx < currentIdx) {
      changeStep(s);
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
      if (mems.some(m => m.includes("pro"))) return 2;
      if (mems.some(m => m.includes("intermediate"))) return 1;
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
      <BrandNav />
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

        {/* Floating cart */}

        {/* STEP 1: Experience level */}
        {step === "experience" && (
          <div className="space-y-8">
            <ExperiencePicker selected={racerType} onSelect={handleExperienceSelect} />
            {racerType === "existing" && !verifiedPerson && (
              <ReturningRacerLookup
                onVerified={handlePersonVerified}
                onSwitchToNew={() => handleExperienceSelect("new")}
                autoCode={autoCodeRef.current}
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
              <button onClick={() => changeStep("experience")} className="text-sm text-white/40 hover:text-white/70 transition-colors">
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
                    <span className="text-white/30 text-xs">13+ &middot; 59&quot;+ tall</span>
                  </button>
                  <button
                    onClick={() => handlePrimaryCategorySelect("junior")}
                    className="py-3 rounded-lg border border-white/15 bg-white/5 text-white text-sm font-semibold hover:border-[#00E2E5]/50 transition-colors"
                  >
                    <span className="block">Junior</span>
                    <span className="text-white/30 text-xs">7-13 &middot; 49&quot;+ tall</span>
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
                        <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-white/10 text-white/50">
                          {r.category === "junior" ? "Junior" : "Adult"}
                        </span>
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                          getRacerTier(r.memberships || []) === "Pro"
                            ? "bg-red-500/20 text-red-400"
                            : getRacerTier(r.memberships || []) === "Intermediate"
                            ? "bg-blue-500/20 text-blue-400"
                            : "bg-green-500/20 text-green-400"
                        }`}>
                          {getRacerTier(r.memberships || [])}
                        </span>
                        {(r.memberships || []).some(m => m.toLowerCase().includes("license fee")) && (
                          <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                            License
                          </span>
                        )}
                        {r.waiverValid && (
                          <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 inline-flex items-center gap-1">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                            Express Lane
                          </span>
                        )}
                      </div>
                      {/* Credit balances */}
                      {r.hasCredits && r.creditBalances && r.creditBalances.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {r.creditBalances.map((cb, ci) => (
                            <span key={ci} className="text-xs font-semibold px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-400/80">
                              {cb.kind}: {cb.balance}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  {i > 0 && (
                    <button
                      type="button"
                      aria-label="Remove racer"
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
                <div className="space-y-2">
                  {linkedFetching && (
                    <div className="flex items-center justify-center gap-2 py-3 rounded-xl border border-dashed border-[#8652FF]/20">
                      <div className="w-3.5 h-3.5 border-2 border-[#8652FF]/20 border-t-[#8652FF] rounded-full animate-spin" />
                      <span className="text-[#8652FF]/50 text-xs font-semibold">Loading linked racers...</span>
                    </div>
                  )}
                  <div className="flex gap-2">
                    {linkedPersons.length > 0 && (
                      <button
                        onClick={() => setShowLinkedModal(true)}
                        className="flex-1 py-3 rounded-xl border border-dashed border-[#8652FF]/40 text-[#8652FF]/70 text-sm font-semibold hover:border-[#8652FF]/70 hover:text-[#8652FF] transition-colors"
                      >
                        + Linked Racer ({linkedPersons.length})
                      </button>
                    )}
                    <button
                      onClick={() => { setAddingRacer(true); setAddingCategory(null); setAddingFoundPerson(null); setAddingAge(null); }}
                      className={`${linkedPersons.length > 0 ? "flex-1" : "w-full"} py-3 rounded-xl border border-dashed border-white/20 text-white/40 text-sm font-semibold hover:border-[#00E2E5]/50 hover:text-[#00E2E5] transition-colors`}
                    >
                      + Add Racer
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-[#00E2E5]/30 bg-[#00E2E5]/5 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[#00E2E5] text-xs font-bold uppercase tracking-wider">Add Racer</p>
                    <button onClick={() => { setAddingRacer(false); setAddingCategory(null); }} className="text-white/30 text-xs hover:text-white/50">Cancel</button>
                  </div>

                  {/* Step 1: Look up the racer */}
                  {!addingFoundPerson && (
                    <ReturningRacerLookup
                      onVerified={(person) => {
                        setAddingFoundPerson(person);
                        // Calculate age from birthDate (from Office API)
                        if (person.birthDate) {
                          const age = Math.floor((Date.now() - new Date(person.birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
                          setAddingAge(age);
                        } else {
                          setAddingAge(null);
                        }
                      }}
                      onSwitchToNew={() => { setAddingRacer(false); setAddingCategory(null); setAddingFoundPerson(null); }}
                    />
                  )}

                  {/* Step 2: Pick category based on age */}
                  {addingFoundPerson && !addingCategory && (() => {
                    const isUnder13 = addingAge !== null && addingAge < 13;
                    const is13OrOver = addingAge !== null && addingAge >= 13;
                    return (
                      <div className="space-y-3">
                        <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-3 text-center">
                          <p className="text-green-400 text-sm font-semibold">{addingFoundPerson.fullName}</p>
                          {addingAge !== null && <p className="text-white/40 text-xs">Age: {addingAge}</p>}
                        </div>
                        <p className="text-white/50 text-xs">Select racer type:</p>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            onClick={() => { handleAddRacer(addingFoundPerson, "adult"); setAddingRacer(false); setAddingCategory(null); setAddingFoundPerson(null); }}
                            disabled={isUnder13}
                            className={`py-3 rounded-lg border text-sm font-semibold transition-colors ${isUnder13 ? "border-white/5 bg-white/[0.02] text-white/20 cursor-not-allowed" : "border-white/15 bg-white/5 text-white hover:border-[#00E2E5]/50"}`}
                          >
                            <span className="block">Adult</span>
                            <span className={`text-xs ${isUnder13 ? "text-white/10" : "text-white/30"}`}>13+ · 59&quot;+ tall</span>
                          </button>
                          <button
                            onClick={() => { handleAddRacer(addingFoundPerson, "junior"); setAddingRacer(false); setAddingCategory(null); setAddingFoundPerson(null); }}
                            disabled={is13OrOver}
                            className={`py-3 rounded-lg border text-sm font-semibold transition-colors ${is13OrOver ? "border-white/5 bg-white/[0.02] text-white/20 cursor-not-allowed" : "border-white/15 bg-white/5 text-white hover:border-[#8652FF]/50"}`}
                          >
                            <span className="block">Junior</span>
                            <span className={`text-xs ${is13OrOver ? "text-white/10" : "text-white/30"}`}>7-12 · 49&quot;+ tall</span>
                          </button>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
            )}

            {verifiedRacers[0]?.category && (
              <>
                <div className="max-w-md mx-auto rounded-xl border border-white/8 bg-white/3 p-3 text-xs text-white/40 text-center">
                  {verifiedRacers.length} racer{verifiedRacers.length !== 1 ? "s" : ""} in your party
                </div>

                {/* Express Lane tip */}
                {verifiedRacers.some(r => r.waiverValid) && (
                  <div className="max-w-md mx-auto rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                    <div className="flex items-start gap-3">
                      <div className="w-7 h-7 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0 mt-0.5">
                        <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-emerald-400 text-xs font-bold uppercase tracking-wider mb-1">Express Lane Eligible</p>
                        <p className="text-white/50 text-xs leading-relaxed">
                          {verifiedRacers.every(r => r.waiverValid === true)
                            ? "All racers in your party are express lane eligible! After checkout, you\u2019ll receive a green express pass — skip Guest Services and Event Check-In and head straight to Karting."
                            : "Some racers are express lane eligible. If all racers have a valid license, your party can skip Guest Services and Event Check-In and head straight to Karting after checkout."
                          }
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between max-w-md mx-auto">
                  <button onClick={() => { changeStep("experience"); setVerifiedPerson(null); setVerifiedRacers([]); }} className="text-sm text-white/40 hover:text-white/70 transition-colors">
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
        {step === "date" && (() => {
          // Mega Tuesdays don't run Junior Starter races — first-time
          // junior racers can't race that day. Catch it the moment
          // Tuesday is picked (via selectedDate), before the guest
          // burns time on product + heat selection only to find no
          // junior options. Returning juniors have already cleared
          // Starter so they're fine.
          const isMegaTuesday = (() => {
            if (!selectedDate) return false;
            const [y, m, d] = selectedDate.split("T")[0].split("-").map(Number);
            return new Date(y, m - 1, d).getDay() === 2; // 2 = Tuesday
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
                          onClick={() => { setSelectedDate(null); }}
                          className="flex-1 px-4 py-2.5 rounded-lg font-body font-bold text-sm uppercase tracking-wider bg-amber-400 text-[#010A20] hover:bg-amber-300 transition-colors cursor-pointer"
                        >
                          Pick a different date
                        </button>
                        <button
                          type="button"
                          onClick={() => changeStep("party")}
                          className="flex-1 px-4 py-2.5 rounded-lg font-body font-bold text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/20 hover:border-white/40 transition-colors cursor-pointer"
                        >
                          Change party
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <button onClick={() => changeStep("party")} className="text-sm text-white/40 hover:text-white/70 transition-colors">
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
                  const hasPro = catMems.some(m => m.toLowerCase().includes("pro"));
                  const hasInt = catMems.some(m => m.toLowerCase().includes("intermediate"));
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
                  packages={
                    // All eligible packages render — Rookie Pack now
                    // has per-schedule variants (each with its own
                    // Starter race component) so the legacy
                    // races.length > 0 filter is no longer needed.
                    selectedDate
                      ? eligiblePackages({
                          racerType,
                          schedule: scheduleForDate(selectedDate),
                          category: bookingCategory,
                        }).filter((p) => p.id !== "rookie-pack")
                      : []
                  }
                  racerCount={adults + juniors}
                  onSelectPackage={handleSelectPackage}
                  date={selectedDate}
                />
              </>
            )}
            <button onClick={() => changeStep("date")} className="text-sm text-white/40 hover:text-white/70 transition-colors">
              ← Change date
            </button>
          </div>
        )}

        {/* STEP 5a: Package heat picker — multi-component sequential
            picker for packages with bundled races (Ultimate Qualifier).
            Renders ahead of the single-race HeatPicker because
            selectedProduct is null when a package is active. */}
        {step === "heat" && selectedPackage && selectedPackage.races.length > 0 && selectedDate && (
          <PackageHeatPicker
            pkg={selectedPackage}
            date={selectedDate}
            quantity={quantity}
            bookedHeats={
              bookings.map((b) => ({
                start: b.block.start,
                stop: b.block.stop,
                track: b.product.track,
              }))
            }
            minAdvanceMinutes={
              racerType === "existing" && verifiedRacers.length > 0 &&
              verifiedRacers.every((r) => r.waiverValid === true)
                ? 0 : 75
            }
            onConfirm={handlePackageHeatsConfirm}
            onBack={() => {
              // Bail out of the package — clear state, return to picker.
              setSelectedPackage(null);
                        changeStep("product");
            }}
          />
        )}

        {/* STEP 5: Heat + Quantity */}
        {step === "heat" && selectedProduct && selectedDate && (
          selectedProduct.packType !== "none" ? (
            <PackHeatPicker
              race={selectedProduct}
              date={selectedDate}
              quantity={quantity}
              onComplete={handlePackComplete}
              onBack={() => changeStep("product")}
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
              onBack={() => changeStep("product")}
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
              minAdvanceMinutes={
                // Express lane = all racers have valid Pandora waiver → no minimum
                // Everyone else = 75 min (1hr 15min) for Guest Services check-in
                racerType === "existing" && verifiedRacers.length > 0 &&
                verifiedRacers.every(r => r.waiverValid === true)
                  ? 0 : 75
              }
            />
          )
        )}

        {/* Height/age confirmation modal for new racers */}
        {showHeightConfirm && (() => {
          const disclaimers = [
            ...(adults > 0 ? [`I have ${adults} adult racer${adults !== 1 ? "s" : ""} who ${adults !== 1 ? "are each" : "is"} at least 13 years old and at least 59" tall (4'11")`] : []),
            ...(juniors > 0 ? [`I have ${juniors} junior racer${juniors !== 1 ? "s" : ""} who ${juniors !== 1 ? "are each" : "is"} between ages 7–13 and between 49" and 70" tall`] : []),
            "I understand that racers who do not meet height or age requirements will not be permitted to race",
            "FastTrax has strict age and height requirements, some enforceable by state regulations. Misrepresenting age may result in removal from the facility.",
          ];
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
              <div className="bg-[#0a1628] border border-white/15 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-5">
                <div className="text-center">
                  <h3 className="text-white font-display text-xl uppercase tracking-widest">Confirm Your Party</h3>
                  <p className="text-white/40 text-sm mt-2">Just like roller coasters, height and age requirements are state mandated and must be followed.</p>
                </div>

                <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
                  <p className="text-amber-400 font-bold text-xs uppercase tracking-wider">Please acknowledge</p>
                  {disclaimers.map((text, i) => (
                    <label key={i} className="flex items-start gap-3 cursor-pointer group">
                      <input
                        type="checkbox"
                        id={`height-ack-${i}`}
                        className="mt-0.5 w-4 h-4 rounded border-white/30 bg-white/5 accent-[#00E2E5] shrink-0"
                      />
                      <span className="text-white/70 text-xs leading-relaxed group-hover:text-white/90 transition-colors">{text}</span>
                    </label>
                  ))}
                </div>

                <button
                  id="height-confirm-btn"
                  onClick={() => {
                    const allChecked = disclaimers.every((_, i) => (document.getElementById(`height-ack-${i}`) as HTMLInputElement)?.checked);
                    if (allChecked) {
                      handleHeightConfirmed();
                    } else {
                      const warn = document.getElementById("height-warn");
                      if (warn) { warn.style.display = "block"; warn.classList.add("animate-pulse"); }
                      // Highlight unchecked boxes
                      disclaimers.forEach((_, i) => {
                        const cb = document.getElementById(`height-ack-${i}`) as HTMLInputElement;
                        if (cb && !cb.checked) cb.parentElement?.classList.add("ring-2", "ring-red-500/50");
                      });
                    }
                  }}
                  className="w-full py-3.5 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25"
                >
                  Confirm & Pick a Date →
                </button>
                <p id="height-warn" className="text-red-400 text-xs text-center font-semibold" style={{ display: "none" }}>
                  Please check all boxes above to continue
                </p>
                <button
                  onClick={() => setShowHeightConfirm(false)}
                  className="w-full py-2.5 rounded-xl font-semibold text-xs border border-white/20 text-white/70 hover:border-white/40 hover:text-white transition-colors"
                >
                  Change Party Size
                </button>
              </div>
            </div>
          );
        })()}

        {/* Post-book choice — shown after returning racers book a heat */}
        {showPostBookChoice && step === "heat" && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
            <div className="bg-[#0a1628] border border-white/15 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4">
              <div className="text-center">
                <div className="text-3xl mb-2">🏁</div>
                <h3 className="text-white font-display text-xl uppercase tracking-widest">Heat Booked!</h3>
                <p className="text-white/50 text-sm mt-1">
                  {bookings.length > 0 && `${bookings[bookings.length - 1]?.product.name} — ${bookings[bookings.length - 1]?.block.name}`}
                </p>
              </div>
              <div className="space-y-2">
                <button
                  onClick={() => { setShowPostBookChoice(false); changeStep("pov"); }}
                  className="w-full py-3.5 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25"
                >
                  Continue to Checkout →
                </button>
                <button
                  onClick={() => {
                    setShowPostBookChoice(false);
                    setSelectedProposal(null);
                    setSelectedBlock(null);
                    setHeatPickerKey(k => k + 1);
                    // Mega: stay on heat step (one track). Others: go to product picker to allow track switch
                    if (selectedProduct?.track === "Mega") {
                      // Stay on heat step — same product
                    } else {
                      setSelectedProduct(null);
                      changeStep("product");
                    }
                  }}
                  className="w-full py-3 rounded-xl font-semibold text-xs border border-white/20 text-white/70 hover:border-white/40 hover:text-white transition-colors"
                >
                  + Add Another Race
                </button>
              </div>
            </div>
          </div>
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
            racerType={racerType}
            onContinue={async (pov) => {
              trackBookingPov(pov?.quantity ?? 0);
              // Belt-and-suspenders: scrub EVERY POV line from the
              // bill before deciding what to do next. Handles
              // - The previous Rookie Pack's parent line + any orphan
              //   children that weren't cascaded by removeItem
              // - Stale POV from a prior pick where billLineId
              //   tracking failed
              // - The user toggling License-only after cancelling a
              //   pack from review (selectedPov is null at that
              //   point, so the existing single-line remove was a
              //   no-op).
              if (activeOrderId) {
                try {
                  const ovRes = await fetch(`/api/sms?endpoint=bill%2Foverview&billId=${activeOrderId}`);
                  if (ovRes.ok) {
                    const ov = await ovRes.json();
                    // BMI/SMS-Timing returns lines keyed by `id`, NOT `lineId`.
                    // Earlier versions of this scrub filtered on `lineId` and
                    // matched nothing, leaving POV on the bill — so the user
                    // saw the POV row stick around after switching from pack
                    // to license-only. Filter on `id` to actually catch them.
                    const povLines: string[] = (ov.lines || [])
                      .filter((l: { name?: string; id?: string | number }) =>
                        !!l.id && (l.name || "").toLowerCase().includes("pov"),
                      )
                      .map((l: { id: string | number }) => String(l.id));
                    console.log("[PovUpsell continue] POV scrub on bill", activeOrderId, "lines:", povLines);
                    for (const lineId of povLines) {
                      await removeBookingLine(activeOrderId, lineId).catch((err) =>
                        console.warn("[PovUpsell continue] remove POV line failed:", lineId, err),
                      );
                    }
                  }
                } catch (err) {
                  console.warn("[PovUpsell continue] overview fetch failed:", err);
                }
              }
              // (Old single-line removal kept for parity with prior
              // logic in case the overview fetch returned no POV
              // lines but selectedPov had a tracked id.)
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
              changeStep("addons");
            }}
            onBack={() => changeStep("heat")}
          />
        )}

        {/* STEP 7: Activity add-ons */}
        {step === "addons" && (
          <AddOnsPage
            racerCount={bookings.reduce((s, b) => s + b.quantity, 0)}
            date={selectedDate || ""}
            bookedHeats={bookings.map(b => ({ start: b.block.start, stop: b.block.stop, track: b.product.track, tier: b.product.tier, label: b.product.name }))}
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
              if (verifiedPerson && contact && contact.email && contact.phone) {
                changeStep("summary");
              } else {
                changeStep("contact");
              }
            }}
            onBack={() => changeStep("pov")}
          />
        )}

        {/* STEP 7: Contact info */}
        {step === "contact" && (
          <ContactForm
            initial={contact}
            onSubmit={handleContactSubmit}
            onBack={() => changeStep("addons")}
            lockedFields={[
              ...(verifiedPerson?.phone ? ["phone" as const] : []),
              ...(verifiedPerson?.email ? ["email" as const] : []),
            ]}
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
            onBack={() => changeStep("contact")}
            confirmationPath="/book/confirmation"
            packResult={packResult ?? undefined}
            packProduct={packResult ? selectedProduct ?? undefined : undefined}
            onRemovePack={async () => {
              // Cancel the whole pack bill in BMI (all 3 heats live on one
              // orderId for a pack, so one cancel clears all of them) and
              // reset local state so the picker is a clean slate again.
              cancelActiveOrder();
              setPackResult(null);
              setSelectedProduct(null);
              changeStep("product");
            }}
            personId={verifiedPerson?.personId}
            verifiedRacers={verifiedRacers.filter(r => r.personId).map(r => ({ personId: r.personId, fullName: r.fullName }))}
            addOns={selectedAddOns.map(a => ({ id: a.id, name: a.name, price: a.price, quantity: a.quantity, perPerson: a.perPerson, proposal: a.proposal, block: a.block, selectedTime: a.selectedTime }))}
            pov={selectedPov}
            selectedPackage={selectedPackage}
            onRemovePackage={handleRemovePackage}
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
                  changeStep("date");
                } else {
                  changeStep("heat");
                  setTimeout(() => changeStep("summary"), 200);
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
              changeStep("heat");
              setTimeout(() => changeStep("summary"), 200);
            }}
            onRemovePov={async () => {
              if (selectedPov?.billLineId) {
                await removeBookingLine(activeOrderId!, selectedPov.billLineId).catch(() => {});
              }
              setSelectedPov(null);
              changeStep("heat");
              setTimeout(() => changeStep("summary"), 200);
            }}
            onCancelRookiePack={async () => {
              // Cancelling the Rookie Pack from the review screen
              // returns the user to the PovUpsell so they can pick
              // License-only (or re-add the bundle). License stays
              // auto-sold (it's required for new racers).
              //
              // Removing JUST selectedPov.billLineId (the parent line
              // returned by booking/sell) sometimes leaves child rows
              // on the bill — BMI doesn't always cascade. So we fetch
              // the bill overview, find every line whose name looks
              // like a POV row, and remove each one. This is what
              // staff actually expects when they hit "cancel pack".
              try {
                if (activeOrderId) {
                  const ovRes = await fetch(`/api/sms?endpoint=bill%2Foverview&billId=${activeOrderId}`);
                  if (ovRes.ok) {
                    const ov = await ovRes.json();
                    // SMS-Timing bill/overview returns each line's id under
                    // `id`, not `lineId`. Filtering on `lineId` matched zero
                    // rows and nothing was actually removed — that's why
                    // POV was still on the BMI bill after cancelling the
                    // pack. Filter on `id`.
                    const povLines: { lineId: string; name: string }[] = (ov.lines || [])
                      .filter((l: { name?: string; id?: string | number }) =>
                        !!l.id && (l.name || "").toLowerCase().includes("pov"),
                      )
                      .map((l: { name?: string; id: string | number }) => ({
                        lineId: String(l.id),
                        name: l.name || "",
                      }));
                    console.log("[cancel rookie pack] POV scrub on bill", activeOrderId, "lines:", povLines);
                    for (const l of povLines) {
                      await removeBookingLine(activeOrderId, l.lineId).catch((err) =>
                        console.warn("[cancel rookie pack] remove POV line failed:", l, err),
                      );
                    }
                  }
                }
              } catch (err) {
                console.warn("[cancel rookie pack] overview fetch failed:", err);
                // Last-ditch fallback: try the parent-line we tracked
                // at sell time. Better than nothing if overview was
                // unavailable.
                if (selectedPov?.billLineId && activeOrderId) {
                  await removeBookingLine(activeOrderId, selectedPov.billLineId).catch(() => {});
                }
              }
              setSelectedPov(null);
              changeStep("pov");
            }}
          />
        )}

        {/* Dev tag */}
        <p className="text-white/10 text-xs text-center mt-12">BMI Public API</p>
      </div>

      {/* Unified floating cart */}
      {/* MiniCart is rendered globally in root layout */}

      {/* Linked Racer Modal */}
      {showLinkedModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          {...modalBackdropProps(() => { setShowLinkedModal(false); setLinkedSelected(null); })}
        >
          <div className="max-w-md w-full rounded-2xl border border-white/10 bg-[#000418] p-6 space-y-4 shadow-2xl max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-white font-display text-lg uppercase tracking-wider">Linked Racers</h3>
                <p className="text-white/40 text-xs">Family members on the same account</p>
              </div>
              <button onClick={() => { setShowLinkedModal(false); setLinkedSelected(null); }} className="text-white/30 hover:text-white/60 text-sm">Close</button>
            </div>

            {/* Step 1: Pick a person */}
            {!linkedSelected && (
              <>
                {linkedPersons.length === 0 && (
                  <p className="text-white/40 text-sm text-center py-4">No linked racers found.</p>
                )}
                {linkedPersons.map(lp => {
                  const alreadyAdded = verifiedRacers.some(r => r.personId === lp.id);
                  return (
                    <div key={lp.id} className={`rounded-xl border p-4 ${alreadyAdded ? "border-green-500/30 bg-green-500/5" : "border-white/10 bg-white/5"}`}>
                      <div className="flex items-center justify-between">
                        <p className="text-white font-semibold text-sm">{lp.firstName} {lp.lastName}</p>
                        {alreadyAdded ? (
                          <span className="text-green-400 text-xs font-bold">Added ✓</span>
                        ) : (
                          <button
                            onClick={async () => {
                              setLinkedLoading(true);
                              // Fetch age from Office API
                              try {
                                const searchRes = await fetch(`/api/bmi-office?action=search&q=${lp.id}&max=5`);
                                const results = await searchRes.json();
                                let age: number | null = null;
                                if (Array.isArray(results) && results.length > 0) {
                                  const detailRes = await fetch(`/api/bmi-office?action=person&id=${results[0].localId}`);
                                  const p = await detailRes.json();
                                  if (p.birthDate) {
                                    age = Math.floor((Date.now() - new Date(p.birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
                                  }
                                }
                                setLinkedSelected({ id: lp.id, name: `${lp.firstName} ${lp.lastName}`, age });
                              } catch {
                                setLinkedSelected({ id: lp.id, name: `${lp.firstName} ${lp.lastName}`, age: null });
                              } finally {
                                setLinkedLoading(false);
                              }
                            }}
                            disabled={linkedLoading}
                            className="px-4 py-1.5 rounded-lg text-xs font-bold bg-[#8652FF]/20 text-[#8652FF] hover:bg-[#8652FF]/30 transition-colors disabled:opacity-40"
                          >
                            Link
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {linkedLoading && (
                  <div className="flex items-center justify-center gap-2 py-2">
                    <div className="w-4 h-4 border-2 border-white/20 border-t-[#8652FF] rounded-full animate-spin" />
                    <span className="text-white/40 text-xs">Loading racer details...</span>
                  </div>
                )}
              </>
            )}

            {/* Step 2: Pick category */}
            {linkedSelected && (() => {
              const isUnder13 = linkedSelected.age !== null && linkedSelected.age < 13;
              const is13OrOver = linkedSelected.age !== null && linkedSelected.age >= 13;
              return (
                <div className="space-y-3">
                  <div className="rounded-lg border border-[#8652FF]/30 bg-[#8652FF]/5 p-3 text-center">
                    <p className="text-white font-semibold text-sm">{linkedSelected.name}</p>
                    {linkedSelected.age !== null && <p className="text-white/40 text-xs">Age: {linkedSelected.age}</p>}
                  </div>
                  <p className="text-white/50 text-xs">Select racer type:</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => { handleAddLinkedRacer(linkedSelected.id, "adult"); setLinkedSelected(null); }}
                      disabled={linkedLoading || isUnder13}
                      className={`py-3 rounded-lg border text-sm font-semibold transition-colors ${isUnder13 ? "border-white/5 bg-white/[0.02] text-white/20 cursor-not-allowed" : "border-white/15 bg-white/5 text-white hover:border-[#00E2E5]/50"}`}
                    >
                      <span className="block">Adult</span>
                      <span className={`text-xs ${isUnder13 ? "text-white/10" : "text-white/30"}`}>13+ · 59&quot;+ tall</span>
                    </button>
                    <button
                      onClick={() => { handleAddLinkedRacer(linkedSelected.id, "junior"); setLinkedSelected(null); }}
                      disabled={linkedLoading || is13OrOver}
                      className={`py-3 rounded-lg border text-sm font-semibold transition-colors ${is13OrOver ? "border-white/5 bg-white/[0.02] text-white/20 cursor-not-allowed" : "border-white/15 bg-white/5 text-white hover:border-[#8652FF]/50"}`}
                    >
                      <span className="block">Junior</span>
                      <span className={`text-xs ${is13OrOver ? "text-white/10" : "text-white/30"}`}>7-12 · 49&quot;+ tall</span>
                    </button>
                  </div>
                  <button onClick={() => setLinkedSelected(null)} className="text-white/30 text-xs hover:text-white/50 transition-colors block mx-auto">
                    ← Back to list
                  </button>
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
