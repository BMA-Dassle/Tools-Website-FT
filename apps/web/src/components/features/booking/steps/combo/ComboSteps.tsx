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
import {
  buildChainFrom,
  buildChains,
  wallClockLabel,
  type ChainResult,
  type LegCandidate,
  type LegFilter,
} from "~/features/combos/combo-itinerary";
import {
  comboHeatsPerRacer,
  comboPriceCentsForDate,
  getComboSpecial,
  type ComboLeg,
  type ComboSpecial,
} from "~/features/combos/combo-specials";
import { modalBackdropProps } from "@/lib/a11y";
import { DISABLED_CARD, TRACK_BADGE, TRACK_CARD, TrackInfoBanner } from "../race/track-visuals";

/**
 * Combo-special wizard steps (Revision 2) — the combo's OWN guided flow.
 *
 * The customer picks ONE start time (the first leg) from a heat grid that
 * matches the normal Red/Blue race picker (same track-tinted cards, badges
 * and track banner). Picking a card opens a SCHEDULE CONFIRM modal showing
 * the auto-assembled visit (earliest feasible chain, transition buffers
 * honored) with a Red/Blue choice for later race legs where both tracks
 * still fit. Confirming writes the heats + fully configures the bowling
 * item; the Schedule step then books the BMI heats + creates the QAMF lane
 * hold on advance (intercepted by BookingFlow).
 *
 * Registry-generic: legs, included license/POV, buffers all come from the
 * ComboSpecial — a future combo is a data change, not a new wizard.
 *
 * No product-picker step → no package upsell can appear mid-combo (owner
 * complaint). The POV step is hidden too: the combo INCLUDES license + POV
 * (registry flags), auto-sold at $0 on BMI and absorbed in the flat price.
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

/* ───────────────── schedule confirm modal ───────────────────────────── */

function trackOf(c: LegCandidate<ComboLegPayload>): string | null {
  return c.payload.kind === "race" ? c.payload.candidate.track : null;
}

function ScheduleConfirmModal({
  combo,
  legCandidates,
  anchor,
  headcount,
  dateYmd,
  busy,
  onConfirm,
  onCancel,
}: {
  combo: ComboSpecial;
  legCandidates: Array<Array<LegCandidate<ComboLegPayload>>>;
  anchor: LegCandidate<ComboLegPayload>;
  headcount: number;
  dateYmd: string;
  busy: boolean;
  onConfirm: (chain: Array<LegCandidate<ComboLegPayload>>) => void;
  onCancel: () => void;
}) {
  // Per-leg track override (race legs after the anchor). null/absent = earliest.
  const [trackChoice, setTrackChoice] = useState<Record<number, string>>({});

  const filtersFor = (choices: Record<number, string>): Array<LegFilter<ComboLegPayload>> =>
    combo.components.map((leg, i) => {
      const chosen = choices[i];
      if (!chosen || leg.kind !== "race" || i === 0) return null;
      return (c: LegCandidate<ComboLegPayload>) => trackOf(c) === chosen;
    });

  const chain = useMemo(
    () => buildChainFrom(legCandidates, combo.transitionMinutes, anchor, filtersFor(trackChoice)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [legCandidates, combo, anchor, trackChoice],
  );

  // For each later race leg: which tracks still produce a full chain (keeping
  // the OTHER legs' current choices)? >1 option → show the Red/Blue picker.
  const trackOptionsByLeg = useMemo(() => {
    const out = new Map<number, string[]>();
    combo.components.forEach((leg, i) => {
      if (leg.kind !== "race" || i === 0) return;
      const tracks = [
        ...new Set(legCandidates[i]?.map(trackOf).filter((t): t is string => !!t)),
      ].sort();
      const viable = tracks.filter(
        (t) =>
          buildChainFrom(
            legCandidates,
            combo.transitionMinutes,
            anchor,
            filtersFor({ ...trackChoice, [i]: t }),
          ) != null,
      );
      if (viable.length > 0) out.set(i, viable);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legCandidates, combo, anchor, trackChoice]);

  const unitCents = comboPriceCentsForDate(combo, dateYmd);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/80 p-4 backdrop-blur-sm sm:items-center"
      {...modalBackdropProps(busy ? () => {} : onCancel)}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 p-5"
        style={{ backgroundColor: "#0a1128" }}
      >
        <h3 className="font-display text-xl uppercase tracking-widest text-white">Your Schedule</h3>
        <p className="mt-1 text-sm text-white/50">
          {new Date(`${dateYmd}T12:00:00`).toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}{" "}
          · {headcount} {headcount === 1 ? "person" : "people"}
        </p>

        {chain ? (
          <ol className="mt-4 space-y-2">
            {combo.components.map((leg, i) => {
              const entry = chain[i];
              const track = entry ? trackOf(entry) : null;
              const badge = track ? TRACK_BADGE[track] : null;
              const options = trackOptionsByLeg.get(i);
              return (
                <li
                  key={`leg-${i}`}
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5"
                >
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 text-white/85">
                      <span>{legIcon(leg)}</span>
                      {legLabel(leg)}
                      {badge && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${badge.bg} ${badge.text}`}
                        >
                          {track}
                        </span>
                      )}
                    </span>
                    <span className="font-semibold text-white">
                      {entry ? wallClockLabel(entry.startIso) : "—"}
                    </span>
                  </div>
                  {options && options.length > 1 && (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[11px] uppercase tracking-wider text-white/35">
                        Track
                      </span>
                      {options.map((t) => {
                        const active = (trackChoice[i] ?? track) === t;
                        const theme = TRACK_CARD[t];
                        return (
                          <button
                            key={t}
                            type="button"
                            disabled={busy}
                            onClick={() => setTrackChoice((prev) => ({ ...prev, [i]: t }))}
                            className={`rounded-lg border px-3 py-1 text-xs font-bold uppercase transition-colors ${
                              active
                                ? (theme?.selected ?? "border-white bg-white/20")
                                : `${theme?.base ?? "border-white/15 bg-white/5"} ${theme?.baseHover ?? ""}`
                            } ${TRACK_BADGE[t]?.text ?? "text-white"}`}
                          >
                            {t}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="mt-4 text-sm text-amber-300">
            That track combination doesn&apos;t fit anymore — pick a different track or start time.
          </p>
        )}

        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-white/60">{combo.name}</span>
            <span className="font-bold text-white">
              ${(unitCents / 100).toFixed(2)}
              <span className="text-xs font-normal text-white/40">/person</span>
            </span>
          </div>
          {(combo.includesLicense || combo.includedPovPerRacer > 0) && (
            <p className="mt-1 text-xs" style={{ color: GOLD }}>
              ✓ Racing license{combo.includedPovPerRacer > 0 ? " + POV race video" : ""} included
            </p>
          )}
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

        <div className="mt-5 flex gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="flex-1 rounded-xl border border-white/20 px-4 py-2.5 text-sm font-semibold text-white/70 transition-colors hover:border-white/40 hover:text-white disabled:opacity-50"
          >
            Pick another time
          </button>
          <button
            type="button"
            disabled={busy || !chain}
            onClick={() => chain && onConfirm(chain)}
            className="flex-1 rounded-xl bg-[#00E2E5] px-4 py-2.5 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Saving…" : "Confirm Schedule"}
          </button>
        </div>
      </div>
    </div>
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
    legCandidates: Array<Array<LegCandidate<ComboLegPayload>>>;
    chains: Array<ChainResult<ComboLegPayload>>;
    error: string | null;
  } | null>(null);
  const [switching, setSwitching] = useState(false);
  const [pendingAnchor, setPendingAnchor] = useState<LegCandidate<ComboLegPayload> | null>(null);

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
          legCandidates,
          chains: buildChains(legCandidates, combo.transitionMinutes),
          error: null,
        });
      } catch (err) {
        if (!cancelled) {
          setFetched({
            key: fetchKey,
            legCandidates: [],
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

  // The currently-selected start (earliest heat in the cart) + its track.
  const selected = useMemo(() => {
    const sorted = item.heats
      .filter((h): h is RaceHeatAssignment & { heatId: string } => !!h.heatId)
      .sort((a, b) => a.heatId.localeCompare(b.heatId));
    return sorted[0] ? { start: sorted[0].heatId, track: sorted[0].track } : null;
  }, [item.heats]);

  async function confirmChain(chain: Array<LegCandidate<ComboLegPayload>>) {
    if (!combo || switching) return;
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
      for (const entry of chain) {
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
      // Included POV (registry): auto-sell exactly this many — the flat price
      // covers them; the Square POV line is suppressed in combo mode.
      onChange({
        heats,
        povQuantity: combo.includedPovPerRacer * party.length,
        povSold: false,
      });

      // Bowling leg → fully configure the bowling item (hold comes at the
      // schedule step's advance).
      const bowlingEntry = chain.find((e) => e.payload.kind === "bowling");
      if (bowling && bowlingEntry && bowlingEntry.payload.kind === "bowling" && date) {
        dispatch({
          type: "updateItem",
          id: bowling.id,
          patch: comboBowlingPatch(bowlingEntry.payload, party.length, date),
        });
      }

      setPendingAnchor(null);
      dispatch({ type: "next" });
    } finally {
      setSwitching(false);
      setBusy?.(false);
    }
  }

  if (!combo) return null;

  const anchorTracks = [
    ...new Set(
      (chains ?? [])
        .map((c) => trackOf(c.anchor))
        .filter((t): t is "Red" | "Blue" | "Mega" => t === "Red" || t === "Blue" || t === "Mega"),
    ),
  ];

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
            {anchorTracks.length > 0 && <TrackInfoBanner tracks={anchorTracks} />}
            {(chains ?? []).some((c) => !c.chain) && (
              <p className="text-center text-xs text-white/35">
                Grayed-out times can&apos;t fit the full combo (bowling + your second race) before
                close.
              </p>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(chains ?? []).map((c) => {
                const isFeasible = !!c.chain;
                const track = trackOf(c.anchor);
                const theme = track ? TRACK_CARD[track] : undefined;
                const badge = track ? TRACK_BADGE[track] : undefined;
                const isSelected =
                  !!selected && selected.start === c.anchor.startIso && selected.track === track;
                const free =
                  c.anchor.payload.kind === "race" ? c.anchor.payload.candidate.freeSpots : 0;
                return (
                  <button
                    key={`${c.anchor.startIso}|${track ?? ""}`}
                    type="button"
                    disabled={!isFeasible || switching}
                    onClick={() => setPendingAnchor(c.anchor)}
                    title={
                      isFeasible ? undefined : "No full combo schedule fits from this start time"
                    }
                    className={`rounded-xl border p-3 text-left transition-colors ${
                      isFeasible
                        ? `${isSelected ? (theme?.selected ?? "") : `${theme?.base ?? "border-white/10 bg-white/5"} ${theme?.baseHover ?? ""}`}`
                        : DISABLED_CARD
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-sm font-bold text-white">
                        {wallClockLabel(c.anchor.startIso)}
                      </span>
                      {badge && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${badge.bg} ${badge.text}`}
                        >
                          {track}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs">
                      {isFeasible ? (
                        <span className="text-emerald-400">
                          {free} spot{free === 1 ? "" : "s"} open
                        </span>
                      ) : (
                        <span className="text-white/30">Won&apos;t fit</span>
                      )}
                    </div>
                    {isSelected && (
                      <div className="mt-1 text-[10px] font-bold uppercase tracking-wider text-white/70">
                        ✓ Selected
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )
      )}

      {/* Preview of the assembled schedule for the current selection */}
      {selected && <ItineraryList item={item} session={session} compact />}

      {pendingAnchor && current && date && (
        <ScheduleConfirmModal
          combo={combo}
          legCandidates={current.legCandidates}
          anchor={pendingAnchor}
          headcount={party.length}
          dateYmd={date}
          busy={switching}
          onConfirm={(chain) => void confirmChain(chain)}
          onCancel={() => setPendingAnchor(null)}
        />
      )}
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

  // Race-leg start times + track in itinerary order (all racers share blocks).
  const raceLegs = [
    ...new Map(
      item.heats
        .filter((h): h is RaceHeatAssignment & { heatId: string } => !!h.heatId)
        .map((h) => [h.heatId, h.track] as const),
    ).entries(),
  ].sort((a, b) => a[0].localeCompare(b[0]));

  let raceIdx = 0;
  const rows = combo.components.map((leg, i) => {
    if (leg.kind === "race") {
      const entry = raceLegs[raceIdx++];
      return {
        key: `leg-${i}`,
        leg,
        track: entry?.[1] ?? null,
        time: entry ? wallClockLabel(entry[0]) : "—",
      };
    }
    if (leg.kind === "bowling") {
      return {
        key: `leg-${i}`,
        leg,
        track: null,
        time: bowling?.bookedAt ? wallClockLabel(bowling.bookedAt) : "—",
      };
    }
    return { key: `leg-${i}`, leg, track: null, time: "—" };
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
        {rows.map((r, i) => {
          const badge = r.track ? TRACK_BADGE[r.track] : null;
          return (
            <li key={r.key} className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 text-white/85">
                <span className="w-5 text-center">{legIcon(r.leg)}</span>
                <span>
                  <span className="mr-1.5 text-white/30">{i + 1}.</span>
                  {legLabel(r.leg)}
                </span>
                {badge && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${badge.bg} ${badge.text}`}
                  >
                    {r.track}
                  </span>
                )}
              </span>
              <span className="font-semibold text-white">{r.time}</span>
            </li>
          );
        })}
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
        {(combo.includesLicense || combo.includedPovPerRacer > 0) && (
          <p className="mt-1 text-xs" style={{ color: GOLD }}>
            ✓ Racing license{combo.includedPovPerRacer > 0 ? " + POV race video" : ""} included
          </p>
        )}
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
