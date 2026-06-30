"use client";

import { useEffect, useMemo, useState } from "react";
import type { BookingSession, BowlingItem, RaceItem, StepDef } from "~/features/booking";
import { qamfCenterIdForCode } from "~/features/booking";
import { releaseHeatBmiLines } from "~/features/booking/service/checkout";
import { scheduleForDate } from "~/features/booking/service/race-pricing";
import type { RaceHeatAssignment } from "~/features/booking/state/types";
import { bookHeatsOnAdvance } from "~/features/booking/service/race";
import {
  candidatesForOrdering,
  comboBowlingPatch,
  fetchComboLegCandidates,
  holdComboBowling,
  releaseComboBowlingHold,
  type ComboLegPayload,
} from "~/features/combos/combo-booking";
import {
  buildChainFrom,
  buildChains,
  wallClockLabel,
  wallClockMs,
  type ChainResult,
  type LegCandidate,
  type LegFilter,
} from "~/features/combos/combo-itinerary";
import {
  comboHeatsPerRacer,
  comboPriceCentsForDate,
  comboReorderFallbackEnabled,
  comboStartHoursLabel,
  getComboSpecial,
  type ComboLeg,
  type ComboSpecial,
} from "~/features/combos/combo-specials";
import { modalBackdropProps } from "@/lib/a11y";
import { formatHourLabel } from "../bowling/availability-client";
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
    return `${hours % 1 === 0 ? hours : hours.toFixed(1)} Hours of ${leg.vip ? "VIP " : ""}Bowling`;
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

/** Does the itinerary run a higher-tier race AFTER a starter (the Ultimate
 *  pattern: you qualify in race 1, then run race 2)? Drives the customer
 *  "qualify to unlock" note on the schedule screens. */
function hasQualifierProgression(combo: ComboSpecial): boolean {
  let sawStarter = false;
  for (const leg of combo.components) {
    if (leg.kind !== "race") continue;
    if (leg.tier === "starter") sawStarter = true;
    else if (sawStarter) return true;
  }
  return false;
}

/** ET wall-clock hour (0–26 chip notation) of either vendor's ISO. */
function etHourOfIso(iso: string): number {
  const naive = iso.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
  const h = new Date(naive).getHours();
  return h < 6 ? h + 24 : h;
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

/* ───────────────────────── Intro / overview step ─────────────────────── */

/** Short customer-facing blurb per leg for the overview step. */
function legBlurb(leg: ComboLeg, combo: ComboSpecial): string {
  if (leg.kind === "race") {
    if (leg.tier === "starter") return "Hit the track and earn your qualification.";
    return `Qualified in your Starter race? Come back faster.${
      combo.qualifyFallbackNote ? ` ${combo.qualifyFallbackNote}` : ""
    }`;
  }
  if (leg.kind === "bowling") {
    return leg.vip
      ? "Walk next door to your semi-private VIP lane — NeoVerse wall, chips & salsa, premium glow."
      : "Walk next door to your lane at HeadPinz.";
  }
  return "";
}

const ComboIntroComponent: StepDef<RaceItem>["Component"] = ({ session }) => {
  const combo = comboFor(session);
  if (!combo) return null;

  const included = [
    combo.includesLicense ? "Racing license" : null,
    combo.includedPovPerRacer > 0 ? "POV race video for every racer" : null,
    ...(combo.perks ?? []),
  ].filter(Boolean) as string[];

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="text-center">
        <h2
          className="font-display text-3xl font-black uppercase tracking-widest"
          style={{ color: GOLD, textShadow: `0 0 28px ${GOLD}55` }}
        >
          {combo.name}
        </h2>
        <p className="mt-2 text-sm text-white/60">{combo.shortDescription}</p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs font-bold uppercase tracking-wider">
          {combo.durationLabel && (
            <span
              className="rounded-full px-3 py-1"
              style={{ backgroundColor: `${GOLD}1f`, color: GOLD }}
            >
              {combo.durationLabel}
            </span>
          )}
          <span className="rounded-full bg-white/10 px-3 py-1 text-white/80">
            ${(combo.price.weekday / 100).toFixed(0)}/person Mon–Thu · $
            {(combo.price.weekend / 100).toFixed(0)}/person Fri–Sun
          </span>
          {combo.startHours?.length ? (
            <span className="rounded-full bg-white/10 px-3 py-1 text-white/80">
              Starts {comboStartHoursLabel(combo)}
            </span>
          ) : null}
        </div>
      </div>

      {/* How it works — the itinerary, numbered */}
      <div className="space-y-2">
        <p className="text-center text-[11px] uppercase tracking-[2px] text-white/35">
          How your visit works
        </p>
        {combo.components.map((leg, i) => (
          <div
            key={`intro-leg-${i}`}
            className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
          >
            <span
              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-black"
              style={{ backgroundColor: `${GOLD}22`, color: GOLD }}
            >
              {i + 1}
            </span>
            <div>
              <p className="text-sm font-bold text-white">
                {legIcon(leg)} {legLabel(leg)}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-white/50">{legBlurb(leg, combo)}</p>
            </div>
          </div>
        ))}
        <p className="text-center text-[11px] text-white/40">
          You pick ONE start time — we schedule the whole visit around it.
        </p>
      </div>

      {/* Everything included */}
      {included.length > 0 && (
        <div
          className="rounded-2xl border p-4"
          style={{ borderColor: `${GOLD}40`, backgroundColor: `${GOLD}0a` }}
        >
          <p
            className="mb-2 text-center text-[11px] uppercase tracking-[2px]"
            style={{ color: GOLD }}
          >
            All included in the price
          </p>
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {included.map((perk) => (
              <li key={perk} className="flex items-center gap-2 text-sm text-white/80">
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                  style={{ backgroundColor: `${GOLD}25`, color: GOLD }}
                >
                  ✓
                </span>
                {perk}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-center text-xs text-white/35">
        Next: tell us who&apos;s racing and bowling.
      </p>
    </div>
  );
};

/* ───────────────── schedule confirm modal ───────────────────────────── */

function trackOf(c: LegCandidate<ComboLegPayload>): string | null {
  return c.payload.kind === "race" ? c.payload.candidate.track : null;
}

function ScheduleConfirmModal({
  combo,
  components,
  legCandidates,
  anchor,
  headcount,
  dateYmd,
  busy,
  onConfirm,
  onCancel,
}: {
  combo: ComboSpecial;
  /** Active leg ordering — `combo.components` normally, or `fallbackComponents`
   *  when the tile resolved via the reorder fallback. `legCandidates` is
   *  index-aligned to THIS list. */
  components: ComboLeg[];
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

  // Per-leg gap caps + floors (e.g. lane within 60 min of race 1; reorder's
  // second race ≥20 / ≤45 min after the first).
  const maxWaits = components.map((l) => l.maxWaitMinutes ?? null);
  const minWaits = components.map((l) => l.minWaitMinutes ?? null);

  const filtersFor = (choices: Record<number, string>): Array<LegFilter<ComboLegPayload>> =>
    components.map((leg, i) => {
      const chosen = choices[i];
      if (!chosen || leg.kind !== "race" || i === 0) return null;
      return (c: LegCandidate<ComboLegPayload>) => trackOf(c) === chosen;
    });

  const chain = useMemo(
    () =>
      buildChainFrom(
        legCandidates,
        combo.transitionMinutes,
        anchor,
        filtersFor(trackChoice),
        maxWaits,
        minWaits,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [legCandidates, combo, anchor, trackChoice],
  );

  // For each later race leg: which tracks still produce a full chain (keeping
  // the OTHER legs' current choices)? >1 option → show the Red/Blue picker.
  const trackOptionsByLeg = useMemo(() => {
    const out = new Map<number, string[]>();
    components.forEach((leg, i) => {
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
            maxWaits,
            minWaits,
          ) != null,
      );
      if (viable.length > 0) out.set(i, viable);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legCandidates, combo, anchor, trackChoice]);

  const unitCents = comboPriceCentsForDate(combo, dateYmd);

  // Real assembled visit length (first leg start → last leg end), shown to
  // the nearest half hour — backs the "≈ 3-hour experience" marketing claim
  // with this chain's actual times.
  const totalMinutes = chain
    ? Math.round((chain[chain.length - 1].endMs - anchor.startMs) / 60_000)
    : null;
  const durationText =
    totalMinutes != null
      ? `about ${(Math.round(totalMinutes / 30) / 2).toLocaleString("en-US", { maximumFractionDigits: 1 })} hours`
      : null;

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
          {durationText ? ` · ${durationText}` : ""}
        </p>

        {chain ? (
          <ol className="mt-4 space-y-2">
            {components.map((leg, i) => {
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

        {chain && hasQualifierProgression(combo) && (
          <p className="mt-2 text-center text-[11px] text-white/40">
            🏁 Qualify in your Starter race to unlock the Intermediate race.
            {combo.qualifyFallbackNote ? ` ${combo.qualifyFallbackNote}` : ""}
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
            {busy ? "Reserving…" : "Confirm Schedule"}
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
  // The tapped start-time tile: its anchor + which ordering (normal vs reorder
  // fallback) the schedule modal should assemble/show.
  const [pending, setPending] = useState<{
    anchor: LegCandidate<ComboLegPayload>;
    ordering: "normal" | "fallback";
  } | null>(null);
  // Live per-leg load status (keyed on fetchKey so a date change resets it):
  // each leg ticks ✓ as its availability lands — a checklist, not a blind
  // spinner. All setState calls happen inside async callbacks (lint-safe).
  const [legsDone, setLegsDone] = useState<{ key: string; done: number[] } | null>(null);

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
          onLegDone: (legIndex) => {
            if (cancelled) return;
            setLegsDone((prev) =>
              prev?.key === fetchKey
                ? { key: fetchKey, done: [...prev.done, legIndex] }
                : { key: fetchKey, done: [legIndex] },
            );
          },
        });
        if (cancelled) return;
        setFetched({
          key: fetchKey,
          legCandidates,
          chains: buildChains(
            legCandidates,
            combo.transitionMinutes,
            combo.components.map((l) => l.maxWaitMinutes ?? null),
          ),
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

      // Bowling leg → fully configure the bowling item.
      const bowlingEntry = chain.find((e) => e.payload.kind === "bowling");
      const bowlingPatch =
        bowling && bowlingEntry && bowlingEntry.payload.kind === "bowling" && date
          ? comboBowlingPatch(combo, bowlingEntry.payload, party.length, date)
          : null;
      if (bowling && bowlingPatch) {
        dispatch({ type: "updateItem", id: bowling.id, patch: bowlingPatch });
      }

      // HOLD EVERYTHING NOW (owner: spots are held the moment the schedule is
      // confirmed, not on Next). The closure's session/item are stale — the
      // dispatches above haven't re-rendered yet — so book against locally
      // updated copies; the bmiLineId/hold dispatches inside apply cleanly to
      // the store's already-updated state. BookingFlow's Next handler stays as
      // an idempotent backstop (booked heats / live holds are skipped).
      const updatedItem: RaceItem = {
        ...item,
        heats,
        povQuantity: combo.includedPovPerRacer * party.length,
        povSold: false,
      };
      const updatedBowling = bowling && bowlingPatch ? { ...bowling, ...bowlingPatch } : bowling;
      const updatedSession: BookingSession = {
        ...session,
        items: session.items.map((i) =>
          i.id === item.id
            ? updatedItem
            : updatedBowling && i.id === updatedBowling.id
              ? updatedBowling
              : i,
        ),
      };
      await bookHeatsOnAdvance(updatedSession, updatedItem, dispatch);
      if (updatedBowling && !updatedBowling.qamfReservationId) {
        const qamfReservationId = await holdComboBowling({
          session: updatedSession,
          item: updatedBowling,
          centerId,
        });
        dispatch({
          type: "setBowlingHold",
          itemId: updatedBowling.id,
          qamfReservationId,
          qamfCenterId: centerId,
        });
      }

      setPending(null);
      dispatch({ type: "next" });
    } catch (err) {
      alert(
        err instanceof Error
          ? `Couldn't hold your schedule: ${err.message}`
          : "Couldn't hold your schedule. Please pick another time.",
      );
    } finally {
      setSwitching(false);
      setBusy?.(false);
    }
  }

  if (!combo) return null;

  // Restricted start grid (registry `startHours`, e.g. 2/4/6/8 PM): ONE cell
  // per (hour, track) — the first FEASIBLE start inside that hour, else the
  // first candidate greyed out (covers "lane unavailable" — the chain already
  // factors the bowling leg). Hours with no heats at all render an
  // Unavailable placeholder so the four slots always show. No startHours →
  // every candidate (generic combos keep the full grid).
  type GridCell =
    | {
        kind: "chain";
        hour: number | null;
        result: ChainResult<ComboLegPayload>;
        ordering: "normal" | "fallback";
      }
    | { kind: "empty"; hour: number };

  // Reorder fallback (flag-gated): a second set of chains assembled in the
  // combo's `fallbackComponents` order (race → race → bowl) from the SAME
  // fetched candidates — used only to rescue a start-hour the normal order
  // can't fill. Both orderings anchor on the same Starter heats (leg 0), so a
  // normal anchor maps to its fallback chain by (start, track).
  const anchorKey = (a: LegCandidate<ComboLegPayload>) => `${a.startIso}|${trackOf(a) ?? ""}`;
  const fallbackChains: Array<ChainResult<ComboLegPayload>> | null =
    comboReorderFallbackEnabled() && combo.fallbackComponents && current
      ? buildChains(
          candidatesForOrdering(combo.components, current.legCandidates, combo.fallbackComponents),
          combo.transitionMinutes,
          combo.fallbackComponents.map((l) => l.maxWaitMinutes ?? null),
          combo.fallbackComponents.map((l) => l.minWaitMinutes ?? null),
        )
      : null;
  const fbFeasibleByAnchor = new Map<string, ChainResult<ComboLegPayload>>();
  if (fallbackChains) {
    for (const r of fallbackChains) if (r.chain) fbFeasibleByAnchor.set(anchorKey(r.anchor), r);
  }

  const gridCells: GridCell[] = (() => {
    if (!chains) return [];
    if (!combo.startHours?.length) {
      return chains.map((result) => ({
        kind: "chain" as const,
        hour: null,
        result,
        ordering: "normal" as const,
      }));
    }
    const cells: GridCell[] = [];
    for (const hour of combo.startHours) {
      const inHour = chains
        .filter((c) => etHourOfIso(c.anchor.startIso) === hour)
        .sort((a, b) => a.anchor.startMs - b.anchor.startMs);
      if (inHour.length === 0) {
        cells.push({ kind: "empty", hour });
        continue;
      }
      const tracks = [...new Set(inHour.map((c) => trackOf(c.anchor) ?? ""))].sort();
      for (const t of tracks) {
        const ofTrack = inHour.filter((c) => (trackOf(c.anchor) ?? "") === t);
        // 1) prefer a feasible NORMAL chain (in-the-middle bowling).
        const normalPick = ofTrack.find((c) => c.chain);
        if (normalPick) {
          cells.push({ kind: "chain", hour, result: normalPick, ordering: "normal" });
          continue;
        }
        // 2) else a feasible FALLBACK chain for an anchor in this hour+track.
        const fbPick = ofTrack
          .map((c) => fbFeasibleByAnchor.get(anchorKey(c.anchor)))
          .find((r): r is ChainResult<ComboLegPayload> => !!r);
        if (fbPick) {
          cells.push({ kind: "chain", hour, result: fbPick, ordering: "fallback" });
          continue;
        }
        // 3) else greyed — show the first anchor's (infeasible) normal result.
        cells.push({ kind: "chain", hour, result: ofTrack[0], ordering: "normal" });
      }
    }
    return cells;
  })();

  const anchorTracks = [
    ...new Set(
      gridCells
        .map((c) => (c.kind === "chain" ? trackOf(c.result.anchor) : null))
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
          {`Choose when your ${legLabel(combo.components[0])} starts — we'll schedule the rest of your ${combo.name} around it.`}
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
        /* Live per-leg checklist — each leg ticks ✓ as its availability lands,
           so the multi-vendor lookup never reads as a stuck spinner. */
        <div className="mx-auto max-w-xs space-y-2 py-10">
          <p className="mb-3 text-center text-xs uppercase tracking-[2px] text-white/35">
            Building your schedule
          </p>
          {combo.components.map((leg, i) => {
            const done = legsDone?.key === fetchKey && legsDone.done.includes(i);
            return (
              <div
                key={`legstatus-${i}`}
                className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm"
              >
                <span className={done ? "text-white/85" : "text-white/45"}>
                  {legIcon(leg)} {legLabel(leg)}
                </span>
                {done ? (
                  <span className="font-bold text-emerald-400">✓</span>
                ) : (
                  <span
                    className="h-4 w-4 animate-spin rounded-full border-2 border-white/15"
                    style={{ borderTopColor: CYAN }}
                    aria-hidden
                  />
                )}
              </div>
            );
          })}
          <p className="pt-1 text-center text-[11px] text-white/30">
            Checking live race times and lane availability…
          </p>
        </div>
      ) : !megaJuniorBlocked && gridCells.length === 0 ? (
        <p className="py-8 text-center text-sm text-white/40">
          {`No ${legLabel(combo.components[0]).toLowerCase()} times this day. Go back and try another date.`}
        </p>
      ) : (
        !megaJuniorBlocked && (
          <>
            {anchorTracks.length > 0 && <TrackInfoBanner tracks={anchorTracks} />}
            {gridCells.some((c) => c.kind === "empty" || !c.result.chain) && (
              <p className="text-center text-xs text-white/35">
                Grayed-out times can&apos;t fit the full experience (VIP lane + your second race) —
                pick another slot or day.
              </p>
            )}
            <div
              className={`grid gap-2 ${
                combo.startHours?.length
                  ? "grid-cols-2 sm:grid-cols-4"
                  : "grid-cols-2 sm:grid-cols-3"
              }`}
            >
              {gridCells.map((cell) => {
                if (cell.kind === "empty") {
                  return (
                    <div
                      key={`empty-${cell.hour}`}
                      className={`rounded-xl border p-3 text-left ${DISABLED_CARD}`}
                      title="No full experience fits in this slot"
                    >
                      <span className="text-sm font-bold text-white">
                        {formatHourLabel(cell.hour)}
                      </span>
                      <div className="mt-1 text-xs text-white/30">Unavailable</div>
                    </div>
                  );
                }
                const c = cell.result;
                const isFeasible = !!c.chain;
                const isReorder = cell.ordering === "fallback";
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
                    onClick={() => setPending({ anchor: c.anchor, ordering: cell.ordering })}
                    title={
                      isFeasible
                        ? isReorder
                          ? (combo.fallbackNote ?? "Both races run first, then your VIP lane")
                          : undefined
                        : "No full combo schedule fits from this start time"
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
                    {isFeasible && isReorder && (
                      <div
                        className="mt-1 text-[10px] font-bold uppercase tracking-wider"
                        style={{ color: GOLD }}
                      >
                        Races first · lane after
                      </div>
                    )}
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

      {pending && current && date && (
        <ScheduleConfirmModal
          combo={combo}
          components={
            pending.ordering === "fallback" && combo.fallbackComponents
              ? combo.fallbackComponents
              : combo.components
          }
          legCandidates={
            pending.ordering === "fallback" && combo.fallbackComponents
              ? candidatesForOrdering(
                  combo.components,
                  current.legCandidates,
                  combo.fallbackComponents,
                )
              : current.legCandidates
          }
          anchor={pending.anchor}
          headcount={party.length}
          dateYmd={date}
          busy={switching}
          onConfirm={(chain) => void confirmChain(chain)}
          onCancel={() => setPending(null)}
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

  // Build one row per leg (race legs paired to heats in tier order: starter is
  // always the earlier heat), then render in ACTUAL chronological order so the
  // reorder fallback (race → race → bowl) shows correctly, not the registry's
  // primary order. Legs with no booked time yet sort last.
  let raceIdx = 0;
  const rows = combo.components
    .map((leg, i) => {
      if (leg.kind === "race") {
        const entry = raceLegs[raceIdx++];
        return { key: `leg-${i}`, leg, track: entry?.[1] ?? null, iso: entry?.[0] ?? null };
      }
      if (leg.kind === "bowling") {
        return { key: `leg-${i}`, leg, track: null, iso: bowling?.bookedAt ?? null };
      }
      return { key: `leg-${i}`, leg, track: null, iso: null as string | null };
    })
    .sort(
      (a, b) =>
        (a.iso ? wallClockMs(a.iso) : Number.POSITIVE_INFINITY) -
        (b.iso ? wallClockMs(b.iso) : Number.POSITIVE_INFINITY),
    )
    .map((r) => ({ ...r, time: r.iso ? wallClockLabel(r.iso) : "—" }));

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
          {combo.durationLabel ? ` · ${combo.durationLabel}` : ""}
        </p>
      </div>

      <ItineraryList item={item} session={session} />

      {hasQualifierProgression(combo) && (
        <p className="text-center text-[11px] text-white/40">
          🏁 Qualify in your Starter race to unlock the Intermediate race.
          {combo.qualifyFallbackNote ? ` ${combo.qualifyFallbackNote}` : ""}
        </p>
      )}

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-white/60">{combo.name}</span>
          <span className="font-bold text-white">
            ${(unitCents / 100).toFixed(2)}
            <span className="text-xs font-normal text-white/40">/person</span>
          </span>
        </div>
        {(combo.includesLicense || combo.includedPovPerRacer > 0 || combo.perks?.length) && (
          <p className="mt-1 text-xs" style={{ color: GOLD }}>
            ✓ Racing license{combo.includedPovPerRacer > 0 ? " + POV race video" : ""}
            {combo.perks?.length ? " + VIP lane perks" : ""} included
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
        Your races and lane are reserved while you finish checkout.
      </p>
    </div>
  );
};

/* ───────────────────────── StepDefs ─────────────────────────────────── */

const startTimeCanAdvance: StepDef<RaceItem>["canAdvance"] = (item, session) =>
  heatsComplete(item, session) && bowlingItemOf(session)?.bookedAt
    ? true
    : { reason: "Pick a start time" };

export const ComboIntroStep: StepDef<RaceItem> = {
  id: "combo-intro",
  title: "Overview",
  Component: ComboIntroComponent,
  isVisible: (_item, session) => !!session.comboSpecialId,
  canAdvance: () => true,
};

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
