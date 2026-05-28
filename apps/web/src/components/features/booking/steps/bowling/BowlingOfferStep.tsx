"use client";

import { useEffect, useMemo, useState } from "react";
import type { Dispatch } from "react";
import type { Action } from "~/features/booking/state/machine";
import type { BowlingItem, KbfItem, StepDef, BookingSession } from "~/features/booking";
import type { BowlingExperienceWithDetails } from "@/lib/bowling-db";

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
}

const QAMF_CENTER_CODES: Record<number, string> = {
  9172: "TXBSQN0FEKQ11",
  3148: "PPTR5G2N0QXF7",
};

function slotHourET(iso: string, bookingDate?: string): number {
  try {
    const dt = new Date(iso);
    const parts = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: "America/New_York",
    }).formatToParts(dt);
    const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    if (isNaN(h)) return -1;
    if (bookingDate && h < 9) {
      const yr = parts.find((p) => p.type === "year")?.value ?? "1970";
      const mo = parts.find((p) => p.type === "month")?.value ?? "01";
      const dy = parts.find((p) => p.type === "day")?.value ?? "01";
      const slotYmd = `${yr}-${mo}-${dy}`;
      if (slotYmd > bookingDate) return h + 24;
    }
    return h;
  } catch {
    return -1;
  }
}

function slotMinuteET(iso: string): number {
  try {
    const m = parseInt(
      new Date(iso).toLocaleString("en-US", {
        minute: "2-digit",
        timeZone: "America/New_York",
      }),
      10,
    );
    return isNaN(m) ? 0 : m;
  } catch {
    return 0;
  }
}

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

  const [experiences, setExperiences] = useState<BowlingExperienceWithDetails[]>([]);
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [holdBusy, setHoldBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load experiences
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

  // Filter to selected tier
  const tierExperiences = useMemo(
    () => experiences.filter((e) => (item.tier === "vip" ? e.isVip : !e.isVip)),
    [experiences, item.tier],
  );

  // Fetch availability for selected date/time
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
              Options?: Record<string, Array<{ Id: number }>>;
            };
          }) => ({
            bookedAt: a.BookedAt,
            webOfferId:
              typeof a.WebOffer.Id === "string" ? parseInt(a.WebOffer.Id, 10) : a.WebOffer.Id,
            webOfferTitle: a.WebOffer.Title ?? "",
            optionId:
              a.WebOffer.Options?.Game?.[0]?.Id ??
              a.WebOffer.Options?.Time?.[0]?.Id ??
              a.WebOffer.Options?.Unlimited?.[0]?.Id,
            optionType: a.WebOffer.Options?.Time
              ? "Time"
              : a.WebOffer.Options?.Unlimited
                ? "Unlimited"
                : "Game",
          }),
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

  async function selectSlot(exp: BowlingExperienceWithDetails, slot: AvailabilitySlot) {
    setHoldBusy(true);
    setError(null);

    try {
      // Create QAMF hold
      const holdRes = await fetch("/api/bowling/v2/reserve/hold", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          centerId,
          webOfferId: slot.webOfferId,
          optionId: slot.optionId,
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

      // Build line items from experience
      const lineItems = exp.items.map((ei) => ({
        squareProductId: ei.squareProductId,
        quantity:
          ei.quantity *
          (exp.kind === "hourly" || ei.sortOrder === 0
            ? Math.max(1, Math.ceil(playerCount / 6))
            : playerCount),
      }));

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
        optionId: slot.optionId ?? null,
        optionType: slot.optionType ?? null,
        bookedAt: slot.bookedAt,
        lineItems,
        rawItems: [],
        hasBookingFee: true,
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

  // Group slots by experience
  const expOfferIds = new Set(tierExperiences.map((e) => e.qamfWebOfferId));
  const relevantSlots = slots.filter((s) => expOfferIds.has(s.webOfferId));

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

      {tierExperiences.length === 0 && !loading && (
        <p className="py-8 text-center text-sm text-white/40">
          No packages available for this date and time. Try a different time.
        </p>
      )}

      <div className="space-y-4">
        {tierExperiences.map((exp) => {
          const expSlots = relevantSlots.filter((s) => s.webOfferId === exp.qamfWebOfferId);
          const isVip = exp.isVip;
          const accent = isVip ? GOLD : CORAL;
          const videoUrl = isVip
            ? `${BLOB}/videos/headpinz-neoverse-v2.mp4`
            : `${BLOB}/videos/headpinz-bowling.mp4`;

          const primaryItem = exp.items.find((i) => i.sortOrder === 0);
          const priceCents = primaryItem?.priceCents ?? 0;
          const isPerLane = exp.kind === "hourly";

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

              {/* Price + time slots */}
              <div className="p-4">
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

                {expSlots.length === 0 ? (
                  <p className="text-xs text-white/30">No availability at this time</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {expSlots.map((slot, i) => {
                      const isSelected =
                        item.webOfferId === slot.webOfferId && item.bookedAt === slot.bookedAt;
                      return (
                        <button
                          key={`${slot.webOfferId}-${slot.bookedAt}-${i}`}
                          type="button"
                          disabled={holdBusy}
                          onClick={() => void selectSlot(exp, slot)}
                          className="rounded-lg px-3 py-2 text-sm font-medium transition-all disabled:opacity-50"
                          style={{
                            backgroundColor: isSelected ? accent : `${accent}15`,
                            color: isSelected ? "#0a1628" : accent,
                            fontWeight: isSelected ? 800 : 500,
                            boxShadow: isSelected ? `0 0 12px ${accent}60` : undefined,
                          }}
                        >
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
