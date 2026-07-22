"use client";

/**
 * "How long?" — the Play Now duration step (FastTrax duckpin per-lane QR).
 *
 * The scan-time hold already pinned the lane at the LONGEST window that fits
 * before close (the ceiling, on item.durationMinutes) and stored its line
 * items, so checkout already works. This step lets the guest pick a SHORTER
 * (cheaper) duration: any option ≤ the ceiling is guaranteed to fit, and
 * picking one re-pins the same lane at that duration (the hold route releases
 * the previous hold). Prices come from the same per-lane buildBowlingLineItems
 * the rest of the bowling flow uses, so displayed == charged.
 */
import { useState } from "react";
import type { BowlingItem, StepDef } from "~/features/booking";
import type {
  BowlingExperienceWithDetails,
  BowlingExperienceDurationOption,
} from "@/lib/bowling-db";
import { FASTTRAX_QAMF_CENTER_ID } from "@/lib/qamf-centers";
import { QAMF_TO_CENTER_CODE } from "~/features/booking/service/bowling-hours";
import { useBowlingExperiences } from "~/features/booking/hooks/useBowlingAvailability";
import { buildBowlingLineItems, bowlingLaneCount } from "~/features/booking/service/bowling-offer";

const WEB_OFFER_ID = 5;

function priceOf(
  exp: BowlingExperienceWithDetails,
  durOpt: BowlingExperienceDurationOption,
  playerCount: number,
  laneCount: number,
): number {
  return buildBowlingLineItems(exp, durOpt, playerCount, laneCount).reduce(
    (sum, li) => sum + (li.priceCents ?? 0) * li.quantity,
    0,
  );
}

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const BowlNowDurationStepComponent: StepDef<BowlingItem>["Component"] = ({
  item,
  onChange,
  dispatch,
  setBusy,
}) => {
  const centerId = item.qamfCenterId ?? FASTTRAX_QAMF_CENTER_ID;
  const centerCode = QAMF_TO_CENTER_CODE[centerId] ?? null;
  const expQuery = useBowlingExperiences(centerCode, false);
  const exp = (expQuery.data ?? []).find((e) => e.qamfWebOfferId === WEB_OFFER_ID) ?? null;

  const playerCount = item.playerCount;
  const laneCount = bowlingLaneCount(playerCount);
  const ceiling = item.durationMinutes ?? Number.POSITIVE_INFINITY;
  const options = (exp?.durationOptions ?? [])
    .filter((d) => d.durationMinutes <= ceiling)
    .sort((a, b) => a.durationMinutes - b.durationMinutes);

  const [changing, setChanging] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(d: BowlingExperienceDurationOption) {
    if (d.qamfOptionId === item.optionId) return; // already selected
    if (item.pinnedLaneNumber == null) return;
    setChanging(d.qamfOptionId);
    setError(null);
    setBusy?.(true);
    try {
      const r = await fetch("/api/bowling/v2/bowl-now/hold", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lane: item.pinnedLaneNumber,
          players: playerCount,
          optionId: d.qamfOptionId,
          replaceReservationId: item.qamfReservationId ?? undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(typeof data.error === "string" ? data.error : "Couldn't switch duration.");
        return;
      }
      dispatch({
        type: "setBowlingHold",
        itemId: item.id,
        qamfReservationId: data.qamfReservationId,
        qamfCenterId: centerId,
      });
      onChange({
        durationMinutes: data.durationMinutes,
        optionId: data.optionId,
        optionType: "Time",
        webOfferId: data.webOfferId,
        bookedAt: data.bookedAt,
        experienceId: data.experienceId ?? null,
        experienceSlug: data.experienceSlug ?? null,
        durationOptionId: data.durationOptionId ?? null,
        durationMultiplier: data.durationMultiplier ?? 1,
        laneCount: data.laneCount ?? laneCount,
        lineItems: Array.isArray(data.lineItems) ? data.lineItems : [],
        hasBookingFee: true,
      } as Partial<BowlingItem>);
    } catch {
      setError("Connection hiccup — try again.");
    } finally {
      setChanging(null);
      setBusy?.(false);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div>
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">How Long?</h2>
        <p className="mt-1 text-sm text-white/50">
          Lane {item.pinnedLaneNumber} — starting now. Pick your time.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
          {error}
        </div>
      )}

      {expQuery.isLoading ? (
        <div className="h-24 animate-pulse rounded-2xl bg-white/[0.05]" aria-hidden />
      ) : options.length === 0 ? (
        <p className="text-sm text-white/50">
          No duckpin durations are available right now — see the front desk.
        </p>
      ) : (
        <div className="space-y-3">
          {options.map((d) => {
            const selected = d.qamfOptionId === item.optionId;
            const price = exp ? priceOf(exp, d, playerCount, laneCount) : 0;
            const busy = changing === d.qamfOptionId;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => void pick(d)}
                disabled={changing != null}
                aria-pressed={selected}
                className={`flex w-full items-center justify-between rounded-2xl border-2 px-5 py-4 text-left disabled:opacity-60 ${
                  selected ? "border-[#00E2E5] bg-[#00E2E5]/10" : "border-white/15 bg-white/5"
                }`}
              >
                <span className="text-lg font-bold text-white">
                  {d.label ?? `${d.durationMinutes} min`}
                </span>
                <span className="text-base font-semibold text-white/80">
                  {busy ? "…" : fmtUsd(price)}
                  {selected ? "  ✓" : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <p className="text-center text-xs text-white/35">
        Priced per lane · a small booking fee is added at checkout.
      </p>
    </div>
  );
};

const BowlNowDurationStep: StepDef<BowlingItem> = {
  id: "bowl-now-duration",
  title: "How long?",
  Component: BowlNowDurationStepComponent,
  isVisible: () => true,
  canAdvance: (item) =>
    item.qamfReservationId && item.durationMinutes
      ? true
      : { reason: "Pick how long you want to bowl" },
};

export default BowlNowDurationStep;
