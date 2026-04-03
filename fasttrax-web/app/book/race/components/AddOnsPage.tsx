"use client";

import { useState } from "react";
import Image from "next/image";

const HEADPINZ_LOGO = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/logos/headpinz-logo-9aUwk9v1Z8LcHZP5chi50PnSbDWpSg.png";

export interface AddOnItem {
  id: string;
  name: string;
  shortName: string;
  description: string;
  price: number;
  image: string;
  perPerson: boolean; // true = per racer, false = per group (up to X people)
  maxPerGroup?: number; // e.g. Shuffly up to 10, Duck Pin up to 6
  color: string;
  location: "fasttrax" | "headpinz";
  quantity: number; // selected quantity
  // Scheduling (for entry/bookable products)
  selectedTime?: string; // ISO start time
  proposal?: unknown; // full proposal for booking/book
  block?: unknown; // selected block
  billLineId?: string; // BMI line ID for removal
}

interface TimeSlot {
  start: string;
  stop: string;
  name: string;
  freeSpots: number;
  capacity: number;
  proposal: unknown;
  block: unknown;
}

interface AddOnsPageProps {
  racerCount: number;
  date: string; // YYYY-MM-DD
  bookedHeats: { start: string; stop: string; track: string | null }[]; // race heats to avoid
  onContinue: (addOns: AddOnItem[]) => void;
  onBack: () => void;
  initialAddOns?: AddOnItem[];
}

const ADD_ONS: Omit<AddOnItem, "quantity">[] = [
  {
    id: "27488020",
    name: "FastTrax Shuffly 1 Hour Combo",
    shortName: "Shuffly",
    description: "A modern twist on classic shuffleboard with immersive AR effects, automatic scoring, and dynamic LED lighting. Up to 10 players per lane.",
    price: 10,
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/addons/shuffly-Z5qjcBLniaNQKdjQGFI3RfWRwx36HZ.jpg",
    perPerson: false,
    maxPerGroup: 10,
    color: "#E53935",
    location: "fasttrax",
  },
  {
    id: "23345635",
    name: "Duckpin Bowling - 1 Hour",
    shortName: "Duckpin",
    description: "Fast, fun bowling with smaller pins and lighter balls. No rental shoes required! Perfect for groups between races.",
    price: 35,
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06561.webp",
    perPerson: false,
    maxPerGroup: 6,
    color: "#004AAD",
    location: "fasttrax",
  },
  {
    id: "27488200",
    name: "Nexus Gel Blaster Arena",
    shortName: "Gel Blaster",
    description: "Step into a live-action video game! High-tech blasters, glowing environments, and fast-paced team battles using eco-friendly Gellets. Located at HeadPinz next door.",
    price: 10,
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/addons/gelblaster-gtOdWfUsDWYEf72h2aBEytF5GCuZUs.jpg",
    perPerson: true,
    color: "#39FF14",
    location: "headpinz",
  },
  {
    id: "8976685",
    name: "Nexus Laser Tag Arena",
    shortName: "Laser Tag",
    description: "Immersive team-based battles with advanced laser blasters and vests in a glowing arena filled with lights, fog, and music. Located at HeadPinz next door.",
    price: 10,
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/addons/lasertag-uMlQDT8COLcGQVEfVyqgjgUOseIZjI.jpg",
    perPerson: true,
    color: "#E53935",
    location: "headpinz",
  },
];

function parseLocal(iso: string): Date {
  const clean = iso.replace(/Z$/, "");
  const [datePart, timePart] = clean.split("T");
  if (!timePart) return new Date(clean);
  const [y, m, d] = datePart.split("-").map(Number);
  const [h, min, s] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, h, min, s || 0);
}

function formatTime(iso: string): string {
  const d = parseLocal(iso);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

// Check if a time slot conflicts with any booked race heat (30 min buffer)
function conflictsWithRace(slotStart: string, slotStop: string, heats: { start: string; stop: string }[]): boolean {
  const sStart = parseLocal(slotStart).getTime();
  const sStop = parseLocal(slotStop).getTime();
  const buffer = 30 * 60_000;
  return heats.some(h => {
    const hStart = parseLocal(h.start).getTime();
    const hStop = parseLocal(h.stop).getTime();
    // Overlap or within buffer
    return sStart < (hStop + buffer) && sStop > (hStart - buffer);
  });
}

export default function AddOnsPage({ racerCount, date, bookedHeats, onContinue, onBack, initialAddOns }: AddOnsPageProps) {
  // Restore previous selections if navigating back
  const [selections, setSelections] = useState<Record<string, number>>(() => {
    if (!initialAddOns) return {};
    const m: Record<string, number> = {};
    for (const a of initialAddOns) { if (a.quantity > 0) m[a.id] = a.quantity; }
    return m;
  });
  const [timeSlots, setTimeSlots] = useState<Record<string, TimeSlot[]>>({});
  const [selectedTimes, setSelectedTimes] = useState<Record<string, number>>({}); // index into timeSlots
  const [loadingSlots, setLoadingSlots] = useState<Record<string, boolean>>({});

  function getQty(id: string) {
    return selections[id] || 0;
  }

  function setQty(id: string, qty: number) {
    setSelections(prev => ({ ...prev, [id]: Math.max(0, qty) }));
    // Fetch time slots when first selected
    if (qty > 0 && !timeSlots[id] && !loadingSlots[id]) {
      fetchTimeSlots(id, qty);
    }
    if (qty === 0) {
      setSelectedTimes(prev => { const n = { ...prev }; delete n[id]; return n; });
    }
  }

  async function fetchTimeSlots(productId: string, qty: number) {
    setLoadingSlots(prev => ({ ...prev, [productId]: true }));
    try {
      const dateOnly = date.split("T")[0];
      const allSlots: TimeSlot[] = [];
      const seen = new Set<string>();

      // Fetch in 2-hour jumps
      const startHours = [11, 13, 15, 17, 19, 21];
      for (const hour of startHours) {
        const h = String(hour).padStart(2, "0");
        const utcTime = `${dateOnly}T${h}:00:00.000Z`;
        try {
          const res = await fetch("/api/sms?endpoint=dayplanner%2Fdayplanner", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              productId,
              pageId: "42730172", // Private add-ons page
              quantity: qty,
              dynamicLines: null,
              date: utcTime,
            }),
          });
          if (!res.ok) continue;
          const data = await res.json();
          for (const p of (data.proposals || [])) {
            const block = p.blocks?.[0]?.block;
            if (!block) continue;
            const key = block.start;
            if (seen.has(key)) continue;
            seen.add(key);

            // Skip if conflicts with race heats
            if (conflictsWithRace(block.start, block.stop, bookedHeats)) continue;

            allSlots.push({
              start: block.start,
              stop: block.stop,
              name: block.name,
              freeSpots: block.freeSpots,
              capacity: block.capacity,
              proposal: p,
              block,
            });
          }
        } catch { /* skip this hour */ }
      }

      allSlots.sort((a, b) => a.start.localeCompare(b.start));
      setTimeSlots(prev => ({ ...prev, [productId]: allSlots }));

      // Auto-select first available slot
      if (allSlots.length > 0) {
        setSelectedTimes(prev => ({ ...prev, [productId]: 0 }));
      }
    } catch {
      setTimeSlots(prev => ({ ...prev, [productId]: [] }));
    } finally {
      setLoadingSlots(prev => ({ ...prev, [productId]: false }));
    }
  }

  function handleContinue() {
    const addOns: AddOnItem[] = ADD_ONS
      .filter(a => getQty(a.id) > 0)
      .map(a => {
        const slots = timeSlots[a.id] || [];
        const selectedIdx = selectedTimes[a.id];
        const slot = selectedIdx !== undefined ? slots[selectedIdx] : undefined;
        // If no slot selected but we have previous data from initialAddOns, carry it forward
        const prev = initialAddOns?.find(ia => ia.id === a.id);
        return {
          ...a,
          quantity: getQty(a.id),
          selectedTime: slot?.start ?? prev?.selectedTime,
          proposal: slot?.proposal ?? prev?.proposal,
          block: slot?.block ?? prev?.block,
        };
      });
    onContinue(addOns);
  }

  const totalAddOns = Object.values(selections).reduce((s, q) => s + q, 0);
  const totalCost = ADD_ONS.reduce((sum, a) => sum + a.price * getQty(a.id), 0);

  return (
    <div className="space-y-8">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-display uppercase tracking-widest text-white">
          Level Up Your Visit
        </h2>
        <p className="text-white/40 text-sm max-w-md mx-auto">
          Add more fun to your race day. These combos are exclusive to online booking.
        </p>
      </div>

      {/* Show booked race times for reference */}
      {bookedHeats.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="text-white/40 text-[10px] uppercase tracking-wider font-semibold mb-2">Your Race Schedule</p>
          <div className="flex flex-wrap gap-2">
            {bookedHeats.map((h, i) => {
              const color = h.track === "Red" ? "#E53935" : h.track === "Blue" ? "#004AAD" : "#00E2E5";
              return (
                <span
                  key={i}
                  className="px-3 py-1 rounded-full text-xs font-semibold border"
                  style={{ borderColor: color, color, backgroundColor: `${color}15` }}
                >
                  🏎️ {formatTime(h.start)} — {h.track ?? "Race"}
                </span>
              );
            })}
          </div>
          <p className="text-white/30 text-[10px] mt-1.5">Pick add-on times that don&apos;t overlap with your races</p>
        </div>
      )}

      <div className="grid gap-4">
        {ADD_ONS.map(addon => {
          const qty = getQty(addon.id);
          const isSelected = qty > 0;
          const priceLabel = addon.perPerson
            ? `$${addon.price}/person`
            : `$${addon.price}${addon.maxPerGroup ? ` (up to ${addon.maxPerGroup} players)` : ""}`;

          return (
            <div
              key={addon.id}
              className={`rounded-xl border overflow-hidden transition-all duration-200 ${
                isSelected
                  ? "border-[#00E2E5]/50 bg-[#00E2E5]/5 ring-1 ring-[#00E2E5]/20"
                  : "border-white/10 bg-white/[0.03] hover:border-white/20"
              }`}
            >
              <div className="flex flex-col sm:flex-row">
                {/* Image */}
                {addon.image && (
                  <div className="relative w-full sm:w-40 h-32 sm:h-auto shrink-0">
                    <Image
                      src={addon.image}
                      alt={addon.shortName}
                      fill
                      className="object-cover"
                      sizes="(max-width: 640px) 100vw, 160px"
                    />
                    <div className="absolute top-2 left-2 flex items-center gap-1.5">
                      <span
                        className="px-2 py-0.5 rounded-full text-[10px] font-bold text-white"
                        style={{ backgroundColor: addon.color }}
                      >
                        {addon.shortName}
                      </span>
                      {addon.location === "headpinz" && (
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-black/70 backdrop-blur">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={HEADPINZ_LOGO} alt="HeadPinz" className="h-3.5 w-auto" />
                          <span className="text-[9px] text-white/80 font-semibold">Next Door</span>
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Content */}
                <div className="flex-1 p-4 flex flex-col justify-between gap-3">
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-white font-bold text-sm">{addon.name}</h3>
                      <span className="text-[#00E2E5] font-bold text-sm shrink-0">{priceLabel}</span>
                    </div>
                    <p className="text-white/40 text-xs mt-1 leading-relaxed">{addon.description}</p>
                    {addon.location === "headpinz" && (
                      <p className="text-amber-400/80 text-[10px] font-semibold mt-1 flex items-center gap-1">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        Located at HeadPinz — right next door to FastTrax
                      </p>
                    )}
                  </div>

                  {/* Quantity controls */}
                  <div className="flex items-center justify-between">
                    {addon.perPerson ? (
                      // Per person: show quantity picker (default to racer count)
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setQty(addon.id, qty - 1)}
                          disabled={qty === 0}
                          className="w-8 h-8 rounded-lg border border-white/20 text-white/60 hover:border-white/40 hover:text-white disabled:opacity-30 transition-colors flex items-center justify-center text-lg"
                        >
                          -
                        </button>
                        <span className="w-8 text-center text-white font-bold text-sm">{qty}</span>
                        <button
                          onClick={() => setQty(addon.id, qty + 1)}
                          className="w-8 h-8 rounded-lg border border-white/20 text-white/60 hover:border-white/40 hover:text-white transition-colors flex items-center justify-center text-lg"
                        >
                          +
                        </button>
                        {qty === 0 && (
                          <button
                            onClick={() => setQty(addon.id, racerCount)}
                            className="ml-2 text-[#00E2E5] text-xs font-semibold hover:underline"
                          >
                            Add for all {racerCount} racer{racerCount !== 1 ? "s" : ""}
                          </button>
                        )}
                      </div>
                    ) : (
                      // Per group: toggle on/off
                      <button
                        onClick={() => setQty(addon.id, qty > 0 ? 0 : 1)}
                        className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors ${
                          isSelected
                            ? "bg-[#00E2E5] text-[#000418]"
                            : "bg-white/10 text-white/60 hover:bg-white/20 hover:text-white"
                        }`}
                      >
                        {isSelected ? "Added ✓" : "Add to Booking"}
                      </button>
                    )}

                    {qty > 0 && (
                      <span className="text-[#00E2E5] text-sm font-semibold">
                        ${(addon.price * qty).toFixed(2)}
                      </span>
                    )}
                  </div>

                  {/* Time picker — shows when add-on is selected */}
                  {isSelected && (
                    <div className="mt-3 pt-3 border-t border-white/10">
                      {loadingSlots[addon.id] ? (
                        <div className="flex items-center gap-2 text-white/40 text-xs">
                          <div className="w-3 h-3 border border-white/30 border-t-white/80 rounded-full animate-spin" />
                          Loading available times...
                        </div>
                      ) : (timeSlots[addon.id]?.length ?? 0) === 0 ? (
                        <p className="text-amber-400/70 text-xs">No times available on this date</p>
                      ) : (
                        <div className="space-y-1.5">
                          <p className="text-white/50 text-[10px] uppercase tracking-wider font-semibold">Select a time</p>
                          <div className="flex flex-wrap gap-1.5">
                            {(() => {
                              const slots = timeSlots[addon.id] || [];
                              // Merge race heats into the timeline
                              const allItems: { time: string; type: "slot" | "race"; idx?: number; trackColor?: string; label: string }[] = [
                                ...slots.map((s, idx) => ({ time: s.start, type: "slot" as const, idx, label: formatTime(s.start) })),
                                ...bookedHeats.map(h => ({
                                  time: h.start,
                                  type: "race" as const,
                                  trackColor: h.track === "Red" ? "#E53935" : h.track === "Blue" ? "#004AAD" : "#00E2E5",
                                  label: formatTime(h.start),
                                })),
                              ];
                              allItems.sort((a, b) => a.time.localeCompare(b.time));
                              // Deduplicate (race heat times already filtered from slots)
                              return allItems.map((item, i) => {
                                if (item.type === "race") {
                                  return (
                                    <span
                                      key={`race-${i}`}
                                      className="px-3 py-1.5 rounded-lg text-xs font-bold border-2 opacity-70 cursor-not-allowed"
                                      style={{ borderColor: item.trackColor, color: item.trackColor, backgroundColor: `${item.trackColor}15` }}
                                      title="Your race"
                                    >
                                      {item.label} 🏎️
                                    </span>
                                  );
                                }
                                const isChosen = selectedTimes[addon.id] === item.idx;
                                return (
                                  <button
                                    key={`slot-${item.idx}`}
                                    onClick={() => setSelectedTimes(prev => ({ ...prev, [addon.id]: item.idx! }))}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                                      isChosen
                                        ? "bg-[#00E2E5] text-[#000418]"
                                        : "bg-white/5 text-white/50 border border-white/10 hover:bg-white/10 hover:text-white"
                                    }`}
                                  >
                                    {item.label}
                                  </button>
                                );
                              });
                            })()}
                          </div>
                          {selectedTimes[addon.id] !== undefined && (
                            <p className="text-white/30 text-[10px]">
                              {formatTime(timeSlots[addon.id][selectedTimes[addon.id]].start)} — {formatTime(timeSlots[addon.id][selectedTimes[addon.id]].stop)}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Summary + CTA */}
      <div className={`rounded-xl border p-5 transition-all duration-300 ${
        totalAddOns > 0 ? "border-[#00E2E5]/40 bg-[#00E2E5]/8" : "border-white/10 bg-white/3"
      }`}>
        {totalAddOns > 0 ? (
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <p className="text-white/50 text-xs mb-1">{totalAddOns} add-on{totalAddOns !== 1 ? "s" : ""} selected</p>
              <p className="text-[#00E2E5] font-bold text-lg">+${totalCost.toFixed(2)}</p>
            </div>
            <div className="flex flex-col gap-2 shrink-0">
              <button
                onClick={handleContinue}
                className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25"
              >
                Continue with Add-Ons →
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-white/30 text-sm">No add-ons selected</p>
            <button
              onClick={() => onContinue([])}
              className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25"
            >
              Skip — Continue to Checkout →
            </button>
          </div>
        )}
      </div>

      <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors">
        ← Back to heat selection
      </button>
    </div>
  );
}
