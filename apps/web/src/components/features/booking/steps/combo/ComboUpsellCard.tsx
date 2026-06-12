"use client";

import { useState } from "react";
import type { BookingSession } from "~/features/booking";
import { clearBookingSession } from "~/features/booking/hooks";
import { abandonBooking } from "~/features/booking/service/checkout";
import { scheduleForDate } from "~/features/booking/service/race-pricing";
import { comboPriceCentsForDate, enabledCombos } from "~/features/combos";
import { clarityEvent } from "~/lib/clarity";

const GOLD = "#FFD700";

/**
 * "Be the VIP" upsell — shown inside the NORMAL race flow's product step
 * (owner ask): for just $X more than the race they're looking at, the guest
 * gets the whole Ultimate VIP Experience (second race, VIP bowling, license,
 * POV, perks). $X = combo per-person price for their date minus the cheapest
 * single race (+ license for new racers, since they must buy one anyway).
 *
 * Upgrading starts a FRESH combo session: the combo wizard only seeds an
 * empty cart (it never clobbers one), so we release any early vendor holds,
 * clear the session, and enter /book/combo/[id]/v2. Confirmed with the guest
 * first whenever anything is already held.
 */
export function ComboUpsellCard({
  session,
  date,
  baselineCents,
  baselineLabel,
}: {
  session: BookingSession;
  date: string | null;
  /** Per-person cents the guest would pay on the CURRENT path (race [+license]). */
  baselineCents: number | null;
  baselineLabel: string;
}) {
  const [switching, setSwitching] = useState(false);

  // Already a combo session, or no premium combo to sell.
  const combo = enabledCombos().find((c) => c.premium) ?? enabledCombos()[0];
  if (session.comboSpecialId || !combo) return null;
  // Wrong complex, or a junior party on Mega Tuesday (combo infeasible).
  if (session.center && session.center !== combo.center) return null;
  if (
    date &&
    scheduleForDate(date) === "mega" &&
    session.party.some((m) => (m.category ?? "adult") === "junior")
  ) {
    return null;
  }

  const comboCents = date ? comboPriceCentsForDate(combo, date) : combo.price.weekday;
  const deltaCents = baselineCents != null ? Math.max(0, comboCents - baselineCents) : null;

  async function upgrade() {
    if (switching) return;
    setSwitching(true);
    clarityEvent("upsell:combo:accepted");
    try {
      const hasHolds =
        !!session.bmiBillId ||
        session.items.some(
          (i) => (i.kind === "bowling" || i.kind === "kbf") && i.qamfReservationId,
        );
      if (hasHolds) {
        const ok = window.confirm(
          `Switch to the ${combo.name}? Your current selections will be released so we can build your VIP schedule.`,
        );
        if (!ok) {
          setSwitching(false);
          return;
        }
        await abandonBooking(session);
      }
      clearBookingSession();
      window.location.href = `/book/combo/${combo.id}/v2`;
    } catch {
      setSwitching(false);
    }
  }

  return (
    <div
      className="rounded-2xl border p-4 sm:p-5"
      style={{
        borderColor: `${GOLD}55`,
        backgroundColor: `${GOLD}0d`,
        boxShadow: `0 0 24px ${GOLD}1f`,
      }}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p
            className="font-display text-lg font-black uppercase tracking-widest"
            style={{ color: GOLD }}
          >
            {deltaCents != null && deltaCents > 0
              ? `For just $${(deltaCents / 100).toFixed(0)} more — be the VIP!`
              : "Be the VIP!"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-white/60">
            The <strong className="text-white/85">{combo.name}</strong>:{" "}
            {combo.includes.join(" + ")}
            {combo.durationLabel ? ` — ${combo.durationLabel.toLowerCase()}` : ""}.{" "}
            {deltaCents != null && deltaCents > 0
              ? `$${(comboCents / 100).toFixed(0)}/person vs ${baselineLabel}.`
              : `$${(comboCents / 100).toFixed(0)}/person.`}
          </p>
        </div>
        <button
          type="button"
          disabled={switching}
          onClick={() => void upgrade()}
          className="shrink-0 rounded-full px-5 py-2.5 text-sm font-bold uppercase tracking-wider transition-all hover:scale-105 disabled:opacity-60"
          style={{ backgroundColor: GOLD, color: "#0a1628", boxShadow: `0 0 18px ${GOLD}40` }}
        >
          {switching ? "Switching…" : "Upgrade to VIP"}
        </button>
      </div>
    </div>
  );
}
