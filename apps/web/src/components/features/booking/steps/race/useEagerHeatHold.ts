"use client";

/**
 * Eager BMI heat holding — the tap-to-hold machinery shared by the single-race
 * grid AND the package grid (owner 2026-07-19: packages must "confirm as
 * you're selecting races" like regular racing; before this the package picker
 * was the v1 review-then-commit port and only wrote heats at a Confirm tap).
 *
 * Semantics (lifted verbatim from SingleRaceHeatPicker's holdHeats):
 *  - `holdingRef` serializes holds — a hold lazily creates the BMI bill; two
 *    concurrent holds would create two bills.
 *  - Optimistic: the cart is patched to `nextHeats` first, then held. On any
 *    failure the lines that DID book are released and the cart reverts, so it
 *    never shows a heat that isn't actually held.
 *  - `holdingKey` marks WHICH card is being held so the "Holding…" spinner
 *    shows on that card, not in a banner off-screen.
 *  - `setBusy` disables the wizard Next while a hold is in flight.
 *  - Success invalidates every availability query — the hold just consumed
 *    capacity the 60s-stale cache doesn't know about.
 */
import { useRef, useState } from "react";
import type { Dispatch } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { bookingKeys } from "~/features/booking";
import type { Action, BookingSession, RaceHeatAssignment, RaceItem } from "~/features/booking";
import { holdPickedHeats } from "~/features/booking/service/race";
import { releaseHeatBmiLines } from "~/features/booking/service/checkout";

export function useEagerHeatHold(args: {
  item: RaceItem;
  session: BookingSession;
  onChange: (patch: Partial<RaceItem>) => void;
  dispatch: Dispatch<Action>;
  setBusy?: (busy: boolean) => void;
}) {
  const { item, session, onChange, dispatch, setBusy } = args;
  const queryClient = useQueryClient();
  const [holding, setHolding] = useState(false);
  const [holdingKey, setHoldingKey] = useState<string | null>(null);
  const [holdError, setHoldError] = useState<string | null>(null);
  const holdingRef = useRef(false);

  /**
   * Hold a just-picked block all-or-nothing. Returns true on success.
   * `revertHeats` is what the cart reverts to on failure — defaults to the
   * item's heats at call time; the package "switch pick" path passes the
   * minus-old-pick set so a failed switch leaves the component honestly
   * unpicked instead of resurrecting the released pick.
   */
  const holdHeats = async (
    nextHeats: RaceHeatAssignment[],
    holdKey: string | null,
    revertHeats: RaceHeatAssignment[] = item.heats,
  ): Promise<boolean> => {
    if (holdingRef.current) return false;
    holdingRef.current = true;
    setHolding(true);
    setHoldingKey(holdKey);
    setHoldError(null);
    setBusy?.(true); // disable the wizard Next while this hold is in flight
    onChange({ heats: nextHeats });
    try {
      const res = await holdPickedHeats(session, { ...item, heats: nextHeats }, dispatch);
      if (!res.ok) {
        if (res.booked.length > 0) {
          await releaseHeatBmiLines(
            { ...session, bmiBillId: res.billId },
            res.booked.map((b) => ({ bmiLineId: b.bmiLineId })),
          );
        }
        onChange({ heats: revertHeats }); // revert to pre-pick
        setHoldError(`Couldn't hold that heat — ${res.error}. Please pick another time.`);
        return false;
      }
      // The hold just consumed capacity the 60s-stale availability cache
      // doesn't know about — refresh so the NEXT grid (e.g. the junior
      // leg after an adult pick) reads post-hold occupancy.
      queryClient.invalidateQueries({ queryKey: bookingKeys.bmi.availabilityAll });
      return true;
    } catch (err) {
      onChange({ heats: revertHeats });
      setHoldError(
        err instanceof Error
          ? `Couldn't hold that heat: ${err.message}`
          : "Couldn't hold that heat. Please try again.",
      );
      return false;
    } finally {
      holdingRef.current = false;
      setHolding(false);
      setHoldingKey(null);
      setBusy?.(false);
    }
  };

  return { holding, holdingKey, holdError, setHoldError, holdingRef, holdHeats };
}
