"use client";

import { useEffect, useMemo, useState } from "react";
import type { BookingSession, BowlingItem, RaceItem, StepDef } from "~/features/booking";
import { qamfCenterIdForCode } from "~/features/booking";
import { releaseHeatBmiLines } from "~/features/booking/service/checkout";
import { scheduleForDate } from "~/features/booking/service/race-pricing";
import type { RaceHeatAssignment } from "~/features/booking/state/types";
import {
  comboBowlingPatch,
  fetchComboLegCandidates,
  releaseComboBowlingHold,
  type ComboLegPayload,
} from "~/features/combos/combo-booking";
import { buildChains, wallClockLabel, type ChainResult } from "~/features/combos/combo-itinerary";
import {
  comboHeatsPerRacer,
  comboPriceCentsForDate,
  getComboSpecial,
  type ComboLeg,
  type ComboSpecial,
} from "~/features/combos/combo-specials";

/**
 * Combo-special wizard steps (Revision 2) — the combo's OWN guided flow.
 *
 * The customer picks ONE start time (the first leg); the chain engine
 * auto-schedules every later leg (earliest feasible, honoring the combo's
 * transition buffer). Registry-generic: both steps render whatever ordered
 * legs the ComboSpecial declares — a future combo with different legs is a
 * data change, not a new wizard.
 *
 *   - ComboStartTimeStep: feasibility-gated start picker. Only start times
 *     with a COMPLETE chain are selectable; picking one writes the race
 *     heats (every racer on the same block per race leg, tier/category/track
 *     stamped for the $0 build pair) and fully configures the bowling item
 *     (comboBowlingPatch) — no holds yet.
 *   - ComboItineraryStep: the assembled visit schedule. Advancing it is
 *     intercepted by BookingFlow, which books the BMI heats + creates the
 *     QAMF lane hold eagerly under the reservation timer.
 *
 * No product-picker step → no package upsell can appear mid-combo (owner
 * complaint). POV remains as the only race upsell, after the itinerary.
 */

const CYAN = "#00E2E5";
const GOLD = "#FFD700";

const TIER_LABEL: Record<string, string> = {
  starter: "Starter Race",
  intermediate: "Intermediate Race",
  pro: "Pro Race",
};

function legLabel(leg: ComboLeg): string {
  if (leg.kind === "race") return TIER_LABEL[leg.tier] ?? `${leg.tier} race`;
  if (leg.kind === "bowling") {
    const hours = leg.durationMinutes / 60;
    return `${hours % 1 === 0 ? hours : hours.toFixed(1)} Hours of Bowling`;
  }
  return leg.slug;
}

function legIcon(leg: ComboLeg): string {
  if (leg.kind === "race") return "🏁";
  if (leg.kind === "bowling") return "🎳";
  return "🎯";
}

function comboFor(session: BookingSession): ComboSpecial | null {
  return session.comboSpecialId ? getComboSpecial(session.comboSpecialId) : null;
}

function bowlingItemOf(session: BookingSession): BowlingItem | null {
  return (session.items.find((i) => i.kind === "bowling") as BowlingItem | undefined) ?? null;
}

/** Heats complete for the combo: one heat per racer per race leg, all picked. */
function heatsComplete(item: RaceItem, session: BookingSession): boolean {
  const combo = comboFor(session);
  if (!combo) return false;
  const expected = comboHeatsPerRacer(combo) * session.party.length;
  return (
    session.party.length > 0 &&
    item.heats.length === expected &&
    item.heats.every((h) => h.heatId && h.assignedTo)
  );
}

/* ───────────────────────── Start Time step ──────────────────────────── */

const ComboStartTimeComponent: StepDef<RaceItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
  setBusy,
}) => {
  const combo = comboFor(session);
  const date = item.date;
  const centerId = qamfCenterIdForCode(session.center) ?? 9172;
  const party = session.party;

  // Junior parties can't run the combo on Mega Tuesday (no junior Starter
  // Mega product) — say WHY instead of just showing zero times.
  const megaJuniorBlocked =
    !!date &&
    scheduleForDate(date) === "mega" &&
    party.some((m) => (m.category ?? "adult") === "junior");

  const partySignature = useMemo(
    () => party.map((m) => `${m.id}:${m.category ?? "adult"}:${m.isNewRacer ? 1 : 0}`).join("|"),
    [party],
  );

  // Keyed fetch result: loading/error are DERIVED (result key ≠ current key
  // → still loading), so the effect never sets state synchronously and stale
  // responses can't clobber a newer date/party selection.
  const fetchKey = `${combo?.id}|${date}|${partySignature}|${centerId}`;
  const [fetched, setFetched] = useState<{
    key: string;
    chains: Array<ChainResult<ComboLegPayload>>;
    error: string | null;
  } | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (!combo || !date || megaJuniorBlocked) return;
    let cancelled = false;
    void (async () => {
      try {
        const legCandidates = await fetchComboLegCandidates({
          combo,
          dateYmd: date,
          party,
          centerId,
        });
        if (cancelled) return;
        setFetched({
          key: fetchKey,
          chains: buildChains(legCandidates, combo.transitionMinutes),
          error: null,
        });
      } catch (err) {
        if (!cancelled) {
          setFetched({
            key: fetchKey,
            chains: [],
            error: err instanceof Error ? err.message : "Couldn't load availability.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchKey, megaJuniorBlocked]);

  const current = fetched?.key === fetchKey ? fetched : null;
  const chains = megaJuniorBlocked ? [] : (current?.chains ?? null);
  const loading = !megaJuniorBlocked && !!date && !!combo && current == null;
  const error = current?.error ?? null;

  // The currently-selected start (earliest heat in the cart).
  const selectedStart = useMemo(() => {
    const starts = item.heats.map((h) => h.heatId).filter((s): s is string => !!s);
    return starts.sort()[0] ?? null;
  }, [item.heats]);

  async function selectChain(result: ChainResult<ComboLegPayload>) {
    if (!combo || !result.chain || switching) return;
    setSwitching(true);
    setBusy?.(true);
    try {
      // Re-pick: release anything the PREVIOUS pick already held.
      const previouslyBooked = item.heats.filter((h) => h.bmiLineId);
      if (previouslyBooked.length > 0) {
        await releaseHeatBmiLines(session, previouslyBooked);
      }
      const bowling = bowlingItemOf(session);
      if (bowling?.qamfReservationId) {
        await releaseComboBowlingHold(bowling);
        dispatch({ type: "clearBowlingHold", itemId: bowling.id });
      }

      // Race legs → one heat per racer per leg, whole party on the same block.
      const heats: RaceHeatAssignment[] = [];
      for (const entry of result.chain) {
        if (entry.payload.kind !== "race") continue;
        const { tier, candidate } = entry.payload;
        for (const racer of party) {
          const category = (racer.category ?? "adult") as "adult" | "junior";
          const cat = candidate.perCategory[category];
          if (!cat) continue; // feasibility guaranteed this exists
          heats.push({
            productId: cat.productId,
            track: (cat.track as RaceHeatAssignment["track"]) ?? null,
            tier: tier as RaceHeatAssignment["tier"],
            category,
            heatId: candidate.start,
            bmiLineId: null,
            assignedTo: racer.id,
          });
        }
      }
      onChange({ heats });

      // Bowling leg → fully configure the bowling item (hold comes at the
      // itinerary confirm).
      const bowlingEntry = result.chain.find((e) => e.payload.kind === "bowling");
      if (bowling && bowlingEntry && bowlingEntry.payload.kind === "bowling" && date) {
        dispatch({
          type: "updateItem",
          id: bowling.id,
          patch: comboBowlingPatch(bowlingEntry.payload, party.length, date),
        });
      }
    } finally {
      setSwitching(false);
      setBusy?.(false);
    }
  }

  if (!combo) return null;

  const feasible = (chains ?? []).filter((c) => c.chain);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="text-center">
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">
          Pick Your Start Time
        </h2>
        <p className="mt-1 text-sm text-white/40">
          Choose when your {legLabel(combo.components[0])} starts — we&apos;ll schedule the rest of
          your {combo.name} around it.
        </p>
      </div>

      {megaJuniorBlocked && (
        <div
          className="rounded-xl px-4 py-3 text-center text-sm font-medium"
          style={{ backgroundColor: `${GOLD}14`, color: GOLD }}
        >
          Junior racers can&apos;t run the combo on Mega Track Tuesdays — please go back and pick
          another day.
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-center text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div
            className="h-8 w-8 animate-spin rounded-full border-2 border-white/15"
            style={{ borderTopColor: CYAN }}
          />
        </div>
      ) : !megaJuniorBlocked && (chains ?? []).length === 0 ? (
        <p className="py-8 text-center text-sm text-white/40">
          No {legLabel(combo.components[0]).toLowerCase()} times this day. Go back and try another
          date.
        </p>
      ) : (
        !megaJuniorBlocked && (
          <>
            {feasible.length === 0 && (chains ?? []).length > 0 && (
              <p className="py-2 text-center text-sm text-white/40">
                No start time fits the whole combo today — every chain runs past what&apos;s
                available. Try another date.
              </p>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(chains ?? []).map((c) => {
                const isFeasible = !!c.chain;
                const isSelected = selectedStart === c.anchor.startIso;
                const raceAnchor = c.anchor.payload.kind === "race" ? c.anchor.payload : null;
                const tracks = raceAnchor
                  ? [
                      ...new Set(
                        Object.values(raceAnchor.candidate.perCategory)
                          .map((p) => p?.track)
                          .filter(Boolean),
                      ),
                    ].join(" + ")
                  : "";
                return (
                  <button
                    key={c.anchor.startIso}
                    type="button"
                    disabled={!isFeasible || switching}
                    onClick={() => void selectChain(c)}
                    title={
                      isFeasible ? undefined : "No full combo schedule fits from this start time"
                    }
                    className="flex flex-col items-center gap-0.5 rounded-xl border px-3 py-2.5 text-sm font-semibold transition-all disabled:cursor-not-allowed"
                    style={{
                      backgroundColor: isSelected
                        ? CYAN
                        : isFeasible
                          ? "rgba(0,226,229,0.10)"
                          : "rgba(255,255,255,0.03)",
                      color: isSelected ? "#000418" : isFeasible ? CYAN : "rgba(255,255,255,0.25)",
                      borderColor: isSelected ? CYAN : "rgba(255,255,255,0.08)",
                      fontWeight: isSelected ? 800 : 600,
                      boxShadow: isSelected ? `0 0 14px ${CYAN}60` : undefined,
                    }}
                  >
                    <span>{wallClockLabel(c.anchor.startIso)}</span>
                    <span className="text-[10px] leading-none opacity-60">
                      {isFeasible ? tracks || " " : "Won't fit"}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )
      )}

      {/* Preview of the assembled schedule for the current selection */}
      {selectedStart && <ItineraryList item={item} session={session} compact />}
    </div>
  );
};

/* ───────────────────────── Itinerary review step ─────────────────────── */

function ItineraryList({
  item,
  session,
  compact = false,
}: {
  item: RaceItem;
  session: BookingSession;
  compact?: boolean;
}) {
  const combo = comboFor(session);
  const bowling = bowlingItemOf(session);
  if (!combo) return null;

  // Race-leg start times in itinerary order (all racers share blocks).
  const raceStarts = [
    ...new Set(item.heats.map((h) => h.heatId).filter((s): s is string => !!s)),
  ].sort();

  let raceIdx = 0;
  const rows = combo.components.map((leg, i) => {
    if (leg.kind === "race") {
      const start = raceStarts[raceIdx++];
      return { key: `leg-${i}`, leg, time: start ? wallClockLabel(start) : "—" };
    }
    if (leg.kind === "bowling") {
      return {
        key: `leg-${i}`,
        leg,
        time: bowling?.bookedAt ? wallClockLabel(bowling.bookedAt) : "—",
      };
    }
    return { key: `leg-${i}`, leg, time: "—" };
  });

  return (
    <div
      className="rounded-2xl border p-4"
      style={{ borderColor: `${CYAN}40`, backgroundColor: `${CYAN}0a` }}
    >
      {!compact && (
        <div
          className="mb-2 text-center text-[11px] uppercase tracking-[2px]"
          style={{ color: CYAN }}
        >
          Your visit
        </div>
      )}
      <ol className="space-y-1.5">
        {rows.map((r, i) => (
          <li key={r.key} className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 text-white/85">
              <span className="w-5 text-center">{legIcon(r.leg)}</span>
              <span>
                <span className="mr-1.5 text-white/30">{i + 1}.</span>
                {legLabel(r.leg)}
              </span>
            </span>
            <span className="font-semibold text-white">{r.time}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const ComboItineraryComponent: StepDef<RaceItem>["Component"] = ({ item, session }) => {
  const combo = comboFor(session);
  if (!combo || !item.date) return null;

  const unitCents = comboPriceCentsForDate(combo, item.date);
  const headcount = session.party.length;

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="text-center">
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">
          Your Schedule
        </h2>
        <p className="mt-1 text-sm text-white/40">
          {new Date(`${item.date}T12:00:00`).toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}{" "}
          · {headcount} {headcount === 1 ? "person" : "people"}
        </p>
      </div>

      <ItineraryList item={item} session={session} />

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-white/60">{combo.name}</span>
          <span className="font-bold text-white">
            ${(unitCents / 100).toFixed(2)}
            <span className="text-xs font-normal text-white/40">/person</span>
          </span>
        </div>
        <div className="mt-1.5 flex items-center justify-between border-t border-white/10 pt-1.5">
          <span className="text-white/60">
            × {headcount} {headcount === 1 ? "person" : "people"}
          </span>
          <span className="font-bold" style={{ color: CYAN }}>
            ${((unitCents * headcount) / 100).toFixed(2)}
            <span className="text-xs font-normal text-white/40"> + tax</span>
          </span>
        </div>
      </div>

      <p className="text-center text-xs text-white/35">
        Hitting Next reserves your races and holds your bowling lane.
      </p>
    </div>
  );
};

/* ───────────────────────── StepDefs ─────────────────────────────────── */

const startTimeCanAdvance: StepDef<RaceItem>["canAdvance"] = (item, session) =>
  heatsComplete(item, session) && bowlingItemOf(session)?.bookedAt
    ? true
    : { reason: "Pick a start time" };

export const ComboStartTimeStep: StepDef<RaceItem> = {
  id: "combo-start",
  title: "Start Time",
  Component: ComboStartTimeComponent,
  isVisible: (_item, session) => !!session.comboSpecialId,
  canAdvance: startTimeCanAdvance,
};

export const ComboItineraryStep: StepDef<RaceItem> = {
  id: "combo-itinerary",
  title: "Schedule",
  Component: ComboItineraryComponent,
  isVisible: (_item, session) => !!session.comboSpecialId,
  canAdvance: startTimeCanAdvance,
};
