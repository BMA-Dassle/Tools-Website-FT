"use client";

/**
 * "How long?" — the Play Now duration step (FastTrax duckpin per-lane QR).
 *
 * Order per owner (2026-07-22 live test): ask the duration FIRST, then hold.
 * No hold exists when this step mounts — "Who's bowling?" only CHECKED the
 * scanned lane was free. We fetch the lane's availability (which durations
 * still fit before close) and show ONLY those; tapping one places the pinned
 * hold on the lane at that duration (releasing any previous pick first, so
 * changing your mind never collides with your own hold). Prices come from the
 * same per-lane buildBowlingLineItems the rest of the bowling flow uses, so
 * displayed == charged.
 */
import { useEffect, useState } from "react";
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
  const lane = item.pinnedLaneNumber ?? null;

  // Which durations still fit before close on THIS lane (close-clamped by the
  // availability route). null = not loaded yet; on fetch failure we fail open
  // to every configured duration — the hold on tap is the final authority.
  const [fittingOptionIds, setFittingOptionIds] = useState<number[] | null>(null);
  const [laneStillFree, setLaneStillFree] = useState(true);
  const [holding, setHolding] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (lane == null) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/bowling/v2/bowl-now/availability?lane=${lane}`, {
          cache: "no-store",
        });
        if (!r.ok || !alive) return;
        const data = (await r.json()) as {
          laneFree?: boolean;
          durations?: Array<{ minutes: number; optionId: number }>;
        };
        if (!alive) return;
        setLaneStillFree(data.laneFree !== false || !!item.qamfReservationId);
        if (Array.isArray(data.durations)) {
          setFittingOptionIds(data.durations.map((d) => d.optionId));
        }
      } catch {
        /* fail open — hold is the authority */
      }
    })();
    return () => {
      alive = false;
    };
    // Re-check when the lane changes (swap); a held session skips the free check.
  }, [lane, item.qamfReservationId]);

  const options = (exp?.durationOptions ?? [])
    .filter((d) => fittingOptionIds == null || fittingOptionIds.includes(d.qamfOptionId))
    .sort((a, b) => a.durationMinutes - b.durationMinutes);

  async function pick(d: BowlingExperienceDurationOption) {
    if (lane == null) return;
    const alreadyHeld = item.qamfReservationId && d.qamfOptionId === item.optionId;
    if (alreadyHeld) return; // re-tap of the held duration is a no-op
    setHolding(d.qamfOptionId);
    setError(null);
    setBusy?.(true);
    try {
      const r = await fetch("/api/bowling/v2/bowl-now/hold", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lane,
          players: playerCount,
          optionId: d.qamfOptionId,
          replaceReservationId: item.qamfReservationId ?? undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        // A prior hold was already released server-side — clear it locally so
        // the guest re-picks cleanly instead of advancing on a dead hold.
        if (item.qamfReservationId) {
          dispatch({ type: "clearBowlingHold", itemId: item.id });
        }
        setError(
          data.code === "lane_unavailable"
            ? `${typeof data.error === "string" ? data.error : `Lane ${lane} is in play.`} Go back to pick another open lane.`
            : typeof data.error === "string"
              ? data.error
              : "Couldn't hold that time — try again.",
        );
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
      setHolding(null);
      setBusy?.(false);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div>
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">How Long?</h2>
        <p className="mt-1 text-sm text-white/50">
          Lane {lane} — starting now. Tap a time to lock it in.
        </p>
      </div>

      {!laneStillFree && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
          Lane {lane} just went into play — go Back to pick another open lane.
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
          {error}
        </div>
      )}

      {expQuery.isLoading ? (
        <div className="h-24 animate-pulse rounded-2xl bg-white/[0.05]" aria-hidden />
      ) : options.length === 0 ? (
        <p className="text-sm text-white/50">
          No duckpin time fits before we close tonight — see the front desk.
        </p>
      ) : (
        <div className="space-y-3">
          {options.map((d) => {
            const selected = !!item.qamfReservationId && d.qamfOptionId === item.optionId;
            const price = exp ? priceOf(exp, d, playerCount, laneCount) : 0;
            const busy = holding === d.qamfOptionId;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => void pick(d)}
                disabled={holding != null}
                aria-pressed={selected}
                className={`flex w-full items-center justify-between rounded-2xl border-2 px-5 py-4 text-left disabled:opacity-60 ${
                  selected ? "border-[#00E2E5] bg-[#00E2E5]/10" : "border-white/15 bg-white/5"
                }`}
              >
                <span className="text-lg font-bold text-white">
                  {d.label ?? `${d.durationMinutes} min`}
                </span>
                <span className="text-base font-semibold text-white/80">
                  {busy ? "Holding…" : fmtUsd(price)}
                  {selected ? "  ✓ Held" : ""}
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
      : { reason: "Tap a time to hold your lane" },
};

export default BowlNowDurationStep;
