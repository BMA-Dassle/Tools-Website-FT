"use client";

/**
 * v3 bowling EXPERIENCE step — merged Tier + Package + duration screen
 * (single-time-pick flow, 2026-07-19).
 *
 * Replaces the classic BowlingTierStep + the package cards of
 * BowlingOfferStep: one tier-sectioned list (Classic coral / VIP gold —
 * mirrors the July RaceProductStep redesign), each package an ExperienceCard
 * with inline duration chips and an accurate "Next lane at …" hint from ONE
 * shared day scan. Selecting a card/duration writes the offer config only —
 * the TIME is picked exactly once, on the next step, from genuinely bookable
 * slots. All selection happens in click handlers, never effects (React 19
 * strict-mode rule).
 */

import { useMemo } from "react";
import { qamfCenterIdForCode } from "~/features/booking";
import type { BowlingItem, KbfItem, StepDef } from "~/features/booking";
import type {
  BowlingExperienceWithDetails,
  BowlingExperienceDurationOption,
} from "@/lib/bowling-db";
import { KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS } from "~/features/booking/service/kbf-pricing";
import { QAMF_TO_CENTER_CODE } from "~/features/booking/service/bowling-hours";
import { isPerLaneExperience, releaseBowlingHold } from "~/features/booking/service/bowling-offer";
import {
  useBowlingExperiences,
  useDayAvailability,
} from "~/features/booking/hooks/useBowlingAvailability";
import { ExperienceCard, type DurationChip } from "../../bowling/ExperienceCard";
import type { AvailabilitySlot } from "./availability-client";

// Bowling wizard accent — owner 2026-07-19: bowling reads BLUE ("red just
// seems negative"); FastTrax red stays on racing only. VIP keeps gold.
const BLUE = "#00E2E5";
const GOLD = "#FFD700";
const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";

type BowlingLikeItem = BowlingItem | KbfItem;

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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

const BowlingExperienceStepComponent: StepDef<BowlingLikeItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
}) => {
  // Resolve from the item's stamped center, else the SELECTED session center —
  // never a hardcoded fallback (rule: refuse rather than default to FM).
  const centerId = item.qamfCenterId ?? qamfCenterIdForCode(session.center);
  const centerCode = centerId != null ? (QAMF_TO_CENTER_CODE[centerId] ?? null) : null;
  const kind =
    item.kind === "kbf" ? "kbf" : (item as BowlingItem).variant === "hourly" ? "hourly" : "open";
  const availKind = kind === "kbf" ? "kbf" : "open,hourly";
  const playerCount =
    item.kind === "bowling"
      ? (item as BowlingItem).playerCount
      : (item as KbfItem).bowlers.length + (item as KbfItem).paidAdults;
  const kiosk = !!session.context?.kiosk;
  const variant = kiosk ? ("kiosk" as const) : ("web" as const);

  const expQuery = useBowlingExperiences(centerCode, kind === "kbf");
  const dayAvail = useDayAvailability({
    centerId,
    date: item.date,
    players: Math.max(playerCount, 1),
    kind: availKind,
    leadMinutes: kiosk ? 0 : 15,
  });

  // Day-of-week + kind + world-cup filtering (classic parity).
  const experiences = useMemo(() => {
    const raw = expQuery.data ?? [];
    const dow = item.date ? new Date(`${item.date}T12:00:00`).getDay() : new Date().getDay();
    return raw
      .filter((e) => !e.slug.startsWith("world-cup-"))
      .filter((e) => (kind === "kbf" ? true : e.kind !== "kbf"))
      .filter(
        (e) =>
          !Array.isArray(e.daysOfWeek) || e.daysOfWeek.length === 0 || e.daysOfWeek.includes(dow),
      );
  }, [expQuery.data, item.date, kind]);

  const regular = experiences.filter((e) => !e.isVip);
  const vip = experiences.filter((e) => e.isVip);

  // First accurate slot for an offer, optionally requiring a specific option
  // id to be verified-available at that slot.
  const slotsByOffer = useMemo(() => {
    const m = new Map<number, AvailabilitySlot[]>();
    for (const s of dayAvail.data ?? []) {
      const arr = m.get(s.webOfferId) ?? [];
      arr.push(s);
      m.set(s.webOfferId, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.bookedAt.localeCompare(b.bookedAt));
    return m;
  }, [dayAvail.data]);

  function firstSlotFor(exp: BowlingExperienceWithDetails, optionId: number | null): string | null {
    const slots = slotsByOffer.get(exp.qamfWebOfferId) ?? [];
    for (const s of slots) {
      if (
        optionId != null &&
        s.optionsVerified &&
        s.availableTimeOptionIds?.length &&
        !s.availableTimeOptionIds.includes(optionId)
      ) {
        continue;
      }
      return s.bookedAt;
    }
    return null;
  }

  function selectExperience(
    exp: BowlingExperienceWithDetails,
    durationOpt: BowlingExperienceDurationOption | null,
  ) {
    const changed =
      item.experienceId !== exp.id || (item.durationOptionId ?? null) !== (durationOpt?.id ?? null);
    if (!changed) return;

    // Changing the package/duration invalidates any live hold + picked time.
    if (item.qamfReservationId && centerId != null) {
      void releaseBowlingHold(item.qamfCenterId ?? centerId, item.qamfReservationId);
      dispatch({ type: "clearBowlingHold", itemId: item.id });
    }

    onChange({
      tier: exp.isVip ? "vip" : "regular",
      experienceId: exp.id,
      experienceSlug: exp.slug,
      webOfferId: exp.qamfWebOfferId,
      optionId: durationOpt?.qamfOptionId ?? exp.qamfOptionId ?? null,
      optionType: (exp.qamfOptionType as "Game" | "Time" | "Unlimited" | null) ?? null,
      durationOptionId: durationOpt?.id ?? null,
      durationMinutes: durationOpt?.durationMinutes ?? exp.qamfOfferDurationMinutes ?? null,
      durationMultiplier: durationOpt?.squareMultiplier ?? 1,
      bookedAt: null,
      hour: null,
      minute: null,
      lineItems: [],
    } as Partial<BowlingLikeItem>);
  }

  if (centerId == null || !centerCode) {
    return (
      <p className="py-8 text-center text-sm text-white/40">
        We couldn&apos;t tell which location this is for. Go back and re-select your center.
      </p>
    );
  }

  if (expQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-white/15"
          style={{ borderTopColor: BLUE }}
        />
      </div>
    );
  }

  function renderCard(exp: BowlingExperienceWithDetails) {
    const isVip = exp.isVip;
    const accent = isVip ? GOLD : BLUE;
    const videoUrl = isVip
      ? `${BLOB}/videos/headpinz-neoverse-v2.mp4`
      : `${BLOB}/videos/headpinz-bowling.mp4`;
    const primaryItem = exp.items.find((i) => i.sortOrder === 0);
    const priceCents = primaryItem?.priceCents ?? 0;
    const perLane = isPerLaneExperience(exp);
    const selected = item.experienceId === exp.id;

    // KBF games are free; the VIP lane carries a $2/person upcharge that IS
    // charged at checkout, so surface it rather than "$0.00" (classic parity).
    const priceLabel =
      kind === "kbf" && !isVip
        ? "Free"
        : kind === "kbf" && isVip
          ? centsToDollars(KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS)
          : centsToDollars(priceCents);
    const perLabel =
      kind === "kbf" && !isVip
        ? ""
        : kind === "kbf" && isVip
          ? " /person · VIP lane"
          : `/${perLane ? "lane" : "person"}`;

    // Per-duration total = unit price × the duration's multiplier (classic
    // parity — without it 1.5h and 2h render the same price). A chip is
    // unavailable when the ACCURATE day scan proves no slot fits it today.
    const durations: DurationChip[] = (exp.durationOptions ?? []).map((opt) => {
      const optPrice = Math.round((opt.overridePriceCents ?? priceCents) * opt.squareMultiplier);
      const anySlot = firstSlotFor(exp, opt.qamfOptionId);
      return {
        opt,
        priceLabel: `${centsToDollars(optPrice)}/${perLane ? "lane" : "person"}`,
        active: selected && item.durationOptionId === opt.id,
        unavailable: !dayAvail.isLoading && dayAvail.data != null && anySlot == null,
      };
    });

    const defaultOptionId = exp.durationOptions?.[0]?.qamfOptionId ?? exp.qamfOptionId ?? null;
    const first = firstSlotFor(exp, defaultOptionId);
    const hint = dayAvail.isLoading
      ? null
      : dayAvail.data == null
        ? null // hint fetch failed — hide rather than block (fail-open)
        : first
          ? `Next lane ${formatTime(first)}`
          : "Sold out this day";

    return (
      <ExperienceCard
        key={exp.id}
        variant={variant}
        exp={exp}
        accent={accent}
        selected={selected}
        priceLabel={priceLabel}
        perLabel={perLabel}
        durations={durations}
        hint={hint}
        hintLoading={dayAvail.isLoading}
        videoUrl={videoUrl}
        onSelect={(durationOpt) => selectExperience(exp, durationOpt)}
      />
    );
  }

  const sectionTitle = (label: string, meta: string, accent: string) => (
    <div className="flex items-baseline justify-between border-b border-white/10 pb-2">
      <h3
        className={`font-display uppercase tracking-widest ${kiosk ? "text-[32px]" : "text-lg"}`}
        style={{ color: accent }}
      >
        {label}
      </h3>
      <span className={`text-white/40 ${kiosk ? "text-[22px]" : "text-xs"}`}>{meta}</span>
    </div>
  );

  return (
    <div className={`mx-auto space-y-8 ${kiosk ? "max-w-none" : "max-w-2xl"}`}>
      <div className="text-center">
        <h2
          className={`font-display uppercase tracking-widest text-white ${
            kiosk ? "text-[40px]" : "text-2xl"
          }`}
        >
          Choose Your Experience
        </h2>
        <p className={`mt-1 text-white/40 ${kiosk ? "text-[24px]" : "text-sm"}`}>
          Pick a package — you&apos;ll choose from real open lane times next
        </p>
      </div>

      {experiences.length === 0 ? (
        <p className="py-8 text-center text-sm text-white/40">
          No bowling packages on this day. Go back and try another date.
        </p>
      ) : (
        <>
          {regular.length > 0 && (
            <section className="space-y-4">
              {sectionTitle("Classic Lanes", "Classic HeadPinz bowling", BLUE)}
              <div className="space-y-4">{regular.map(renderCard)}</div>
            </section>
          )}
          {vip.length > 0 && (
            <section className="space-y-4">
              {sectionTitle("VIP Suites", "NeoVerse wall · semi-private 8-lane suite", GOLD)}
              <div className="space-y-4">{vip.map(renderCard)}</div>
            </section>
          )}
        </>
      )}
    </div>
  );
};

const BowlingExperienceStep: StepDef<BowlingItem> = {
  id: "bowling-experience",
  title: "Experience",
  Component: BowlingExperienceStepComponent as StepDef<BowlingItem>["Component"],
  isVisible: () => true,
  canAdvance: (item) => {
    if (item.webOfferId == null || item.experienceId == null) {
      return { reason: "Pick a package" };
    }
    return true;
  },
};

export default BowlingExperienceStep;
