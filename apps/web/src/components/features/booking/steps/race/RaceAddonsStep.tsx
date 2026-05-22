"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RaceItem, StepDef } from "~/features/booking";

/**
 * Race step — race-day add-ons (Shuffly, Duckpin, Gel Blaster, Laser Tag).
 *
 * v1 parity: full port of `apps/web/app/book/race/components/AddOnsPage.tsx`.
 *
 * Each add-on is a BMI product the customer can attach to the same combined
 * session bill:
 *   - Per-person (Gel Blaster, Laser Tag): qty = racer count by default,
 *     adjustable up/down via stepper
 *   - Per-group (FT Shuffly, Duckpin): qty toggles 0/1
 *
 * When an add-on is added the step fires SMS-Timing dayplanner probes at
 * 2-hour jumps (11/13/15/17/19/21) to enumerate available time slots. Each
 * slot is checked against:
 *   - Race heat conflicts (30-min buffer either side of every booked heat)
 *   - Cross-addon conflicts (same building = 0 buffer / back-to-back OK;
 *     different building = 30-min buffer for travel time)
 *
 * State on RaceItem.addons: `{ id, qty, selectedTime, bmiLineId }[]`.
 * Checkout (commit 10) iterates entries with qty > 0 and BMI sells each
 * line on the combined bill.
 */

const HEADPINZ_LOGO =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/logos/headpinz-logo-9aUwk9v1Z8LcHZP5chi50PnSbDWpSg.png";

type AddonDef = {
  id: string;
  name: string;
  shortName: string;
  description: string;
  price: number;
  image: string;
  perPerson: boolean;
  maxPerGroup?: number;
  color: string;
  location: "fasttrax" | "headpinz";
  discountLabel?: string;
  saveLabel?: string;
};

// Verbatim copy from v1 AddOnsPage.tsx:53-112 — keep in sync if v1 edits.
const ADD_ONS: AddonDef[] = [
  {
    id: "27488020",
    name: "FastTrax Shuffly 1 Hour Combo",
    shortName: "FT Shuffly Combo",
    description:
      "A modern twist on classic shuffleboard with immersive AR effects, automatic scoring, and dynamic LED lighting. Up to 10 players per lane.",
    price: 10,
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/addons/shuffly-Z5qjcBLniaNQKdjQGFI3RfWRwx36HZ.jpg",
    perPerson: false,
    maxPerGroup: 10,
    color: "#E53935",
    location: "fasttrax",
    discountLabel: "OVER 50% OFF",
    saveLabel: "Save now — not available in-center",
  },
  {
    id: "23345635",
    name: "Duckpin Bowling - 1 Hour",
    shortName: "Duckpin",
    description:
      "Fast, fun bowling with smaller pins and lighter balls. No rental shoes required! Perfect for groups between races.",
    price: 35,
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06561.webp",
    perPerson: false,
    maxPerGroup: 6,
    color: "#004AAD",
    location: "fasttrax",
  },
  {
    id: "27488200",
    name: "Nexus Gel Blaster",
    shortName: "Gel Blaster",
    description:
      "Step into a live-action video game! High-tech blasters, glowing environments, and fast-paced team battles using eco-friendly Gellets. Located at HeadPinz next door.",
    price: 10,
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/addons/gelblaster-gtOdWfUsDWYEf72h2aBEytF5GCuZUs.jpg",
    perPerson: true,
    color: "#39FF14",
    location: "headpinz",
    discountLabel: "15%+ OFF",
    saveLabel: "Save now — not available in-center",
  },
  {
    id: "8976685",
    name: "Nexus Laser Tag Arena",
    shortName: "Laser Tag",
    description:
      "Immersive team-based battles with advanced laser blasters and vests in a glowing arena filled with lights, fog, and music. Located at HeadPinz next door.",
    price: 10,
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/addons/lasertag-uMlQDT8COLcGQVEfVyqgjgUOseIZjI.jpg",
    perPerson: true,
    color: "#E53935",
    location: "headpinz",
  },
];

// Shared private add-ons page for dayplanner — v1 AddOnsPage.tsx:203.
const ADDON_PAGE_ID = "42730172";

// Heat duration approximation for race-vs-addon conflict detection. v1 reads
// block.stop from BMI's availability response; v2's RaceHeatAssignment only
// stores heatId (block.start), so we approximate. 30 min is wider than any
// real heat (Red 12 / Blue 15 / Mega 24) so conflict detection errs safe.
const HEAT_DURATION_MS = 30 * 60_000;
const RACE_CONFLICT_BUFFER_MS = 30 * 60_000;
const CROSS_BUILDING_BUFFER_MS = 30 * 60_000;

interface TimeSlot {
  start: string;
  stop: string;
  name: string;
  freeSpots: number;
  capacity: number;
}

function parseLocal(iso: string): Date {
  const clean = iso.replace(/Z$/, "");
  const [datePart, timePart] = clean.split("T");
  if (!timePart) return new Date(clean);
  const [y, m, d] = datePart.split("-").map(Number);
  const [h, min, s] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, h, min, s || 0);
}

function formatTime(iso: string): string {
  return parseLocal(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function bookedHeatsFromItem(
  item: RaceItem,
): Array<{ start: string; stop: string; track: string | null }> {
  // Dedup by heatId (v2 stores one entry per racer × heat).
  const seen = new Set<string>();
  const out: Array<{ start: string; stop: string; track: string | null }> = [];
  for (const h of item.heats) {
    if (!h.heatId || seen.has(h.heatId)) continue;
    seen.add(h.heatId);
    const startMs = parseLocal(h.heatId).getTime();
    out.push({
      start: h.heatId,
      stop: new Date(startMs + HEAT_DURATION_MS).toISOString().replace(/\.\d{3}Z$/, ""),
      track: h.track,
    });
  }
  return out;
}

function conflictsWithRace(
  slotStart: string,
  slotStop: string,
  heats: { start: string; stop: string }[],
): boolean {
  const sStart = parseLocal(slotStart).getTime();
  const sStop = parseLocal(slotStop).getTime();
  return heats.some((h) => {
    const hStart = parseLocal(h.start).getTime();
    const hStop = parseLocal(h.stop).getTime();
    return sStart < hStop + RACE_CONFLICT_BUFFER_MS && sStop > hStart - RACE_CONFLICT_BUFFER_MS;
  });
}

const RaceAddonsStepComponent: StepDef<RaceItem>["Component"] = ({ item, session, onChange }) => {
  const racerCount = Math.max(1, session.party.length);
  const bookedHeats = useMemo(() => bookedHeatsFromItem(item), [item.heats]);

  // Local per-addon UI state — slot lists are derived from network probes.
  const [timeSlots, setTimeSlots] = useState<Record<string, TimeSlot[]>>({});
  const [loadingSlots, setLoadingSlots] = useState<Record<string, boolean>>({});

  // Convenience lookup into item.addons (productId → entry).
  const entryById = useMemo(() => {
    const m = new Map<string, RaceItem["addons"][number]>();
    for (const a of item.addons) m.set(a.id, a);
    return m;
  }, [item.addons]);

  const getQty = (id: string): number => entryById.get(id)?.qty ?? 0;

  const writeEntry = (id: string, patch: Partial<RaceItem["addons"][number]>) => {
    const existing = entryById.get(id);
    const merged = {
      id,
      qty: existing?.qty ?? 0,
      selectedTime: existing?.selectedTime ?? null,
      bmiLineId: existing?.bmiLineId ?? null,
      ...patch,
    };
    const filtered = item.addons.filter((a) => a.id !== id);
    onChange({ addons: [...filtered, merged] });
  };

  const removeEntry = (id: string) => {
    onChange({ addons: item.addons.filter((a) => a.id !== id) });
  };

  const fetchTimeSlots = useCallback(
    async (productId: string, qty: number) => {
      if (!item.date) return;
      setLoadingSlots((p) => ({ ...p, [productId]: true }));
      try {
        const dateOnly = item.date.split("T")[0];
        const allSlots: TimeSlot[] = [];
        const seen = new Set<string>();
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
                pageId: ADDON_PAGE_ID,
                quantity: qty,
                dynamicLines: null,
                date: utcTime,
              }),
            });
            if (!res.ok) continue;
            const data = (await res.json()) as {
              proposals?: Array<{
                blocks?: Array<{ block?: TimeSlot }>;
              }>;
            };
            for (const p of data.proposals ?? []) {
              const block = p.blocks?.[0]?.block;
              if (!block) continue;
              if (seen.has(block.start)) continue;
              seen.add(block.start);
              if (conflictsWithRace(block.start, block.stop, bookedHeats)) continue;
              allSlots.push(block);
            }
          } catch {
            /* skip this hour */
          }
        }
        allSlots.sort((a, b) => a.start.localeCompare(b.start));
        setTimeSlots((p) => ({ ...p, [productId]: allSlots }));
        // Auto-pick the first slot if customer hasn't picked one yet.
        const existing = entryById.get(productId);
        if (allSlots.length > 0 && !existing?.selectedTime) {
          writeEntry(productId, { selectedTime: allSlots[0].start });
        }
      } catch {
        setTimeSlots((p) => ({ ...p, [productId]: [] }));
      } finally {
        setLoadingSlots((p) => ({ ...p, [productId]: false }));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item.date, bookedHeats],
  );

  // Re-fetch any addon whose qty > 0 once on mount (back-nav restore).
  useEffect(() => {
    for (const a of item.addons) {
      if (a.qty > 0 && !timeSlots[a.id] && !loadingSlots[a.id]) {
        fetchTimeSlots(a.id, a.qty);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setQty = (addon: AddonDef, qty: number) => {
    const clamped = Math.max(0, qty);
    if (clamped === 0) {
      removeEntry(addon.id);
      return;
    }
    writeEntry(addon.id, { qty: clamped });
    if (!timeSlots[addon.id] && !loadingSlots[addon.id]) {
      fetchTimeSlots(addon.id, clamped);
    }
  };

  if (!item.date) {
    return (
      <div className="bg-amber-500/8 rounded-xl border border-amber-500/30 p-4 text-sm text-amber-300">
        Pick a date first — add-on times depend on the race day.
      </div>
    );
  }

  const totalCount = item.addons.reduce((sum, a) => sum + a.qty, 0);
  const totalCost = item.addons.reduce((sum, a) => {
    const def = ADD_ONS.find((x) => x.id === a.id);
    if (!def) return sum;
    return sum + def.price * a.qty;
  }, 0);

  return (
    <div className="space-y-8">
      <div className="space-y-2 text-center">
        <h2 className="font-display text-2xl tracking-widest text-white uppercase">
          Level Up Your Visit
        </h2>
        <p className="mx-auto max-w-md text-sm text-white/40">
          Add more fun to your race day. These combos are exclusive to online booking.
        </p>
      </div>

      {bookedHeats.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="mb-2 text-xs font-semibold tracking-wider text-white/40 uppercase">
            Your Race Schedule
          </p>
          <div className="flex flex-wrap gap-2">
            {bookedHeats.map((h, i) => {
              const color =
                h.track === "Red"
                  ? "#E53935"
                  : h.track === "Blue"
                    ? "#004AAD"
                    : h.track === "Mega"
                      ? "#A855F7"
                      : "#00E2E5";
              const display = h.track ?? "Race";
              return (
                <span
                  key={i}
                  className="rounded-full border px-3 py-1 text-xs font-semibold"
                  style={{ borderColor: color, color, backgroundColor: `${color}15` }}
                >
                  🏎️ {formatTime(h.start)} — {display}
                </span>
              );
            })}
          </div>
          <p className="mt-1.5 text-xs text-white/30">
            Pick add-on times that don&apos;t overlap with your races
          </p>
        </div>
      )}

      <div className="grid gap-4">
        {ADD_ONS.map((addon) => {
          const qty = getQty(addon.id);
          const isSelected = qty > 0;
          const priceLabel = addon.perPerson
            ? `$${addon.price}/person`
            : `$${addon.price}${addon.maxPerGroup ? ` (up to ${addon.maxPerGroup} players)` : ""}`;
          return (
            <div
              key={addon.id}
              className={`overflow-hidden rounded-xl border transition-all duration-200 ${
                isSelected
                  ? "border-[#00E2E5]/50 bg-[#00E2E5]/5 ring-1 ring-[#00E2E5]/20"
                  : "border-white/10 bg-white/[0.03] hover:border-white/20"
              }`}
            >
              <div className="flex flex-col sm:flex-row">
                <div className="relative h-32 w-full shrink-0 sm:h-auto sm:w-40">
                  <Image
                    src={addon.image}
                    alt={addon.shortName}
                    fill
                    className="object-cover"
                    sizes="(max-width: 640px) 100vw, 160px"
                  />
                  <div className="absolute top-2 left-2">
                    <span
                      className="rounded-full px-2 py-0.5 text-xs font-bold text-white"
                      style={{ backgroundColor: addon.color }}
                    >
                      {addon.shortName}
                    </span>
                  </div>
                </div>

                <div className="flex flex-1 flex-col justify-between gap-3 p-4">
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-bold text-white">{addon.name}</h3>
                      <span className="shrink-0 text-sm font-bold text-[#00E2E5]">
                        {priceLabel}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-white/40">
                      {addon.description}
                    </p>
                    {(addon.discountLabel || addon.saveLabel) && (
                      <div className="mt-1.5 flex items-center gap-2">
                        {addon.discountLabel && (
                          <span className="rounded border border-yellow-400/30 bg-yellow-400/15 px-1.5 py-0.5 text-xs font-bold text-yellow-400">
                            {addon.discountLabel}
                          </span>
                        )}
                        {addon.saveLabel && (
                          <span className="text-xs text-yellow-400/70">{addon.saveLabel}</span>
                        )}
                      </div>
                    )}
                    {addon.location === "headpinz" && (
                      <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-amber-400/80">
                        <Image
                          src={HEADPINZ_LOGO}
                          alt=""
                          width={12}
                          height={12}
                          className="h-3 w-3"
                        />
                        Located at HeadPinz — right next door to FastTrax
                      </p>
                    )}
                  </div>

                  {/* Qty controls */}
                  {addon.perPerson ? (
                    qty === 0 ? (
                      <button
                        type="button"
                        onClick={() => setQty(addon, racerCount)}
                        className="w-full rounded-lg border border-[#00E2E5]/30 bg-[#00E2E5]/10 py-2.5 text-xs font-bold text-[#00E2E5] transition-colors hover:bg-[#00E2E5]/20"
                      >
                        Add for all {racerCount} racer{racerCount !== 1 ? "s" : ""} — $
                        {(addon.price * racerCount).toFixed(2)}
                      </button>
                    ) : (
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setQty(addon, qty - 1)}
                            className="flex h-7 w-7 items-center justify-center rounded border border-white/20 text-sm text-white/50 transition-colors hover:border-white/40 hover:text-white"
                          >
                            -
                          </button>
                          <span className="w-6 text-center text-xs font-semibold text-white">
                            {qty}
                          </span>
                          <button
                            type="button"
                            onClick={() => setQty(addon, qty + 1)}
                            className="flex h-7 w-7 items-center justify-center rounded border border-white/20 text-sm text-white/50 transition-colors hover:border-white/40 hover:text-white"
                          >
                            +
                          </button>
                          <span className="ml-1 text-xs text-white/30">
                            {qty} {qty === 1 ? "person" : "people"}
                          </span>
                        </div>
                        <span className="text-sm font-semibold text-[#00E2E5]">
                          ${(addon.price * qty).toFixed(2)}
                        </span>
                      </div>
                    )
                  ) : (
                    <div className="flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => setQty(addon, qty > 0 ? 0 : 1)}
                        className={`rounded-lg px-4 py-2 text-xs font-bold transition-colors ${
                          isSelected
                            ? "bg-[#00E2E5] text-[#000418]"
                            : "bg-white/10 text-white/60 hover:bg-white/20 hover:text-white"
                        }`}
                      >
                        {isSelected ? "Added ✓" : "Add to Booking"}
                      </button>
                      {qty > 0 && (
                        <span className="text-sm font-semibold text-[#00E2E5]">
                          ${(addon.price * qty).toFixed(2)}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Time slot picker — appears when addon is selected */}
                  {isSelected && (
                    <SlotPicker
                      addon={addon}
                      slots={timeSlots[addon.id]}
                      loading={!!loadingSlots[addon.id]}
                      selectedTime={entryById.get(addon.id)?.selectedTime ?? null}
                      bookedHeats={bookedHeats}
                      otherSelections={item.addons
                        .filter((a) => a.id !== addon.id && a.qty > 0 && a.selectedTime)
                        .map((a) => {
                          const def = ADD_ONS.find((x) => x.id === a.id)!;
                          const slot = timeSlots[a.id]?.find((s) => s.start === a.selectedTime);
                          return slot
                            ? {
                                start: slot.start,
                                stop: slot.stop,
                                location: def.location,
                              }
                            : null;
                        })
                        .filter(
                          (
                            x,
                          ): x is { start: string; stop: string; location: AddonDef["location"] } =>
                            !!x,
                        )}
                      onPick={(start) => writeEntry(addon.id, { selectedTime: start })}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div
        className={`rounded-xl border p-5 transition-all duration-300 ${
          totalCount > 0 ? "border-[#00E2E5]/40 bg-[#00E2E5]/8" : "border-white/10 bg-white/3"
        }`}
      >
        {totalCount > 0 ? (
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs text-white/50">
              {totalCount} add-on{totalCount !== 1 ? "s" : ""} selected
            </p>
            <p className="text-lg font-bold text-[#00E2E5]">+${totalCost.toFixed(2)}</p>
          </div>
        ) : (
          <p className="text-center text-sm text-white/30">No add-ons selected</p>
        )}
      </div>
    </div>
  );
};

function SlotPicker({
  addon,
  slots,
  loading,
  selectedTime,
  bookedHeats,
  otherSelections,
  onPick,
}: {
  addon: AddonDef;
  slots: TimeSlot[] | undefined;
  loading: boolean;
  selectedTime: string | null;
  bookedHeats: Array<{ start: string; stop: string; track: string | null }>;
  otherSelections: Array<{ start: string; stop: string; location: AddonDef["location"] }>;
  onPick: (start: string) => void;
}) {
  if (loading) {
    return (
      <div className="mt-3 flex items-center gap-2 border-t border-white/10 pt-3 text-xs text-white/40">
        <div className="h-3 w-3 animate-spin rounded-full border border-white/30 border-t-white/80" />
        Loading available times…
      </div>
    );
  }
  const list = slots ?? [];
  if (list.length === 0) {
    return (
      <div className="mt-3 border-t border-white/10 pt-3">
        <p className="text-xs text-amber-400/70">No times available on this date</p>
      </div>
    );
  }

  // Merge race heats into the timeline display.
  type Pill =
    | { kind: "slot"; data: TimeSlot }
    | { kind: "race"; start: string; trackColor: string };
  const pills: Pill[] = [
    ...list.map((s): Pill => ({ kind: "slot", data: s })),
    ...bookedHeats.map((h): Pill => {
      const color =
        h.track === "Red"
          ? "#E53935"
          : h.track === "Blue"
            ? "#004AAD"
            : h.track === "Mega"
              ? "#A855F7"
              : "#00E2E5";
      return { kind: "race", start: h.start, trackColor: color };
    }),
  ];
  pills.sort((a, b) => {
    const aTime = a.kind === "slot" ? a.data.start : a.start;
    const bTime = b.kind === "slot" ? b.data.start : b.start;
    return aTime.localeCompare(bTime);
  });

  return (
    <div className="mt-3 space-y-1.5 border-t border-white/10 pt-3">
      <p className="text-xs font-semibold tracking-wider text-white/50 uppercase">Select a time</p>
      <div className="flex flex-wrap gap-1.5">
        {pills.map((p, i) => {
          if (p.kind === "race") {
            return (
              <span
                key={`race-${i}`}
                className="cursor-not-allowed rounded-lg border-2 px-3 py-1.5 text-xs font-bold opacity-70"
                style={{
                  borderColor: p.trackColor,
                  color: p.trackColor,
                  backgroundColor: `${p.trackColor}15`,
                }}
                title="Your race"
              >
                {formatTime(p.start)} 🏎️
              </span>
            );
          }
          const slot = p.data;
          const isChosen = selectedTime === slot.start;
          const slotStartMs = parseLocal(slot.start).getTime();
          const slotStopMs = parseLocal(slot.stop).getTime();
          const conflictsWithOther = otherSelections.some((o) => {
            const buffer = o.location === addon.location ? 0 : CROSS_BUILDING_BUFFER_MS;
            const oStart = parseLocal(o.start).getTime();
            const oStop = parseLocal(o.stop).getTime();
            return slotStartMs < oStop + buffer && slotStopMs > oStart - buffer;
          });
          if (conflictsWithOther) {
            return (
              <span
                key={`slot-${slot.start}`}
                className="bg-white/3 cursor-not-allowed rounded-lg border border-white/5 px-3 py-1.5 text-xs font-semibold text-white/15"
                title="Conflicts with another activity"
              >
                {formatTime(slot.start)}
              </span>
            );
          }
          return (
            <button
              key={`slot-${slot.start}`}
              type="button"
              onClick={() => onPick(slot.start)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                isChosen
                  ? "bg-[#00E2E5] text-[#000418]"
                  : "border border-white/10 bg-white/5 text-white/50 hover:bg-white/10 hover:text-white"
              }`}
            >
              {formatTime(slot.start)}
            </button>
          );
        })}
      </div>
      {selectedTime && (
        <p className="text-xs text-white/30">
          {(() => {
            const s = list.find((x) => x.start === selectedTime);
            return s ? `${formatTime(s.start)} — ${formatTime(s.stop)}` : null;
          })()}
        </p>
      )}
    </div>
  );
}

export const RaceAddonsStep: StepDef<RaceItem> = {
  id: "race-addons",
  title: "Extras",
  Component: RaceAddonsStepComponent,
  isVisible: () => true,
  // Add-ons always optional; canAdvance never blocks. If the customer picked
  // an addon but couldn't grab a slot, the entry just ships with selectedTime
  // null and checkout (commit 10) skips it with a non-blocking warning.
  canAdvance: () => true,
};
