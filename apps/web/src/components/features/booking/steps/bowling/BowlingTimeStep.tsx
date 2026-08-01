"use client";

/**
 * v3 bowling TIME step — the ONE place the guest picks a time
 * (single-time-pick flow, 2026-07-19; pattern owner asked for: the kiosk
 * "Next Available" hero + slot list, built off KioskSlotStep).
 *
 * The Experience step already fixed the offer + duration, so every slot
 * shown here comes from the ACCURATE availability mode — genuinely bookable
 * for this exact package and duration. Tapping the hero or a grid pill
 * creates the QAMF hold immediately (eager hold, releasing any superseded
 * hold); on a race ("just taken") the grid refetches and an amber banner
 * explains. No auto-pick, no widening, no second confirmation.
 */

import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { qamfCenterIdForCode } from "~/features/booking";
import type { BowlingItem, KbfItem, StepDef } from "~/features/booking";
import type {
  BowlingExperienceWithDetails,
  BowlingExperienceDurationOption,
} from "@/lib/bowling-db";
import { clarityTag, clarityEvent } from "~/lib/clarity";
import {
  QAMF_TO_CENTER_CODE,
  bowlingCartConflicts,
} from "~/features/booking/service/bowling-hours";
import {
  bowlingLaneCount,
  buildBowlingLineItems,
  effectiveBowlingOptionId,
  holdBowlingSlot,
  isPerLaneExperience,
  slotAllowedForExperience,
} from "~/features/booking/service/bowling-offer";
import {
  useBowlingExperiences,
  useOfferSlots,
} from "~/features/booking/hooks/useBowlingAvailability";
import {
  etHour,
  etMinutesOfDay,
  fetchJsonWithRetry,
  parseAvailabilities,
  type AvailabilitySlot,
  type RawAvailability,
} from "./availability-client";
import { NextAvailableCard } from "../../bowling/NextAvailableCard";
import { TimeSlotGrid, type GridSlot } from "../../bowling/TimeSlotGrid";
import { VipUpgradeModal } from "../../bowling/VipUpgradeModal";
// Kiosk-only (kiosk.css keyframes drive it — web keeps the pulse skeleton).
import { BrandedLoader } from "~/features/kiosk/components/BrandedLoader";

// Bowling wizard accent — owner 2026-07-19: bowling reads BLUE ("red just
// seems negative"); FastTrax red stays on racing only. VIP keeps gold.
const BLUE = "#00E2E5";
const GOLD = "#FFD700";

type BowlingLikeItem = BowlingItem | KbfItem;

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

function formatDateLabel(date: string, todayLabel: boolean): string {
  if (todayLabel) return "today";
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

const BowlingTimeStepComponent: StepDef<BowlingLikeItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
  setBusy,
}) => {
  const centerId = item.qamfCenterId ?? qamfCenterIdForCode(session.center);
  const centerCode = centerId != null ? (QAMF_TO_CENTER_CODE[centerId] ?? null) : null;
  const kind =
    item.kind === "kbf" ? "kbf" : (item as BowlingItem).variant === "hourly" ? "hourly" : "open";
  const availKind = kind === "kbf" ? "kbf" : "open,hourly";
  const playerCount =
    item.kind === "bowling"
      ? (item as BowlingItem).playerCount
      : (item as KbfItem).bowlers.length + (item as KbfItem).paidAdults;
  const laneCount = bowlingLaneCount(playerCount);
  const kiosk = !!session.context?.kiosk;
  const variant = kiosk ? ("kiosk" as const) : ("web" as const);
  const accent = item.tier === "vip" ? GOLD : BLUE;

  const [holding, setHolding] = useState(false);
  const [reservingAt, setReservingAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vipUpgrade, setVipUpgrade] = useState<{
    exp: BowlingExperienceWithDetails;
    bookedAt: string;
  } | null>(null);
  const vipOfferedRef = useRef(false);
  const queryClient = useQueryClient();

  const expQuery = useBowlingExperiences(centerCode, kind === "kbf");
  const exp = (expQuery.data ?? []).find((e) => e.id === item.experienceId) ?? null;
  const durationOpt: BowlingExperienceDurationOption | null =
    (exp?.durationOptions ?? []).find((d) => d.id === item.durationOptionId) ?? null;

  const slotsQuery = useOfferSlots({
    centerId,
    date: item.date,
    players: Math.max(playerCount, 1),
    kind: availKind,
    webOfferId: item.webOfferId,
    durationMinutes: item.durationMinutes,
    leadMinutes: kiosk ? 0 : 15,
  });

  const conflictOf = useMemo(
    () => bowlingCartConflicts(session, item.id, item.date, item.durationMinutes),
    [session, item.id, item.date, item.durationMinutes],
  );

  // Experience-scoped slot window (Midnight Madness shares the all-day
  // Fri-Sun offer but sells only 11:45 PM+): useOfferSlots fetches by
  // webOfferId, which can't distinguish the sharing experiences — without
  // this filter MM listed every daytime slot (2026-08-01 incident). The item
  // slug is stamped at selectExperience; exp?.slug covers a stale session.
  const expSlug = item.experienceSlug ?? exp?.slug ?? "";
  const slots = (slotsQuery.data ?? []).filter((s) =>
    slotAllowedForExperience(expSlug, etMinutesOfDay(s.bookedAt)),
  );
  const firstClear = slots.find((s) => conflictOf(s.bookedAt) == null) ?? null;
  const heroSelected = firstClear != null && item.bookedAt === firstClear.bookedAt;

  // One-time "sold out" signal (classic parity), keyed per lookup.
  const soldOutFiredRef = useRef<string | null>(null);
  if (!slotsQuery.isLoading && slotsQuery.data != null && slots.length === 0) {
    const key = `${item.date}:${item.webOfferId}:${item.durationMinutes}`;
    if (soldOutFiredRef.current !== key) {
      soldOutFiredRef.current = key;
      clarityTag("availability", "soldout");
      clarityEvent("availability:soldout");
    }
  }

  async function pickSlot(slot: AvailabilitySlot) {
    if (holding) return;
    // Re-tap of the already-held slot is a no-op (a second hold for the same
    // slot can 409 against our own hold when it consumed the last lane).
    if (item.qamfReservationId && item.bookedAt === slot.bookedAt) return;
    if (centerId == null || item.webOfferId == null || !exp) {
      setError("We couldn't tell which package this is for. Go back and re-select.");
      return;
    }
    if (kiosk && conflictOf(slot.bookedAt)) return; // kiosk hard-blocks conflicts

    setHolding(true);
    setReservingAt(slot.bookedAt);
    setError(null);
    setBusy?.(true);
    try {
      const effectiveOptionId = effectiveBowlingOptionId(durationOpt, exp, slot.optionId);
      const { qamfReservationId } = await holdBowlingSlot({
        centerId,
        webOfferId: item.webOfferId,
        optionId: effectiveOptionId,
        optionType: (slot.optionType ?? item.optionType ?? "Time") as "Game" | "Time" | "Unlimited",
        bookedAt: slot.bookedAt,
        players: playerCount,
        service: "BookForLater",
        // Lets the hold route apply experience-scoped windows (MM shares the
        // all-day Fri-Sun offer id).
        experienceSlug: exp.slug,
        previousHoldId: item.qamfReservationId,
        previousCenterId: item.qamfCenterId,
      });

      dispatch({
        type: "setBowlingHold",
        itemId: item.id,
        qamfReservationId,
        qamfCenterId: centerId,
      });
      onChange({
        bookedAt: slot.bookedAt,
        hour: etHour(slot.bookedAt),
        minute: etMinutesOfDay(slot.bookedAt) % 60,
        optionId: effectiveOptionId ?? null,
        optionType: (slot.optionType ?? item.optionType ?? null) as
          | "Game"
          | "Time"
          | "Unlimited"
          | null,
        lineItems: buildBowlingLineItems(exp, durationOpt, playerCount, laneCount),
        rawItems: [],
        hasBookingFee: true,
      } as Partial<BowlingLikeItem>);

      // VIP upsell (classic parity): after a Regular pick, offer the VIP
      // counterpart of the same kind at the same time — once per visit. The
      // Time step checks the VIP offer's accurate slots via the query cache.
      if (!exp.isVip && item.tier === "regular" && !vipOfferedRef.current) {
        const vipExp = (expQuery.data ?? []).find((e) => e.isVip && e.kind === exp.kind);
        if (vipExp) {
          const vipSlots = await queryClient.fetchQuery<AvailabilitySlot[]>({
            queryKey: [
              "bowling-v3",
              "vip-upsell",
              centerId,
              item.date,
              playerCount,
              vipExp.qamfWebOfferId,
              slot.bookedAt,
            ],
            staleTime: 30_000,
            queryFn: async () => {
              const durParam = item.durationMinutes
                ? `&durationMinutes=${item.durationMinutes}`
                : "";
              const raw = await fetchJsonWithRetry<RawAvailability>(
                `/api/bowling/v2/availability?centerId=${centerId}&players=${playerCount}` +
                  `&startDate=${item.date}&kind=${availKind}&webOfferId=${vipExp.qamfWebOfferId}` +
                  `&hour=${etHour(slot.bookedAt)}&minute=${etMinutesOfDay(slot.bookedAt) % 60}` +
                  `&windowMinutes=15${durParam}&optionCheck=accurate`,
              );
              return parseAvailabilities(raw);
            },
          });
          const vipAtSame = vipSlots.find(
            (s) => s.webOfferId === vipExp.qamfWebOfferId && s.bookedAt === slot.bookedAt,
          );
          if (vipAtSame) {
            vipOfferedRef.current = true;
            setVipUpgrade({ exp: vipExp, bookedAt: slot.bookedAt });
            clarityEvent("upsell:vip:shown");
          }
        }
      }
    } catch (err) {
      // Typed 409s (option_unavailable / slot_taken) and plain failures land
      // here: refresh the grid so the stale slot disappears, keep the guest
      // on this step. Never auto-pick a replacement.
      setError(
        err instanceof Error && err.message
          ? `${err.message}`
          : "That time was just taken — pick another.",
      );
      void queryClient.invalidateQueries({ queryKey: ["bowling-v3", "offer-slots"] });
    } finally {
      setHolding(false);
      setReservingAt(null);
      setBusy?.(false);
    }
  }

  // Accept the VIP upsell: switch the item to the VIP counterpart and hold
  // its slot. If it was just taken, pickSlot surfaces the error and the
  // Regular hold the customer already has stands.
  async function acceptVipUpgrade() {
    if (!vipUpgrade) return;
    const { exp: vipExp, bookedAt } = vipUpgrade;
    setVipUpgrade(null);
    clarityEvent("upsell:vip:accepted");
    const vipDurOpt =
      (vipExp.durationOptions ?? []).find(
        (d) => d.durationMinutes === (item.durationMinutes ?? -1),
      ) ?? null;
    onChange({
      tier: "vip",
      experienceId: vipExp.id,
      experienceSlug: vipExp.slug,
      webOfferId: vipExp.qamfWebOfferId,
      durationOptionId: vipDurOpt?.id ?? null,
      durationMultiplier: vipDurOpt?.squareMultiplier ?? 1,
    } as Partial<BowlingLikeItem>);
    try {
      const effectiveOptionId = effectiveBowlingOptionId(vipDurOpt, vipExp, undefined);
      setHolding(true);
      setBusy?.(true);
      const { qamfReservationId } = await holdBowlingSlot({
        centerId: centerId!,
        webOfferId: vipExp.qamfWebOfferId,
        optionId: effectiveOptionId,
        optionType: (vipExp.qamfOptionType ?? "Time") as "Game" | "Time" | "Unlimited",
        bookedAt,
        players: playerCount,
        service: "BookForLater",
        experienceSlug: vipExp.slug,
        previousHoldId: item.qamfReservationId,
        previousCenterId: item.qamfCenterId,
      });
      dispatch({
        type: "setBowlingHold",
        itemId: item.id,
        qamfReservationId,
        qamfCenterId: centerId!,
      });
      onChange({
        bookedAt,
        optionId: effectiveOptionId ?? null,
        lineItems: buildBowlingLineItems(vipExp, vipDurOpt, playerCount, laneCount),
      } as Partial<BowlingLikeItem>);
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "The VIP lane was just taken — your original time is still held.",
      );
    } finally {
      setHolding(false);
      setBusy?.(false);
    }
  }

  if (centerId == null) {
    return (
      <p className="py-8 text-center text-sm text-white/40">
        We couldn&apos;t tell which location this is for. Go back and re-select your center.
      </p>
    );
  }

  const durationLabel =
    durationOpt?.label ??
    (exp?.qamfOfferDurationMinutes ? `${exp.qamfOfferDurationMinutes} min` : null);
  const dateLabel = item.date ? formatDateLabel(item.date, kiosk) : "";
  const gridSlots: GridSlot[] = slots.map((s) => ({
    bookedAt: s.bookedAt,
    label: formatTime(s.bookedAt),
  }));
  const anyConflicts = slots.some((s) => conflictOf(s.bookedAt) != null);

  return (
    <div className={`mx-auto ${kiosk ? "max-w-none space-y-[32px]" : "max-w-2xl space-y-6"}`}>
      <div className="text-center">
        <h2
          className={`font-display uppercase tracking-widest text-white ${
            kiosk ? "text-[40px]" : "text-2xl"
          }`}
        >
          Pick Your Time
        </h2>
        <p className={`mt-1 text-white/40 ${kiosk ? "text-[24px]" : "text-sm"}`}>
          {exp ? exp.label : "Your package"}
          {durationLabel ? ` · ${durationLabel}` : ""} — every time shown is open right now
        </p>
      </div>

      {error && (
        <div
          className={`rounded-xl border border-amber-500/40 bg-amber-500/10 text-center text-amber-100 ${
            kiosk ? "px-[28px] py-[20px] text-[26px]" : "p-3 text-sm"
          }`}
        >
          {error}
        </div>
      )}

      {slotsQuery.isLoading ? (
        kiosk ? (
          // Kiosk design rule: anything that loads shows the logo loader
          // (kiosk.css keyframes) — never a bare skeleton.
          <div className="flex justify-center py-[80px]">
            <BrandedLoader
              brand={session.entryBrand}
              label="Checking lane times"
              sublabel="Finding every open lane right now"
            />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="h-36 animate-pulse rounded-2xl bg-white/[0.05]" aria-hidden />
            <div className="flex flex-wrap gap-2" aria-hidden>
              {Array.from({ length: 8 }).map((_, i) => (
                <span key={i} className="h-9 w-20 animate-pulse rounded-lg bg-white/[0.05]" />
              ))}
            </div>
          </div>
        )
      ) : slotsQuery.isError ? (
        <div className="space-y-3 text-center">
          <p className={`text-white/50 ${kiosk ? "text-[26px]" : "text-sm"}`}>
            Couldn&apos;t check lane times. This is usually momentary.
          </p>
          <button
            type="button"
            onClick={() => void slotsQuery.refetch()}
            className={`rounded-full font-bold uppercase tracking-wider ${
              kiosk ? "k-btn-primary px-[40px] py-[18px] text-[24px]" : "px-6 py-2.5 text-sm"
            }`}
            style={kiosk ? undefined : { backgroundColor: accent, color: "#0a1628" }}
          >
            Try again
          </button>
        </div>
      ) : slots.length === 0 ? (
        <div className="space-y-3 text-center">
          <p className={`text-white/50 ${kiosk ? "text-[26px]" : "text-sm"}`}>
            No {exp?.label ?? "package"} lanes {kiosk ? "left today" : `on ${dateLabel}`}
            {durationLabel ? ` for ${durationLabel}` : ""}.
          </p>
          <p className={`text-white/35 ${kiosk ? "text-[24px]" : "text-xs"}`}>
            {kiosk
              ? "The front desk can help with walk-in availability — or go back and try a different package."
              : "Go back to switch packages or pick a different date."}
          </p>
        </div>
      ) : (
        <>
          {firstClear ? (
            <NextAvailableCard
              variant={variant}
              eyebrow={`Next available · ${dateLabel}`}
              timeLabel={formatTime(firstClear.bookedAt)}
              subline={
                holding && reservingAt === firstClear.bookedAt
                  ? "Holding your lane…"
                  : heroSelected
                    ? kiosk
                      ? "Held for you — hit Continue to keep going"
                      : "Held for you — continue to lock it in"
                    : kiosk
                      ? "Tap to grab it — we'll hold your lane"
                      : "Tap to lock it in — we'll hold your lane for 15 minutes"
              }
              accent={accent}
              selected={heroSelected}
              busy={holding && reservingAt === firstClear.bookedAt}
              onTap={() => void pickSlot(firstClear)}
            />
          ) : null}

          {gridSlots.length > (firstClear ? 1 : 0) && (
            <div>
              <div
                className={
                  kiosk
                    ? "k-eyebrow mb-[16px] text-white/40"
                    : "mb-3 text-[11px] uppercase tracking-[2px] text-white/35"
                }
              >
                Or pick another time
              </div>
              <TimeSlotGrid
                variant={variant}
                slots={gridSlots}
                selectedAt={item.bookedAt}
                reservingAt={reservingAt}
                accent={accent}
                conflictOf={conflictOf}
                disabled={holding}
                onPick={(slot) => {
                  const full = slots.find((s) => s.bookedAt === slot.bookedAt);
                  if (full) void pickSlot(full);
                }}
              />
              {anyConflicts && (
                <p className={`mt-3 text-white/40 ${kiosk ? "text-[22px]" : "text-[11px]"}`}>
                  {kiosk
                    ? "Crossed-out times overlap something you've already booked this visit."
                    : "Outlined times overlap another activity in your cart — you can still pick them."}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {vipUpgrade &&
        (() => {
          const regPrice = exp?.items.find((i) => i.sortOrder === 0)?.priceCents ?? 0;
          const vipPrice = vipUpgrade.exp.items.find((i) => i.sortOrder === 0)?.priceCents ?? 0;
          return (
            <VipUpgradeModal
              variant={variant}
              exp={vipUpgrade.exp}
              deltaCents={vipPrice - regPrice}
              perLane={isPerLaneExperience(vipUpgrade.exp)}
              busy={holding}
              onAccept={() => void acceptVipUpgrade()}
              onDecline={() => {
                clarityEvent("upsell:vip:declined");
                setVipUpgrade(null);
              }}
            />
          );
        })()}
    </div>
  );
};

const BowlingTimeStep: StepDef<BowlingItem> = {
  id: "bowling-time",
  title: "Time",
  Component: BowlingTimeStepComponent as StepDef<BowlingItem>["Component"],
  isVisible: () => true,
  canAdvance: (item) =>
    item.bookedAt && item.qamfReservationId ? true : { reason: "Tap a time to hold your lane" },
};

export default BowlingTimeStep;
