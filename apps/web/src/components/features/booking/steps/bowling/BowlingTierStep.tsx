"use client";

import { useEffect, useMemo, useState } from "react";
import type { BowlingItem, KbfItem, StepDef } from "~/features/booking";
import type { BowlingExperienceWithDetails } from "@/lib/bowling-db";
import {
  probeAvailability,
  parseAvailabilities,
  etHour,
  etMinutesOfDay,
} from "./availability-client";
import { getPublicReopenMinutes } from "@/lib/group-events";

const CORAL = "#fd5b56";
const GOLD = "#FFD700";
const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";

type BowlingLikeItem = BowlingItem | KbfItem;

const QAMF_CENTER_CODES: Record<number, string> = {
  9172: "TXBSQN0FEKQ11",
  3148: "PPTR5G2N0QXF7",
};

function formatSlotTime(iso: string): string {
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
function formatHour(h: number): string {
  const hr = h % 24;
  const ampm = hr >= 12 ? "PM" : "AM";
  return `${hr % 12 === 0 ? 12 : hr % 12} ${ampm}`;
}

/** Per-tier availability for the chosen day, relative to the picked hour. */
interface TierAvail {
  openAtChosen: boolean;
  nextLabel: string | null; // soonest slot ≥ chosen hour (else earliest) — for "Next available"
  any: boolean;
  /** Precise earliest start within the chosen hour (e.g. "2:30 PM" when the top-of-hour
   *  slots are blocked by a morning-buyout reopen); null at the top of the hour. */
  chosenLabel: string | null;
}

const BowlingTierStepComponent: StepDef<BowlingLikeItem>["Component"] = ({
  item,
  onChange,
  setBusy,
}) => {
  const centerId = item.qamfCenterId ?? 9172;
  const centerCode = QAMF_CENTER_CODES[centerId] ?? "TXBSQN0FEKQ11";
  const kind =
    item.kind === "kbf" ? "kbf" : (item as BowlingItem).variant === "hourly" ? "hourly" : "open";
  // The availability probe scans BOTH open + hourly offers for non-KBF bowling,
  // so weekend time-bowling (Fri-Sun 1.5hr/2hr, offers 158/159) surfaces alongside
  // open play. The experience list already includes hourly experiences — only the
  // probe was pinned to "open", which hid all weekend daytime availability.
  const availKind = kind === "kbf" ? "kbf" : "open,hourly";
  const playerCount =
    item.kind === "bowling"
      ? (item as BowlingItem).playerCount
      : (item as KbfItem).bowlers.length + (item as KbfItem).paidAdults;
  const chosenHour = item.hour;

  const [experiences, setExperiences] = useState<BowlingExperienceWithDetails[]>([]);
  const [loading, setLoading] = useState(true);
  // Whole-day availability (both tiers) so each card can show open-at-your-time /
  // next-available — so a sold-out Regular doesn't hide that VIP is open (or vice versa).
  const [slots, setSlots] = useState<Array<{ webOfferId: number; bookedAt: string }>>([]);
  const [availLoading, setAvailLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const kindParam = kind === "kbf" ? "&kind=kbf" : "";
    void (async () => {
      try {
        const res = await fetch(`/api/bowling/v2/experiences?centerCode=${centerCode}${kindParam}`);
        const data = await res.json();
        const all: BowlingExperienceWithDetails[] = Array.isArray(data) ? data : [];
        setExperiences(kind === "kbf" ? all : all.filter((e) => e.kind !== "kbf"));
      } catch {
        setExperiences([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [centerCode, kind]);

  // Whole-day scan (30-min granularity, both tiers) for the availability badges.
  useEffect(() => {
    if (!item.date) {
      setAvailLoading(false);
      return;
    }
    let cancelled = false;
    setAvailLoading(true);
    void (async () => {
      try {
        const data = await probeAvailability(
          `/api/bowling/v2/availability?centerId=${centerId}&players=${Math.max(playerCount, 1)}&startDate=${item.date}&kind=${availKind}&stepMinutes=30`,
        );
        // Morning-only buyout: drop start times before the public reopen so a
        // pre-reopen slot (e.g. 2:00 PM) can't read as "open at your time".
        const reopenMins = item.date ? getPublicReopenMinutes(item.date) : null;
        if (!cancelled)
          setSlots(
            parseAvailabilities(data)
              .filter((s) => reopenMins == null || etMinutesOfDay(s.bookedAt) >= reopenMins)
              .map((s) => ({
                webOfferId: s.webOfferId,
                bookedAt: s.bookedAt,
              })),
          );
      } catch {
        if (!cancelled) setSlots([]);
      } finally {
        if (!cancelled) setAvailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [centerId, playerCount, item.date, kind]);

  // Block the wizard's Next while the availability scan runs — the customer
  // should see which tier is open (and the next-available time) before advancing.
  useEffect(() => {
    setBusy?.(availLoading);
    return () => setBusy?.(false);
  }, [availLoading, setBusy]);

  const hasRegular = experiences.some((e) => !e.isVip);
  const hasVip = experiences.some((e) => e.isVip);

  // Compute per-tier availability from the day scan.
  const tierAvail = useMemo(() => {
    const dow = item.date ? new Date(`${item.date}T12:00:00`).getDay() : new Date().getDay();
    const offerIdsForTier = (vip: boolean) =>
      new Set(
        experiences
          .filter(
            (e) =>
              e.isVip === vip &&
              (!Array.isArray(e.daysOfWeek) ||
                e.daysOfWeek.length === 0 ||
                e.daysOfWeek.includes(dow)),
          )
          .map((e) => e.qamfWebOfferId),
      );
    const compute = (vip: boolean): TierAvail => {
      const ids = offerIdsForTier(vip);
      const mine = slots
        .filter((s) => ids.has(s.webOfferId))
        .sort((a, b) => a.bookedAt.localeCompare(b.bookedAt));
      if (mine.length === 0)
        return { openAtChosen: false, nextLabel: null, any: false, chosenLabel: null };
      const inChosenHour =
        chosenHour != null ? mine.filter((s) => etHour(s.bookedAt) === chosenHour) : [];
      const openAtChosen = inChosenHour.length > 0;
      // `mine` is sorted ascending, so inChosenHour[0] is the earliest start in the
      // chosen hour. Show its precise time only when it's offset from the top of the
      // hour (the reopen case) — the common :00 start keeps the bare hour label.
      const chosenStart = inChosenHour[0]?.bookedAt;
      const chosenLabel =
        chosenStart && etMinutesOfDay(chosenStart) % 60 !== 0 ? formatSlotTime(chosenStart) : null;
      const atOrAfter =
        chosenHour != null ? mine.find((s) => etHour(s.bookedAt) >= chosenHour) : undefined;
      const next = atOrAfter ?? mine[0];
      return { openAtChosen, nextLabel: formatSlotTime(next.bookedAt), any: true, chosenLabel };
    };
    return { regular: compute(false), vip: compute(true) };
  }, [slots, experiences, item.date, chosenHour]);

  // Auto-select if only one tier exists
  useEffect(() => {
    if (loading) return;
    if (hasRegular && !hasVip && item.tier !== "regular") {
      onChange({ tier: "regular" } as Partial<BowlingLikeItem>);
    } else if (hasVip && !hasRegular && item.tier !== "vip") {
      onChange({ tier: "vip" } as Partial<BowlingLikeItem>);
    }
  }, [loading, hasRegular, hasVip]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-white/15"
          style={{ borderTopColor: CORAL }}
        />
      </div>
    );
  }

  // If only one tier, auto-advance (canAdvance will pass)
  if ((hasRegular && !hasVip) || (hasVip && !hasRegular)) {
    return (
      <div className="mx-auto max-w-md py-8 text-center">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-white/15 mx-auto"
          style={{ borderTopColor: CORAL }}
        />
        <p className="mt-3 text-sm text-white/40">Loading packages...</p>
      </div>
    );
  }

  function selectTier(tier: "regular" | "vip") {
    onChange({ tier } as Partial<BowlingLikeItem>);
  }

  function AvailBadge({ a }: { a: TierAvail }) {
    if (availLoading)
      return (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-white/45">
          <span
            className="h-3 w-3 animate-spin rounded-full border-2 border-white/20"
            style={{ borderTopColor: "#fff" }}
          />
          Checking availability…
        </span>
      );
    if (a.openAtChosen)
      return (
        <span className="text-[11px] font-semibold" style={{ color: "#22c55e" }}>
          ✓ Open at {a.chosenLabel ?? (chosenHour != null ? formatHour(chosenHour) : "your time")}
        </span>
      );
    if (a.any && a.nextLabel)
      return (
        <span className="text-[11px] font-semibold" style={{ color: "#f59e0b" }}>
          Next available {a.nextLabel}
        </span>
      );
    return <span className="text-[11px] text-white/35">Sold out this day</span>;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="text-center">
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">
          Choose Your Experience
        </h2>
        <p className="mt-1 text-sm text-white/40">
          Standard lanes or the VIP suite with NeoVerse technology
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Regular */}
        {hasRegular && (
          <button
            type="button"
            aria-label="Select Regular bowling experience"
            onClick={() => selectTier("regular")}
            className="group relative overflow-hidden rounded-2xl border transition-all"
            style={{
              borderColor: item.tier === "regular" ? CORAL : "rgba(255,255,255,0.1)",
              boxShadow: item.tier === "regular" ? `0 0 20px ${CORAL}40` : undefined,
            }}
          >
            <video
              src={`${BLOB}/videos/headpinz-bowling.mp4`}
              autoPlay
              loop
              muted
              playsInline
              className="h-40 w-full object-cover opacity-60 transition-opacity group-hover:opacity-80"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 p-4">
              <h3
                className="font-display text-xl uppercase tracking-widest"
                style={{ color: CORAL }}
              >
                Regular
              </h3>
              <p className="mt-1 text-xs text-white/60">Classic HeadPinz bowling lanes</p>
              <div className="mt-1.5">
                <AvailBadge a={tierAvail.regular} />
              </div>
            </div>
          </button>
        )}

        {/* VIP */}
        {hasVip && (
          <button
            type="button"
            aria-label="Select VIP bowling experience"
            onClick={() => selectTier("vip")}
            className="group relative overflow-hidden rounded-2xl border transition-all"
            style={{
              borderColor: item.tier === "vip" ? GOLD : "rgba(255,255,255,0.1)",
              boxShadow: item.tier === "vip" ? `0 0 20px ${GOLD}40` : undefined,
            }}
          >
            <video
              src={`${BLOB}/videos/headpinz-neoverse-v2.mp4`}
              autoPlay
              loop
              muted
              playsInline
              className="h-40 w-full object-cover opacity-60 transition-opacity group-hover:opacity-80"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 p-4">
              <h3
                className="font-display text-xl uppercase tracking-widest"
                style={{ color: GOLD }}
              >
                VIP
              </h3>
              <p className="mt-1 text-xs text-white/60">NeoVerse + HyperBowling premium suite</p>
              <div className="mt-1.5">
                <AvailBadge a={tierAvail.vip} />
              </div>
            </div>
          </button>
        )}
      </div>
    </div>
  );
};

const BowlingTierStep: StepDef<BowlingItem> = {
  id: "bowling-tier",
  title: "Experience",
  Component: BowlingTierStepComponent as StepDef<BowlingItem>["Component"],
  isVisible: () => true,
  canAdvance: (item) => (item.tier ? true : { reason: "Choose Regular or VIP" }),
};

export default BowlingTierStep;
