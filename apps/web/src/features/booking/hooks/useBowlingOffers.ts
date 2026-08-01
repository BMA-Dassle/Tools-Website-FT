"use client";

/**
 * Shared data/behavior layer for the CLASSIC bowling "Choose a Package" step —
 * one brain, two skins. The web BowlingOfferStep and the kiosk-native
 * KioskBowlingOfferStep both render on top of this hook, so the experiences
 * catalog fetch, the QAMF fine-probe + full-day widen fallback (accurate
 * option mode), duration validation and the reserve hold live in exactly one
 * place. Extracted verbatim from BowlingOfferStep.tsx (2026-07-20); the
 * money-adjacent pieces already live in service/bowling-offer.ts and are
 * reused here. Any behavior change here changes BOTH surfaces; keep it
 * presentational-free. (The v3 single-time-pick flow has its own hooks —
 * useBowlingAvailability — and does not use this.)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch } from "react";
import type { Action } from "../state/machine";
import type { BowlingItem, KbfItem, BookingSession } from "../state/types";
import { qamfCenterIdForCode } from "../types";
import type {
  BowlingExperienceWithDetails,
  BowlingExperienceDurationOption,
} from "@/lib/bowling-db";
import {
  bowlingLaneCount,
  buildBowlingLineItems,
  effectiveBowlingOptionId,
  holdBowlingSlot,
  longestFittingOptionId,
  slotAllowedForExperience,
} from "../service/bowling-offer";
import { clarityTag, clarityEvent } from "~/lib/clarity";
import {
  type AvailabilitySlot,
  probeAvailability,
  parseAvailabilities,
  etHour,
  etMinutesOfDay,
} from "~/components/features/booking/steps/bowling/availability-client";
import { getPublicReopenMinutes } from "@/lib/group-events";
import { FASTTRAX_QAMF_CENTER_ID, FASTTRAX_CENTER_CODE } from "@/lib/qamf-centers";

export type BowlingLikeItem = BowlingItem | KbfItem;

const QAMF_CENTER_CODES: Record<number, string> = {
  9172: "TXBSQN0FEKQ11",
  3148: "PPTR5G2N0QXF7",
  [FASTTRAX_QAMF_CENTER_ID]: FASTTRAX_CENTER_CODE,
};

export function formatBookedTime(iso: string): string {
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

export function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Duration buttons filtered to only the options that actually fit. Gated on
 * optionsVerified: only the accurate server response filters options by real
 * lane occupancy — trusting the optimistic echo is exactly the "2h shown when
 * only 1.5h fits" bug. Empty when the experience has no duration options.
 */
export function validDurationOptionsFor(
  exp: BowlingExperienceWithDetails,
  expSlots: AvailabilitySlot[],
): BowlingExperienceDurationOption[] {
  if (!exp.durationOptions?.length) return [];
  return (exp.durationOptions ?? []).filter((opt) => {
    if (!expSlots.length) return true;
    if (!expSlots[0].optionsVerified) return true;
    const ids = expSlots[0].availableTimeOptionIds;
    return !ids?.length || ids.includes(opt.qamfOptionId);
  });
}

/** Fun 4 All near-closing notice: the primary (90-min) option isn't available
 *  at any of the offer's slots — only the shorter fallback is. */
export function isNearClosingOnly(
  exp: BowlingExperienceWithDetails,
  expSlots: AvailabilitySlot[],
): boolean {
  return (
    exp.slug.includes("fun-4-all") &&
    expSlots.length > 0 &&
    exp.qamfOptionId != null &&
    expSlots.every(
      (s) =>
        s.availableTimeOptionIds?.length && !s.availableTimeOptionIds.includes(exp.qamfOptionId!),
    )
  );
}

export interface UseBowlingOffersArgs {
  item: BowlingLikeItem;
  session: BookingSession;
  onChange: (patch: Partial<BowlingLikeItem>) => void;
  dispatch: Dispatch<Action>;
  /**
   * Offer the VIP counterpart after a Regular pick (drives the web upsell
   * modal). The kiosk renders its own always-visible VIP strip instead, so it
   * passes false — no upsell state is set and no upsell analytics fire.
   */
  offerVipUpsell?: boolean;
}

export function useBowlingOffers({
  item,
  session,
  onChange,
  dispatch,
  offerVipUpsell = true,
}: UseBowlingOffersArgs) {
  // Resolve from the item's stamped center, else the SELECTED session center —
  // never a hardcoded fallback. null = no center yet (the flow shows the center
  // picker); booking is blocked below until it's resolved.
  const centerId = item.qamfCenterId ?? qamfCenterIdForCode(session.center);
  const centerCode = centerId != null ? (QAMF_CENTER_CODES[centerId] ?? null) : null;
  const kind =
    item.kind === "kbf" ? "kbf" : (item as BowlingItem).variant === "hourly" ? "hourly" : "open";
  // Probe BOTH open + hourly so weekend time-bowling (Fri-Sun 1.5hr/2hr) shows
  // alongside open play; the experience list already includes hourly experiences.
  const availKind = kind === "kbf" ? "kbf" : "open,hourly";
  const playerCount =
    item.kind === "bowling"
      ? (item as BowlingItem).playerCount
      : (item as KbfItem).bowlers.length + (item as KbfItem).paidAdults;
  const laneCount = bowlingLaneCount(playerCount);

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
        const raw: BowlingExperienceWithDetails[] = Array.isArray(data) ? data : [];
        // World-cup experiences are ONLY bookable via the match-picker entry
        // (?experience=world-cup) — never here, where any-hour booking would
        // book a lane outside a match window.
        const all = raw.filter((e) => !e.slug.startsWith("world-cup-"));
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
    // Morning-only buyout: hide any start time before the public reopen (ET
    // minutes-of-day). Applied to both the fine and widened probes so the
    // "next available" surfaced is always at-or-after the reopen time.
    const reopenMins = item.date ? getPublicReopenMinutes(item.date) : null;
    const dropBeforeReopen = (arr: AvailabilitySlot[]) =>
      reopenMins == null ? arr : arr.filter((s) => etMinutesOfDay(s.bookedAt) >= reopenMins);
    void (async () => {
      try {
        // optionCheck=accurate (2026-07-19): the server duration-window-
        // filters each slot's Time options, so a 2-hour duration only shows
        // when the lane is actually free for 2 hours — the offer-accuracy
        // owner bug. optionsVerified on the parsed slots reflects it.
        const fine = dropBeforeReopen(
          parseAvailabilities(
            await probeAvailability(
              `/api/bowling/v2/availability?centerId=${centerId}&players=${playerCount}&startDate=${item.date}&kind=${availKind}&hour=${selectedHour}&minute=${item.minute ?? 0}&windowMinutes=45&optionCheck=accurate`,
            ),
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
            const wide = dropBeforeReopen(
              parseAvailabilities(
                await probeAvailability(
                  `/api/bowling/v2/availability?centerId=${centerId}&players=${playerCount}&startDate=${item.date}&kind=${availKind}&stepMinutes=30&optionCheck=accurate`,
                ),
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
    // experiences.length is a no-op dep (tierExperiences is a useMemo over
    // experiences, so its identity already changes with the list) — listed to
    // satisfy exhaustive-deps for the wait-for-experiences guard above.
  }, [
    centerId,
    playerCount,
    item.date,
    kind,
    availKind,
    selectedHour,
    item.minute,
    tierExperiences,
    experiences.length,
  ]);

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

  /** Hold a slot for an experience. Resolves true when the hold landed (the
   *  item patch is dispatched) — the kiosk skin auto-advances on true. */
  async function selectSlot(
    exp: BowlingExperienceWithDetails,
    slot: AvailabilitySlot,
    durationOpt: BowlingExperienceDurationOption | null,
  ): Promise<boolean> {
    // Never silently book a different complex — if the center didn't resolve
    // from the item or the session, refuse rather than defaulting to Fort Myers.
    if (centerId == null) {
      setError("We couldn't tell which location this is for. Go back and re-select your center.");
      return false;
    }

    // Re-tap of the already-held selection is a no-op (a second hold for the
    // same slot can 409 against our own hold when it consumed the last lane).
    if (
      item.qamfReservationId &&
      item.bookedAt === slot.bookedAt &&
      item.experienceId === exp.id &&
      (item.durationOptionId ?? null) === (durationOpt?.id ?? null)
    ) {
      return true;
    }

    setHoldBusy(true);
    setReservingAt(slot.bookedAt);
    setError(null);

    try {
      // Option precedence guard (Pizza Bowl / Fun 4 All short-booking bug) —
      // see effectiveBowlingOptionId in service/bowling-offer.ts. Experiences
      // that seed NO option at all (Midnight Madness on the shared Fri-Sun
      // Time offer) book the longest close-fitting option instead — the
      // slot's own optionId is a response-order guess that degrades to the
      // shortest duration.
      const effectiveOptionId =
        durationOpt == null && exp.qamfOptionId == null && !exp.durationOptions?.length
          ? (longestFittingOptionId(slot, experiences) ?? slot.optionId)
          : effectiveBowlingOptionId(durationOpt, exp, slot.optionId);

      // holdBowlingSlot releases the superseded hold first (re-pick after an
      // earlier selection used to leak the old hold for its full 10-min TTL).
      const { qamfReservationId } = await holdBowlingSlot({
        centerId,
        webOfferId: slot.webOfferId,
        optionId: effectiveOptionId,
        optionType: slot.optionType,
        bookedAt: slot.bookedAt,
        players: playerCount,
        service: "BookForLater",
        previousHoldId: item.qamfReservationId,
        previousCenterId: item.qamfCenterId,
      });

      const lineItems = buildBowlingLineItems(exp, durationOpt, playerCount, laneCount);

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
      if (offerVipUpsell && !exp.isVip && item.tier === "regular" && !vipOfferedRef.current) {
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
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Hold creation failed");
      return false;
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
  // `slug` scopes experience-specific slot windows (Midnight Madness shares
  // the all-day Fri-Sun offer but only sells its late-night window) — the
  // offer id alone can't distinguish the sharing experiences.
  function slotsForOffer(webOfferId: number, slug = ""): AvailabilitySlot[] {
    const atOffer = relevantSlots
      .filter(
        (s) =>
          s.webOfferId === webOfferId && slotAllowedForExperience(slug, etMinutesOfDay(s.bookedAt)),
      )
      .sort((a, b) => a.bookedAt.localeCompare(b.bookedAt));
    if (widened) return atOffer.slice(0, 8);
    const inHour = atOffer.filter((s) => etHour(s.bookedAt) === selectedHour);
    return inHour.length ? [inHour[0]] : [];
  }

  // Filter out hourly experience cards when no duration options are valid at
  // this time. availableTimeOptionIds is only trusted when the server ran the
  // accurate filter (optionsVerified) — the optimistic response echoes every
  // configured option and must not gate anything.
  const visibleExperiences = tierExperiences.filter((exp) => {
    // Midnight Madness: hide the card entirely outside its late-night window
    // (a permanent "sold out" card all day would read as a bug).
    if (
      exp.slug.startsWith("midnight-madness") &&
      slotsForOffer(exp.qamfWebOfferId, exp.slug).length === 0
    ) {
      return false;
    }
    if (!exp.durationOptions?.length) return true;
    const expSlots = slotsForOffer(exp.qamfWebOfferId, exp.slug);
    if (expSlots.length === 0) return true;
    if (!expSlots[0].optionsVerified) return true;
    const ids = expSlots[0].availableTimeOptionIds;
    if (!ids?.length) return true;
    return (exp.durationOptions ?? []).some((d) => ids.includes(d.qamfOptionId));
  });

  return {
    // context
    centerId,
    kind,
    playerCount,
    laneCount,
    selectedHour,
    // data
    experiences,
    tierExperiences,
    visibleExperiences,
    slotsForOffer,
    // status
    loading,
    holdBusy,
    reservingAt,
    error,
    widened,
    // duration selection
    selectedDurationOpt,
    setSelectedDurationOpt,
    // VIP upsell (web modal only — kiosk passes offerVipUpsell: false)
    vipUpgrade,
    setVipUpgrade,
    acceptVipUpgrade,
    // actions
    selectSlot,
  };
}
