"use client";

import { useState, useEffect, useCallback, useRef, type CSSProperties } from "react";
import { useParams } from "next/navigation";
import {
  getGroupEvent,
  getReservationAttractions,
  getFreeflowAttractions,
} from "@/lib/group-events";
import type {
  GroupEventAttraction,
  GroupEventMealWindow,
  GroupEventLocation,
} from "@/lib/group-events";
import type { ClassifiedProduct, BmiProposal, BmiBlock } from "@/app/book/race/data";
import { bookRaceHeat, bmiPost } from "@/app/book/race/data";
import HeatPicker from "@/app/book/race/components/HeatPicker";
import { pandoraOnboardGuest } from "@/lib/pandora";
import type { PandoraWaiverTemplate } from "@/lib/pandora";
import WaiverSigning from "@/components/pandora/WaiverSigning";

// ── Track info (mirrors ProductPicker's TRACK_INFO) ──────────────────────────

const TRACK_INFO: Record<
  string,
  {
    title: string;
    stat: string;
    tagline: string;
    image: string;
    accent: string;
  }
> = {
  Red: {
    title: "Red Track",
    stat: "1,095 ft",
    tagline: "Technical & clockwise — more turns, more strategy.",
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/red-track-1Fsl8rQ5rVIHi6hXkkvUraGEqr4WM2.jpg",
    accent: "red",
  },
  Blue: {
    title: "Blue Track",
    stat: "1,013 ft",
    tagline: "High-speed & counter-clockwise — long straights, quick finishes.",
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/blue-track-iYCkFVDkIiDVwNQaiABoZsqzj2Fjnj.jpg",
    accent: "blue",
  },
};

// ── Types ────────────────────────────────────────────────────────────────────

type Step =
  | "gate"
  | "mode" // choose: just attending vs. race with us (racing venues only)
  | "attend" // just-attending RSVP form (name + company + guests)
  | "name"
  | "waiver"
  | "dashboard"
  | "racing-track"
  | "racing-heat"
  | "attraction-slots"
  | "confirmation";

interface GuestInfo {
  email: string;
  firstName: string;
  lastName: string;
  displayName: string; // "Eric O."
  birthdate?: string; // "YYYY-MM-DD" — needed for waiver template
}

/** An item in the cart — selected but not yet booked in BMI */
interface CartItem {
  attractionSlug: string;
  label: string;
  track?: string; // racing only
  proposal: BmiProposal;
  block: BmiBlock;
  /** product ID for booking/book */
  productId: string;
  /** Set after booking/book succeeds — the BMI order ID (temp hold). */
  heldOrderId?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDisplayName(first: string, last: string): string {
  return `${first} ${last.charAt(0).toUpperCase()}.`;
}

/** Festive emoji for a "what's included" perk, matched by keyword. */
function includedIcon(item: string): string {
  const s = item.toLowerCase();
  if (s.includes("drink")) return "🍸";
  if (s.includes("buffet") || s.includes("food")) return "🍽️";
  if (s.includes("bowl")) return "🎳";
  if (s.includes("race") || s.includes("kart")) return "🏎️";
  if (s.includes("gift")) return "🎁";
  return "🎄";
}

function sessionKey(slug: string, key: string): string {
  return `groupEvent:${slug}:${key}`;
}

/** Check if a heat (ISO start/stop) overlaps with the meal window */
function heatOverlapsMeal(
  heatStartIso: string,
  heatStopIso: string,
  eventDate: string,
  meal: GroupEventMealWindow,
): boolean {
  const parse = (iso: string) => {
    const clean = iso.replace(/Z$/, "");
    const [dp, tp] = clean.split("T");
    if (!tp) return new Date(clean);
    const [y, m, d] = dp.split("-").map(Number);
    const [h, min] = tp.split(":").map(Number);
    return new Date(y, m - 1, d, h, min);
  };
  const hStart = parse(heatStartIso).getTime();
  const hStop = parse(heatStopIso).getTime();
  const [mh1, mm1] = meal.startTime.split(":").map(Number);
  const [mh2, mm2] = meal.endTime.split(":").map(Number);
  const [ey, em, ed] = eventDate.split("-").map(Number);
  const mStart = new Date(ey, em - 1, ed, mh1, mm1).getTime();
  const mStop = new Date(ey, em - 1, ed, mh2, mm2).getTime();
  return hStart < mStop && hStop > mStart;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function GroupEventPage() {
  const params = useParams();
  const slug = params.slug as string;
  const event = getGroupEvent(slug);

  const [step, setStep] = useState<Step>("gate");
  const [guest, setGuest] = useState<GuestInfo | null>(null);
  const [gateError, setGateError] = useState("");
  // Multi-venue events: which location the guest is RSVPing for (null = not yet chosen).
  const [selectedLocation, setSelectedLocation] = useState<GroupEventLocation | null>(null);
  // "Just attending" RSVP details (company + party size), shown on confirmation.
  const [attendInfo, setAttendInfo] = useState<{ company: string; guests: number } | null>(null);
  // Live countdown clock (client-only — null on SSR to avoid hydration mismatch).
  const [nowMs, setNowMs] = useState<number | null>(null);

  // Cart — items selected but not yet booked
  const [cart, setCart] = useState<CartItem[]>([]);
  const [confirmedBillId, setConfirmedBillId] = useState<string | null>(null);

  // Person + Waiver state
  const [personId, setPersonId] = useState<string | null>(null);
  const [waiverValid, setWaiverValid] = useState(false);
  const [waiverTemplate, setWaiverTemplate] = useState<PandoraWaiverTemplate | null>(null);
  const [waiverLoading, setWaiverLoading] = useState(false);
  const [waiverError, setWaiverError] = useState<string | null>(null);

  // Cancel state
  const [cancellingBillId, setCancellingBillId] = useState<string | null>(null);

  // Racing state
  const [selectedTrack, setSelectedTrack] = useState<string | null>(null);
  const [heatRosters, setHeatRosters] = useState<Record<string, string[]>>({});
  const [bookingInProgress, setBookingInProgress] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);

  // Attraction slot picker state
  const [activeAttraction, setActiveAttraction] = useState<GroupEventAttraction | null>(null);
  const [attractionSlots, setAttractionSlots] = useState<BmiProposal[]>([]);
  const [attractionLoading, setAttractionLoading] = useState(false);

  // Free-flow state
  const [selectedFreeflow, setSelectedFreeflow] = useState<string[]>([]);
  const [freeflowSaved, setFreeflowSaved] = useState(false);

  // Already-confirmed reservations (from previous visit)
  const [existingReservations, setExistingReservations] = useState<
    { type: string; track?: string; time?: string; billId?: string }[]
  >([]);

  const cartRef = useRef<HTMLDivElement>(null);

  // ── Auto-scroll to top on step change ──────────────────────────────────
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [step]);

  // ── Hero video: honor reduced-motion / Save-Data, pick source by viewport ──
  // src starts null so SSR + first paint show the poster still; the effect then
  // promotes to the autoplaying loop (unless the user opted out of motion).
  const [hero, setHero] = useState<{ motion: boolean; src: string | null }>({
    motion: true,
    src: null,
  });
  useEffect(() => {
    const hv = event?.landing?.heroVideo;
    if (!hv) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of browser capabilities on mount
    setHero({
      motion: !reduce && conn?.saveData !== true,
      src: window.innerWidth >= 1024 ? hv.mp4_1080 : hv.mp4_720,
    });
  }, [event]);

  // ── Live countdown tick (client-only; updates each minute) ─────────────────
  useEffect(() => {
    if (!event?.landing?.countdown) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seed clock on mount
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [event]);

  // ── Restore session ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!event) return;
    try {
      const email = sessionStorage.getItem(sessionKey(slug, "email"));
      const firstName = sessionStorage.getItem(sessionKey(slug, "firstName"));
      const lastName = sessionStorage.getItem(sessionKey(slug, "lastName"));
      const storedPersonId = sessionStorage.getItem(sessionKey(slug, "personId"));
      const storedBirthdate = sessionStorage.getItem(sessionKey(slug, "birthdate"));
      const storedLocationKey = sessionStorage.getItem(sessionKey(slug, "location"));
      const loc = storedLocationKey
        ? event.landing?.locations?.find((l) => l.key === storedLocationKey)
        : undefined;
      if (loc) setSelectedLocation(loc);
      if (email && firstName && lastName) {
        setGuest({
          email,
          firstName,
          lastName,
          displayName: makeDisplayName(firstName, lastName),
          birthdate: storedBirthdate || undefined,
        });
        if (storedPersonId) {
          setPersonId(storedPersonId);
          setWaiverValid(true); // They already signed if they have a personId in session
        }
        // Multi-venue events: racers (have a personId from onboarding) resume at
        // the booking dashboard; "just attending" guests resume at confirmation.
        // Legacy events keep the original dashboard resume.
        if (event.landing?.locations) {
          setStep(storedPersonId ? "dashboard" : "confirmation");
        } else {
          setStep("dashboard");
        }
        fetchExistingRsvp(slug, email);
      }
    } catch {
      /* sessionStorage unavailable */
    }
  }, [slug, event]);

  // ── Fetch rosters ────────────────────────────────────────────────────────

  const fetchRosters = useCallback(async () => {
    if (!event) return;
    try {
      const res = await fetch(`/api/group-event/roster?slug=${slug}`);
      const data = await res.json();
      const mapped: Record<string, string[]> = {};
      for (const [key, names] of Object.entries(data.rosters || {})) {
        const colonIdx = key.indexOf(":");
        const heatStart = key.slice(colonIdx + 1);
        if (!mapped[heatStart]) mapped[heatStart] = [];
        mapped[heatStart].push(...(names as string[]));
      }
      setHeatRosters(mapped);
    } catch (err) {
      console.error("[group-event] Failed to fetch rosters:", err);
    }
  }, [slug, event]);

  useEffect(() => {
    if (step === "dashboard" || step === "racing-heat") {
      fetchRosters();
    }
  }, [step, fetchRosters]);

  // ── Fetch existing RSVP ──────────────────────────────────────────────────

  async function fetchExistingRsvp(eventSlug: string, email: string) {
    try {
      const res = await fetch(
        `/api/group-event/rsvp?slug=${eventSlug}&email=${encodeURIComponent(email)}`,
      );
      const data = await res.json();
      if (data?.freeflow) setSelectedFreeflow(data.freeflow);
      // Restore personId from RSVP (survives cancel + rebook)
      if (data?.personId && !personId) {
        setPersonId(data.personId);
        sessionStorage.setItem(sessionKey(slug, "personId"), data.personId);
      }
      if (data?.reservations?.length) {
        setExistingReservations(data.reservations);
        setStep("confirmation");
      }
    } catch {
      /* first visit */
    }
  }

  // ── Not found ────────────────────────────────────────────────────────────

  if (!event) {
    return (
      <div className="min-h-screen bg-[#000418] flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-3xl font-display text-white uppercase tracking-widest mb-4">
            Event Not Found
          </h1>
          <p className="text-white/50">This event link may be expired or invalid.</p>
        </div>
      </div>
    );
  }

  // ── Gate handlers ───────────────────────────────────────────────────────

  function handleGateSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = (form.get("email") as string).trim().toLowerCase();
    // Open-access events skip the company-domain check — any valid email gets in
    // (the input is type="email" required, so the address itself is validated).
    const open = (event!.accessMode ?? "domain") === "open";
    if (!open) {
      const domain = email.split("@")[1];
      if (!domain || !event!.allowedDomains.includes(domain)) {
        const allowed = event!.allowedDomains.filter(
          (d) => d !== "headpinz.com" && d !== "fasttraxent.com",
        );
        setGateError(`This event is for @${allowed[0]} employees`);
        return;
      }
    }
    setGateError("");
    sessionStorage.setItem(sessionKey(slug, "email"), email);
    setGuest((prev) =>
      prev ? { ...prev, email } : { email, firstName: "", lastName: "", displayName: "" },
    );
    // Multi-venue events branch: racing venues let the guest pick attend-vs-race;
    // non-racing venues go straight to the just-attending form. Legacy events
    // (no location chooser) keep the original name → waiver flow.
    if (selectedLocation) {
      setStep(selectedLocation.racing ? "mode" : "attend");
    } else {
      setStep("name");
    }
  }

  // ── Just-attending RSVP (name + company + party size; no waiver/DOB) ───────
  async function handleAttendSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const firstName = (form.get("firstName") as string).trim();
    const lastName = (form.get("lastName") as string).trim();
    const company = (form.get("company") as string).trim();
    const guests = Math.min(2, Math.max(1, Number(form.get("guests")) || 1));
    if (!firstName || !lastName) return;
    const email = guest!.email;
    const displayName = makeDisplayName(firstName, lastName);
    sessionStorage.setItem(sessionKey(slug, "firstName"), firstName);
    sessionStorage.setItem(sessionKey(slug, "lastName"), lastName);
    setGuest({ email, firstName, lastName, displayName });
    setAttendInfo({ company, guests });
    setWaiverLoading(true);
    setWaiverError(null);
    try {
      const res = await fetch("/api/group-event/rsvp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          email,
          name: displayName,
          freeflow: [],
          reservations: [],
          personId: null,
          location: selectedLocation?.key,
          company,
          guests,
        }),
      });
      if (!res.ok) throw new Error("Failed to save RSVP");
      setStep("confirmation");
    } catch (err) {
      console.error("[group-event] Attend RSVP failed:", err);
      setWaiverError(err instanceof Error ? err.message : "Couldn't save your RSVP.");
    } finally {
      setWaiverLoading(false);
    }
  }

  async function handleNameSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const firstName = (form.get("firstName") as string).trim();
    const lastName = (form.get("lastName") as string).trim();
    const bYear = form.get("birth-year") as string;
    const bMonth = form.get("birth-month") as string;
    const bDay = form.get("birth-day") as string;
    // Date of birth is only needed for the racing waiver. RSVP-only venues
    // (Naples — no FastTrax) collect name + email alone.
    const needDob = selectedLocation?.racing !== false;
    if (!firstName || !lastName) return;
    if (needDob && (!bYear || !bMonth || !bDay)) return;
    const birthdate = needDob
      ? `${bYear}-${bMonth.padStart(2, "0")}-${bDay.padStart(2, "0")}`
      : undefined;

    // Age validation
    if (needDob && event?.minAge) {
      const today = new Date();
      const bd = new Date(Number(bYear), Number(bMonth) - 1, Number(bDay));
      let age = today.getFullYear() - bd.getFullYear();
      const monthDiff = today.getMonth() - bd.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < bd.getDate())) age--;
      if (age < event.minAge) {
        setWaiverError(`You must be at least ${event.minAge} years old to attend this event.`);
        return;
      }
    }
    setWaiverError(null);

    const email = guest!.email;
    const displayName = makeDisplayName(firstName, lastName);
    sessionStorage.setItem(sessionKey(slug, "firstName"), firstName);
    sessionStorage.setItem(sessionKey(slug, "lastName"), lastName);
    if (birthdate) sessionStorage.setItem(sessionKey(slug, "birthdate"), birthdate);
    setGuest({ email, firstName, lastName, displayName, birthdate });

    // RSVP-only venues (no racing → no waiver). Record attendance and finish.
    if (selectedLocation && !selectedLocation.racing) {
      setWaiverLoading(true);
      setWaiverError(null);
      try {
        const res = await fetch("/api/group-event/rsvp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            slug,
            email,
            name: displayName,
            freeflow: [],
            reservations: [],
            personId: null,
            location: selectedLocation.key,
          }),
        });
        if (!res.ok) throw new Error("Failed to save RSVP");
        setStep("confirmation");
      } catch (err) {
        console.error("[group-event] RSVP failed:", err);
        setWaiverError(err instanceof Error ? err.message : "Couldn't save your RSVP.");
      } finally {
        setWaiverLoading(false);
      }
      return;
    }

    setWaiverLoading(true);
    setWaiverError(null);

    try {
      // Shared Pandora onboard: create person → check waiver → fetch template
      const pandoraLocation = event?.pandoraLocation ?? "headpinz";
      const result = await pandoraOnboardGuest(
        { firstName, lastName, email, birthdate: birthdate!, location: pandoraLocation },
        pandoraLocation,
      );
      setPersonId(result.personId);
      sessionStorage.setItem(sessionKey(slug, "personId"), result.personId);

      if (result.waiverValid) {
        setWaiverValid(true);
        setStep("dashboard");
        fetchExistingRsvp(slug, email);
      } else {
        setWaiverTemplate(result.template);
        setStep("waiver");
      }
    } catch (err) {
      console.error("[group-event] Name/waiver setup failed:", err);
      setWaiverError(err instanceof Error ? err.message : "Setup failed. Please try again.");
    } finally {
      setWaiverLoading(false);
    }
  }

  // ── Cancel reservation ──────────────────────────────────────────────────

  async function handleCancelReservation(billId: string) {
    if (!guest) return;
    setCancellingBillId(billId);
    try {
      const res = await fetch("/api/group-event/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, billId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Cancel failed");

      // Preserve personId from the cancelled booking (for waiver link on rebook)
      if (data.personId && !personId) {
        setPersonId(data.personId);
        sessionStorage.setItem(sessionKey(slug, "personId"), data.personId);
      }

      // Remove cancelled reservation from RSVP
      const remaining = existingReservations.filter((r) => r.billId !== billId);
      setExistingReservations(remaining);

      // Update RSVP record in Redis
      await fetch("/api/group-event/rsvp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          email: guest.email,
          name: guest.displayName,
          freeflow: selectedFreeflow,
          reservations: remaining,
          personId: data.personId || personId,
          location: selectedLocation?.key,
        }),
      });

      // Remove from heat roster too
      await fetch("/api/group-event/roster", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, email: guest.email }),
      });

      // If no reservations left, go back to dashboard
      if (remaining.length === 0) {
        setStep("dashboard");
      }
    } catch (err) {
      console.error("[group-event] Cancel failed:", err);
      setBookingError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setCancellingBillId(null);
    }
  }

  // ── Cart helpers ────────────────────────────────────────────────────────

  function addToCart(item: CartItem) {
    // Replace if same attraction already in cart
    setCart((prev) => {
      const filtered = prev.filter((c) => c.attractionSlug !== item.attractionSlug);
      return [...filtered, item];
    });
    setStep("dashboard");
    // Scroll to cart after a tick
    setTimeout(() => {
      cartRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
  }

  async function removeFromCart(attractionSlug: string) {
    const item = cart.find((c) => c.attractionSlug === attractionSlug);

    // If this item had a temp hold (racing), cancel the BMI order
    if (item?.heldOrderId && guest) {
      try {
        await fetch("/api/group-event/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug, billId: item.heldOrderId }),
        });
        // Remove from heat roster
        await fetch("/api/group-event/roster", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug, email: guest.email }),
        });
        fetchRosters();
      } catch (err) {
        console.error("[group-event] Failed to cancel held order:", err);
      }
    }

    setCart((prev) => prev.filter((c) => c.attractionSlug !== attractionSlug));
  }

  /** Check if an attraction is already selected (in cart) or already confirmed */
  function isAttractionSelected(attrSlug: string): boolean {
    return cart.some((c) => c.attractionSlug === attrSlug);
  }

  function isAttractionConfirmed(attrSlug: string): boolean {
    if (attrSlug === "racing") {
      return existingReservations.some((r) => r.type === "racing");
    }
    return existingReservations.some((r) => r.type === attrSlug);
  }

  function getExistingBooking(attrSlug: string) {
    if (attrSlug === "racing") return existingReservations.find((r) => r.type === "racing");
    return existingReservations.find((r) => r.type === attrSlug);
  }

  function getCartItem(attrSlug: string) {
    return cart.find((c) => c.attractionSlug === attrSlug);
  }

  // ── Racing heat → book immediately (creates temp hold like normal flow) ──

  async function handleRaceHeatSelect(proposal: BmiProposal, block: BmiBlock) {
    if (!selectedTrack || !event || !guest) return;
    const trackConfig = event.attractions
      .find((a) => a.slug === "racing")
      ?.bmiTracks?.find((t) => t.track === selectedTrack);
    if (!trackConfig) return;

    setBookingInProgress(true);
    setBookingError(null);

    try {
      const product: ClassifiedProduct = {
        productId: trackConfig.productId,
        pageId: trackConfig.pageId,
        name: `Starter Race ${selectedTrack}`,
        tier: "starter",
        category: "adult",
        track: selectedTrack,
        price: 0,
        isCombo: false,
        packType: "none",
        raceCount: 1,
        sessionGroup: "Karting",
        raw: {
          id: 0,
          name: `Starter Race ${selectedTrack}`,
          info: "",
          hasPicture: false,
          isCombo: false,
          minAge: null,
          maxAge: null,
          isMembersOnly: false,
          minAmount: -1,
          maxAmount: 10,
          resourceKind: "Race",
          kind: 2,
          bookingMode: 0,
          productGroup: "Karting",
          prices: [{ amount: 0, kind: 0, shortName: "m", depositKind: 0 }],
          resources: [],
          dynamicGroups: null,
          xRef: null,
        },
      };

      const { rawOrderId } = await bookRaceHeat(product, 1, proposal);
      console.log("[group-event] race held, orderId:", rawOrderId);

      // Register contact person on held order so BMI links waiver to guest
      if (personId) {
        try {
          const contactBody = JSON.stringify({
            firstName: guest.firstName,
            lastName: guest.lastName,
            email: guest.email,
          });
          const contactJson =
            `{"personId":${personId},"orderId":${rawOrderId},` + contactBody.slice(1);
          await fetch(
            "/api/bmi?" + new URLSearchParams({ endpoint: "person/registerContactPerson" }),
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: contactJson,
            },
          );
        } catch {
          /* non-fatal */
        }
      }

      // Record on roster immediately so other guests see the name
      await fetch("/api/group-event/roster", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          track: selectedTrack,
          heatStart: block.start,
          email: guest.email,
          displayName: guest.displayName,
        }),
      });
      fetchRosters();

      addToCart({
        attractionSlug: "racing",
        label: `Go-Kart Racing · ${selectedTrack} Track`,
        track: selectedTrack,
        proposal,
        block,
        productId: trackConfig.productId,
        heldOrderId: rawOrderId,
      });
    } catch (err) {
      console.error("[group-event] Race hold failed:", err);
      setBookingError(
        err instanceof Error ? err.message : "Failed to reserve heat. Please try again.",
      );
      // Stay on heat picker so they can retry
    } finally {
      setBookingInProgress(false);
    }
  }

  // ── Attraction slot → add to cart (no immediate BMI call) ───────────────

  function handleAttractionSlotSelect(
    attraction: GroupEventAttraction,
    proposal: BmiProposal,
    block: BmiBlock,
  ) {
    addToCart({
      attractionSlug: attraction.slug,
      label: attraction.label,
      proposal,
      block,
      productId: attraction.bmiProductId!,
    });
  }

  // ── Confirm all — close held racing + book remaining items on same bill ─

  async function handleConfirmAll() {
    if (!guest || !event || cart.length === 0) return;
    setBookingInProgress(true);
    setBookingError(null);

    try {
      // Racing is already booked (temp held) — reuse its orderId
      const racingItem = cart.find((c) => c.heldOrderId);
      let orderId: string | null = racingItem?.heldOrderId || null;
      const bookedItems: { type: string; track?: string; time: string; billId: string }[] = [];

      // Record the racing hold as a booked item
      if (racingItem) {
        bookedItems.push({
          type: "racing",
          track: racingItem.track,
          time: racingItem.block.start,
          billId: racingItem.heldOrderId!,
        });
      }

      // Book non-racing items (gel blaster, laser tag) — chain onto racing's orderId
      for (const item of cart) {
        if (item.heldOrderId) continue; // Already booked (racing)
        {
          // Gel blaster / laser tag — booking/book with orderId chaining
          const payload: Record<string, unknown> = {
            productId: item.productId,
            quantity: 1,
            resourceId: Number(item.proposal.blocks[0]?.block.resourceId) || -1,
            proposal: {
              blocks: item.proposal.blocks.map((pb) => ({
                productLineIds: pb.productLineIds || [],
                block: { ...pb.block, resourceId: Number(pb.block.resourceId) || -1 },
              })),
              productLineId: item.proposal.productLineId ?? null,
            },
          };

          // Inject orderId as raw number if chaining onto existing bill
          let bodyJson = JSON.stringify(payload);
          if (orderId) {
            bodyJson = `{"orderId":${orderId},` + bodyJson.slice(1);
          }

          const bookRes = await fetch(
            "/api/bmi?" + new URLSearchParams({ endpoint: "booking/book" }),
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: bodyJson,
            },
          );
          const rawText = await bookRes.text();
          const orderIdMatch = rawText.match(/"orderId"\s*:\s*(\d+)/);
          if (!orderIdMatch) {
            console.error("[group-event] booking/book failed:", rawText.substring(0, 300));
            throw new Error(`Failed to book ${item.label}`);
          }
          orderId = orderIdMatch[1];
          bookedItems.push({ type: item.attractionSlug, time: item.block.start, billId: orderId });
        }
      }

      // Register contact person on the bill so BMI links the waiver + shows
      // the guest name instead of blank/online. Must happen BEFORE payment/confirm.
      if (orderId && personId) {
        try {
          const contactBody = JSON.stringify({
            firstName: guest.firstName,
            lastName: guest.lastName,
            email: guest.email,
          });
          const contactJson =
            `{"personId":${personId},"orderId":${orderId},` + contactBody.slice(1);
          await fetch(
            "/api/bmi?" + new URLSearchParams({ endpoint: "person/registerContactPerson" }),
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: contactJson,
            },
          );
          console.log("[group-event] registered contact person", personId, "on bill", orderId);
        } catch {
          /* non-fatal */
        }
      }

      // Server-side idempotent confirm — safe against double-fires
      if (orderId) {
        const confirmRes = await fetch("/api/booking/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ billId: orderId, amount: 0, depositKind: 2 }),
        });
        if (!confirmRes.ok) {
          console.error("[group-event] confirm failed:", await confirmRes.text());
        }
      }

      // Register person on the reservation so they show up as a participant
      if (orderId && personId) {
        try {
          const regBody = JSON.stringify({ firstName: guest.firstName, lastName: guest.lastName });
          const rawJson = `{"personId":${personId},"orderId":${orderId},` + regBody.slice(1);
          await fetch(
            "/api/bmi?" + new URLSearchParams({ endpoint: "person/registerProjectPerson" }),
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: rawJson,
            },
          );
          console.log("[group-event] registered person", personId, "on bill", orderId);
        } catch {
          /* non-fatal */
        }
      }

      // Save all reservations to RSVP record
      const existing = await fetch(
        `/api/group-event/rsvp?slug=${slug}&email=${encodeURIComponent(guest.email)}`,
      )
        .then((r) => r.json())
        .catch(() => null);
      const prevReservations = existing?.reservations || [];
      await fetch("/api/group-event/rsvp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          email: guest.email,
          name: guest.displayName,
          freeflow: selectedFreeflow,
          reservations: [...prevReservations, ...bookedItems],
          personId,
          location: selectedLocation?.key,
        }),
      });

      setConfirmedBillId(orderId);
      setExistingReservations((prev) => [...prev, ...bookedItems]);
      setCart([]);
      setStep("confirmation");
      fetchRosters();
    } catch (err) {
      console.error("[group-event] Booking failed:", err);
      setBookingError(err instanceof Error ? err.message : "Booking failed. Please try again.");
    } finally {
      setBookingInProgress(false);
    }
  }

  // ── Fetch attraction slots ───────────────────────────────────────────────

  async function fetchAttractionSlots(attraction: GroupEventAttraction) {
    if (!attraction.bmiProductId || !attraction.bmiPageId) return;
    setAttractionLoading(true);
    try {
      const data = await bmiPost(
        "availability",
        {
          ProductId: Number(attraction.bmiProductId),
          PageId: Number(attraction.bmiPageId),
          Quantity: 1,
          OrderId: null,
          PersonId: null,
          DynamicLines: [],
        },
        { date: event!.eventDate },
      );
      let proposals: BmiProposal[] = data.proposals || [];
      proposals.sort((a, b) => {
        const aS = a.blocks?.[0]?.block?.start || "";
        const bS = b.blocks?.[0]?.block?.start || "";
        return aS.localeCompare(bS);
      });

      // Filter to event time window
      if (event) {
        const [sh, sm] = event.startTime.split(":").map(Number);
        const [eh, em] = event.endTime.split(":").map(Number);
        const winStart = sh * 60 + sm;
        const winEnd = eh * 60 + em;
        proposals = proposals.filter((p) => {
          const start = p.blocks?.[0]?.block?.start;
          if (!start) return true;
          const clean = start.replace(/Z$/, "");
          const tp = clean.split("T")[1];
          if (!tp) return true;
          const [h, m] = tp.split(":").map(Number);
          const blockMin = h * 60 + m;
          return blockMin >= winStart && blockMin < winEnd;
        });
      }

      setAttractionSlots(proposals);
    } catch {
      setAttractionSlots([]);
    } finally {
      setAttractionLoading(false);
    }
  }

  // ── Free-flow save ───────────────────────────────────────────────────────

  async function saveFreeflow(items: string[]) {
    if (!guest) return;
    setSelectedFreeflow(items);
    try {
      await fetch("/api/group-event/rsvp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          email: guest.email,
          name: guest.displayName,
          freeflow: items,
        }),
      });
      setFreeflowSaved(true);
      setTimeout(() => setFreeflowSaved(false), 2000);
    } catch (err) {
      console.error("[group-event] Failed to save freeflow:", err);
    }
  }

  // ── RSVP without booking — record attendance for guests who aren't racing ──
  // On racing-only events there are no free-flow checkboxes, so this is the only
  // way a non-racer leaves an RSVP record (name/email/waiver, no reservations).
  async function handleAttendOnly() {
    if (!guest) return;
    setBookingInProgress(true);
    setBookingError(null);
    try {
      const res = await fetch("/api/group-event/rsvp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          email: guest.email,
          name: guest.displayName,
          freeflow: selectedFreeflow,
          reservations: existingReservations,
          personId,
          location: selectedLocation?.key,
        }),
      });
      if (!res.ok) throw new Error("Failed to save RSVP");
      setStep("confirmation");
    } catch (err) {
      console.error("[group-event] Attend-only RSVP failed:", err);
      setBookingError(err instanceof Error ? err.message : "Couldn't save your RSVP.");
    } finally {
      setBookingInProgress(false);
    }
  }

  // ── Time formatting ──────────────────────────────────────────────────────

  function formatTime(iso: string): string {
    const clean = iso.replace(/Z$/, "");
    const [datePart, timePart] = clean.split("T");
    if (!timePart) return clean;
    const [y, m, d] = datePart.split("-").map(Number);
    const [h, min] = timePart.split(":").map(Number);
    return new Date(y, m - 1, d, h, min).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  // Non-racing venues (Naples) book nothing — suppress reservation activities.
  const reservationAttractions =
    selectedLocation && !selectedLocation.racing ? [] : getReservationAttractions(event);
  const freeflowAttractions = getFreeflowAttractions(event);
  const hasFreeflow = freeflowAttractions.length > 0;
  const isOpenAccess = (event.accessMode ?? "domain") === "open";
  const landing = event.landing;
  const eventDateDisplay = new Date(event.eventDate + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  // "16:30" → "4:30 PM" (24h config → friendly display)
  const fmt12 = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    const hr = ((h + 11) % 12) + 1;
    return `${hr}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  };
  // Per-location date display ("Jul 23" short, or "Thursday, July 30" long).
  const fmtLocDate = (d: string, long = false) =>
    new Date(d + "T12:00:00").toLocaleDateString(
      "en-US",
      long
        ? { weekday: "long", month: "long", day: "numeric" }
        : { month: "short", day: "numeric" },
    );
  // Live countdown to a date's 4 PM start. null until the client clock seeds.
  const countdownStr = (d: string): string | null => {
    if (nowMs == null) return null;
    const diff = new Date(d + "T16:00:00").getTime() - nowMs;
    if (diff <= 0) return "Happening now";
    const days = Math.floor(diff / 86_400_000);
    const hrs = Math.floor((diff % 86_400_000) / 3_600_000);
    const mins = Math.floor((diff % 3_600_000) / 60_000);
    if (days > 0) return `${days}d ${hrs}h`;
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m`;
  };
  // The marketing landing replaces the compact header on the entry step.
  const showLanding = !!landing && step === "gate";
  // Date of birth is only needed for the racing waiver (Fort Myers). RSVP-only
  // venues (Naples) collect name + email alone.
  const nameNeedsDob = selectedLocation?.racing !== false;

  // Accent theming — honor event.accentColor (default cyan). Tailwind v4 applies
  // opacity modifiers to CSS-variable colors via color-mix, so `bg-(--accent)/8`
  // reproduces the prior `bg-(--accent)/8` exactly when --accent is cyan; healthnet
  // therefore renders identically while FastTrax picks up its red.
  const accent = event.accentColor;
  const accentFg = event.accentTextColor ?? "#000418";
  const accentHover = event.accentHoverColor ?? "#ffffff";
  const accentStyle = {
    "--accent": accent,
    "--accent-fg": accentFg,
    "--accent-hover": accentHover,
  } as CSSProperties;

  return (
    <div className="min-h-screen bg-[#000418] pt-[140px]" style={accentStyle}>
      {/* Compact header — funnel steps, and any event without a landing config */}
      {!showLanding && (
        <div className="border-b border-white/10 bg-white/3">
          <div className="max-w-2xl mx-auto px-4 py-6 text-center">
            {event.heroImage && (
              <img
                src={event.heroImage}
                alt={event.companyName}
                className="h-12 md:h-16 mx-auto mb-4 object-contain"
              />
            )}
            <p className="text-xs text-white/40 uppercase tracking-[0.2em] mb-1">
              {event.eventKicker ?? "Private Event"}
            </p>
            <h1 className="text-2xl md:text-3xl font-display text-white uppercase tracking-widest">
              {event.eventTitle}
            </h1>
            <p className="text-white/50 text-sm mt-2">
              {selectedLocation
                ? `${selectedLocation.label} · ${fmtLocDate(selectedLocation.date, true)} · ${landing?.eventTime ?? ""}`
                : `${eventDateDisplay} · ${landing?.eventTime ?? `${event.startTime} – ${event.endTime}`}`}
            </p>
          </div>
        </div>
      )}

      {/* ═══ LANDING — full marketing page on the entry step (public promos) ═══ */}
      {showLanding && landing && (
        <div>
          {/* ── Hero ── */}
          <section className="relative flex min-h-[72vh] w-full items-center overflow-hidden">
            {hero.motion && hero.src && landing.heroVideo ? (
              <video
                key={hero.src}
                className="absolute inset-0 h-full w-full object-cover"
                poster={landing.heroVideo.poster}
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
                aria-hidden="true"
              >
                <source src={hero.src} type="video/mp4" />
              </video>
            ) : (
              landing.heroVideo && (
                <img
                  src={landing.heroVideo.poster}
                  alt=""
                  aria-hidden="true"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              )
            )}
            {/* Legibility overlay */}
            <div className="absolute inset-0 bg-gradient-to-b from-[#000418]/75 via-[#000418]/45 to-[#000418]" />
            {/* Hero content */}
            <div className="relative z-10 mx-auto w-full max-w-3xl px-4 py-16 text-center">
              <p className="mb-3 text-xs uppercase tracking-[0.3em] text-white/60 md:text-sm">
                {event.companyName}
              </p>
              <h1 className="font-display text-4xl uppercase leading-tight tracking-widest text-white md:text-6xl">
                {landing.headline ?? event.eventTitle}
              </h1>
              {landing.freeBadge && (
                <span className="mt-4 inline-block rounded-full bg-(--accent) px-4 py-1.5 text-sm font-bold uppercase tracking-widest text-(--accent-fg)">
                  {landing.freeBadge}
                </span>
              )}
              {landing.tagline && (
                <p className="mx-auto mt-5 max-w-xl text-base text-white/80 md:text-lg">
                  {landing.tagline}
                </p>
              )}
              <p className="mt-4 text-sm font-medium text-white/70 md:text-base">
                {landing.locations && landing.locations.length > 0
                  ? selectedLocation
                    ? `${selectedLocation.label} · ${fmtLocDate(selectedLocation.date, true)} · ${landing.eventTime ?? ""}`
                    : landing.locations
                        .map((l) => `${l.label} ${fmtLocDate(l.date)}`)
                        .join("  ·  ") + (landing.eventTime ? `  ·  ${landing.eventTime}` : "")
                  : `${eventDateDisplay} · ${landing.eventTime ?? `${fmt12(event.startTime)} – ${fmt12(event.endTime)}`}`}
              </p>
              <button
                type="button"
                onClick={() =>
                  document.getElementById("ge-signup")?.scrollIntoView({ behavior: "smooth" })
                }
                className="mt-8 rounded-xl bg-(--accent) px-8 py-4 text-base font-bold text-(--accent-fg) shadow-lg transition-colors hover:bg-(--accent-hover)"
              >
                {landing.ctaLabel ?? "Sign Up"}
              </button>
            </div>
          </section>

          {/* ── Experience + What's included ── */}
          <div className="mx-auto max-w-4xl px-4 pt-14">
            {landing.intro && (
              <p className="mx-auto max-w-2xl text-center text-lg leading-relaxed text-white/70 md:text-xl">
                {landing.intro}
              </p>
            )}
          </div>

          {/* ── What's included (festive) ── */}
          {landing.included && landing.included.length > 0 && (
            <div className="mx-auto max-w-5xl px-4 pt-14">
              <div className="relative overflow-hidden rounded-3xl border border-(--accent)/25">
                {landing.backgrounds?.included && (
                  <div aria-hidden className="pointer-events-none absolute inset-0">
                    <img
                      src={landing.backgrounds.included}
                      alt=""
                      className="h-full w-full object-cover opacity-30"
                    />
                    <div className="absolute inset-0 bg-[#000418]/75" />
                  </div>
                )}
                <div className="relative p-6 md:p-10">
                  <h2 className="text-center font-display text-2xl uppercase tracking-widest text-white md:text-3xl">
                    What&rsquo;s Included
                  </h2>
                  <p className="mb-8 mt-1 text-center text-sm text-white/60">
                    Our gift to every guest &#127876;
                  </p>
                  <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                    {landing.included.map((inc) => (
                      <div
                        key={inc.item}
                        className="rounded-2xl border border-white/15 bg-white/5 p-5 text-center backdrop-blur-sm"
                      >
                        <div className="mb-2 text-3xl" aria-hidden>
                          {includedIcon(inc.item)}
                        </div>
                        <p className="font-display text-sm uppercase tracking-widest text-white">
                          {inc.item}
                        </p>
                        {inc.note && (
                          <p className="mt-1 text-xs leading-relaxed text-white/60">{inc.note}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Feature video — real FastTrax racing (Fort Myers) ── */}
          {landing.featureVideo && (
            <div className="mx-auto max-w-5xl px-4 pt-14">
              <div className="mb-6 text-center">
                <h2 className="font-display text-2xl uppercase tracking-widest text-white md:text-3xl">
                  {landing.featureVideo.heading ?? "The Main Event"}
                </h2>
                {landing.featureVideo.text && (
                  <p className="mx-auto mt-2 max-w-xl text-sm text-white/60 md:text-base">
                    {landing.featureVideo.text}
                  </p>
                )}
              </div>
              <div className="relative aspect-video overflow-hidden rounded-2xl border border-white/10">
                {hero.motion ? (
                  <video
                    className="absolute inset-0 h-full w-full object-cover"
                    poster={landing.featureVideo.poster}
                    autoPlay
                    muted
                    loop
                    playsInline
                    preload="none"
                    aria-hidden="true"
                  >
                    <source src={landing.featureVideo.src} type="video/mp4" />
                  </video>
                ) : (
                  <img
                    src={landing.featureVideo.poster}
                    alt=""
                    aria-hidden="true"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                )}
              </div>
            </div>
          )}

          {/* ── Gallery ── */}
          {landing.gallery && landing.gallery.length > 0 && (
            <div className="mx-auto max-w-6xl px-4 pt-14 pb-14">
              <div className="grid auto-rows-[130px] grid-cols-2 gap-3 md:auto-rows-[150px] md:grid-cols-3">
                {landing.gallery.map((g, i) => (
                  <picture
                    key={g.webp}
                    className={`block overflow-hidden rounded-xl border border-white/10 ${
                      i === 0 ? "col-span-2 row-span-2" : ""
                    }`}
                  >
                    <source srcSet={g.webp} type="image/webp" />
                    <img
                      src={g.jpg}
                      alt={g.alt}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  </picture>
                ))}
              </div>
            </div>
          )}

          {/* ── Sign up: choose location → RSVP ── */}
          <div id="ge-signup" className="mx-auto max-w-2xl px-4 pb-20 pt-4">
            <div className="relative overflow-hidden rounded-2xl border border-(--accent)/30 bg-white/3 p-8">
              {landing.backgrounds?.signup && (
                <div aria-hidden className="pointer-events-none absolute inset-0">
                  <img
                    src={landing.backgrounds.signup}
                    alt=""
                    className="h-full w-full object-cover opacity-25"
                  />
                  <div className="absolute inset-0 bg-[#000418]/80" />
                </div>
              )}
              <div className="relative">
                {landing.locations && landing.locations.length > 0 && !selectedLocation ? (
                  <>
                    <h2 className="mb-1 text-center font-display text-2xl uppercase tracking-widest text-white">
                      Choose Your Location
                    </h2>
                    <p className="mb-6 text-center text-sm text-white/50">
                      Two festive evenings — pick the one near you to RSVP.
                    </p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {landing.locations.map((loc) => (
                        <button
                          key={loc.key}
                          type="button"
                          onClick={() => {
                            setSelectedLocation(loc);
                            setGateError("");
                            try {
                              sessionStorage.setItem(sessionKey(slug, "location"), loc.key);
                            } catch {
                              /* sessionStorage unavailable */
                            }
                          }}
                          className="rounded-xl border border-white/10 bg-white/5 p-5 text-left transition-colors hover:border-(--accent)/50 hover:bg-white/10"
                        >
                          <p className="font-display text-lg uppercase tracking-widest text-white">
                            {loc.label}
                          </p>
                          <p className="mt-1 text-xl font-bold leading-tight text-(--accent)">
                            {fmtLocDate(loc.date, true)}
                          </p>
                          <p className="text-sm font-semibold text-white/70">{landing.eventTime}</p>
                          {landing.countdown && countdownStr(loc.date) && (
                            <span className="mt-2 inline-block rounded-full bg-(--accent)/15 px-3 py-1 text-xs font-bold text-(--accent)">
                              &#9203; {countdownStr(loc.date)} away
                            </span>
                          )}
                          <p className="mt-2 text-xs leading-relaxed text-white/50">{loc.venue}</p>
                          <p className="text-xs leading-relaxed text-white/40">{loc.address}</p>
                          {loc.racing && (
                            <p className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-(--accent)/80">
                              Includes go-kart racing
                            </p>
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="mx-auto max-w-md text-center">
                    <h2 className="mb-2 font-display text-2xl uppercase tracking-widest text-white">
                      {landing.ctaLabel ?? "Sign Up"}
                    </h2>
                    {selectedLocation && (
                      <p className="mb-5 text-sm text-white/60">
                        <span className="text-white">{selectedLocation.label}</span> ·{" "}
                        {fmtLocDate(selectedLocation.date, true)} · {landing.eventTime}
                        {landing.locations && landing.locations.length > 1 && (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedLocation(null);
                              setGateError("");
                              try {
                                sessionStorage.removeItem(sessionKey(slug, "location"));
                              } catch {
                                /* sessionStorage unavailable */
                              }
                            }}
                            className="ml-2 text-(--accent) underline underline-offset-2 hover:text-(--accent-hover)"
                          >
                            change
                          </button>
                        )}
                      </p>
                    )}
                    <p className="mb-6 text-sm text-white/50">Enter your email to RSVP.</p>
                    <form onSubmit={handleGateSubmit} className="space-y-4">
                      <input
                        name="email"
                        type="email"
                        required
                        placeholder="you@email.com"
                        className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-(--accent)/50 focus:ring-1 focus:ring-(--accent)/30"
                      />
                      {gateError && <p className="text-xs text-red-400">{gateError}</p>}
                      <button
                        type="submit"
                        className="w-full rounded-xl bg-(--accent) py-3 text-sm font-bold text-(--accent-fg) transition-colors hover:bg-(--accent-hover)"
                      >
                        {landing.ctaLabel ?? "Continue"}
                      </button>
                    </form>
                  </div>
                )}
                {landing.finePrint && (
                  <p className="mt-6 text-center text-[11px] leading-relaxed text-white/30">
                    {landing.finePrint}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="relative">
        {landing && step !== "gate" && landing.backgrounds?.form && (
          <div aria-hidden className="pointer-events-none absolute inset-0">
            <img
              src={landing.backgrounds.form}
              alt=""
              className="h-full w-full object-cover opacity-20"
            />
            <div className="absolute inset-0 bg-[#000418]/85" />
          </div>
        )}
        <div className="relative max-w-2xl mx-auto px-4 py-8">
          {/* ═══ STEP: Email Gate (plain — events without a landing config) ═══ */}
          {step === "gate" && !landing && (
            <div className="max-w-md mx-auto">
              <div className="rounded-2xl border border-white/10 bg-white/3 p-8 text-center">
                {event.heroImage && (
                  <img
                    src={event.heroImage}
                    alt={event.companyName}
                    className="h-10 mx-auto mb-4 object-contain"
                  />
                )}
                <h2 className="text-xl font-display text-white uppercase tracking-widest mb-2">
                  Welcome
                </h2>
                <p className="text-white/50 text-sm mb-6">
                  {isOpenAccess
                    ? "Enter your email to get started."
                    : "Enter your company email to access the event."}
                </p>
                <form onSubmit={handleGateSubmit} className="space-y-4">
                  <input
                    name="email"
                    type="email"
                    required
                    placeholder={isOpenAccess ? "you@email.com" : "you@company.com"}
                    className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder:text-white/30 focus:border-(--accent)/50 focus:ring-1 focus:ring-(--accent)/30 outline-none text-sm"
                  />
                  {gateError && <p className="text-red-400 text-xs">{gateError}</p>}
                  <button
                    type="submit"
                    className="w-full py-3 rounded-xl font-bold text-sm bg-(--accent) text-(--accent-fg) hover:bg-(--accent-hover) transition-colors"
                  >
                    Continue
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* ═══ STEP: How are you joining? (racing venues) ═══ */}
          {step === "mode" && (
            <div className="max-w-md mx-auto">
              <div className="rounded-2xl border border-white/10 bg-white/3 p-8">
                <h2 className="mb-1 text-center text-xl font-display uppercase tracking-widest text-white">
                  How are you joining us?
                </h2>
                <p className="mb-6 text-center text-sm text-white/50">
                  {selectedLocation?.label} &middot;{" "}
                  {selectedLocation && fmtLocDate(selectedLocation.date, true)}
                </p>
                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={() => setStep("attend")}
                    className="w-full rounded-xl border border-white/15 bg-white/5 p-5 text-left transition-colors hover:border-(--accent)/50 hover:bg-white/10"
                  >
                    <p className="font-display text-base uppercase tracking-widest text-white">
                      Just Attending
                    </p>
                    <p className="mt-1 text-sm text-white/55">
                      Holiday bites, drinks &amp; complimentary bowling. Bring up to 2 — one quick
                      RSVP.
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setStep("name")}
                    className="w-full rounded-xl border border-(--accent)/40 bg-(--accent)/10 p-5 text-left transition-colors hover:border-(--accent) hover:bg-(--accent)/20"
                  >
                    <p className="font-display text-base uppercase tracking-widest text-white">
                      Attending + Racing 🏎️
                    </p>
                    <p className="mt-1 text-sm text-white/55">
                      Everything above, plus a go-kart race. Each racer registers individually
                      (waiver required).
                    </p>
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setStep("gate")}
                  className="mt-5 w-full text-center text-xs text-white/40 transition-colors hover:text-white/70"
                >
                  &larr; Back
                </button>
              </div>
            </div>
          )}

          {/* ═══ STEP: Just-attending RSVP (name + company + guests) ═══ */}
          {step === "attend" && (
            <div className="max-w-md mx-auto">
              <div className="rounded-2xl border border-white/10 bg-white/3 p-8 text-center">
                <h2 className="mb-2 text-xl font-display uppercase tracking-widest text-white">
                  Reserve Your Spot
                </h2>
                <p className="mb-6 text-sm text-white/50">
                  {selectedLocation?.label} &middot;{" "}
                  {selectedLocation && fmtLocDate(selectedLocation.date, true)} &middot;{" "}
                  {landing?.eventTime}
                </p>
                <form onSubmit={handleAttendSubmit} className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <input
                      name="firstName"
                      type="text"
                      required
                      placeholder="First name"
                      className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-(--accent)/50 focus:ring-1 focus:ring-(--accent)/30"
                    />
                    <input
                      name="lastName"
                      type="text"
                      required
                      placeholder="Last name"
                      className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-(--accent)/50 focus:ring-1 focus:ring-(--accent)/30"
                    />
                  </div>
                  <input
                    name="company"
                    type="text"
                    placeholder="Company name"
                    className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-(--accent)/50 focus:ring-1 focus:ring-(--accent)/30"
                  />
                  <div className="text-left">
                    <label
                      htmlFor="ge-guests"
                      className="mb-1.5 ml-1 block text-left text-xs text-white/40"
                    >
                      Number attending (up to 2)
                    </label>
                    <select
                      id="ge-guests"
                      name="guests"
                      defaultValue="1"
                      className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-white outline-none [color-scheme:dark] focus:border-(--accent)/50 focus:ring-1 focus:ring-(--accent)/30"
                    >
                      <option value="1" style={{ backgroundColor: "#000418", color: "#fff" }}>
                        1 — just me
                      </option>
                      <option value="2" style={{ backgroundColor: "#000418", color: "#fff" }}>
                        2 — me + a guest
                      </option>
                    </select>
                  </div>
                  {waiverError && <p className="text-xs text-red-400">{waiverError}</p>}
                  <button
                    type="submit"
                    disabled={waiverLoading}
                    className="w-full rounded-xl bg-(--accent) py-3 text-sm font-bold text-(--accent-fg) transition-colors hover:bg-(--accent-hover) disabled:opacity-50"
                  >
                    {waiverLoading ? "Saving…" : "Confirm RSVP"}
                  </button>
                </form>
                {selectedLocation?.racing && (
                  <button
                    type="button"
                    onClick={() => setStep("mode")}
                    className="mt-4 w-full text-center text-xs text-white/40 transition-colors hover:text-white/70"
                  >
                    &larr; Back
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ═══ STEP: Name + Birthdate (racing registration) ═══ */}
          {step === "name" && (
            <div className="max-w-md mx-auto">
              <div className="rounded-2xl border border-white/10 bg-white/3 p-8 text-center">
                <h2 className="text-xl font-display text-white uppercase tracking-widest mb-2">
                  Racer Details
                </h2>
                <p className="text-white/50 text-sm mb-6">
                  {nameNeedsDob
                    ? "Used for heat rosters and your activity waiver."
                    : "So we know who's joining us."}
                </p>
                <form onSubmit={handleNameSubmit} className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <input
                      name="firstName"
                      type="text"
                      required
                      placeholder="First name"
                      className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder:text-white/30 focus:border-(--accent)/50 focus:ring-1 focus:ring-(--accent)/30 outline-none text-sm"
                    />
                    <input
                      name="lastName"
                      type="text"
                      required
                      placeholder="Last name"
                      className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder:text-white/30 focus:border-(--accent)/50 focus:ring-1 focus:ring-(--accent)/30 outline-none text-sm"
                    />
                  </div>
                  {nameNeedsDob && (
                    <div>
                      <label
                        htmlFor="ge-birth-year"
                        className="block text-left text-white/40 text-xs mb-1.5 ml-1"
                      >
                        Date of Birth
                      </label>
                      <div className="grid grid-cols-3 gap-2">
                        <select
                          id="ge-birth-year"
                          name="birth-year"
                          required
                          defaultValue=""
                          className="px-3 py-3 rounded-xl bg-white/5 border border-white/10 text-white focus:border-(--accent)/50 focus:ring-1 focus:ring-(--accent)/30 outline-none text-sm [color-scheme:dark]"
                        >
                          <option
                            value=""
                            disabled
                            style={{ backgroundColor: "#000418", color: "#fff" }}
                          >
                            Year
                          </option>
                          {Array.from({ length: 90 }, (_, i) => new Date().getFullYear() - i).map(
                            (y) => (
                              <option
                                key={y}
                                value={y}
                                style={{ backgroundColor: "#000418", color: "#fff" }}
                              >
                                {y}
                              </option>
                            ),
                          )}
                        </select>
                        <select
                          name="birth-month"
                          required
                          defaultValue=""
                          className="px-3 py-3 rounded-xl bg-white/5 border border-white/10 text-white focus:border-(--accent)/50 focus:ring-1 focus:ring-(--accent)/30 outline-none text-sm [color-scheme:dark]"
                        >
                          <option
                            value=""
                            disabled
                            style={{ backgroundColor: "#000418", color: "#fff" }}
                          >
                            Month
                          </option>
                          {[
                            "Jan",
                            "Feb",
                            "Mar",
                            "Apr",
                            "May",
                            "Jun",
                            "Jul",
                            "Aug",
                            "Sep",
                            "Oct",
                            "Nov",
                            "Dec",
                          ].map((m, i) => (
                            <option
                              key={i + 1}
                              value={i + 1}
                              style={{ backgroundColor: "#000418", color: "#fff" }}
                            >
                              {m}
                            </option>
                          ))}
                        </select>
                        <select
                          name="birth-day"
                          required
                          defaultValue=""
                          className="px-3 py-3 rounded-xl bg-white/5 border border-white/10 text-white focus:border-(--accent)/50 focus:ring-1 focus:ring-(--accent)/30 outline-none text-sm [color-scheme:dark]"
                        >
                          <option
                            value=""
                            disabled
                            style={{ backgroundColor: "#000418", color: "#fff" }}
                          >
                            Day
                          </option>
                          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                            <option
                              key={d}
                              value={d}
                              style={{ backgroundColor: "#000418", color: "#fff" }}
                            >
                              {d}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}
                  {waiverError && <p className="text-red-400 text-xs">{waiverError}</p>}
                  <button
                    type="submit"
                    disabled={waiverLoading}
                    className="w-full py-3 rounded-xl font-bold text-sm bg-(--accent) text-(--accent-fg) hover:bg-(--accent-hover) transition-colors disabled:opacity-50"
                  >
                    {waiverLoading ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-4 h-4 border-2 border-(--accent-fg)/30 border-t-(--accent-fg) rounded-full animate-spin" />
                        Setting up...
                      </span>
                    ) : (
                      "Continue"
                    )}
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* ═══ STEP: Waiver ═══ */}
          {step === "waiver" && waiverTemplate && personId && (
            <div className="max-w-md mx-auto">
              <WaiverSigning
                personId={personId}
                template={waiverTemplate}
                location={event.pandoraLocation ?? "headpinz"}
                onComplete={() => {
                  setWaiverValid(true);
                  setStep("dashboard");
                  fetchExistingRsvp(slug, guest!.email);
                }}
              />
            </div>
          )}

          {/* ═══ STEP: Dashboard ═══ */}
          {step === "dashboard" && guest && (
            <div className="space-y-8">
              <div className="text-center">
                <p className="text-white/50 text-sm">
                  Welcome, <span className="text-white font-semibold">{guest.firstName}</span>!
                </p>
                <p className="text-white/30 text-xs mt-1">Choose your activities below</p>
                <button
                  onClick={() => {
                    sessionStorage.removeItem(sessionKey(slug, "email"));
                    sessionStorage.removeItem(sessionKey(slug, "firstName"));
                    sessionStorage.removeItem(sessionKey(slug, "lastName"));
                    setGuest(null);
                    setCart([]);
                    setExistingReservations([]);
                    setSelectedFreeflow([]);
                    setStep("gate");
                  }}
                  className="text-white/30 text-xs mt-2 hover:text-white/60 underline underline-offset-2 transition-colors"
                >
                  Not {guest.firstName}? Switch account
                </button>
              </div>

              {/* Event info banner */}
              <div className="rounded-xl border border-(--accent)/20 bg-(--accent)/5 p-4 space-y-2 text-sm text-white/70 leading-relaxed">
                {hasFreeflow ? (
                  <>
                    <p>
                      <strong className="text-white">
                        Go-Kart Racing, Laser Tag, and Gel Blaster
                      </strong>{" "}
                      all require a signed waiver and a pre-booked time slot. You can only book for
                      yourself, but your name will appear on the booking so your coworkers can see
                      who&rsquo;s in each session.
                    </p>
                    <p>
                      All other activities are <strong className="text-white">free-flow</strong> and
                      available at your leisure throughout the event.
                    </p>
                  </>
                ) : (
                  <p>
                    <strong className="text-white">Go-Kart Racing</strong> requires a signed waiver
                    and a pre-booked time slot. You can only book for yourself, but your name will
                    appear on the heat so others can see who&rsquo;s racing.
                  </p>
                )}
                {event.mealWindow && (
                  <p className="text-amber-300/90">
                    <strong className="text-amber-300">{event.mealWindow.label}</strong> is served
                    at {event.mealWindow.location} from{" "}
                    <strong className="text-amber-300">
                      {new Date(`2000-01-01T${event.mealWindow.startTime}`).toLocaleTimeString(
                        "en-US",
                        { hour: "numeric", minute: "2-digit", hour12: true },
                      )}{" "}
                      &ndash;{" "}
                      {new Date(`2000-01-01T${event.mealWindow.endTime}`).toLocaleTimeString(
                        "en-US",
                        { hour: "numeric", minute: "2-digit", hour12: true },
                      )}
                    </strong>
                    &mdash; plan your reservations around it!
                  </p>
                )}
              </div>

              {/* Reservation-based activities */}
              <div>
                <h3 className="text-xs text-white/40 uppercase tracking-[0.15em] font-semibold mb-3">
                  Reserve a Time Slot
                </h3>
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                  {reservationAttractions.map((attr) => {
                    const confirmed = isAttractionConfirmed(attr.slug);
                    const inCart = isAttractionSelected(attr.slug);
                    const cartItem = getCartItem(attr.slug);
                    const existingBooking = getExistingBooking(attr.slug);
                    const isDone = confirmed || inCart;

                    return (
                      <button
                        key={attr.slug}
                        onClick={() => {
                          if (confirmed) return;
                          if (inCart) {
                            // Allow re-picking by removing from cart and opening picker
                            removeFromCart(attr.slug);
                          }
                          if (attr.slug === "racing") {
                            setStep("racing-track");
                          } else {
                            setActiveAttraction(attr);
                            fetchAttractionSlots(attr);
                            setStep("attraction-slots");
                          }
                        }}
                        disabled={confirmed}
                        className={`
                        w-full rounded-xl border overflow-hidden text-left transition-all
                        ${
                          confirmed
                            ? "border-emerald-500/30"
                            : inCart
                              ? "border-(--accent)/40 ring-1 ring-(--accent)/20"
                              : "border-white/10 hover:border-white/25 cursor-pointer"
                        }
                      `}
                      >
                        {/* Image */}
                        <div className="relative h-32 sm:h-40 w-full">
                          {attr.image ? (
                            <img
                              src={attr.image}
                              alt={attr.label}
                              className={`w-full h-full object-cover object-top ${isDone ? "opacity-50" : ""}`}
                            />
                          ) : (
                            <div className="w-full h-full bg-white/5" />
                          )}
                          <div className="absolute inset-0 bg-gradient-to-t from-[#000418] via-[#000418]/70 to-[#000418]/20" />
                          <div className="absolute bottom-0 left-0 right-0 p-4">
                            <div className="flex items-center gap-2">
                              <span className="text-white font-bold text-base">{attr.label}</span>
                              {confirmed && (
                                <span className="text-emerald-400 text-xs font-semibold bg-emerald-500/15 px-2 py-0.5 rounded-full">
                                  &#10003; Confirmed
                                </span>
                              )}
                              {inCart && !confirmed && (
                                <span className="text-(--accent) text-xs font-semibold bg-(--accent)/15 px-2 py-0.5 rounded-full">
                                  Selected
                                </span>
                              )}
                            </div>
                            <p className="text-white/50 text-xs mt-0.5">{attr.description}</p>
                            {confirmed && existingBooking && (
                              <p className="text-emerald-400/70 text-xs mt-1 font-medium">
                                {existingBooking.track
                                  ? `${existingBooking.track} Track · ${formatTime(existingBooking.time!)}`
                                  : formatTime(existingBooking.time!)}
                              </p>
                            )}
                            {inCart && cartItem && (
                              <p className="text-(--accent)/70 text-xs mt-1 font-medium">
                                {cartItem.track ? `${cartItem.track} Track · ` : ""}
                                {formatTime(cartItem.block.start)}
                                <span className="text-white/30 ml-2">(tap to change)</span>
                              </p>
                            )}
                            {!isDone && (
                              <p className="text-(--accent) text-xs font-semibold mt-1">
                                Tap to reserve &rsaquo;
                              </p>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Free-flow activities — only when the event has any freeflow attractions */}
              {hasFreeflow && (
                <div>
                  <h3 className="text-xs text-white/40 uppercase tracking-[0.15em] font-semibold mb-3">
                    I Plan to Attend
                  </h3>
                  <div className="rounded-xl border border-white/10 bg-white/3 p-3 space-y-2">
                    {freeflowAttractions.map((attr) => {
                      const checked = selectedFreeflow.includes(attr.slug);
                      return (
                        <label
                          key={attr.slug}
                          className={`flex items-center gap-3 cursor-pointer group rounded-lg p-2 transition-colors ${checked ? "bg-(--accent)/8" : "hover:bg-white/3"}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              const next = checked
                                ? selectedFreeflow.filter((s) => s !== attr.slug)
                                : [...selectedFreeflow, attr.slug];
                              saveFreeflow(next);
                            }}
                            className="w-4 h-4 shrink-0 rounded border-white/20 bg-white/5 text-(--accent) focus:ring-(--accent)/30 accent-(--accent)"
                          />
                          {attr.image && (
                            <img
                              src={attr.image}
                              alt={attr.label}
                              className="w-10 h-10 rounded-lg object-cover shrink-0"
                            />
                          )}
                          <div className="min-w-0">
                            <span className="text-white text-sm font-medium group-hover:text-white/90">
                              {attr.label}
                            </span>
                            <p className="text-white/30 text-xs truncate">{attr.description}</p>
                          </div>
                        </label>
                      );
                    })}
                    {freeflowSaved && (
                      <p className="text-emerald-400 text-xs text-center animate-pulse">Saved!</p>
                    )}
                  </div>
                </div>
              )}

              {/* ── Cart: Your Selections ── */}
              <div ref={cartRef}>
                {cart.length > 0 && (
                  <div className="rounded-xl border border-(--accent)/30 bg-(--accent)/5 p-5 space-y-4">
                    <h3 className="text-sm font-bold text-white uppercase tracking-wider">
                      Your Reservations
                    </h3>
                    <div className="space-y-2">
                      {cart.map((item) => (
                        <div
                          key={item.attractionSlug}
                          className="flex items-center justify-between bg-white/5 rounded-lg px-3 py-2"
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="text-white text-sm font-medium">{item.label}</p>
                              {item.heldOrderId && (
                                <span className="text-emerald-400 text-[10px] font-semibold bg-emerald-500/15 px-1.5 py-0.5 rounded">
                                  Held
                                </span>
                              )}
                            </div>
                            <p className="text-(--accent)/70 text-xs">
                              {formatTime(item.block.start)} &rarr; {formatTime(item.block.stop)}
                            </p>
                          </div>
                          <button
                            onClick={() => removeFromCart(item.attractionSlug)}
                            className="text-white/30 hover:text-red-400 transition-colors text-xs"
                            aria-label={`Remove ${item.label}`}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>

                    {bookingError && (
                      <div className="rounded-lg border border-red-500/30 bg-red-500/8 p-3 text-center">
                        <p className="text-red-400 text-sm">{bookingError}</p>
                      </div>
                    )}

                    <button
                      onClick={handleConfirmAll}
                      disabled={bookingInProgress}
                      className="w-full py-3.5 rounded-xl font-bold text-sm bg-(--accent) text-(--accent-fg) hover:bg-(--accent-hover) transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {bookingInProgress ? (
                        <span className="flex items-center justify-center gap-2">
                          <span className="w-4 h-4 border-2 border-(--accent-fg)/30 border-t-(--accent-fg) rounded-full animate-spin" />
                          Confirming reservations...
                        </span>
                      ) : (
                        `Confirm ${cart.length} Reservation${cart.length === 1 ? "" : "s"}`
                      )}
                    </button>
                    <p className="text-white/30 text-[11px] text-center">
                      All reservations will be booked together under your name.
                    </p>
                  </div>
                )}

                {cart.length === 0 && !existingReservations.length && (
                  <div className="rounded-xl border border-white/8 bg-white/3 p-4 text-center space-y-3">
                    <p className="text-white/30 text-sm">
                      {hasFreeflow
                        ? "Select your activities above, then confirm them all at once here."
                        : "Reserve a kart above — or, if you're not racing, just let us know you're coming."}
                    </p>
                    {!hasFreeflow && (
                      <button
                        onClick={handleAttendOnly}
                        disabled={bookingInProgress}
                        className="w-full py-3 rounded-xl font-bold text-sm border border-(--accent)/40 text-(--accent) hover:bg-(--accent)/10 transition-colors disabled:opacity-50"
                      >
                        {bookingInProgress ? "Saving…" : "I'm attending — not racing"}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Info footer */}
              <div className="rounded-xl border border-white/8 bg-white/3 p-4 text-xs text-white/40 space-y-1">
                <p>
                  &middot; All activities are{" "}
                  <strong className="text-white/60">complimentary</strong>{" "}
                  {isOpenAccess
                    ? `for ${event.companyName} guests.`
                    : `for ${event.companyName} team members.`}
                </p>
                {event.includesLicense && (
                  <p>
                    &middot; Racing license fee is{" "}
                    <strong className="text-white/60">included</strong> &mdash; no charge at
                    check-in.
                  </p>
                )}
                <p>
                  &middot; Please arrive <strong className="text-white/60">15 minutes early</strong>{" "}
                  for racing check-in.
                </p>
              </div>
            </div>
          )}

          {/* ═══ STEP: Track Picker ═══ */}
          {step === "racing-track" && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-1">
                  Pick Your Track
                </h2>
                <p className="text-white/50 text-sm">Two indoor tracks — choose your style</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {(["Blue", "Red"] as const).map((trackName) => {
                  const info = TRACK_INFO[trackName];
                  const trackConfig = event.attractions
                    .find((a) => a.slug === "racing")
                    ?.bmiTracks?.find((t) => t.track === trackName);
                  if (!info || !trackConfig) return null;
                  const ringClass =
                    info.accent === "red"
                      ? "border-red-500/40 hover:border-red-500 hover:ring-red-500/30"
                      : "border-blue-500/40 hover:border-blue-500 hover:ring-blue-500/30";
                  const titleClass = info.accent === "red" ? "text-red-300" : "text-blue-300";
                  return (
                    <button
                      key={trackName}
                      onClick={() => {
                        setSelectedTrack(trackName);
                        setStep("racing-heat");
                      }}
                      className={`group relative overflow-hidden rounded-xl text-left border transition-all duration-200 hover:scale-[1.02] hover:ring-2 cursor-pointer ${ringClass}`}
                    >
                      <div className="relative aspect-[21/9] sm:aspect-[4/3]">
                        <img
                          src={info.image}
                          alt={info.title}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
                      </div>
                      <div className="p-3">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <h4
                            className={`font-display text-base uppercase tracking-wide ${titleClass}`}
                          >
                            {info.title}
                          </h4>
                          <span className="text-white/50 text-xs font-mono">{info.stat}</span>
                        </div>
                        <p className="text-white/70 text-xs leading-snug">{info.tagline}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
              <button
                onClick={() => setStep("dashboard")}
                className="text-sm text-white/40 hover:text-white/70 transition-colors"
              >
                &larr; Back to activities
              </button>
            </div>
          )}

          {/* ═══ STEP: Heat Picker ═══ */}
          {step === "racing-heat" && selectedTrack && (
            <div className="space-y-6">
              <HeatPicker
                race={{
                  productId: event.attractions
                    .find((a) => a.slug === "racing")!
                    .bmiTracks!.find((t) => t.track === selectedTrack)!.productId,
                  pageId: event.attractions
                    .find((a) => a.slug === "racing")!
                    .bmiTracks!.find((t) => t.track === selectedTrack)!.pageId,
                  name: `Starter Race ${selectedTrack}`,
                  tier: "starter",
                  category: "adult",
                  track: selectedTrack,
                  price: 0,
                  isCombo: false,
                  packType: "none",
                  raceCount: 1,
                  sessionGroup: "Karting",
                  raw: {
                    id: 0,
                    name: `Starter Race ${selectedTrack}`,
                    info: "",
                    hasPicture: false,
                    isCombo: false,
                    minAge: null,
                    maxAge: null,
                    isMembersOnly: false,
                    minAmount: -1,
                    maxAmount: 10,
                    resourceKind: "Race",
                    kind: 2,
                    bookingMode: 0,
                    productGroup: "Karting",
                    prices: [{ amount: 0, kind: 0, shortName: "m", depositKind: 0 }],
                    resources: [],
                    dynamicGroups: null,
                    xRef: null,
                  },
                }}
                date={event.eventDate}
                quantity={1}
                onQuantityChange={() => {}}
                onConfirm={handleRaceHeatSelect}
                onBack={() => setStep("racing-track")}
                confirmLabel={bookingInProgress ? "Reserving..." : "Reserve This Heat"}
                packageMode={true}
                immediateConfirm={false}
                heatRosters={heatRosters}
                mealWarning={
                  event.mealWindow
                    ? {
                        label: event.mealWindow.label,
                        eventDate: event.eventDate,
                        startTime: event.mealWindow.startTime,
                        endTime: event.mealWindow.endTime,
                      }
                    : undefined
                }
                timeWindow={{ start: event.startTime, end: event.endTime }}
              />
            </div>
          )}

          {/* ═══ STEP: Attraction Time Slots ═══ */}
          {step === "attraction-slots" && activeAttraction && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-1">
                  {activeAttraction.label}
                </h2>
                <p className="text-white/50 text-sm">Pick a session time</p>
              </div>

              {attractionLoading ? (
                <div className="h-48 flex items-center justify-center">
                  <div className="w-8 h-8 border-2 border-white/20 border-t-white/80 rounded-full animate-spin" />
                </div>
              ) : attractionSlots.length === 0 ? (
                <div className="h-48 flex flex-col items-center justify-center gap-3">
                  <p className="text-white/40 text-sm">No sessions available for this date.</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {attractionSlots.map((proposal, idx) => {
                    const block = proposal.blocks?.[0]?.block;
                    if (!block) return null;
                    const isFull = block.freeSpots < 1;
                    const mealOverlap = event.mealWindow
                      ? heatOverlapsMeal(block.start, block.stop, event.eventDate, event.mealWindow)
                      : false;
                    return (
                      <button
                        key={idx}
                        onClick={() => {
                          if (isFull) return;
                          handleAttractionSlotSelect(activeAttraction, proposal, block);
                        }}
                        disabled={isFull}
                        className={`
                        rounded-xl border p-3 text-left transition-all duration-150
                        ${
                          isFull
                            ? "border-white/5 bg-white/3 opacity-40 cursor-not-allowed"
                            : mealOverlap
                              ? "border-amber-500/30 bg-amber-500/5 hover:border-amber-500/50 hover:bg-amber-500/10 cursor-pointer"
                              : "border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10 cursor-pointer"
                        }
                      `}
                      >
                        <div className="text-white font-bold text-base mb-0.5">
                          {formatTime(block.start)}
                        </div>
                        <div className="text-white/40 text-xs mb-1">
                          &rarr; {formatTime(block.stop)}
                        </div>
                        <div
                          className={`text-xs font-medium ${isFull ? "text-red-400" : "text-emerald-400"}`}
                        >
                          {isFull
                            ? "Full"
                            : `${block.freeSpots} spot${block.freeSpots === 1 ? "" : "s"} open`}
                        </div>
                        {mealOverlap && !isFull && (
                          <div className="flex items-center gap-1 mt-1.5 text-amber-400 text-[10px] font-medium">
                            <svg
                              className="w-3 h-3 shrink-0"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                              />
                            </svg>
                            Overlaps with food buffet
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              <button
                onClick={() => {
                  setActiveAttraction(null);
                  setStep("dashboard");
                }}
                className="text-sm text-white/40 hover:text-white/70 transition-colors"
              >
                &larr; Back to activities
              </button>
            </div>
          )}

          {/* ═══ STEP: Confirmation ═══ */}
          {step === "confirmation" && guest && (
            <div className="max-w-md mx-auto space-y-6">
              <div className="text-center">
                <div className="w-16 h-16 rounded-full bg-emerald-500/20 flex items-center justify-center mx-auto mb-4">
                  <svg
                    className="w-8 h-8 text-emerald-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-2">
                  You&rsquo;re All Set!
                </h2>
                <p className="text-white/50 text-sm">
                  {existingReservations.length > 0
                    ? `Your reservations are confirmed, ${guest.firstName}.`
                    : `You're on the list, ${guest.firstName} — see you there!`}
                </p>
              </div>

              {/* RSVP summary — venue/date (+ company & party size for "just attending") */}
              {selectedLocation && (
                <div className="rounded-xl border border-(--accent)/20 bg-(--accent)/5 p-4 text-center text-sm">
                  <p className="font-semibold text-white">
                    {selectedLocation.label} &middot; {fmtLocDate(selectedLocation.date, true)}
                  </p>
                  <p className="mt-0.5 text-white/60">
                    {landing?.eventTime} &middot; {selectedLocation.venue}
                  </p>
                  {attendInfo && (
                    <p className="mt-2 text-white/50">
                      {attendInfo.company ? `${attendInfo.company} · ` : ""}
                      {attendInfo.guests} {attendInfo.guests === 1 ? "guest" : "guests"}
                    </p>
                  )}
                </div>
              )}

              {/* Waiver status badge — only for racers (those who onboarded) */}
              {!!personId && (
                <div
                  className={`rounded-xl p-4 text-center ${waiverValid ? "border border-emerald-500/30 bg-emerald-500/8" : "border-2 border-amber-500/40 bg-amber-500/8"}`}
                >
                  <div className="flex items-center justify-center gap-2">
                    {waiverValid ? (
                      <>
                        <svg
                          className="w-5 h-5 text-emerald-400"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                          />
                        </svg>
                        <span className="text-emerald-400 font-bold text-sm">Waiver Signed</span>
                      </>
                    ) : (
                      <>
                        <svg
                          className="w-5 h-5 text-amber-400"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                        <span className="text-amber-400 font-bold text-sm">Waiver Pending</span>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Reserved activities */}
              {existingReservations.length > 0 && (
                <div>
                  <h3 className="text-xs text-white/40 uppercase tracking-[0.15em] font-semibold mb-2">
                    Reserved Activities
                  </h3>
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-3">
                    {existingReservations.map((r, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <div>
                          <p className="text-white text-sm font-medium">
                            {r.type === "racing"
                              ? `Go-Kart Racing · ${r.track} Track`
                              : r.type === "gel-blaster"
                                ? "Nexus Gel Blaster"
                                : r.type === "laser-tag"
                                  ? "Nexus Laser Tag"
                                  : r.type}
                          </p>
                          {r.time && (
                            <p className="text-emerald-400/70 text-xs">{formatTime(r.time)}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-emerald-400 text-xs font-semibold">&#10003;</span>
                          {r.billId && (
                            <button
                              onClick={() => handleCancelReservation(r.billId!)}
                              disabled={cancellingBillId === r.billId}
                              className="text-white/25 hover:text-red-400 transition-colors text-xs disabled:opacity-50"
                              title="Cancel this reservation"
                            >
                              {cancellingBillId === r.billId ? (
                                <span className="w-3 h-3 border border-white/30 border-t-white/80 rounded-full animate-spin inline-block" />
                              ) : (
                                "✕"
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Free-flow activities */}
              {selectedFreeflow.length > 0 && (
                <div>
                  <h3 className="text-xs text-white/40 uppercase tracking-[0.15em] font-semibold mb-2">
                    Free-Flow Activities
                  </h3>
                  <div className="rounded-xl border border-white/10 bg-white/3 p-4 space-y-2">
                    {selectedFreeflow.map((slug) => {
                      const attr = freeflowAttractions.find((a) => a.slug === slug);
                      return (
                        <div key={slug} className="flex items-center gap-3">
                          <span className="text-(--accent) text-xs">&#10003;</span>
                          <span className="text-white/70 text-sm">{attr?.label || slug}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {bookingError && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/8 p-3 text-center">
                  <p className="text-red-400 text-sm">{bookingError}</p>
                </div>
              )}

              <div className="rounded-xl border border-white/8 bg-white/3 p-4 text-xs text-white/40 space-y-1">
                <p>
                  &middot; Please arrive <strong className="text-white/60">15 minutes early</strong>{" "}
                  for check-in.
                </p>
                {event.includesLicense && !!personId && (
                  <p>
                    &middot; Racing license fee is{" "}
                    <strong className="text-white/60">included</strong> &mdash; no charge.
                  </p>
                )}
              </div>

              {!!personId && (
                <button
                  onClick={() => setStep("dashboard")}
                  className="w-full py-3 rounded-xl font-bold text-sm border border-white/20 text-white/70 hover:border-white/40 hover:text-white transition-colors"
                >
                  &larr; Back to Activities
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
