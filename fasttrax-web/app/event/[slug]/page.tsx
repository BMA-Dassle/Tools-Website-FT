"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { getGroupEvent, getReservationAttractions, getFreeflowAttractions } from "@/lib/group-events";
import type { GroupEvent, GroupEventAttraction } from "@/lib/group-events";
import type { ClassifiedProduct, BmiProposal, BmiBlock } from "@/app/book/race/data";
import { bookRaceHeat, bmiPost } from "@/app/book/race/data";
import HeatPicker from "@/app/book/race/components/HeatPicker";

// ── Types ────────────────────────────────────────────────────────────────────

type Step = "gate" | "name" | "dashboard" | "racing-track" | "racing-heat" | "attraction-slots" | "confirmation";

interface GuestInfo {
  email: string;
  firstName: string;
  lastName: string;
  displayName: string; // "Eric O."
}

interface RaceBooking {
  track: string;
  heatStart: string;
  heatEnd: string;
  billId: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDisplayName(first: string, last: string): string {
  return `${first} ${last.charAt(0).toUpperCase()}.`;
}

function sessionKey(slug: string, key: string): string {
  return `groupEvent:${slug}:${key}`;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function GroupEventPage() {
  const params = useParams();
  const slug = params.slug as string;
  const event = getGroupEvent(slug);

  const [step, setStep] = useState<Step>("gate");
  const [guest, setGuest] = useState<GuestInfo | null>(null);
  const [gateError, setGateError] = useState("");

  // Racing state
  const [selectedTrack, setSelectedTrack] = useState<string | null>(null);
  const [raceBooking, setRaceBooking] = useState<RaceBooking | null>(null);
  const [heatRosters, setHeatRosters] = useState<Record<string, string[]>>({});
  const [bookingInProgress, setBookingInProgress] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);

  // Attraction booking state
  const [activeAttraction, setActiveAttraction] = useState<GroupEventAttraction | null>(null);
  const [attractionSlots, setAttractionSlots] = useState<BmiProposal[]>([]);
  const [attractionLoading, setAttractionLoading] = useState(false);
  const [attractionBookings, setAttractionBookings] = useState<{ slug: string; time: string; billId: string }[]>([]);

  // Free-flow state
  const [selectedFreeflow, setSelectedFreeflow] = useState<string[]>([]);
  const [freeflowSaved, setFreeflowSaved] = useState(false);

  // ── Restore session ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!event) return;
    try {
      const email = sessionStorage.getItem(sessionKey(slug, "email"));
      const firstName = sessionStorage.getItem(sessionKey(slug, "firstName"));
      const lastName = sessionStorage.getItem(sessionKey(slug, "lastName"));
      if (email && firstName && lastName) {
        setGuest({ email, firstName, lastName, displayName: makeDisplayName(firstName, lastName) });
        setStep("dashboard");
        // Restore existing RSVP data
        fetchExistingRsvp(slug, email);
      }
    } catch { /* sessionStorage unavailable */ }
  }, [slug, event]);

  // ── Fetch rosters ────────────────────────────────────────────────────────

  const fetchRosters = useCallback(async () => {
    if (!event) return;
    try {
      const res = await fetch(`/api/group-event/roster?slug=${slug}`);
      const data = await res.json();
      // Transform from "Red:2026-06-19T09:00:00" → keyed by heatStart for each track
      const mapped: Record<string, string[]> = {};
      for (const [key, names] of Object.entries(data.rosters || {})) {
        // key format: "Red:2026-06-19T09:00:00"
        const colonIdx = key.indexOf(":");
        const heatStart = key.slice(colonIdx + 1);
        // HeatPicker keys by block.start ISO string
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
      const res = await fetch(`/api/group-event/rsvp?slug=${eventSlug}&email=${encodeURIComponent(email)}`);
      const data = await res.json();
      if (data?.freeflow) setSelectedFreeflow(data.freeflow);
      if (data?.reservations?.length) {
        // Restore race booking if exists
        const race = data.reservations.find((r: { type: string }) => r.type === "racing");
        if (race) setRaceBooking(race);
        // Restore attraction bookings
        const attrs = data.reservations.filter((r: { type: string }) => r.type !== "racing");
        if (attrs.length) setAttractionBookings(attrs);
      }
    } catch { /* first visit */ }
  }

  // ── Not found ────────────────────────────────────────────────────────────

  if (!event) {
    return (
      <div className="min-h-screen bg-[#000418] flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-3xl font-display text-white uppercase tracking-widest mb-4">Event Not Found</h1>
          <p className="text-white/50">This event link may be expired or invalid.</p>
        </div>
      </div>
    );
  }

  // ── Gate handler ─────────────────────────────────────────────────────────

  function handleGateSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = (form.get("email") as string).trim().toLowerCase();
    const domain = email.split("@")[1];
    if (!domain || !event!.allowedDomains.includes(domain)) {
      const allowed = event!.allowedDomains.filter(d => d !== "headpinz.com" && d !== "fasttraxent.com");
      setGateError(`This event is for @${allowed[0]} employees`);
      return;
    }
    setGateError("");
    sessionStorage.setItem(sessionKey(slug, "email"), email);
    setGuest((prev) => prev ? { ...prev, email } : { email, firstName: "", lastName: "", displayName: "" });
    setStep("name");
  }

  function handleNameSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const firstName = (form.get("firstName") as string).trim();
    const lastName = (form.get("lastName") as string).trim();
    if (!firstName || !lastName) return;
    const email = guest!.email;
    const displayName = makeDisplayName(firstName, lastName);
    sessionStorage.setItem(sessionKey(slug, "firstName"), firstName);
    sessionStorage.setItem(sessionKey(slug, "lastName"), lastName);
    setGuest({ email, firstName, lastName, displayName });
    setStep("dashboard");
    fetchExistingRsvp(slug, email);
  }

  // ── Race booking handler ─────────────────────────────────────────────────

  async function handleRaceHeatConfirm(proposal: BmiProposal, block: BmiBlock) {
    if (!guest || !selectedTrack || !event) return;
    setBookingInProgress(true);
    setBookingError(null);

    try {
      const trackConfig = event.attractions
        .find(a => a.slug === "racing")
        ?.bmiTracks?.find(t => t.track === selectedTrack);
      if (!trackConfig) throw new Error("Track config not found");

      // Build a ClassifiedProduct stub for bookRaceHeat
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
          id: Number(trackConfig.productId),
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

      // Book the heat
      const { rawOrderId } = await bookRaceHeat(product, 1, proposal);

      // Close at $0 — credit path
      const confirmBody = JSON.stringify({
        id: crypto.randomUUID(),
        paymentTime: new Date().toISOString(),
        amount: 0,
        orderId: Number(rawOrderId),
        depositKind: 2,
      });
      await fetch("/api/bmi?" + new URLSearchParams({ endpoint: "payment/confirm" }), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: confirmBody,
      });

      const booking: RaceBooking = {
        track: selectedTrack,
        heatStart: block.start,
        heatEnd: block.stop,
        billId: rawOrderId,
      };
      setRaceBooking(booking);

      // Record on roster
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

      // Save to RSVP record
      await saveRsvp({ type: "racing", track: selectedTrack, time: block.start, billId: rawOrderId });

      setStep("dashboard");
      fetchRosters();
    } catch (err) {
      console.error("[group-event] Race booking failed:", err);
      setBookingError("Booking failed. Please try again.");
    } finally {
      setBookingInProgress(false);
    }
  }

  // ── Attraction booking handler ───────────────────────────────────────────

  async function handleAttractionBook(attraction: GroupEventAttraction, proposal: BmiProposal, block: BmiBlock) {
    if (!guest) return;
    setBookingInProgress(true);
    setBookingError(null);

    try {
      // Book via attractions-data bookAttractionSlot pattern
      const payload: Record<string, unknown> = {
        productId: attraction.bmiProductId,
        quantity: 1,
        resourceId: Number(proposal.blocks[0]?.block.resourceId) || -1,
        proposal: {
          blocks: proposal.blocks.map(pb => ({
            productLineIds: pb.productLineIds || [],
            block: { ...pb.block, resourceId: Number(pb.block.resourceId) || -1 },
          })),
          productLineId: proposal.productLineId ?? null,
        },
      };

      const bookRes = await fetch("/api/bmi?" + new URLSearchParams({ endpoint: "booking/book" }), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const rawText = await bookRes.text();
      const orderIdMatch = rawText.match(/"orderId"\s*:\s*(\d+)/);
      if (!orderIdMatch) throw new Error("Booking failed");
      const rawOrderId = orderIdMatch[1];

      // Close at $0
      await fetch("/api/bmi?" + new URLSearchParams({ endpoint: "payment/confirm" }), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          paymentTime: new Date().toISOString(),
          amount: 0,
          orderId: Number(rawOrderId),
          depositKind: 2,
        }),
      });

      const newBooking = { slug: attraction.slug, time: block.start, billId: rawOrderId };
      setAttractionBookings(prev => [...prev, newBooking]);
      await saveRsvp({ type: attraction.slug, time: block.start, billId: rawOrderId });

      setActiveAttraction(null);
      setStep("dashboard");
    } catch (err) {
      console.error("[group-event] Attraction booking failed:", err);
      setBookingError("Booking failed. Please try again.");
    } finally {
      setBookingInProgress(false);
    }
  }

  // ── Fetch attraction slots ───────────────────────────────────────────────

  async function fetchAttractionSlots(attraction: GroupEventAttraction) {
    if (!attraction.bmiProductId || !attraction.bmiPageId) return;
    setAttractionLoading(true);
    try {
      const data = await bmiPost("availability", {
        ProductId: Number(attraction.bmiProductId),
        PageId: Number(attraction.bmiPageId),
        Quantity: 1,
        OrderId: null,
        PersonId: null,
        DynamicLines: [],
      }, { date: event!.eventDate });
      const proposals: BmiProposal[] = data.proposals || [];
      proposals.sort((a, b) => {
        const aS = a.blocks?.[0]?.block?.start || "";
        const bS = b.blocks?.[0]?.block?.start || "";
        return aS.localeCompare(bS);
      });
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

  // ── RSVP helper ──────────────────────────────────────────────────────────

  async function saveRsvp(newReservation: { type: string; track?: string; time?: string; billId?: string }) {
    if (!guest) return;
    // Get current record and append
    const existing = await fetch(`/api/group-event/rsvp?slug=${slug}&email=${encodeURIComponent(guest.email)}`).then(r => r.json()).catch(() => null);
    const reservations = existing?.reservations || [];
    reservations.push(newReservation);
    await fetch("/api/group-event/rsvp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        email: guest.email,
        name: guest.displayName,
        freeflow: selectedFreeflow,
        reservations,
      }),
    });
  }

  // ── Time formatting ──────────────────────────────────────────────────────

  function formatTime(iso: string): string {
    const clean = iso.replace(/Z$/, "");
    const [datePart, timePart] = clean.split("T");
    if (!timePart) return clean;
    const [y, m, d] = datePart.split("-").map(Number);
    const [h, min] = timePart.split(":").map(Number);
    return new Date(y, m - 1, d, h, min).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const reservationAttractions = getReservationAttractions(event);
  const freeflowAttractions = getFreeflowAttractions(event);
  const eventDateDisplay = new Date(event.eventDate + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  return (
    <div className="min-h-screen bg-[#000418] pt-[140px]">
      {/* Header */}
      <div className="border-b border-white/10 bg-white/3">
        <div className="max-w-2xl mx-auto px-4 py-6 text-center">
          {event.heroImage && (
            <img
              src={event.heroImage}
              alt={event.companyName}
              className="h-12 md:h-16 mx-auto mb-4 object-contain"
            />
          )}
          <p className="text-xs text-white/40 uppercase tracking-[0.2em] mb-1">Private Event</p>
          <h1 className="text-2xl md:text-3xl font-display text-white uppercase tracking-widest">
            {event.eventTitle}
          </h1>
          <p className="text-white/50 text-sm mt-2">
            {eventDateDisplay} &middot; {event.startTime} &ndash; {event.endTime}
          </p>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-8">

        {/* ═══ STEP: Email Gate ═══ */}
        {step === "gate" && (
          <div className="max-w-md mx-auto">
            <div className="rounded-2xl border border-white/10 bg-white/3 p-8 text-center">
              {event.heroImage && (
                <img src={event.heroImage} alt={event.companyName} className="h-10 mx-auto mb-4 object-contain" />
              )}
              <h2 className="text-xl font-display text-white uppercase tracking-widest mb-2">Welcome</h2>
              <p className="text-white/50 text-sm mb-6">
                Enter your company email to access the event.
              </p>
              <form onSubmit={handleGateSubmit} className="space-y-4">
                <input
                  name="email"
                  type="email"
                  required
                  placeholder="you@company.com"
                  className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder:text-white/30 focus:border-[#00E2E5]/50 focus:ring-1 focus:ring-[#00E2E5]/30 outline-none text-sm"
                />
                {gateError && <p className="text-red-400 text-xs">{gateError}</p>}
                <button
                  type="submit"
                  className="w-full py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors"
                >
                  Continue
                </button>
              </form>
            </div>
          </div>
        )}

        {/* ═══ STEP: Name ═══ */}
        {step === "name" && (
          <div className="max-w-md mx-auto">
            <div className="rounded-2xl border border-white/10 bg-white/3 p-8 text-center">
              <h2 className="text-xl font-display text-white uppercase tracking-widest mb-2">Your Name</h2>
              <p className="text-white/50 text-sm mb-6">
                Used for heat rosters so your team can see who&apos;s in each session.
              </p>
              <form onSubmit={handleNameSubmit} className="space-y-4">
                <input
                  name="firstName"
                  type="text"
                  required
                  placeholder="First name"
                  className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder:text-white/30 focus:border-[#00E2E5]/50 focus:ring-1 focus:ring-[#00E2E5]/30 outline-none text-sm"
                />
                <input
                  name="lastName"
                  type="text"
                  required
                  placeholder="Last name"
                  className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder:text-white/30 focus:border-[#00E2E5]/50 focus:ring-1 focus:ring-[#00E2E5]/30 outline-none text-sm"
                />
                <button
                  type="submit"
                  className="w-full py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors"
                >
                  Enter Event
                </button>
              </form>
            </div>
          </div>
        )}

        {/* ═══ STEP: Dashboard ═══ */}
        {step === "dashboard" && guest && (
          <div className="space-y-8">
            <div className="text-center">
              <p className="text-white/50 text-sm">Welcome, <span className="text-white font-semibold">{guest.firstName}</span>!</p>
              <p className="text-white/30 text-xs mt-1">Choose your activities below</p>
            </div>

            {/* Reservation-based activities */}
            <div>
              <h3 className="text-xs text-white/40 uppercase tracking-[0.15em] font-semibold mb-3">
                Reserve a Time Slot
              </h3>
              <div className="grid gap-3">
                {reservationAttractions.map((attr) => {
                  const isRacing = attr.slug === "racing";
                  const bookingCount = isRacing
                    ? (raceBooking ? 1 : 0)
                    : attractionBookings.filter(b => b.slug === attr.slug).length;
                  const maxAllowed = attr.maxPerGuest ?? Infinity;
                  const isBooked = bookingCount >= maxAllowed;
                  const booking = isRacing
                    ? raceBooking
                    : attractionBookings.find(b => b.slug === attr.slug);

                  return (
                    <button
                      key={attr.slug}
                      onClick={() => {
                        if (isBooked) return;
                        if (isRacing) {
                          setStep("racing-track");
                        } else {
                          setActiveAttraction(attr);
                          fetchAttractionSlots(attr);
                          setStep("attraction-slots");
                        }
                      }}
                      disabled={isBooked}
                      className={`
                        w-full rounded-xl border p-4 text-left transition-all
                        ${isBooked
                          ? "border-emerald-500/30 bg-emerald-500/8"
                          : "border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/8 cursor-pointer"
                        }
                      `}
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{attr.icon}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-white font-semibold text-sm">{attr.label}</span>
                            {isBooked && (
                              <span className="text-emerald-400 text-xs font-semibold">&#10003; Booked</span>
                            )}
                          </div>
                          <p className="text-white/40 text-xs mt-0.5">{attr.description}</p>
                          {isBooked && booking && (
                            <p className="text-emerald-400/70 text-xs mt-1">
                              {isRacing && raceBooking
                                ? `${raceBooking.track} Track • ${formatTime(raceBooking.heatStart)}`
                                : "time" in (booking as { time?: string })
                                  ? formatTime((booking as { time: string }).time)
                                  : "Reserved"
                              }
                            </p>
                          )}
                        </div>
                        {!isBooked && (
                          <span className="text-white/30 text-sm">&rsaquo;</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Free-flow activities */}
            <div>
              <h3 className="text-xs text-white/40 uppercase tracking-[0.15em] font-semibold mb-3">
                I Plan to Attend
              </h3>
              <div className="rounded-xl border border-white/10 bg-white/3 p-4 space-y-3">
                {freeflowAttractions.map((attr) => {
                  const checked = selectedFreeflow.includes(attr.slug);
                  return (
                    <label
                      key={attr.slug}
                      className="flex items-center gap-3 cursor-pointer group"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = checked
                            ? selectedFreeflow.filter(s => s !== attr.slug)
                            : [...selectedFreeflow, attr.slug];
                          saveFreeflow(next);
                        }}
                        className="w-4 h-4 rounded border-white/20 bg-white/5 text-[#00E2E5] focus:ring-[#00E2E5]/30 accent-[#00E2E5]"
                      />
                      <span className="text-lg">{attr.icon}</span>
                      <div>
                        <span className="text-white text-sm group-hover:text-white/90">{attr.label}</span>
                        <p className="text-white/30 text-xs">{attr.description}</p>
                      </div>
                    </label>
                  );
                })}
                {freeflowSaved && (
                  <p className="text-emerald-400 text-xs text-center animate-pulse">Saved!</p>
                )}
              </div>
            </div>

            {/* Info footer */}
            <div className="rounded-xl border border-white/8 bg-white/3 p-4 text-xs text-white/40 space-y-1">
              <p>&middot; All activities are <strong className="text-white/60">complimentary</strong> for {event.companyName} team members.</p>
              {event.includesLicense && (
                <p>&middot; Racing license fee is <strong className="text-white/60">included</strong> &mdash; no charge at check-in.</p>
              )}
              <p>&middot; Please arrive <strong className="text-white/60">15 minutes early</strong> for racing check-in.</p>
            </div>
          </div>
        )}

        {/* ═══ STEP: Track Picker ═══ */}
        {step === "racing-track" && (
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-1">Choose Your Track</h2>
              <p className="text-white/50 text-sm">Select Red or Blue track for your race</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {event.attractions
                .find(a => a.slug === "racing")
                ?.bmiTracks?.map((t) => (
                  <button
                    key={t.track}
                    onClick={() => {
                      setSelectedTrack(t.track);
                      setStep("racing-heat");
                    }}
                    className="rounded-xl border border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10 p-6 text-center transition-all cursor-pointer"
                  >
                    <div
                      className="w-12 h-12 rounded-full mx-auto mb-3"
                      style={{ backgroundColor: t.track === "Red" ? "#E41C1D" : "#2563EB" }}
                    />
                    <span className="text-white font-bold text-lg">{t.track} Track</span>
                    <p className="text-white/40 text-xs mt-1">Starter Race</p>
                  </button>
                ))}
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
            {bookingError && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/8 p-4 text-center">
                <p className="text-red-400 text-sm">{bookingError}</p>
              </div>
            )}
            {bookingInProgress && (
              <div className="rounded-xl border border-[#00E2E5]/30 bg-[#00E2E5]/8 p-4 text-center">
                <p className="text-[#00E2E5] text-sm animate-pulse">Booking your race...</p>
              </div>
            )}
            <HeatPicker
              race={{
                productId: event.attractions.find(a => a.slug === "racing")!.bmiTracks!.find(t => t.track === selectedTrack)!.productId,
                pageId: event.attractions.find(a => a.slug === "racing")!.bmiTracks!.find(t => t.track === selectedTrack)!.pageId,
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
              onConfirm={handleRaceHeatConfirm}
              onBack={() => setStep("racing-track")}
              confirmLabel="Book This Heat"
              packageMode={true}
              immediateConfirm={false}
              heatRosters={heatRosters}
            />
          </div>
        )}

        {/* ═══ STEP: Attraction Time Slots ═══ */}
        {step === "attraction-slots" && activeAttraction && (
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-1">{activeAttraction.label}</h2>
              <p className="text-white/50 text-sm">Pick a session time</p>
            </div>

            {bookingError && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/8 p-4 text-center">
                <p className="text-red-400 text-sm">{bookingError}</p>
              </div>
            )}
            {bookingInProgress && (
              <div className="rounded-xl border border-[#00E2E5]/30 bg-[#00E2E5]/8 p-4 text-center">
                <p className="text-[#00E2E5] text-sm animate-pulse">Booking...</p>
              </div>
            )}

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
                  return (
                    <button
                      key={idx}
                      onClick={() => {
                        if (isFull || bookingInProgress) return;
                        handleAttractionBook(activeAttraction, proposal, block);
                      }}
                      disabled={isFull || bookingInProgress}
                      className={`
                        rounded-xl border p-3 text-left transition-all duration-150
                        ${isFull
                          ? "border-white/5 bg-white/3 opacity-40 cursor-not-allowed"
                          : "border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10 cursor-pointer"
                        }
                      `}
                    >
                      <div className="text-white font-bold text-base mb-0.5">{formatTime(block.start)}</div>
                      <div className="text-white/40 text-xs mb-1">&rarr; {formatTime(block.stop)}</div>
                      <div className={`text-xs font-medium ${isFull ? "text-red-400" : "text-emerald-400"}`}>
                        {isFull ? "Full" : `${block.freeSpots} spot${block.freeSpots === 1 ? "" : "s"} open`}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            <button
              onClick={() => { setActiveAttraction(null); setStep("dashboard"); }}
              className="text-sm text-white/40 hover:text-white/70 transition-colors"
            >
              &larr; Back to activities
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
