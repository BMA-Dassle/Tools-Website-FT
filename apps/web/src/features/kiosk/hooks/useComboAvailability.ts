"use client";

/**
 * Is a combo special (e.g. the "Ultimate VIP Experience", id `race-bowl`)
 * actually bookable TODAY?
 *
 * Polls the SAME feasibility the booking start-time step computes — a synthetic
 * minimum-size adult party run through real BMI race-heat + QAMF VIP-lane
 * availability + `buildChains` — every 5 minutes (owner 2026-07-19). Used to
 * lock the kiosk's VIP buttons when no full race → VIP-lane → race itinerary
 * fits today (out of lanes, too late in the day, a league owns the suite, …).
 *
 * Defaults AVAILABLE and only flips false once a check PROVES infeasibility, and
 * a failed probe keeps the last known value — so a slow or erroring check never
 * FALSELY locks the button. Returns false immediately when the combo is disabled
 * or isn't offered at this center (it can't be booked there regardless).
 *
 * The whole feasibility fetch is client-safe (BMI via the /api/bmi proxy, lanes
 * via /api/bowling/v2/*), so this runs entirely in the kiosk browser.
 */
import { useEffect, useState } from "react";
import { buildChains, getComboSpecial } from "~/features/combos";
import { comboMinHeadcount, comboReorderFallbackEnabled } from "~/features/combos/combo-specials";
import { candidatesForOrdering, fetchComboLegCandidates } from "~/features/combos/combo-booking";
import { newPartyMember, qamfCenterIdForCode, type CenterCode } from "~/features/booking";
import { todayYmd } from "../service/first-available";

/** Owner 2026-07-19: re-check VIP feasibility every 5 minutes. */
const CHECK_INTERVAL_MS = 5 * 60_000;

export function useComboAvailability(comboId: string, center: CenterCode | null): boolean {
  const combo = getComboSpecial(comboId);
  const applicable = !!combo?.enabled && !!center && combo.center === center;
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    if (!combo || !applicable || !center) return;
    const centerId = qamfCenterIdForCode(center);
    if (centerId == null) return;
    let alive = true;

    // Representative walk-up: the combo's minimum party of new adult racers.
    const party = Array.from({ length: comboMinHeadcount(combo) }, (_, i) =>
      newPartyMember({ firstName: `probe${i + 1}`, category: "adult", isNewRacer: true }),
    );

    const check = async () => {
      try {
        const legCandidates = await fetchComboLegCandidates({
          combo,
          dateYmd: todayYmd(),
          party,
          centerId,
        });
        let feasible = buildChains(
          legCandidates,
          combo.transitionMinutes,
          combo.components.map((l) => l.maxWaitMinutes ?? null),
        ).some((c) => c.chain != null);
        // Match the booking step: with the reorder fallback enabled, a combo that
        // doesn't fit the primary order may still fit the reordered one.
        if (!feasible && comboReorderFallbackEnabled() && combo.fallbackComponents) {
          feasible = buildChains(
            candidatesForOrdering(combo.components, legCandidates, combo.fallbackComponents),
            combo.transitionMinutes,
            combo.fallbackComponents.map((l) => l.maxWaitMinutes ?? null),
            combo.fallbackComponents.map((l) => l.minWaitMinutes ?? null),
          ).some((c) => c.chain != null);
        }
        if (alive) setAvailable(feasible);
      } catch {
        /* BMI/QAMF blip — keep the last known value; never false-lock on error */
      }
    };

    void check();
    const timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [combo, applicable, center]);

  return applicable ? available : false;
}
