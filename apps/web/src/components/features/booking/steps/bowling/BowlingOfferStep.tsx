"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch } from "react";
import type { Action } from "~/features/booking/state/machine";
import type { BowlingItem, KbfItem, StepDef, BookingSession } from "~/features/booking";
import type {
  BowlingExperienceWithDetails,
  BowlingExperienceDurationOption,
} from "@/lib/bowling-db";

const CORAL = "#fd5b56";
const GOLD = "#FFD700";
const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";

type BowlingLikeItem = BowlingItem | KbfItem;

interface AvailabilitySlot {
  bookedAt: string;
  webOfferId: number;
  webOfferTitle: string;
  optionId?: number;
  optionType?: "Game" | "Time" | "Unlimited";
  availableTimeOptionIds?: number[];
}

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
  const centerId = item.qamfCenterId ?? 9172;
  const centerCode = QAMF_CENTER_CODES[centerId] ?? "TXBSQN0FEKQ11";
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
  const [error, setError] = useState<string | null>(null);
  const [selectedDurationOpt, setSelectedDurationOpt] =
    useState<BowlingExperienceDurationOption | null>(null);

  useEffect(() => {
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
        (!e.daysOfWeek.length || e.daysOfWeek.includes(dow)),
    );
  }, [experiences, item.tier, item.date]);

  // Fetch availability — parse QAMF response including availableTimeOptionIds
  useEffect(() => {
    if (!item.date || item.hour === null || item.minute === null) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/bowling/v2/availability?centerId=${centerId}&players=${playerCount}&startDate=${item.date}&hour=${item.hour}&minute=${item.minute}&kind=${kind}`,
        );
        const data = await res.json();
        const avail: AvailabilitySlot[] = (data.Availabilities ?? []).map(
          (a: {
            BookedAt: string;
            WebOffer: {
              Id: number | string;
              Title?: string;
              Options?: Record<string, Array<{ Id: number; Minutes?: number }>>;
            };
          }) => {
            const twoGame = a.WebOffer.Options?.Game?.find((g: { Id: number }) => g.Id);
            const timeOpts = a.WebOffer.Options?.Time ?? [];
            const unlimOpts = a.WebOffer.Options?.Unlimited ?? [];

            let optionId: number | undefined;
            let optionType: "Game" | "Time" | "Unlimited" = "Game";

            if (twoGame) {
              optionId = twoGame.Id;
              optionType = "Game";
            } else if (timeOpts[0]) {
              const longest = timeOpts.reduce(
                (best, t) => ((t.Minutes ?? 0) > (best.Minutes ?? 0) ? t : best),
                timeOpts[0],
              );
              optionId = longest.Id;
              optionType = "Time";
            } else if (unlimOpts[0]) {
              optionId = unlimOpts[0].Id;
              optionType = "Unlimited";
            }

            return {
              bookedAt: a.BookedAt,
              webOfferId:
                typeof a.WebOffer.Id === "string" ? parseInt(a.WebOffer.Id, 10) : a.WebOffer.Id,
              webOfferTitle: a.WebOffer.Title ?? "",
              optionId,
              optionType,
              availableTimeOptionIds: timeOpts.map((t) => t.Id),
            };
          },
        );
        setSlots(avail);
      } catch {
        setError("Couldn't check availability. Please try again.");
        setSlots([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [centerId, playerCount, item.date, item.hour, item.minute, kind]);

  function buildLineItems(
    exp: BowlingExperienceWithDetails,
    durationOpt: BowlingExperienceDurationOption | null,
  ) {
    const isPerLane = exp.kind === "hourly" || exp.slug.startsWith("pizza-bowl");
    const qtyMultiplier = isPerLane ? laneCount : playerCount;
    const durationMultiplier = durationOpt?.squareMultiplier ?? 1;

    return exp.items.map((ei) => {
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
    setHoldBusy(true);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Hold creation failed");
    } finally {
      setHoldBusy(false);
    }
  }

  if (loading && slots.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-white/15"
          style={{ borderTopColor: CORAL }}
        />
      </div>
    );
  }

  const expOfferIds = new Set(tierExperiences.map((e) => e.qamfWebOfferId));
  const relevantSlots = slots.filter((s) => expOfferIds.has(s.webOfferId));

  // Filter out hourly experience cards when no duration options are valid at this time
  const visibleExperiences = tierExperiences.filter((exp) => {
    if (exp.durationOptions.length === 0) return true;
    const expSlots = relevantSlots.filter((s) => s.webOfferId === exp.qamfWebOfferId);
    if (expSlots.length === 0) return true;
    const ids = expSlots[0].availableTimeOptionIds;
    if (!ids?.length) return true;
    return exp.durationOptions.some((d) => ids.includes(d.qamfOptionId));
  });

  // Auto-select: when there's one non-hourly experience with one slot,
  // skip the time-chip click — user already picked the time on the slots step.
  const autoSelectDone = useRef(false);
  useEffect(() => {
    if (loading || autoSelectDone.current || holdBusy || item.bookedAt) return;
    const nonHourly = visibleExperiences.filter((e) => e.durationOptions.length === 0);
    if (nonHourly.length !== 1) return;
    const exp = nonHourly[0];
    const expSlots = relevantSlots.filter((s) => s.webOfferId === exp.qamfWebOfferId);
    if (expSlots.length !== 1) return;
    autoSelectDone.current = true;
    void selectSlot(exp, expSlots[0], null);
  }, [loading, visibleExperiences, relevantSlots, holdBusy, item.bookedAt]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="text-center">
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">
          Choose a Package
        </h2>
        <p className="mt-1 text-sm text-white/40">Select your bowling experience and time</p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-center text-sm text-red-400">
          {error}
        </div>
      )}

      {visibleExperiences.length === 0 && !loading && (
        <p className="py-8 text-center text-sm text-white/40">
          No packages available for this date and time. Try a different time.
        </p>
      )}

      <div className="space-y-4">
        {visibleExperiences.map((exp) => {
          const expSlots = relevantSlots.filter((s) => s.webOfferId === exp.qamfWebOfferId);
          const isVip = exp.isVip;
          const accent = isVip ? GOLD : CORAL;
          const videoUrl = isVip
            ? `${BLOB}/videos/headpinz-neoverse-v2.mp4`
            : `${BLOB}/videos/headpinz-bowling.mp4`;

          const primaryItem = exp.items.find((i) => i.sortOrder === 0);
          const priceCents = primaryItem?.priceCents ?? 0;
          const isPerLane = exp.kind === "hourly" || exp.slug.startsWith("pizza-bowl");
          const hasDurationOptions = exp.durationOptions.length > 0;

          // Filter duration buttons to only show options QAMF confirms are available
          const validDurationOptions = hasDurationOptions
            ? exp.durationOptions.filter((opt) => {
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

                {/* Price display */}
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-lg font-bold text-white">
                    {centsToDollars(priceCents)}
                    <span className="text-xs font-normal text-white/40">
                      /{isPerLane ? "lane" : "person"}
                    </span>
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
                        const optPrice = opt.overridePriceCents ?? priceCents;
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
                  <p className="text-xs text-white/30">Select a duration to see available times</p>
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
                    className="w-full rounded-full px-4 py-3 text-sm font-bold uppercase tracking-wider transition-all hover:scale-[1.01] disabled:opacity-50"
                    style={{
                      backgroundColor: `${accent}1a`,
                      color: accent,
                      border: `1px solid ${accent}55`,
                    }}
                  >
                    Select {formatTime(expSlots[0].bookedAt)}
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
                          className="rounded-lg px-3 py-2 text-sm font-medium transition-all disabled:opacity-50"
                          style={{
                            backgroundColor: isSlotSelected ? accent : `${accent}15`,
                            color: isSlotSelected ? "#0a1628" : accent,
                            fontWeight: isSlotSelected ? 800 : 500,
                            boxShadow: isSlotSelected ? `0 0 12px ${accent}60` : undefined,
                          }}
                        >
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

      {holdBusy && (
        <div className="flex items-center justify-center gap-2 py-4">
          <div
            className="h-5 w-5 animate-spin rounded-full border-2 border-white/15"
            style={{ borderTopColor: GOLD }}
          />
          <span className="text-sm text-white/50">Reserving your lane...</span>
        </div>
      )}
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
