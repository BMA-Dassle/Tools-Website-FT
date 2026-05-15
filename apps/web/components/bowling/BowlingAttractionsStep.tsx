"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ATTRACTIONS,
  type AttractionSlug,
  type AttractionConfig,
  type BmiProposal,
  type BmiBlock,
  bookAttractionSlot,
} from "@/lib/attractions-data";

// ── Design tokens (mirrored from BowlingWizard) ────────────────────────────
const CORAL = "#fd5b56";

// ── Attraction configs for the bowling add-on step ─────────────────────────
// Only gel blaster and laser tag — the two session-based per-person
// attractions available at both HeadPinz locations.
const ADDON_ATTRACTIONS: { slug: AttractionSlug; config: AttractionConfig }[] = [
  { slug: "laser-tag", config: ATTRACTIONS["laser-tag"] },
  { slug: "gel-blaster", config: ATTRACTIONS["gel-blaster"] },
];

// Square catalog variation IDs for attraction line items on the day-of order.
// Shared across HeadPinz Fort Myers and Naples (enabled at both locations).
const ATTRACTION_CATALOG_IDS: Record<string, string> = {
  "laser-tag": "TXNWQI43HNMX2EHP72ZPUVXU",
  "gel-blaster": "IPAKRTMOYX37ATF7UBJCXQSP",
};

// ── Types ──────────────────────────────────────────────────────────────────

export interface AttractionAddon {
  slug: AttractionSlug;
  name: string;
  productId: string; // BMI product ID (string — NEVER Number())
  pageId: string;
  quantity: number;
  proposal: BmiProposal;
  block: BmiBlock;
  bmiOrderId: string | null; // raw BMI order ID (string for precision)
  bmiBillLineId: string | null;
  squareCatalogObjectId: string | null; // Square catalog variation ID for day-of order line item
  pricePerPerson: number; // dollars
  totalPrice: number; // dollars
  color: string;
  timeLabel: string; // formatted time for display
}

interface Props {
  /** Bowling center location key */
  locationKey: "headpinz" | "naples";
  /** BMI client key for the location (undefined = default / Fort Myers) */
  bmiClientKey: string | undefined;
  /** Bowling date in YYYY-MM-DD format */
  date: string;
  /** Number of bowlers (default quantity for attractions) */
  playerCount: number;
  /** Currently booked attraction add-ons */
  addons: AttractionAddon[];
  /** Callback when addons change */
  onAddonsChange: (addons: AttractionAddon[]) => void;
  /** Navigate to next step */
  onContinue: () => void;
  /** Navigate to previous step */
  onBack: () => void;
  /** Bowling start time (ISO string from QAMF slot `bookedAt`) */
  bowlingStartIso?: string;
  /** Bowling session duration in minutes (derived from experience kind + duration option) */
  bowlingDurationMinutes?: number;
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
  return parseLocal(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDate(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function spotsLabel(free: number, capacity: number) {
  if (free === 0) return { text: "text-red-400", label: "Full" };
  if (free / capacity <= 0.3)
    return { text: "text-amber-400", label: `${free} spot${free === 1 ? "" : "s"} left` };
  return { text: "text-emerald-400", label: `${free} of ${capacity} open` };
}

// ── Component ──────────────────────────────────────────────────────────────

// ── Bowling window helper ─────────────────────────────────────────────────
// Returns true if an attraction slot overlaps with the bowling session.
// Rule: block slots from (bowlingStart − 15 min) through bowlingEnd (inclusive).
// First available attraction slot is 15 min after bowling ends.
function isBlockedByBowling(
  slotStartIso: string,
  bowlingStartIso: string | undefined,
  bowlingDurationMinutes: number | undefined,
): boolean {
  if (!bowlingStartIso || !bowlingDurationMinutes) return false;
  const slotMs = parseLocal(slotStartIso).getTime();
  const bowlStartMs = parseLocal(bowlingStartIso).getTime();
  const bowlEndMs = bowlStartMs + bowlingDurationMinutes * 60_000;
  // Block from 15 min before bowling start through bowling end
  return slotMs >= bowlStartMs - 15 * 60_000 && slotMs <= bowlEndMs;
}

export default function BowlingAttractionsStep({
  locationKey,
  bmiClientKey,
  date,
  playerCount,
  addons,
  onAddonsChange,
  onContinue,
  onBack,
  bowlingStartIso,
  bowlingDurationMinutes: bowlDurationMin,
}: Props) {
  type SubStep = "browse" | "time";
  const [subStep, setSubStep] = useState<SubStep>("browse");
  const [pickingSlug, setPickingSlug] = useState<AttractionSlug | null>(null);
  const [pickingQty, setPickingQty] = useState(playerCount);

  // Time slot state
  const [proposals, setProposals] = useState<BmiProposal[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [booking, setBooking] = useState(false);
  const ctaRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to CTA when a time slot is selected
  useEffect(() => {
    if (selectedIdx !== null) {
      setTimeout(() => ctaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  }, [selectedIdx]);

  // ── Resolve attraction product for the current center ────────────────
  const getProduct = useCallback(
    (slug: AttractionSlug) => {
      const config = ATTRACTIONS[slug];
      if (!config) return null;
      const product = config.products.find((p) => p.location === locationKey);
      return product
        ? {
            productId: String(product.productId),
            pageId: config.pageIds[locationKey] ?? "",
            price: product.price,
          }
        : null;
    },
    [locationKey],
  );

  // ── Fetch time slots from BMI dayplanner ──────────────────────────────
  const fetchSlots = useCallback(
    async (slug: AttractionSlug, qty: number) => {
      const product = getProduct(slug);
      if (!product) return;

      setSlotsLoading(true);
      setSlotsError(null);
      setSelectedIdx(null);
      setProposals([]);

      try {
        const dateOnly = date.split("T")[0];
        const [y, m, d] = dateOnly.split("-").map(Number);
        const dayOfWeek = new Date(y, m - 1, d).getDay();
        const startHours =
          dayOfWeek === 0 || dayOfWeek === 6 ? [10, 12, 14, 16, 18, 20, 22] : [14, 16, 18, 20, 22];

        const smsBase = bmiClientKey
          ? `/api/sms?endpoint=dayplanner%2Fdayplanner&clientKey=${bmiClientKey}`
          : "/api/sms?endpoint=dayplanner%2Fdayplanner";

        const allProposals: BmiProposal[] = [];
        const seen = new Set<string>();

        for (const hour of startHours) {
          const h = String(hour).padStart(2, "0");
          try {
            const batch: BmiProposal[] = await fetch(smsBase, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                productId: product.productId,
                pageId: product.pageId,
                quantity: qty,
                dynamicLines: null,
                date: `${dateOnly}T${h}:00:00.000Z`,
              }),
            })
              .then((r) => {
                if (!r.ok) throw new Error("Failed");
                return r.json();
              })
              .then((d) => d.proposals || []);

            for (const p of batch) {
              const key = p.blocks?.[0]?.block?.start;
              if (key && !seen.has(key)) {
                seen.add(key);
                allProposals.push(p);
              }
            }
          } catch {
            /* skip failed batch */
          }
        }

        allProposals.sort((a, b) => {
          const aStart = a.blocks?.[0]?.block?.start || "";
          const bStart = b.blocks?.[0]?.block?.start || "";
          return aStart.localeCompare(bStart);
        });

        setProposals(allProposals);
      } catch {
        setSlotsError("Couldn't load time slots. Please try again.");
      } finally {
        setSlotsLoading(false);
      }
    },
    [date, bmiClientKey, getProduct],
  );

  // ── Start picking an attraction ────────────────────────────────────────
  const startPicking = useCallback(
    (slug: AttractionSlug) => {
      setPickingSlug(slug);
      setPickingQty(playerCount);
      setSubStep("time");
      void fetchSlots(slug, playerCount);
    },
    [playerCount, fetchSlots],
  );

  // ── Book the attraction on BMI ─────────────────────────────────────────
  const confirmBooking = useCallback(async () => {
    if (selectedIdx === null || !pickingSlug) return;

    const proposal = proposals[selectedIdx];
    const block = proposal?.blocks?.[0]?.block;
    if (!proposal || !block) return;

    const product = getProduct(pickingSlug);
    if (!product) return;

    setBooking(true);
    try {
      // Chain onto existing BMI order if we already booked an attraction
      const existingOrderId = addons[0]?.bmiOrderId ?? null;

      const { rawOrderId, billLineId } = await bookAttractionSlot(
        product.productId,
        pickingQty,
        proposal,
        existingOrderId,
        null, // personId
        bmiClientKey,
      );

      // Dayplanner returns total price for the requested quantity
      const blockTotalPrice = block.prices?.find((p) => p.depositKind === 0)?.amount;
      const perPersonPrice =
        blockTotalPrice != null && pickingQty > 0 ? blockTotalPrice / pickingQty : product.price;
      const totalPrice = blockTotalPrice != null ? blockTotalPrice : product.price * pickingQty;

      const config = ATTRACTIONS[pickingSlug];

      const newAddon: AttractionAddon = {
        slug: pickingSlug,
        name: config?.shortName ?? pickingSlug,
        productId: product.productId,
        pageId: product.pageId,
        quantity: pickingQty,
        proposal,
        block,
        bmiOrderId: rawOrderId,
        bmiBillLineId: billLineId,
        squareCatalogObjectId: ATTRACTION_CATALOG_IDS[pickingSlug] ?? null,
        pricePerPerson: perPersonPrice,
        totalPrice,
        color: config?.color ?? CORAL,
        timeLabel: formatTime(block.start),
      };

      // Replace if same slug exists, otherwise add
      const updated = addons.filter((a) => a.slug !== pickingSlug);
      updated.push(newAddon);
      onAddonsChange(updated);

      // Back to browse
      setSubStep("browse");
      setPickingSlug(null);
    } catch (err) {
      setSlotsError(err instanceof Error ? err.message : "Booking failed — try a different time.");
    } finally {
      setBooking(false);
    }
  }, [
    selectedIdx,
    pickingSlug,
    pickingQty,
    proposals,
    getProduct,
    addons,
    bmiClientKey,
    onAddonsChange,
  ]);

  // ── Remove an addon ────────────────────────────────────────────────────
  const removeAddon = useCallback(
    (slug: AttractionSlug) => {
      onAddonsChange(addons.filter((a) => a.slug !== slug));
    },
    [addons, onAddonsChange],
  );

  // ── Picking config ─────────────────────────────────────────────────────
  const pickingConfig = pickingSlug ? ATTRACTIONS[pickingSlug] : null;
  const pickingProduct = pickingSlug ? getProduct(pickingSlug) : null;
  const selectedProposal = selectedIdx !== null ? proposals[selectedIdx] : null;
  const selectedBlock = selectedProposal?.blocks?.[0]?.block ?? null;

  // Price for the selected time slot
  const blockTotalPrice = selectedBlock?.prices?.find((p) => p.depositKind === 0)?.amount;
  const perPersonPrice =
    blockTotalPrice != null && pickingQty > 0
      ? blockTotalPrice / pickingQty
      : (pickingProduct?.price ?? 0);
  const lineTotal =
    blockTotalPrice != null ? blockTotalPrice : (pickingProduct?.price ?? 0) * pickingQty;

  // Total for all booked addons
  const addonsTotal = addons.reduce((s, a) => s + a.totalPrice, 0);

  // ── Render ─────────────────────────────────────────────────────────────

  if (subStep === "time" && pickingSlug && pickingConfig) {
    // ── TIME SLOT PICKER ───────────────────────────────────────────────
    return (
      <div className="space-y-5">
        <div className="text-center">
          <h2 className="text-xl sm:text-2xl font-display text-white uppercase tracking-widest mb-1">
            Pick a Time
          </h2>
          <p className="text-white/50 text-sm">
            <span className="text-white/80">{pickingConfig.shortName}</span> · {formatDate(date)}
          </p>
        </div>

        {/* Quantity adjuster */}
        <div className="max-w-xs mx-auto rounded-xl border border-white/8 bg-white/3 p-3">
          <div className="flex items-center justify-between">
            <span className="text-white/50 text-xs">Players</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  const newQty = Math.max(1, pickingQty - 1);
                  setPickingQty(newQty);
                  void fetchSlots(pickingSlug, newQty);
                }}
                disabled={pickingQty <= 1}
                className="w-8 h-8 rounded-full border border-white/20 text-white/60 hover:text-white hover:border-white/40 flex items-center justify-center text-lg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                −
              </button>
              <span className="w-6 text-center text-white font-bold text-base">{pickingQty}</span>
              <button
                type="button"
                onClick={() => {
                  const newQty = Math.min(pickingConfig.maxGroupSize, pickingQty + 1);
                  setPickingQty(newQty);
                  void fetchSlots(pickingSlug, newQty);
                }}
                disabled={pickingQty >= pickingConfig.maxGroupSize}
                className="w-8 h-8 rounded-full border border-white/20 text-white/60 hover:text-white hover:border-white/40 flex items-center justify-center text-lg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                +
              </button>
            </div>
          </div>
        </div>

        {/* Time slots */}
        {slotsLoading ? (
          <div className="h-48 flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-white/20 border-t-white/80 rounded-full animate-spin" />
          </div>
        ) : slotsError ? (
          <div className="h-48 flex flex-col items-center justify-center gap-3">
            <p className="text-red-400 text-sm">{slotsError}</p>
            <button
              type="button"
              onClick={() => void fetchSlots(pickingSlug, pickingQty)}
              className="text-xs text-white/50 hover:text-white underline"
            >
              Retry
            </button>
          </div>
        ) : proposals.length === 0 ? (
          <div className="h-48 flex flex-col items-center justify-center gap-3">
            <p className="text-white/40 text-sm">
              No {pickingConfig.shortName.toLowerCase()} slots available for this date.
            </p>
            <button
              type="button"
              onClick={() => {
                setSubStep("browse");
                setPickingSlug(null);
              }}
              className="text-xs text-white/50 hover:text-white underline"
            >
              Go back
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {proposals.map((proposal, idx) => {
                const block = proposal.blocks?.[0]?.block;
                if (!block) return null;

                const bowlingBlocked = isBlockedByBowling(
                  block.start,
                  bowlingStartIso,
                  bowlDurationMin,
                );
                const isFull = block.freeSpots < pickingQty;
                const isDisabled = isFull || bowlingBlocked;
                const isSelected = selectedIdx === idx;
                const spots = spotsLabel(block.freeSpots, block.capacity);

                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => !isDisabled && setSelectedIdx(idx)}
                    disabled={isDisabled}
                    className={`
                      rounded-xl border p-3 text-left transition-all duration-150
                      ${
                        isSelected
                          ? "border-white/40 bg-white/15 ring-1 ring-white/30"
                          : isDisabled
                            ? "border-white/5 bg-white/3 opacity-40 cursor-not-allowed"
                            : "border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10 cursor-pointer"
                      }
                    `}
                    style={
                      isSelected
                        ? {
                            borderColor: pickingConfig.color,
                            backgroundColor: `${pickingConfig.color}15`,
                            boxShadow: `0 0 0 1px ${pickingConfig.color}50`,
                          }
                        : undefined
                    }
                  >
                    <div className="text-white font-bold text-base mb-0.5">
                      {formatTime(block.start)}
                    </div>
                    <div className="text-white/40 text-xs mb-2">
                      {block.stop ? `→ ${formatTime(block.stop)}` : ""}
                    </div>
                    {bowlingBlocked ? (
                      <>
                        <div className="text-[13px] font-medium text-[#fd5b56]/70">🎳 Bowling</div>
                        <div className="mt-2 h-1 rounded-full bg-[#fd5b56]/30 overflow-hidden">
                          <div className="h-full w-full rounded-full bg-[#fd5b56]/50" />
                        </div>
                      </>
                    ) : (
                      <>
                        <div
                          className={`text-[13px] font-medium ${isFull ? "text-red-400" : spots.text}`}
                        >
                          {isFull ? "Full" : spots.label}
                        </div>
                        <div className="mt-2 h-1 rounded-full bg-white/10 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              isFull
                                ? "bg-red-500"
                                : block.freeSpots / block.capacity <= 0.3
                                  ? "bg-amber-400"
                                  : "bg-emerald-400"
                            }`}
                            style={{
                              width: `${(block.freeSpots / block.capacity) * 100}%`,
                            }}
                          />
                        </div>
                      </>
                    )}
                  </button>
                );
              })}
            </div>

            {/* CTA */}
            <div
              ref={ctaRef}
              className={`rounded-xl border p-4 transition-all duration-300 ${
                selectedBlock ? "border-white/20 bg-white/8" : "border-white/10 bg-white/3"
              }`}
              style={
                selectedBlock
                  ? {
                      borderColor: `${pickingConfig.color}60`,
                      backgroundColor: `${pickingConfig.color}10`,
                    }
                  : undefined
              }
            >
              {selectedBlock ? (
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                  <div>
                    <p className="text-white/50 text-xs mb-1">Selected</p>
                    <p className="text-white font-bold">
                      {pickingConfig.shortName} · {formatTime(selectedBlock.start)}
                    </p>
                    <p
                      className="text-sm font-semibold mt-0.5"
                      style={{ color: pickingConfig.color }}
                    >
                      ${perPersonPrice.toFixed(2)} × {pickingQty} ={" "}
                      <span className="text-lg">${lineTotal.toFixed(2)}</span>
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void confirmBooking()}
                    disabled={booking}
                    className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold text-sm text-[#000418] hover:brightness-110 transition-all shadow-lg disabled:opacity-50"
                    style={{
                      backgroundColor: pickingConfig.color,
                      boxShadow: `0 10px 25px ${pickingConfig.color}40`,
                    }}
                  >
                    {booking ? (
                      <>
                        <div className="w-4 h-4 border-2 border-[#000418]/30 border-t-[#000418] rounded-full animate-spin" />
                        Booking…
                      </>
                    ) : (
                      "Add to Booking →"
                    )}
                  </button>
                </div>
              ) : (
                <p className="text-white/30 text-sm text-center">Select a time slot above</p>
              )}
            </div>
          </>
        )}

        {/* Back button */}
        <button
          type="button"
          onClick={() => {
            setSubStep("browse");
            setPickingSlug(null);
          }}
          className="text-sm text-white/40 hover:text-white/70 transition-colors block mx-auto"
        >
          ← Back to activities
        </button>
      </div>
    );
  }

  // ── BROWSE: Attraction cards ─────────────────────────────────────────
  return (
    <div className="space-y-4">
      <p className="font-body text-white/55 text-sm text-center">
        Add laser tag or gel blasters to your bowling visit
      </p>

      {ADDON_ATTRACTIONS.map(({ slug, config }) => {
        const product = getProduct(slug);
        if (!product) return null; // not available at this center

        const existing = addons.find((a) => a.slug === slug);

        return (
          <div
            key={slug}
            className="rounded-xl overflow-hidden transition-all"
            style={{
              backgroundColor: existing ? `${config.color}10` : "rgba(255,255,255,0.04)",
              border: `1.78px ${existing ? "solid" : "dashed"} ${
                existing ? `${config.color}40` : "rgba(255,255,255,0.10)"
              }`,
            }}
          >
            {/* Card header */}
            <div className="p-4 flex items-center gap-4">
              {/* Color accent bar */}
              <div
                className="w-1 h-14 rounded-full flex-shrink-0"
                style={{ backgroundColor: config.color }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-body font-bold text-white text-sm">{config.shortName}</span>
                  {config.durationLabel && (
                    <span className="text-white/30 text-xs">{config.durationLabel}</span>
                  )}
                </div>
                <div className="font-body text-white/40 text-xs">
                  ${product.price.toFixed(2)} / person
                </div>
              </div>

              {/* Action */}
              {existing ? (
                <div className="flex items-center gap-2 flex-shrink-0">
                  <div className="text-right">
                    <div className="text-xs font-bold" style={{ color: config.color }}>
                      {existing.quantity}p · {existing.timeLabel}
                    </div>
                    <div className="text-xs font-bold text-white/60">
                      ${existing.totalPrice.toFixed(2)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeAddon(slug)}
                    aria-label={`Remove ${config.shortName}`}
                    className="w-8 h-8 rounded-full border border-white/15 text-white/40 hover:text-red-400 hover:border-red-400/40 flex items-center justify-center transition-colors"
                    title="Remove"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => startPicking(slug)}
                  className="px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider transition-all hover:scale-[1.02]"
                  style={{
                    backgroundColor: `${config.color}20`,
                    color: config.color,
                    border: `1px solid ${config.color}40`,
                  }}
                >
                  Add
                </button>
              )}
            </div>

            {/* Booked confirmation strip */}
            {existing && (
              <div
                className="px-4 py-2 flex items-center gap-2"
                style={{
                  backgroundColor: `${config.color}08`,
                  borderTop: `1px solid ${config.color}15`,
                }}
              >
                <svg
                  className="w-4 h-4 flex-shrink-0"
                  style={{ color: config.color }}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-xs text-white/50">
                  Booked for {existing.quantity} at {existing.timeLabel}
                </span>
              </div>
            )}
          </div>
        );
      })}

      {/* Addons total */}
      {addonsTotal > 0 && (
        <div
          className="rounded-xl p-3 text-center"
          style={{ backgroundColor: "rgba(255,255,255,0.04)" }}
        >
          <span className="font-body text-white/50 text-xs">Activities total: </span>
          <span className="font-body font-bold text-white text-sm">${addonsTotal.toFixed(2)}</span>
          <span className="font-body text-white/30 text-xs ml-1">(paid at center)</span>
        </div>
      )}

      {/* Navigation */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 rounded-full px-4 py-3 font-body font-bold text-xs sm:text-sm uppercase tracking-wider text-white/80 border border-white/15"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          className="flex-1 rounded-full px-6 py-3 font-body font-bold text-sm uppercase tracking-wider text-white"
          style={{ backgroundColor: CORAL, boxShadow: `0 0 18px ${CORAL}40` }}
        >
          {addons.length > 0 ? "Continue" : "Skip Activities"}
        </button>
      </div>
    </div>
  );
}
