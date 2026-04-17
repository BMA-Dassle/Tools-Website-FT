"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { setBookingLocation, getBookingLocation, clearBookingLocation, getBookingClientKey, syncLocationFromUrl } from "@/lib/booking-location";
import Image from "next/image";
import Link from "next/link";
import BrandNav from "@/components/BrandNav";
import PaymentForm from "@/components/square/PaymentForm";
import type { PaymentResult } from "@/components/square/PaymentForm";
// MiniCart is rendered globally in root layout
import ContactForm from "@/app/book/race/components/ContactForm";
import type { ContactInfo } from "@/app/book/race/components/ContactForm";
import {
  ATTRACTIONS,
  ATTRACTION_LIST,
  bookAttractionSlot,
  bmiGet,
  calculateTax,
  calculateTotal,
  type AttractionConfig,
  type AttractionProduct,
  type AttractionSlug,
  type LocationKey,
  type BmiPage,
  type BmiProposal,
  type BmiBlock,
  type BmiProposalBlock,
  normalizeLocationSlug,
} from "@/lib/attractions-data";

// ── Types ───────────────────────────────────────────────────────────────────

type Step = "location" | "product" | "date" | "time" | "quantity" | "cart" | "contact" | "review";

interface CartItem {
  attraction: AttractionSlug;
  attractionName: string;
  product: AttractionProduct;
  date: string;
  time: { proposal: BmiProposal; block: BmiBlock };
  quantity: number;
  billLineId: string | null;
  color: string;
}

interface BookingState {
  location: LocationKey | null;
  product: AttractionProduct | null;
  date: string | null; // YYYY-MM-DD
  time: { proposal: BmiProposal; block: BmiBlock } | null;
  quantity: number;
  contact: ContactInfo | null;
  orderId: string | null;
  billLineId: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseLocal(iso: string): Date {
  const clean = iso.replace(/Z$/, "");
  const [datePart, timePart] = clean.split("T");
  if (!timePart) return new Date(clean);
  const [y, m, d] = datePart.split("-").map(Number);
  const [h, min, s] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, h, min, s || 0);
}

function formatTime(iso: string) {
  return parseLocal(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatDate(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function toISO(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function spotsLabel(free: number, capacity: number) {
  if (free === 0) return { text: "text-red-400", label: "Full" };
  if (free / capacity <= 0.3) return { text: "text-amber-400", label: `${free} spot${free === 1 ? "" : "s"} left` };
  return { text: "text-emerald-400", label: `${free} of ${capacity} open` };
}

// ── Step Indicator ──────────────────────────────────────────────────────────

function StepIndicator({ steps, current, color }: { steps: { key: Step; label: string }[]; current: Step; color: string }) {
  const currentIdx = steps.findIndex(s => s.key === current);
  return (
    <div className="flex items-center justify-center gap-1 sm:gap-2 px-2">
      {steps.map((s, i) => {
        const isActive = i === currentIdx;
        const isDone = i < currentIdx;
        return (
          <div key={s.key} className="flex items-center gap-1 sm:gap-2">
            {i > 0 && <div className={`w-4 sm:w-6 h-px ${isDone ? "bg-white/30" : "bg-white/10"}`} />}
            <div className="flex items-center gap-1.5">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                  isActive
                    ? "text-[#000418] shadow-lg"
                    : isDone
                      ? "bg-white/20 text-white/60"
                      : "bg-white/5 text-white/25"
                }`}
                style={isActive ? { backgroundColor: color, boxShadow: `0 0 20px ${color}40` } : undefined}
              >
                {isDone ? (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  i + 1
                )}
              </div>
              <span className={`text-xs sm:text-xs font-medium hidden sm:inline ${isActive ? "text-white" : isDone ? "text-white/50" : "text-white/25"}`}>
                {s.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Location Picker ─────────────────────────────────────────────────────────

const LOCATION_INFO: Record<LocationKey, { name: string; address: string }> = {
  fasttrax: { name: "FastTrax Fort Myers", address: "14501 Global Pkwy, Fort Myers" },
  headpinz: { name: "HeadPinz Fort Myers", address: "14513 Global Pkwy, Fort Myers" },
  naples: { name: "HeadPinz Naples", address: "8525 Radio Ln, Naples" },
};

function LocationPicker({ config, onSelect, onBack, color }: { config: AttractionConfig; onSelect: (loc: LocationKey) => void; onBack: () => void; color: string }) {
  // Build location options from the attraction's actual products
  const locationKeys = [...new Set(config.products.map(p => p.location))] as LocationKey[];
  const locations = locationKeys.map(key => ({ key, ...LOCATION_INFO[key] }));

  // If only one location, auto-select it
  useEffect(() => {
    if (locations.length === 1) onSelect(locations[0].key);
  }, []);
  if (locations.length <= 1) return null;

  return (
    <div className="space-y-6 max-w-md mx-auto">
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-2">Choose Location</h2>
        <p className="text-white/50 text-sm">{config.name} is available at multiple locations.</p>
      </div>
      <div className="grid gap-3">
        {locations.map(loc => (
          <button
            key={loc.key}
            onClick={() => onSelect(loc.key)}
            className="rounded-xl border border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10 p-5 text-left transition-all group"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white font-bold text-base">{loc.name}</p>
                <p className="text-white/40 text-xs mt-1">{loc.address}</p>
              </div>
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ backgroundColor: `${color}20` }}
              >
                <svg className="w-5 h-5" style={{ color }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </div>
            </div>
          </button>
        ))}
      </div>
      <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors block mx-auto">
        ← Back to experiences
      </button>
    </div>
  );
}

// ── Product Picker ──────────────────────────────────────────────────────────

function ProductPickerStep({
  products,
  loading,
  onSelect,
  onBack,
  color,
  attractionName,
}: {
  products: AttractionProduct[];
  loading: boolean;
  onSelect: (p: AttractionProduct) => void;
  onBack: () => void;
  color: string;
  attractionName: string;
}) {
  if (loading) {
    return (
      <div className="h-48 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-white/20 border-t-white/80 rounded-full animate-spin" />
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="h-48 flex flex-col items-center justify-center gap-3">
        <p className="text-white/40 text-sm">No products available for this date.</p>
        <button onClick={onBack} className="text-xs text-white/50 hover:text-white underline">
          Go back
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-lg mx-auto">
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-2">Choose a Package</h2>
        <p className="text-white/50 text-sm">{attractionName}</p>
      </div>
      <div className="grid gap-3">
        {products.map(p => (
          <button
            key={p.productId}
            onClick={() => onSelect(p)}
            className="rounded-xl border border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10 p-5 text-left transition-all group"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white font-bold text-base">{p.name}</p>
                <div className="flex items-center gap-3 mt-1">
                  {p.durationMin && (
                    <span className="text-white/40 text-xs">{p.durationMin} min</span>
                  )}
                  {p.isCombo && (
                    <span className="text-xs px-2 py-0.5 rounded-full border border-white/15 text-white/50">Combo</span>
                  )}
                </div>
              </div>
              <div className="text-right">
                <p className="text-white font-bold text-lg">${p.price.toFixed(2)}</p>
                <p className="text-white/40 text-xs">
                  {p.bookingMode === "per-person" ? "per person" : "per table"}
                </p>
              </div>
            </div>
          </button>
        ))}
      </div>
      <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors block mx-auto">
        ← Back
      </button>
    </div>
  );
}

// ── Date Picker (simplified for attractions) ────────────────────────────────

function AttractionDatePicker({
  productId,
  selected,
  onSelect,
  onBack,
  clientKey,
}: {
  productId: string;
  selected: string | null;
  clientKey?: string;
  onSelect: (date: string) => void;
  onBack: () => void;
}) {
  const today = new Date();
  const todayStr = toISO(today.getFullYear(), today.getMonth(), today.getDate());
  const daysLeft = getDaysInMonth(today.getFullYear(), today.getMonth()) - today.getDate();
  const init = daysLeft === 0
    ? { year: today.getMonth() === 11 ? today.getFullYear() + 1 : today.getFullYear(), month: today.getMonth() === 11 ? 0 : today.getMonth() + 1 }
    : { year: today.getFullYear(), month: today.getMonth() };

  const [viewYear, setViewYear] = useState(init.year);
  const [viewMonth, setViewMonth] = useState(init.month);
  const [available, setAvailable] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const fetchAvailability = useCallback(async (year: number, month: number) => {
    setLoading(true);
    try {
      const dateFrom = `${year}-${String(month + 1).padStart(2, "0")}-01`;
      const lastDay = getDaysInMonth(year, month);
      const dateTill = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      const data = await bmiGet("availability", { productId, dateFrom, dateTill }, clientKey);
      const activities: { date: string; status: number }[] = data.activities || [];
      setAvailable(new Set(activities.filter(a => a.status === 0).map(a => a.date.split("T")[0])));
    } catch {
      setAvailable(new Set());
    } finally {
      setLoading(false);
    }
  }, [productId, clientKey]);

  useEffect(() => { fetchAvailability(viewYear, viewMonth); }, [viewYear, viewMonth, fetchAvailability]);

  const monthName = new Date(viewYear, viewMonth).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay = new Date(viewYear, viewMonth, 1).getDay();

  function prevMonth() {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  }

  // Prevent navigating before current month
  const canGoPrev = viewYear > today.getFullYear() || (viewYear === today.getFullYear() && viewMonth > today.getMonth());

  return (
    <div className="space-y-6 max-w-sm mx-auto">
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-2">Pick a Date</h2>
      </div>

      {/* Month nav */}
      <div className="flex items-center justify-between px-2">
        <button onClick={prevMonth} disabled={!canGoPrev} className={`p-2 rounded-lg ${canGoPrev ? "text-white/60 hover:text-white hover:bg-white/10" : "text-white/15 cursor-not-allowed"}`}>
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
        </button>
        <span className="text-white font-display text-base uppercase tracking-wider">{monthName}</span>
        <button onClick={nextMonth} className="p-2 rounded-lg text-white/60 hover:text-white hover:bg-white/10">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-1 text-center">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} className="text-white/30 text-xs font-bold py-1">{d}</div>
        ))}
      </div>

      {/* Calendar grid */}
      {loading ? (
        <div className="h-48 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-white/20 border-t-white/80 rounded-full animate-spin" />
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: firstDay }).map((_, i) => <div key={`e-${i}`} />)}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1;
            const iso = toISO(viewYear, viewMonth, day);
            const isPast = iso < todayStr;
            const isAvailable = available.has(iso) && !isPast;
            const isSelected = iso === selected;

            return (
              <button
                key={day}
                onClick={() => isAvailable && onSelect(iso)}
                disabled={!isAvailable}
                className={`
                  aspect-square rounded-lg flex items-center justify-center text-sm font-medium transition-all
                  ${isSelected
                    ? "bg-[#00E2E5] text-[#000418] font-bold shadow-lg shadow-[#00E2E5]/25"
                    : isAvailable
                      ? "text-white hover:bg-white/10 cursor-pointer"
                      : "text-white/15 cursor-not-allowed"
                  }
                `}
              >
                {day}
              </button>
            );
          })}
        </div>
      )}

      <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors block mx-auto">
        ← Back
      </button>
    </div>
  );
}

// ── Time Slot Picker (for attractions — uses BMI availability endpoint) ─────

function TimeSlotPicker({
  product,
  date,
  quantity,
  onConfirm,
  onBack,
  color,
  clientKey,
}: {
  product: AttractionProduct;
  date: string;
  quantity: number;
  onConfirm: (proposal: BmiProposal, block: BmiBlock) => void;
  onBack: () => void;
  color: string;
  clientKey?: string;
}) {
  const [proposals, setProposals] = useState<BmiProposal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const ctaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedIdx !== null) {
      setTimeout(() => ctaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  }, [selectedIdx]);

  const fetchSlots = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSelectedIdx(null);
    try {
      const dateOnly = date.split("T")[0];
      const allProposals: BmiProposal[] = [];
      const seen = new Set<string>();

      // Fetch time slots via SMS-Timing dayplanner in 2-hour jumps
      const [y, m, d] = dateOnly.split("-").map(Number);
      const dayOfWeek = new Date(y, m - 1, d).getDay();
      const startHours = (dayOfWeek === 0 || dayOfWeek === 6)
        ? [10, 12, 14, 16, 18, 20, 22]
        : [14, 16, 18, 20, 22];

      // Build SMS-Timing URL — add clientKey for non-default locations (e.g. Naples)
      const smsBase = clientKey
        ? `/api/sms?endpoint=dayplanner%2Fdayplanner&clientKey=${clientKey}`
        : "/api/sms?endpoint=dayplanner%2Fdayplanner";

      for (const hour of startHours) {
        const h = String(hour).padStart(2, "0");
        try {
          const batch: BmiProposal[] = await fetch(smsBase, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              productId: product.productId,
              pageId: product.pageId,
              quantity: quantity,
              dynamicLines: null,
              date: `${dateOnly}T${h}:00:00.000Z`,
            }),
          }).then(r => {
            if (!r.ok) throw new Error("Failed");
            return r.json();
          }).then(d => d.proposals || []);

          for (const p of batch) {
            const key = p.blocks?.[0]?.block?.start;
            if (key && !seen.has(key)) {
              seen.add(key);
              allProposals.push(p);
            }
          }
        } catch { /* skip this batch */ }
      }

      allProposals.sort((a, b) => {
        const aStart = a.blocks?.[0]?.block?.start || "";
        const bStart = b.blocks?.[0]?.block?.start || "";
        return aStart.localeCompare(bStart);
      });

      setProposals(allProposals);
    } catch {
      setError("Couldn't load time slots. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [product.productId, product.pageId, date, quantity, clientKey]);

  useEffect(() => { fetchSlots(); }, [fetchSlots]);

  const displayDate = formatDate(date);
  const selectedProposal = selectedIdx !== null ? proposals[selectedIdx] : null;
  const selectedBlock = selectedProposal?.blocks?.[0]?.block ?? null;
  // Dayplanner is called with the group's quantity, so the price returned is
  // already the TOTAL for that many people — do not multiply by quantity again.
  // Fallback (no selected block yet): use catalog price × qty as an estimate.
  const blockTotalPrice = selectedBlock?.prices?.find(p => p.depositKind === 0)?.amount;
  const perPersonPrice = blockTotalPrice != null && quantity > 0
    ? blockTotalPrice / quantity
    : product.price;
  const lineTotal = blockTotalPrice != null
    ? blockTotalPrice
    : (product.bookingMode === "per-person" ? product.price * quantity : product.price);

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-1">Pick a Time</h2>
        <p className="text-white/50 text-sm">
          <span className="text-white/80">{product.name}</span> · {displayDate}
        </p>
      </div>

      {/* Booking summary */}
      <div className="max-w-sm mx-auto rounded-xl border border-white/8 bg-white/3 p-3 text-center">
        <p className="text-white/50 text-xs">
          {product.bookingMode === "per-person"
            ? <>Booking for <span className="text-white font-semibold">{quantity} {quantity === 1 ? "person" : "people"}</span></>
            : <span className="text-white font-semibold">1 {product.name.toLowerCase().includes("lane") ? "lane" : "table"}</span>
          }
        </p>
      </div>

      {loading ? (
        <div className="h-48 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-white/20 border-t-white/80 rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="h-48 flex flex-col items-center justify-center gap-3">
          <p className="text-red-400 text-sm">{error}</p>
          <button onClick={fetchSlots} className="text-xs text-white/50 hover:text-white underline">Retry</button>
        </div>
      ) : proposals.length === 0 ? (
        <div className="h-48 flex flex-col items-center justify-center gap-3">
          <p className="text-white/40 text-sm">No time slots available for this date.</p>
          <button onClick={onBack} className="text-xs text-white/50 hover:text-white underline">Choose a different date</button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {proposals.map((proposal, idx) => {
              const block = proposal.blocks?.[0]?.block;
              if (!block) return null;

              const isFull = block.freeSpots < quantity;
              const isSelected = selectedIdx === idx;
              const spots = spotsLabel(block.freeSpots, block.capacity);

              return (
                <button
                  key={idx}
                  onClick={() => !isFull && setSelectedIdx(idx)}
                  disabled={isFull}
                  className={`
                    rounded-xl border p-3 text-left transition-all duration-150
                    ${isSelected
                      ? `border-white/40 bg-white/15 ring-1 ring-white/30`
                      : isFull
                        ? "border-white/5 bg-white/3 opacity-40 cursor-not-allowed"
                        : "border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10 cursor-pointer"
                    }
                  `}
                  style={isSelected ? { borderColor: color, backgroundColor: `${color}15`, boxShadow: `0 0 0 1px ${color}50` } : undefined}
                >
                  <div className="text-white font-bold text-base mb-0.5">{formatTime(block.start)}</div>
                  <div className="text-white/40 text-xs mb-2">{block.stop ? `→ ${formatTime(block.stop)}` : ""}</div>
                  <div className="text-xs font-medium mb-1 text-white/60">{block.name}</div>
                  <div className={`text-[13px] font-medium ${isFull ? "text-red-400" : spots.text}`}>
                    {isFull ? "Full" : spots.label}
                  </div>
                  <div className="mt-2 h-1 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${isFull ? "bg-red-500" : block.freeSpots / block.capacity <= 0.3 ? "bg-amber-400" : "bg-emerald-400"}`}
                      style={{ width: `${(block.freeSpots / block.capacity) * 100}%` }}
                    />
                  </div>
                </button>
              );
            })}
          </div>

          {/* CTA */}
          <div
            ref={ctaRef}
            className={`rounded-xl border p-5 transition-all duration-300 ${selectedBlock ? "border-white/20 bg-white/8" : "border-white/10 bg-white/3"}`}
            style={selectedBlock ? { borderColor: `${color}60`, backgroundColor: `${color}10` } : undefined}
          >
            {selectedBlock ? (
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <p className="text-white/50 text-xs mb-1">Selected</p>
                  <p className="text-white font-bold">{selectedBlock.name} · {formatTime(selectedBlock.start)}</p>
                  <p className="text-sm font-semibold mt-0.5" style={{ color }}>
                    {product.bookingMode === "per-person"
                      ? <>${perPersonPrice.toFixed(2)} x {quantity} = <span className="text-lg">${lineTotal.toFixed(2)}</span></>
                      : <span className="text-lg">${lineTotal.toFixed(2)}</span>
                    }
                  </p>
                </div>
                <button
                  onClick={() => selectedProposal && selectedBlock && onConfirm(selectedProposal, selectedBlock)}
                  className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold text-sm text-[#000418] hover:brightness-110 transition-all shadow-lg"
                  style={{ backgroundColor: color, boxShadow: `0 10px 25px ${color}40` }}
                >
                  Continue →
                </button>
              </div>
            ) : (
              <p className="text-white/30 text-sm text-center">Select a time slot above</p>
            )}
          </div>
        </>
      )}

      <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors block mx-auto">
        ← Back
      </button>
    </div>
  );
}

// ── Quantity Picker ─────────────────────────────────────────────────────────

function QuantityPicker({
  max,
  value,
  onChange,
  onConfirm,
  onBack,
  color,
  label,
}: {
  max: number;
  value: number;
  onChange: (q: number) => void;
  onConfirm: () => void;
  onBack: () => void;
  color: string;
  label: string;
}) {
  return (
    <div className="space-y-6 max-w-sm mx-auto">
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-2">How Many {label}?</h2>
        <p className="text-white/40 text-xs">Up to {max}</p>
      </div>

      <div className="flex items-center justify-center gap-4">
        <button
          onClick={() => value > 1 && onChange(value - 1)}
          disabled={value <= 1}
          className="w-14 h-14 rounded-xl border border-white/15 bg-white/5 text-white text-2xl font-bold hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
        >
          -
        </button>
        <div className="w-20 text-center">
          <span className="text-5xl font-display text-white">{value}</span>
        </div>
        <button
          onClick={() => value < max && onChange(value + 1)}
          disabled={value >= max}
          className="w-14 h-14 rounded-xl border border-white/15 bg-white/5 text-white text-2xl font-bold hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
        >
          +
        </button>
      </div>

      <div className="flex items-center justify-between gap-4 pt-4">
        <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors">
          ← Back
        </button>
        <button
          onClick={onConfirm}
          className="inline-flex items-center gap-2 px-8 py-3 rounded-xl font-bold text-sm text-[#000418] hover:brightness-110 transition-all shadow-lg"
          style={{ backgroundColor: color, boxShadow: `0 10px 25px ${color}40` }}
        >
          Continue →
        </button>
      </div>
    </div>
  );
}

// ── Review & Pay ────────────────────────────────────────────────────────────

type ReviewState =
  | { status: "idle" }
  | { status: "booking" }
  | { status: "booked"; orderId: string; total: number; subtotal: number; tax: number; lines: { name: string; quantity: number; amount: number; credit?: number; time?: string | null }[]; creditsApplied?: number }
  | { status: "card-form"; orderId: string; total: number; subtotal: number; tax: number; lines: { name: string; quantity: number; amount: number; credit?: number; time?: string | null }[]; creditsApplied?: number }
  | { status: "error"; message: string };

function ReviewStep({
  booking,
  config,
  contact,
  onBack,
  color,
}: {
  booking: BookingState;
  config: AttractionConfig;
  contact: ContactInfo;
  onBack: () => void;
  color: string;
}) {
  const [state, setState] = useState<ReviewState>({ status: "idle" });
  const effectRan = useRef(false);

  useEffect(() => {
    if (effectRan.current) return;
    effectRan.current = true;
    runBooking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runBooking() {
    if (!booking.orderId) {
      setState({ status: "error", message: "No booking found" });
      return;
    }
    setState({ status: "booking" });

    try {
      const orderId = booking.orderId;

      // Resolve clientKey for Naples
      const ck = getBookingClientKey();

      // 1. Register contact person on the bill
      const regQs = new URLSearchParams({ endpoint: "person/registerContactPerson", ...(ck ? { clientKey: ck } : {}) });
      const regBody = JSON.stringify({
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        phone: contact.phone.replace(/\D/g, ""),
      });
      const rawRegJson = `{"orderId":${orderId},` + regBody.slice(1);
      await fetch(`/api/bmi?${regQs.toString()}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rawRegJson,
      });

      // 2. Get bill overview — shows ALL items on the bill (attractions + races)
      const smsOverviewQs = ck ? `endpoint=bill%2Foverview&billId=${orderId}&clientKey=${ck}` : `endpoint=bill%2Foverview&billId=${orderId}`;
      const overviewRes = await fetch(`/api/sms?${smsOverviewQs}`);
      const overview = await overviewRes.json();

      const cashTotal = overview.total?.find((t: { depositKind: number }) => t.depositKind === 0);
      const creditTotals = (overview.total || []).filter((t: { depositKind: number }) => t.depositKind === 2);
      const totalCredits = creditTotals.reduce((s: number, t: { amount: number }) => s + Math.abs(t.amount), 0);
      const cashSub = overview.subTotal?.find((t: { depositKind: number }) => t.depositKind === 0);
      const cashTax = overview.totalTax?.find((t: { depositKind: number }) => t.depositKind === 0);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lines = (overview.lines || []).map((l: any) => {
        const cashPrice = l.totalPrice?.find((p: { depositKind: number }) => p.depositKind === 0);
        const creditPrice = l.totalPrice?.find((p: { depositKind: number }) => p.depositKind === 2);
        const lineTime = l.scheduledTime?.start || l.schedules?.[0]?.start;
        return {
          name: l.name,
          quantity: l.quantity,
          amount: cashPrice?.amount ?? 0,
          credit: creditPrice ? Math.abs(creditPrice.amount) : 0,
          time: lineTime || null,
        };
      });

      setState({
        status: "booked",
        orderId,
        total: cashTotal?.amount ?? 0,
        subtotal: cashSub?.amount ?? 0,
        tax: cashTax?.amount ?? 0,
        lines,
        creditsApplied: totalCredits,
      });
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Failed to load order" });
    }
  }

  async function handlePay() {
    if (state.status !== "booked") return;

    try {
      const { orderId, total, subtotal, tax, lines, creditsApplied } = state;

      // Store booking details in Redis for confirmation page
      const bookingDetails = {
        billId: orderId,
        amount: total.toFixed(2),
        attraction: config.slug,
        name: `${contact.firstName} ${contact.lastName}`,
        email: contact.email,
        phone: contact.phone,
        date: booking.date,
        isCreditOrder: "false",
        smsOptIn: contact.smsOptIn ? "true" : "false",
      };
      await fetch("/api/booking-store", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bookingDetails),
      });
      localStorage.setItem(`booking_${orderId}`, JSON.stringify(bookingDetails));

      // Transition to card form
      setState({ status: "card-form", orderId, total, subtotal, tax, lines, creditsApplied });
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Payment failed" });
    }
  }

  function handlePaymentSuccess(result: PaymentResult) {
    const orderId = state.status === "card-form" ? state.orderId : "";
    // Store payment details for confirmation page
    sessionStorage.setItem(`payment_${orderId}`, JSON.stringify({
      cardBrand: result.cardBrand,
      cardLast4: result.cardLast4,
      amount: result.amount,
      paymentId: result.paymentId,
    }));
    window.location.href = `/book/confirmation?billId=${orderId}`;
  }

  function handlePaymentError(error: string) {
    setState({ status: "error", message: error });
  }

  function handlePaymentCancel() {
    if (state.status === "card-form") {
      const { orderId, total, subtotal, tax, lines, creditsApplied } = state;
      setState({ status: "booked", orderId, total, subtotal, tax, lines, creditsApplied });
    }
  }

  // Loading
  if (state.status === "idle" || state.status === "booking") {
    return (
      <div className="min-h-[400px] flex flex-col items-center justify-center gap-4">
        <div className="w-10 h-10 border-2 border-white/20 rounded-full animate-spin" style={{ borderTopColor: color }} />
        <p className="text-white/60 text-sm">Reserving your spot...</p>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="min-h-[300px] flex flex-col items-center justify-center gap-4">
        <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center">
          <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <p className="text-red-400 text-sm text-center">{state.message}</p>
        <button onClick={onBack} className="text-xs text-white/50 hover:text-white underline">Go back</button>
      </div>
    );
  }

  if (state.status === "card-form") {
    return (
      <PaymentForm
        amount={state.total}
        itemName={config.name}
        billId={state.orderId}
        contact={{
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          phone: contact.phone,
        }}
        locationId={getBookingLocation() || booking.location || undefined}
        onSuccess={handlePaymentSuccess}
        onError={handlePaymentError}
        onCancel={handlePaymentCancel}
      />
    );
  }

  // Booked — show summary + pay button
  const { orderId: bookedOrderId, total: bmiTotal, subtotal: bmiSubtotal, tax: bmiTax, lines } = state;

  return (
    <div className="space-y-6 max-w-md mx-auto">
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-2">Review & Pay</h2>
        <p className="text-white/50 text-sm">Confirm your booking details below.</p>
      </div>

      {/* Line items */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
        <div className="p-4 sm:p-5 space-y-3">
          {/* Date & time */}
          <div className="flex items-center gap-3 pb-3 border-b border-white/8">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${color}15` }}>
              <svg className="w-5 h-5" style={{ color }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <path d="M16 2v4M8 2v4M3 10h18" />
              </svg>
            </div>
            <div>
              <p className="text-white text-sm font-medium">{booking.date ? formatDate(booking.date) : ""}</p>
              <p className="text-white/40 text-xs">
                {booking.time?.block.start ? formatTime(booking.time.block.start) : ""}
                {booking.time?.block.stop ? ` — ${formatTime(booking.time.block.stop)}` : ""}
              </p>
            </div>
          </div>

          {/* Items — all items from the bill (attractions + races if shared) */}
          {lines.map((line, i) => (
            <div key={i} className="flex items-center justify-between py-1.5">
              <div>
                <p className="text-white text-sm">{line.name}{line.quantity > 1 ? ` x${line.quantity}` : ""}</p>
                {line.time && <p className="text-white/30 text-xs">{formatTime(line.time)}</p>}
              </div>
              <p className="text-white font-semibold text-sm">
                {line.credit && line.credit > 0 ? <span className="text-green-400">Credit</span> : `$${line.amount.toFixed(2)}`}
              </p>
            </div>
          ))}
        </div>

        {/* Totals */}
        <div className="border-t border-white/8 p-4 sm:p-5 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-white/50">Subtotal</span>
            <span className="text-white">${bmiSubtotal.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-white/50">Tax</span>
            <span className="text-white">${bmiTax.toFixed(2)}</span>
          </div>
          {state.creditsApplied && state.creditsApplied > 0 ? (
            <>
              <div className="flex justify-between text-sm">
                <span className="text-green-400">Credits Applied</span>
                <span className="text-green-400">-{state.creditsApplied} credit{state.creditsApplied !== 1 ? "s" : ""}</span>
              </div>
              <div className="flex justify-between text-base font-bold pt-2 border-t border-white/8">
                <span className="text-white">Amount Due</span>
                <span style={{ color }}>${bmiTotal.toFixed(2)}</span>
              </div>
            </>
          ) : (
            <div className="flex justify-between text-base font-bold pt-2 border-t border-white/8">
              <span className="text-white">Total</span>
              <span style={{ color }}>${bmiTotal.toFixed(2)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Contact summary */}
      <div className="rounded-xl border border-white/8 bg-white/3 p-4 text-xs text-white/40 leading-relaxed">
        Confirmation will be sent to <span className="text-white/70">{contact.email}</span>.
        Payment handled securely by Square.
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between gap-4">
        <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors">
          ← Back
        </button>
        <button
          onClick={handlePay}
          className="inline-flex items-center gap-2 px-8 py-3.5 rounded-xl font-bold text-sm text-[#000418] hover:brightness-110 transition-all shadow-lg"
          style={{ backgroundColor: color, boxShadow: `0 10px 25px ${color}40` }}
        >
          Pay ${bmiTotal.toFixed(2)} →
        </button>
      </div>
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────

export function AttractionBookingCore({ navComponent }: { navComponent?: React.ReactNode }) {
  const params = useParams();
  const router = useRouter();
  const slug = params.attraction as string;
  const config = ATTRACTIONS[slug] as AttractionConfig | undefined;
  if (!navComponent) navComponent = <BrandNav />;

  // Resolve location: URL param > sessionStorage > hostname > config default
  // URL param takes absolute priority (Naples links pass ?location=naples)
  // Accepts friendly aliases: ?location=fort-myers, ?location=naples, etc.
  const urlLoc = typeof window !== "undefined"
    ? normalizeLocationSlug(new URLSearchParams(window.location.search).get("location"))
    : null;
  const validUrlLoc = urlLoc && config?.products.some(p => p.location === urlLoc) ? urlLoc : null;
  const storedLoc = getBookingLocation();
  const validStoredLoc = !validUrlLoc && storedLoc && config?.products.some(p => p.location === storedLoc) ? storedLoc : null;
  const hostDefault = typeof window !== "undefined"
    ? window.location.hostname.includes("headpinz") ? "headpinz" as LocationKey
    : window.location.hostname.includes("fasttrax") ? "fasttrax" as LocationKey
    : null
    : null;
  const hostLoc = hostDefault && config?.products.some(p => p.location === hostDefault) ? hostDefault : null;
  const initialLocation = validUrlLoc || validStoredLoc || hostLoc || (config && config.location !== "both" ? config.location as LocationKey : null);
  // Persist resolved location to sessionStorage so other pages can read it
  if (initialLocation && typeof window !== "undefined") setBookingLocation(initialLocation);
  const initialStep = initialLocation ? "product" : (config?.location === "both" ? "location" : "product");
  const [step, setStep] = useState<Step>(initialStep);
  const [booking, setBooking] = useState<BookingState>({
    location: initialLocation,
    product: null,
    date: null,
    time: null,
    quantity: 1,
    contact: null,
    orderId: null,
    billLineId: null,
  });
  const [cartItems, setCartItems] = useState<CartItem[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(sessionStorage.getItem("attractionCart") || "[]"); } catch { return []; }
  });
  const contentRef = useRef<HTMLDivElement>(null);

  // Persist cart + orderId to sessionStorage
  useEffect(() => {
    sessionStorage.setItem("attractionCart", JSON.stringify(cartItems));
  }, [cartItems]);

  // Restore orderId from cart if returning from /book
  useEffect(() => {
    if (!booking.orderId && cartItems.length > 0) {
      const storedOrderId = sessionStorage.getItem("attractionOrderId");
      if (storedOrderId) setBooking(prev => ({ ...prev, orderId: storedOrderId }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll to top only on forward step transitions (not re-renders)
  const prevStep = useRef(step);
  useEffect(() => {
    if (step !== prevStep.current) {
      prevStep.current = step;
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [step]);

  // Set initial step and location when config becomes available (useParams may be async).
  // CRITICAL: don't overwrite a location that was already resolved from URL param /
  // sessionStorage / hostname — that's why we computed `initialLocation` above.
  useEffect(() => {
    if (!config) return;
    if (config.location === "both") {
      // Only show the picker if we couldn't resolve a location from URL/storage/hostname
      if (!booking.location) setStep("location");
      else setStep("product");
    } else {
      setBooking(prev => ({ ...prev, location: config.location as LocationKey }));
      setStep("product");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.slug]);

  // Compute products from static config (no API fetch needed — prices are fixed)
  // Use effective location: booking.location, or auto-detect for single-location attractions
  const effectiveLocation = booking.location || (config && config.location !== "both" ? config.location as LocationKey : null);
  const clientKey = getBookingClientKey();
  const products: AttractionProduct[] = config && effectiveLocation
    ? config.products
        .filter(p => p.location === effectiveLocation)
        .map(p => ({
          productId: p.productId,
          pageId: config.pageIds[effectiveLocation!] || "",
          name: p.name,
          attraction: config.slug,
          location: p.location,
          price: p.price,
          bookingMode: config.bookingMode,
          maxAmount: p.maxPerBooking,
          durationMin: p.durationMin,
          isCombo: p.isCombo,
          raw: {} as AttractionProduct["raw"],
        } as AttractionProduct))
    : [];
  const productsLoading = false;

  // 404 for invalid slugs
  if (!config) {
    return (
      <div className="min-h-screen bg-[#000418] flex flex-col items-center justify-center">
        {navComponent}
        <h1 className="text-3xl font-display text-white uppercase tracking-widest mb-4">Not Found</h1>
        <p className="text-white/50 mb-6">This attraction doesn't exist.</p>
        <Link href="/book" className="text-[#00E2E5] hover:underline text-sm">
          ← Browse all experiences
        </Link>
      </div>
    );
  }

  // Don't show racing here — it has its own dedicated flow
  if (config.slug === "racing") {
    router.replace("/book/race");
    return null;
  }

  const color = config.color;

  // Build step list dynamically based on config
  const stepList: { key: Step; label: string }[] = [];
  if (config.location === "both") stepList.push({ key: "location", label: "Location" });
  stepList.push({ key: "product", label: "Package" });
  // For per-person attractions, quantity comes before date (BMI needs qty for availability)
  if (config.bookingMode === "per-person") {
    stepList.push({ key: "quantity", label: "Party" });
  }
  stepList.push({ key: "date", label: "Date" });
  stepList.push({ key: "time", label: "Time" });
  stepList.push({ key: "cart", label: "Cart" });
  stepList.push({ key: "contact", label: "Details" });
  stepList.push({ key: "review", label: "Pay" });

  // Navigation helpers
  function goBack() {
    const currentIdx = stepList.findIndex(s => s.key === step);
    if (currentIdx > 0) {
      setStep(stepList[currentIdx - 1].key);
    } else {
      window.location.href = "/book";
    }
  }

  function goNext() {
    const currentIdx = stepList.findIndex(s => s.key === step);
    if (currentIdx < stepList.length - 1) setStep(stepList[currentIdx + 1].key);
  }

  function nextStepAfter(current: Step): Step {
    const currentIdx = stepList.findIndex(s => s.key === current);
    return stepList[currentIdx + 1]?.key || "review";
  }

  // Handlers
  function handleLocationSelect(loc: LocationKey) {
    setBookingLocation(loc);
    setBooking(prev => ({ ...prev, location: loc, product: null, date: null, time: null }));
    setStep(nextStepAfter("location"));
  }

  function handleProductSelect(product: AttractionProduct) {
    setBooking(prev => ({ ...prev, product, date: null, time: null }));
    setStep(nextStepAfter("product"));
  }

  // Auto-select product for single-product attractions (Gel Blaster, Laser Tag)
  useEffect(() => {
    if (step === "product" && products.length === 1 && !booking.product) {
      handleProductSelect(products[0]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, products.length, booking.product]);

  function handleQuantityConfirm() {
    setStep(nextStepAfter("quantity"));
  }

  function handleDateSelect(date: string) {
    setBooking(prev => ({ ...prev, date, time: null }));
    setStep(nextStepAfter("date"));
  }

  async function handleTimeConfirm(proposal: BmiProposal, block: BmiBlock) {
    if (!booking.product || !config) return;
    setBooking(prev => ({ ...prev, time: { proposal, block } }));

    try {
      // Book the attraction in BMI
      const { rawOrderId, billLineId } = await bookAttractionSlot(
        booking.product.productId,
        booking.quantity,
        proposal,
        booking.orderId,
        null,
        clientKey,
      );
      const newOrderId = booking.orderId || rawOrderId;
      setBooking(prev => ({ ...prev, orderId: newOrderId, billLineId }));
      sessionStorage.setItem("attractionOrderId", newOrderId);

      // Add to cart
      setCartItems(prev => [...prev, {
        attraction: config.slug,
        attractionName: config.shortName,
        product: booking.product!,
        date: booking.date!,
        time: { proposal, block },
        quantity: booking.quantity,
        billLineId,
        color: config.color,
      }]);

      setStep("cart");
    } catch (err) {
      console.error("[handleTimeConfirm] booking failed:", err);
      alert("Failed to reserve. Please try again.");
    }
  }

  function handleContactSubmit(contact: ContactInfo) {
    setBooking(prev => ({ ...prev, contact }));
    setStep("review");
  }

  return (
    <div className="min-h-screen bg-[#000418]">
      {navComponent}

      {/* Hero */}
      <section className="relative pt-32 sm:pt-36 pb-4 px-4">
        <div className="absolute inset-0 overflow-hidden">
          <Image
            src={config.heroImage}
            alt={config.name}
            fill
            className="object-cover opacity-15 blur-sm"
            priority
          />
          <div className="absolute inset-0 bg-gradient-to-b from-[#000418]/60 via-[#000418]/80 to-[#000418]" />
        </div>
        <div className="relative max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5 mb-4">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
            <span className="text-white/60 text-xs font-medium">{LOCATION_INFO[(getBookingLocation() || booking.location) as LocationKey]?.name || config.building}</span>
          </div>
          <h1 className="font-display text-2xl sm:text-4xl text-white uppercase tracking-widest mb-2">
            {config.name}
          </h1>
          <p className="text-white/50 text-sm max-w-md mx-auto">{config.description}</p>
        </div>
      </section>

      {/* Step indicator */}
      <section className="py-4 sm:py-6 px-4">
        <div className="max-w-3xl mx-auto">
          <StepIndicator steps={stepList} current={step} color={color} />
        </div>
      </section>

      {/* Content */}
      <section ref={contentRef} className="px-4 pb-20 sm:pb-28">
        <div className="max-w-3xl mx-auto">

          {/* Location step */}
          {step === "location" && (
            <LocationPicker config={config} onSelect={handleLocationSelect} onBack={goBack} color={color} />
          )}

          {/* Product step */}
          {step === "product" && (
            <ProductPickerStep
              products={products}
              loading={productsLoading}
              onSelect={handleProductSelect}
              onBack={goBack}
              color={color}
              attractionName={config.name}
            />
          )}

          {/* Quantity step (per-person attractions) */}
          {step === "quantity" && (
            <QuantityPicker
              max={config.maxGroupSize}
              value={booking.quantity}
              onChange={q => setBooking(prev => ({ ...prev, quantity: q }))}
              onConfirm={handleQuantityConfirm}
              onBack={goBack}
              color={color}
              label="People"
            />
          )}

          {/* Date step */}
          {step === "date" && booking.product && (
            <AttractionDatePicker
              productId={booking.product.productId}
              selected={booking.date}
              onSelect={handleDateSelect}
              onBack={goBack}
              clientKey={clientKey}
            />
          )}

          {/* Time step */}
          {step === "time" && booking.product && booking.date && (
            <TimeSlotPicker
              product={booking.product}
              date={booking.date}
              quantity={booking.quantity}
              onConfirm={handleTimeConfirm}
              onBack={goBack}
              color={color}
              clientKey={clientKey}
            />
          )}

          {/* Cart step — shows what's been booked, offers to add more */}
          {step === "cart" && (
            <div className="space-y-6 max-w-lg mx-auto">
              <div className="text-center">
                <div className="w-14 h-14 rounded-full bg-green-500/20 border-2 border-green-500/50 flex items-center justify-center mx-auto mb-3">
                  <svg className="w-7 h-7 text-green-400" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-1">Added to Cart!</h2>
                <p className="text-white/50 text-sm">Your spot is reserved. Add more or continue to checkout.</p>
              </div>

              {/* Cart items */}
              <div className="space-y-2">
                {cartItems.map((item, i) => (
                  <div key={i} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }} />
                          <span className="text-white font-semibold text-sm">{item.attractionName}</span>
                        </div>
                        <p className="text-white/40 text-xs mt-1">
                          {item.product.name} &middot; {formatTime(item.time.block.start)}
                          {item.quantity > 1 && ` &middot; ${item.quantity} ${item.product.bookingMode === "per-person" ? "people" : "tables"}`}
                        </p>
                        <p className="text-white/30 text-xs">{formatDate(item.date)}</p>
                      </div>
                      <span className="text-white font-bold">${(item.product.price * item.quantity).toFixed(2)}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Subtotal */}
              <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="flex justify-between text-sm">
                  <span className="text-white/60">Subtotal</span>
                  <span className="text-white font-bold">${cartItems.reduce((s, item) => s + item.product.price * item.quantity, 0).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm mt-1">
                  <span className="text-white/60">Tax</span>
                  <span className="text-white">${calculateTax(cartItems.reduce((s, item) => s + item.product.price * item.quantity, 0)).toFixed(2)}</span>
                </div>
                <div className="border-t border-white/10 mt-2 pt-2 flex justify-between font-bold">
                  <span className="text-white">Total</span>
                  <span style={{ color }}>${calculateTotal(cartItems.reduce((s, item) => s + item.product.price * item.quantity, 0)).toFixed(2)}</span>
                </div>
              </div>

              {/* Actions */}
              <div className="space-y-3">
                <a
                  href="/book/checkout"
                  onClick={() => sessionStorage.setItem("checkoutReturnPath", `/book/${config.slug}`)}
                  className="w-full py-4 rounded-xl font-bold text-base text-[#000418] transition-colors shadow-lg text-center block"
                  style={{ backgroundColor: color }}
                >
                  Continue to Checkout →
                </a>
                <a
                  href="/book"
                  className="w-full py-3 rounded-xl border border-white/15 text-white/60 hover:border-white/30 hover:text-white text-sm font-semibold transition-colors text-center block"
                >
                  + Add Another Activity
                </a>
              </div>

              {/* Cross-sell cards */}
              <div>
                <p className="text-white/30 text-xs uppercase tracking-wider mb-3">Add to your visit</p>
                <div className="grid grid-cols-2 gap-2">
                  {ATTRACTION_LIST
                    .filter(a => a.slug !== config.slug)
                    .filter(a => !booking.location || a.products.some(p => p.location === booking.location) || a.location === booking.location)
                    .slice(0, 6)
                    .map(a => {
                      const loc = booking.location || effectiveLocation;
                      const href = a.slug === "racing" ? "/book/race" : `/book/${a.slug}${loc ? `?location=${loc}` : ""}`;
                      const locName = loc ? LOCATION_INFO[loc]?.name : a.building;
                      return (
                        <a
                          key={a.slug}
                          href={href}
                          className="rounded-lg border border-white/10 bg-white/[0.03] p-3 hover:border-white/20 hover:bg-white/[0.06] transition-all text-center"
                        >
                          <p className="text-white font-semibold text-xs">{a.shortName}</p>
                          <p className="text-white/30 text-xs mt-0.5">{a.durationLabel}</p>
                          <p className="text-white/20 text-[10px] mt-0.5">{locName}</p>
                        </a>
                      );
                    })}
                </div>
              </div>
            </div>
          )}

          {/* Contact step */}
          {step === "contact" && (
            <ContactForm
              initial={booking.contact}
              onSubmit={handleContactSubmit}
              onBack={goBack}
            />
          )}

          {/* Review & Pay step */}
          {step === "review" && booking.contact && (
            <ReviewStep
              booking={booking}
              config={config}
              contact={booking.contact}
              onBack={goBack}
              color={color}
            />
          )}
        </div>
      </section>
    </div>
  );
}

export default function AttractionBookingPage() {
  return <AttractionBookingCore />;
}
