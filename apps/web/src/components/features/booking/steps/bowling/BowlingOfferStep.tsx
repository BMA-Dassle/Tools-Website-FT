"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch } from "react";
import type { Action } from "~/features/booking/state/machine";
import { qamfCenterIdForCode } from "~/features/booking";
import type { BowlingItem, KbfItem, StepDef, BookingSession } from "~/features/booking";
import type {
  BowlingExperienceWithDetails,
  BowlingExperienceDurationOption,
} from "@/lib/bowling-db";
import { KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS } from "~/features/booking/service/kbf-pricing";
import { clarityTag, clarityEvent } from "~/lib/clarity";
import {
  type AvailabilitySlot,
  probeAvailability,
  parseAvailabilities,
  etHour,
  formatHourLabel,
} from "./availability-client";

const CORAL = "#fd5b56";
const GOLD = "#FFD700";
const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";

// VIP suite perks for the upgrade modal. Core amenities apply to every VIP
// lane; some experiences add their own inclusions (shoes, pizza) on top.
const VIP_CORE_PERKS = [
  "Semi-private 8-lane VIP area",
  "NeoVerse video wall",
  "Complimentary chips & salsa",
  "HyperBowling + premium glow lighting",
];
const VIP_EXTRA_PERKS: Record<string, string[]> = {
  "fun-4-all-vip": ["Bowling shoes included"],
  "pizza-bowl-vip": ["Large one-topping pizza", "Pitcher of soda", "Shoes for up to 6"],
};

type BowlingLikeItem = BowlingItem | KbfItem;

const QAMF_CENTER_CODES: Record<number, string> = {
  9172: "TXBSQN0FEKQ11",
  3148: "PPTR5G2N0QXF7",
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
  } catch {
    return iso;
  }
}

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const BowlingOfferStepComponent: StepDef<BowlingLikeItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
}) => {
  // Resolve from the item's stamped center, else the SELECTED session center —
  // never a hardcoded fallback. null = no center yet (the flow shows the center
  // picker); booking is blocked below until it's resolved.
  const centerId = item.qamfCenterId ?? qamfCenterIdForCode(session.center);
  const centerCode = centerId != null ? (QAMF_CENTER_CODES[centerId] ?? null) : null;
  const kind =
    item.kind === "kbf" ? "kbf" : (item as BowlingItem).variant === "hourly" ? "hourly" : "open";
  const playerCount =
    item.kind === "bowling"
      ? (item as BowlingItem).playerCount
      : (item as KbfItem).bowlers.length + (item as KbfItem).paidAdults;
  const laneCount = Math.max(1, Math.ceil(playerCount / 6));

  const [experiences, setExperiences] = useState<BowlingExperienceWithDetails[]>([]);
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [holdBusy, setHoldBusy] = useState(false);
  // bookedAt of the slot currently being reserved — drives the inline spinner
  // ON the tapped button (not a separate notice below the fold).
  const [reservingAt, setReservingAt] = useState<string | null>(null);
  // VIP upsell shown after a Regular pick (v1 parity): the VIP counterpart
  // experience + the VIP slot at the same time, or null when not offered.
  const [vipUpgrade, setVipUpgrade] = useState<{
    exp: BowlingExperienceWithDetails;
    slot: AvailabilitySlot;
  } | null>(null);
  // Offer the VIP upsell at most once per visit so re-picking times doesn't nag.
  const vipOfferedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDurationOpt, setSelectedDurationOpt] =
    useState<BowlingExperienceDurationOption | null>(null);
  // True when the chosen hour had nothing for this tier and we widened to the
  // next-available times (drives the "showing next available" notice).
  const [widened, setWidened] = useState(false);

  // The hour the customer picked under the calendar (0-26 notation).
  const selectedHour = item.hour;

  useEffect(() => {
    if (!centerCode) return; // no center resolved yet — the picker is showing
    const kindParam = kind === "kbf" ? "&kind=kbf" : "";
    void (async () => {
      try {
        const res = await fetch(`/api/bowling/v2/experiences?centerCode=${centerCode}${kindParam}`);
        const data = await res.json();
        const all: BowlingExperienceWithDetails[] = Array.isArray(data) ? data : [];
        setExperiences(kind === "kbf" ? all : all.filter((e) => e.kind !== "kbf"));
      } catch {
        setExperiences([]);
      }
    })();
  }, [centerCode, kind]);

  const tierExperiences = useMemo(() => {
    const dow = item.date ? new Date(`${item.date}T12:00:00`).getDay() : new Date().getDay();
    return experiences.filter(
      (e) =>
        (item.tier === "vip" ? e.isVip : !e.isVip) &&
        (!Array.isArray(e.daysOfWeek) || e.daysOfWeek.length === 0 || e.daysOfWeek.includes(dow)),
    );
  }, [experiences, item.tier, item.date]);

  // Fine probe around the hour the customer chose under the calendar, with a
  // widen safeguard (v1 parity: BowlingWizard.tsx fetchSlots). The chosen hour
  // is already known-open from the date step's coarse scan, so a narrow ±45-min
  // window (~7 probes) gets the exact start times fast. Only when that hour has
  // nothing for THIS tier — e.g. open for regular but full for VIP — do we widen
  // to a 30-min full-day scan to surface the next-available times.
  useEffect(() => {
    if (!item.date || selectedHour === null || centerId == null) {
      setSlots([]);
      setWidened(false);
      return;
    }
    // Wait for experiences so the tier filter (→ widen decision) is known.
    if (!experiences.length) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const fine = parseAvailabilities(
          await probeAvailability(
            `/api/bowling/v2/availability?centerId=${centerId}&players=${playerCount}&startDate=${item.date}&kind=${kind}&hour=${selectedHour}&minute=${item.minute ?? 0}&windowMinutes=45`,
          ),
        );
        const tierIds = new Set(tierExperiences.map((e) => e.qamfWebOfferId));
        const hasTierAtHour = fine.some(
          (s) => tierIds.has(s.webOfferId) && etHour(s.bookedAt) === selectedHour,
        );

        let merged = fine;
        let didWiden = false;
        if (!hasTierAtHour) {
          try {
            const wide = parseAvailabilities(
              await probeAvailability(
                `/api/bowling/v2/availability?centerId=${centerId}&players=${playerCount}&startDate=${item.date}&kind=${kind}&stepMinutes=30`,
              ),
            );
            const seen = new Set(fine.map((s) => `${s.bookedAt}::${s.webOfferId}`));
            merged = [...fine];
            for (const s of wide) {
              const k = `${s.bookedAt}::${s.webOfferId}`;
              if (!seen.has(k)) {
                merged.push(s);
                seen.add(k);
              }
            }
            didWiden = merged.some((s) => tierIds.has(s.webOfferId));
          } catch {
            // Keep the fine results — partial is better than nothing.
          }
        }
        if (cancelled) return;
        setSlots(merged);
        setWidened(didWiden);
      } catch {
        if (!cancelled) {
          setError("Couldn't check availability. Please try again.");
          setSlots([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [centerId, playerCount, item.date, kind, selectedHour, item.minute, tierExperiences]);

  // Fire a one-time "sold out" signal when the probe finishes with no slots for
  // this tier on the chosen day — demand we'd otherwise lose silently. Keyed on
  // date/tier/hour so it fires once per distinct lookup, not on every render.
  const soldOutFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (loading || experiences.length === 0) return;
    const tierIds = new Set(tierExperiences.map((e) => e.qamfWebOfferId));
    const hasAny = slots.some((s) => tierIds.has(s.webOfferId));
    const key = `${item.date}:${item.tier}:${selectedHour}`;
    if (!hasAny && soldOutFiredRef.current !== key) {
      soldOutFiredRef.current = key;
      clarityTag("availability", "soldout");
      clarityEvent("availability:soldout");
    }
  }, [loading, slots, experiences, tierExperiences, item.date, item.tier, selectedHour]);

  function buildLineItems(
    exp: BowlingExperienceWithDetails,
    durationOpt: BowlingExperienceDurationOption | null,
  ) {
    const isPerLane = exp.kind === "hourly" || exp.slug.startsWith("pizza-bowl");
    const qtyMultiplier = isPerLane ? laneCount : playerCount;
    const durationMultiplier = durationOpt?.squareMultiplier ?? 1;

    return (exp.items ?? []).map((ei) => {
      const isPrimary = ei.sortOrder === 0;
      const useOverride = isPrimary && durationOpt?.overrideSquareProductId;

      return {
        squareProductId: useOverride ? durationOpt!.overrideSquareProductId! : ei.squareProductId,
        quantity: isPrimary
          ? ei.quantity * qtyMultiplier * durationMultiplier
          : ei.quantity * laneCount,
        label: ei.label,
        priceCents: useOverride
          ? (durationOpt!.overridePriceCents ?? ei.priceCents)
          : ei.priceCents,
        depositPct: useOverride
          ? (durationOpt!.overrideDepositPct ?? ei.depositPct)
          : ei.depositPct,
        squareCatalogObjectId: useOverride
          ? (durationOpt!.overrideCatalogObjectId ?? ei.squareCatalogObjectId)
          : ei.squareCatalogObjectId,
      };
    });
  }

  async function selectSlot(
    exp: BowlingExperienceWithDetails,
    slot: AvailabilitySlot,
    durationOpt: BowlingExperienceDurationOption | null,
  ) {
    // Never silently book a different complex — if the center didn't resolve
    // from the item or the session, refuse rather than defaulting to Fort Myers.
    if (centerId == null) {
      setError("We couldn't tell which location this is for. Go back and re-select your center.");
      return;
    }

    setHoldBusy(true);
    setReservingAt(slot.bookedAt);
    setError(null);

    try {
      const effectiveOptionId = durationOpt?.qamfOptionId ?? slot.optionId;

      const holdRes = await fetch("/api/bowling/v2/reserve/hold", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          centerId,
          webOfferId: slot.webOfferId,
          optionId: effectiveOptionId,
          optionType: slot.optionType,
          bookedAt: slot.bookedAt,
          players: playerCount,
          service: "BookForLater",
        }),
      });
      const holdData = await holdRes.json();

      if (!holdRes.ok) {
        setError(holdData.error ?? "Couldn't reserve this slot. Try another time.");
        return;
      }

      const qamfReservationId = holdData.qamfReservationId as string;
      const lineItems = buildLineItems(exp, durationOpt);

      dispatch({
        type: "setBowlingHold",
        itemId: item.id,
        qamfReservationId,
        qamfCenterId: centerId,
      });

      onChange({
        experienceId: exp.id,
        experienceSlug: exp.slug,
        webOfferId: slot.webOfferId,
        optionId: effectiveOptionId ?? null,
        optionType: slot.optionType ?? null,
        bookedAt: slot.bookedAt,
        lineItems,
        rawItems: [],
        hasBookingFee: true,
        durationMinutes: durationOpt?.durationMinutes ?? null,
        durationMultiplier: durationOpt?.squareMultiplier ?? 1,
      } as Partial<BowlingLikeItem>);

      // VIP upsell (v1 parity): after a Regular pick, offer the VIP counterpart
      // of the same kind at the same time — once per visit.
      if (!exp.isVip && item.tier === "regular" && !vipOfferedRef.current) {
        const vipExp = experiences.find((e) => e.isVip && e.kind === exp.kind);
        const vipSlot = vipExp
          ? slots.find(
              (s) => s.webOfferId === vipExp.qamfWebOfferId && s.bookedAt === slot.bookedAt,
            )
          : undefined;
        if (vipExp && vipSlot) {
          vipOfferedRef.current = true;
          setVipUpgrade({ exp: vipExp, slot: vipSlot });
          clarityEvent("upsell:vip:shown");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Hold creation failed");
    } finally {
      setHoldBusy(false);
      setReservingAt(null);
    }
  }

  // Accept the VIP upsell: switch the item to VIP and hold the VIP slot. If that
  // slot was just taken, selectSlot surfaces the error and the Regular hold the
  // customer already has stands.
  async function acceptVipUpgrade() {
    if (!vipUpgrade) return;
    const { exp, slot } = vipUpgrade;
    setVipUpgrade(null);
    clarityEvent("upsell:vip:accepted");
    onChange({ tier: "vip" } as Partial<BowlingLikeItem>);
    await selectSlot(exp, slot, null);
  }

  const expOfferIds = new Set(tierExperiences.map((e) => e.qamfWebOfferId));
  const relevantSlots = slots.filter((s) => expOfferIds.has(s.webOfferId));

  // What an offer's card books. Normally the customer already chose the hour on
  // the date step, so we DON'T re-ask for a time — we book the earliest start
  // within that hour (a single confirm). Only when that hour was full for this
  // tier (widened) do we surface the next-available times to pick from.
  function slotsForOffer(webOfferId: number): AvailabilitySlot[] {
    const atOffer = relevantSlots
      .filter((s) => s.webOfferId === webOfferId)
      .sort((a, b) => a.bookedAt.localeCompare(b.bookedAt));
    if (widened) return atOffer.slice(0, 8);
    const inHour = atOffer.filter((s) => etHour(s.bookedAt) === selectedHour);
    return inHour.length ? [inHour[0]] : [];
  }

  // Filter out hourly experience cards when no duration options are valid at this time
  const visibleExperiences = tierExperiences.filter((exp) => {
    if (!exp.durationOptions?.length) return true;
    const expSlots = slotsForOffer(exp.qamfWebOfferId);
    if (expSlots.length === 0) return true;
    const ids = expSlots[0].availableTimeOptionIds;
    if (!ids?.length) return true;
    return (exp.durationOptions ?? []).some((d) => ids.includes(d.qamfOptionId));
  });

  // Auto-select removed — was causing crashes in strict mode.
  // Single-slot UX handled via the full-width "Select" button below.

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="text-center">
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">
          Choose a Package
        </h2>
        <p className="mt-1 text-sm text-white/40">
          {selectedHour === null || widened
            ? "Select your bowling experience"
            : `${formatHourLabel(selectedHour)} · change the time on the previous step`}
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-center text-sm text-red-400">
          {error}
        </div>
      )}

      {widened && selectedHour !== null && (
        <div
          className="rounded-xl px-3 py-2.5 text-center text-sm font-medium"
          style={{ backgroundColor: `${GOLD}14`, color: GOLD }}
        >
          ⚠ Nothing open at {formatHourLabel(selectedHour)}. The earliest available times are below
          — picking one changes your start time.
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div
            className="h-8 w-8 animate-spin rounded-full border-2 border-white/15"
            style={{ borderTopColor: CORAL }}
          />
        </div>
      ) : visibleExperiences.length === 0 ? (
        <p className="py-8 text-center text-sm text-white/40">
          No availability this day. Go back and try another date.
        </p>
      ) : (
        <>
          <div className="space-y-4">
            {visibleExperiences.map((exp) => {
              const expSlots = slotsForOffer(exp.qamfWebOfferId);
              const isVip = exp.isVip;
              const accent = isVip ? GOLD : CORAL;
              const videoUrl = isVip
                ? `${BLOB}/videos/headpinz-neoverse-v2.mp4`
                : `${BLOB}/videos/headpinz-bowling.mp4`;

              const primaryItem = exp.items.find((i) => i.sortOrder === 0);
              const priceCents = primaryItem?.priceCents ?? 0;
              const isPerLane = exp.kind === "hourly" || exp.slug.startsWith("pizza-bowl");
              const hasDurationOptions = (exp.durationOptions?.length ?? 0) > 0;

              // Filter duration buttons to only show options QAMF confirms are available
              const validDurationOptions = hasDurationOptions
                ? (exp.durationOptions ?? []).filter((opt) => {
                    if (!expSlots.length) return true;
                    const ids = expSlots[0].availableTimeOptionIds;
                    return !ids?.length || ids.includes(opt.qamfOptionId);
                  })
                : [];

              // Fun 4 All near-closing notice: primary option (90min) not available
              const isFunForAll = exp.slug.includes("fun-4-all");
              const showNearClosingNotice =
                isFunForAll &&
                expSlots.length > 0 &&
                exp.qamfOptionId != null &&
                expSlots.every(
                  (s) =>
                    s.availableTimeOptionIds?.length &&
                    !s.availableTimeOptionIds.includes(exp.qamfOptionId!),
                );

              const isSelected = item.experienceId === exp.id;

              return (
                <div
                  key={exp.id}
                  className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]"
                >
                  {/* Video header */}
                  <div className="relative h-32 overflow-hidden">
                    <video
                      src={videoUrl}
                      autoPlay
                      loop
                      muted
                      playsInline
                      className="h-full w-full object-cover opacity-50"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
                    <div className="absolute inset-x-0 bottom-0 p-4">
                      <h3
                        className="font-display text-lg uppercase tracking-widest"
                        style={{ color: accent }}
                      >
                        {exp.label}
                      </h3>
                      <p className="mt-0.5 text-xs text-white/50">{exp.description}</p>
                    </div>
                  </div>

                  <div className="p-4">
                    {/* Near-closing notice for Fun 4 All */}
                    {showNearClosingNotice && (
                      <div
                        className="mb-3 rounded-lg px-3 py-2 text-center text-xs font-medium"
                        style={{ backgroundColor: `${GOLD}18`, color: GOLD }}
                      >
                        Only 1 hour available near closing
                      </div>
                    )}

                    {/* Price display. KBF games are free; the VIP lane carries a
                    $2/person upcharge that IS charged at checkout, so surface it
                    here rather than showing "$0.00". */}
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-lg font-bold text-white">
                        {kind === "kbf" && !isVip ? (
                          "Free"
                        ) : kind === "kbf" && isVip ? (
                          <>
                            {centsToDollars(KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS)}
                            <span className="text-xs font-normal text-white/40">
                              {" "}
                              /person · VIP lane
                            </span>
                          </>
                        ) : (
                          <>
                            {centsToDollars(priceCents)}
                            <span className="text-xs font-normal text-white/40">
                              /{isPerLane ? "lane" : "person"}
                            </span>
                          </>
                        )}
                      </span>
                      {isVip && (
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                          style={{ backgroundColor: `${GOLD}20`, color: GOLD }}
                        >
                          VIP
                        </span>
                      )}
                    </div>

                    {/* Duration options — filtered by QAMF available option IDs */}
                    {validDurationOptions.length > 0 && (
                      <div className="mb-3">
                        <div className="mb-1.5 text-[10px] uppercase tracking-wider text-white/30">
                          Duration
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {validDurationOptions.map((opt) => {
                            const isActive =
                              selectedDurationOpt?.id === opt.id && item.experienceId === exp.id;
                            // Per-duration total = unit (1hr) price × the
                            // duration's multiplier (v1 parity: BowlingWizard
                            // 4951-4952). Without the multiplier, 1.5h and 2h
                            // render the same price.
                            const optPrice = Math.round(
                              (opt.overridePriceCents ?? priceCents) * opt.squareMultiplier,
                            );
                            return (
                              <button
                                key={opt.id}
                                type="button"
                                onClick={() => setSelectedDurationOpt(isActive ? null : opt)}
                                className="rounded-lg px-3 py-2 text-sm font-medium transition-all"
                                style={{
                                  backgroundColor: isActive ? accent : `${accent}15`,
                                  color: isActive ? "#0a1628" : accent,
                                  fontWeight: isActive ? 800 : 500,
                                  boxShadow: isActive ? `0 0 12px ${accent}60` : undefined,
                                }}
                              >
                                {opt.label}
                                <span className="ml-1.5 text-xs opacity-60">
                                  {centsToDollars(optPrice)}/{isPerLane ? "lane" : "person"}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Time slots */}
                    {hasDurationOptions && !selectedDurationOpt ? (
                      <p className="text-xs text-white/30">
                        Select a duration to see available times
                      </p>
                    ) : expSlots.length === 0 ? (
                      <p className="text-xs text-white/30">No availability at this time</p>
                    ) : expSlots.length === 1 && !isSelected ? (
                      /* Auto-select UX: single slot gets a full-width button */
                      <button
                        type="button"
                        disabled={holdBusy}
                        onClick={() =>
                          void selectSlot(
                            exp,
                            expSlots[0],
                            hasDurationOptions ? selectedDurationOpt : null,
                          )
                        }
                        className="flex w-full items-center justify-center gap-2 rounded-full px-4 py-3 text-sm font-bold uppercase tracking-wider transition-all hover:scale-[1.01] disabled:opacity-60"
                        style={{
                          backgroundColor: `${accent}1a`,
                          color: accent,
                          border: `1px solid ${accent}55`,
                        }}
                      >
                        {reservingAt === expSlots[0].bookedAt ? (
                          <>
                            <span
                              className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
                              aria-hidden
                            />
                            Reserving…
                          </>
                        ) : (
                          <>Select {formatTime(expSlots[0].bookedAt)}</>
                        )}
                      </button>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {expSlots.map((slot, i) => {
                          const isSlotSelected = isSelected && item.bookedAt === slot.bookedAt;
                          return (
                            <button
                              key={`${slot.webOfferId}-${slot.bookedAt}-${i}`}
                              type="button"
                              disabled={holdBusy}
                              onClick={() =>
                                void selectSlot(
                                  exp,
                                  slot,
                                  hasDurationOptions ? selectedDurationOpt : null,
                                )
                              }
                              className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-all disabled:opacity-60"
                              style={{
                                backgroundColor: isSlotSelected ? accent : `${accent}15`,
                                color: isSlotSelected ? "#0a1628" : accent,
                                fontWeight: isSlotSelected ? 800 : 500,
                                boxShadow: isSlotSelected ? `0 0 12px ${accent}60` : undefined,
                              }}
                            >
                              {reservingAt === slot.bookedAt && (
                                <span
                                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
                                  aria-hidden
                                />
                              )}
                              {isSlotSelected ? "✓ " : ""}
                              {formatTime(slot.bookedAt)}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* VIP upgrade upsell — shown after a Regular pick (v1 parity) */}
      {vipUpgrade &&
        (() => {
          const regExp = experiences.find((e) => e.id === item.experienceId);
          const regPrice = regExp?.items.find((i) => i.sortOrder === 0)?.priceCents ?? 0;
          const vipPrice = vipUpgrade.exp.items.find((i) => i.sortOrder === 0)?.priceCents ?? 0;
          const delta = vipPrice - regPrice;
          const vipPerLane =
            vipUpgrade.exp.kind === "hourly" || vipUpgrade.exp.slug.startsWith("pizza-bowl");
          return (
            <div
              className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
              style={{ backgroundColor: "rgba(0,0,0,0.78)" }}
            >
              <div
                className="w-full max-w-md overflow-hidden rounded-2xl"
                style={{ backgroundColor: "#0d1f3c", border: `2px solid ${GOLD}55` }}
              >
                <div className="relative h-36 overflow-hidden">
                  <video
                    autoPlay
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    className="absolute inset-0 h-full w-full object-cover"
                  >
                    <source src={`${BLOB}/videos/headpinz-neoverse-v2.mp4`} type="video/mp4" />
                  </video>
                  <div
                    className="absolute inset-0"
                    style={{
                      background: "linear-gradient(to bottom, transparent 30%, #0d1f3c 100%)",
                    }}
                  />
                  <span
                    className="absolute bottom-3 left-4 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest"
                    style={{ backgroundColor: GOLD, color: "#0a1628" }}
                  >
                    VIP Upgrade
                  </span>
                </div>

                <div className="p-5">
                  <h3
                    className="mb-1 font-display text-xl uppercase tracking-wider text-white"
                    style={{ textShadow: `0 0 20px ${GOLD}40` }}
                  >
                    Upgrade to VIP?
                  </h3>
                  <p className="mb-4 text-sm text-white/55">{vipUpgrade.exp.description}</p>

                  <ul className="mb-5 space-y-2">
                    {[...VIP_CORE_PERKS, ...(VIP_EXTRA_PERKS[vipUpgrade.exp.slug] ?? [])].map(
                      (perk) => (
                        <li key={perk} className="flex items-center gap-2">
                          <span
                            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                            style={{ backgroundColor: `${GOLD}25`, color: GOLD }}
                          >
                            ✓
                          </span>
                          <span className="text-sm text-white/75">{perk}</span>
                        </li>
                      ),
                    )}
                  </ul>

                  {delta > 0 && (
                    <div
                      className="mb-5 flex items-center justify-between rounded-xl px-4 py-3"
                      style={{ backgroundColor: `${GOLD}12`, border: `1px solid ${GOLD}30` }}
                    >
                      <span className="text-sm text-white/55">VIP upgrade</span>
                      <span className="font-display text-lg font-bold" style={{ color: GOLD }}>
                        +{centsToDollars(delta)}
                        <span className="text-sm font-normal text-white/40">
                          /{vipPerLane ? "lane" : "person"}
                        </span>
                      </span>
                    </div>
                  )}

                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        clarityEvent("upsell:vip:declined");
                        setVipUpgrade(null);
                      }}
                      className="flex-1 rounded-full border border-white/20 py-3 text-sm font-bold uppercase tracking-wider text-white/60 transition-colors hover:border-white/40 hover:text-white"
                    >
                      No Thanks
                    </button>
                    <button
                      type="button"
                      disabled={holdBusy}
                      onClick={() => void acceptVipUpgrade()}
                      className="flex-1 rounded-full py-3 text-sm font-bold uppercase tracking-wider text-[#0a1628] transition-all hover:scale-[1.02] disabled:opacity-60"
                      style={{ backgroundColor: GOLD, boxShadow: `0 0 18px ${GOLD}40` }}
                    >
                      Upgrade
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
};

const BowlingOfferStep: StepDef<BowlingItem> = {
  id: "bowling-offer",
  title: "Package",
  Component: BowlingOfferStepComponent as StepDef<BowlingItem>["Component"],
  isVisible: () => true,
  canAdvance: (item) =>
    item.webOfferId && item.bookedAt && item.qamfReservationId
      ? true
      : { reason: "Select a time slot" },
};

export default BowlingOfferStep;
