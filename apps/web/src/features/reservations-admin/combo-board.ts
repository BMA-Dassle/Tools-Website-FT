/**
 * Pure logic for the VIP combo board: live step progress, combo grouping,
 * schedule indexing, and main-list row merging.
 * Extracted verbatim from app/admin/[token]/reservations/ReservationsClient.tsx.
 *
 * Everything here takes `nowMs` as a parameter (ET wall-clock ms, see
 * format.ts etWallMs/nowEtWallMs) so countdown/retirement logic stays
 * deterministic and unit-testable.
 */
import { centerLabel, etWallMs } from "./format";
import type { ComboMergeInfo, ComboMeta, ComboScheduleStep, Reservation } from "./types";

/** Where a combo itinerary step sits relative to now. Status truth first —
 *  bowling legStatus (QAMF lane state: completed = lane closed, arrived =
 *  lane open) and race raceState (Pandora session actualStart/actualEnd +
 *  called watermark: finished / on_track / called / not_called) both beat
 *  the clock — then the booked start + expected duration. `overdue` =
 *  schedule-active but the party hasn't checked in, lane still open past its
 *  scheduled end, or a heat still uncalled past its scheduled end. */
export function stepProgress(
  step: ComboScheduleStep,
  nowMs: number,
): {
  state: "done" | "active" | "upcoming";
  minsLeft: number;
  minsUntil: number;
  overdue: boolean;
} | null {
  if (step.legStatus === "completed" || step.raceState === "finished") {
    return { state: "done", minsLeft: 0, minsUntil: 0, overdue: false };
  }
  if (!step.iso) return null;
  const startMs = etWallMs(step.iso);
  if (Number.isNaN(startMs)) return null;
  const endMs = startMs + step.durationMin * 60_000;
  if (step.legStatus === "arrived") {
    // Lane is open RIGHT NOW — active regardless of the clock; past the
    // scheduled end it's running over, not done.
    return {
      state: "active",
      minsLeft: Math.max(0, (endMs - nowMs) / 60_000),
      minsUntil: 0,
      overdue: nowMs >= endMs,
    };
  }
  if (step.raceState === "on_track" || step.raceState === "called") {
    // Karts are on track / racers being called to the grid RIGHT NOW —
    // active regardless of the clock (heats routinely run 6-20 min behind).
    return {
      state: "active",
      minsLeft: Math.max(0, (endMs - nowMs) / 60_000),
      minsUntil: 0,
      overdue: false,
    };
  }
  if (step.raceState === "not_called" && nowMs >= startMs) {
    // Scheduled start passed but the track hasn't called this heat — it's
    // running behind, NOT done (the clock-only board lied "Done" here).
    // Amber once even the scheduled end has passed.
    return {
      state: "active",
      minsLeft: Math.max(0, (endMs - nowMs) / 60_000),
      minsUntil: 0,
      overdue: nowMs >= endMs,
    };
  }
  if (nowMs >= endMs) return { state: "done", minsLeft: 0, minsUntil: 0, overdue: false };
  if (nowMs >= startMs)
    return {
      state: "active",
      minsLeft: (endMs - nowMs) / 60_000,
      minsUntil: 0,
      // A bowling step carries legStatus; schedule-active without an open
      // lane means the party hasn't checked in to the lane yet.
      overdue: step.legStatus != null && step.legStatus !== "arrived",
    };
  return { state: "upcoming", minsLeft: 0, minsUntil: (startMs - nowMs) / 60_000, overdue: false };
}

/** One VIP combo's legs grouped with its live schedule + display totals. */
export interface ComboGroup {
  key: string;
  comboId: string;
  meta: ComboMeta | undefined;
  legs: Reservation[];
  bowling: Reservation | undefined;
  races: Reservation[];
  anchor: Reservation;
  guestName: string;
  guestPhone?: string;
  playerCount?: number;
  centerCode: string;
  lane?: string;
  dayofOrders: Array<{
    orderId: string;
    leg: Reservation;
    kind: "Racing" | "Bowling";
    totalCents: number;
  }>;
  totalCents: number;
  /** Pre-discount package value: charged total + the legs' stamped promo
   *  savings. A 100% comp charges $0 but the package is still worth this. */
  grossCents: number;
  schedule: ComboScheduleStep[];
  inactive: boolean;
}

/**
 * Grouping key correlating a combo's legs. A paid combo books ONE deposit
 * order whose id both legs share (it survives the day-of racing/bowling
 * split), so that's the primary key. A $0 comp (100% promo) captures NO
 * deposit — its legs carry only their two DIFFERENT day-of order ids — so
 * deposit-less combo legs correlate on combo + guest + event date instead
 * (the one thing both legs of one visit share). The theoretical collision —
 * the same guest booking the SAME combo twice for the SAME day — merges into
 * one card; display-only and far rarer than every comp splitting in two.
 * Last resorts (no combo id / no guest) keep the old order-id fallbacks.
 */
export function comboGroupKey(r: Reservation): string {
  if (r.squareDepositOrderId) return r.squareDepositOrderId;
  const guest = (r.guestPhone ?? "").replace(/\D/g, "") || (r.guestName ?? "").trim().toLowerCase();
  if (r.comboSpecialId && guest) {
    return `combo|${r.comboSpecialId}|${guest}|${(r.eventAt ?? r.bookedAt).slice(0, 10)}`;
  }
  return r.squareDayofOrderId || r.bmiBillId || `id-${r.id}`;
}

/**
 * VIP combos — group the legs (race + bowling) of one combo together via
 * comboGroupKey. The bowling leg carries the real lane + slot time, the race
 * leg(s) are the karting heats.
 */
export function buildComboGroups(
  vipReservations: Reservation[],
  comboMeta: Record<string, ComboMeta>,
  nowMs: number,
): ComboGroup[] {
  const byOrder = new Map<string, Reservation[]>();
  for (const r of vipReservations) {
    const key = comboGroupKey(r);
    const arr = byOrder.get(key) ?? [];
    arr.push(r);
    byOrder.set(key, arr);
  }
  const groups = Array.from(byOrder.entries()).map(([key, legs]): ComboGroup => {
    const sorted = [...legs].sort((a, b) => a.bookedAt.localeCompare(b.bookedAt));
    const bowling = sorted.find((l) => l.productKind === "open" || l.productKind === "kbf");
    const races = sorted.filter((l) => l.productKind === "race");
    // Anchor time = the bowling slot (real schedule); fall back to earliest leg.
    const anchor = bowling ?? sorted[0];
    const comboId = sorted.find((l) => l.comboSpecialId)?.comboSpecialId ?? "";
    const meta = comboMeta[comboId];
    const allLegsCancelled = sorted.every((l) => l.status === "cancelled");
    const allTerminal = sorted.every(
      (l) => l.status === "cancelled" || l.status === "completed" || l.status === "no_show",
    );

    // Assumed race-leg length (arrive → off track) — owner's 30-min rule,
    // mirrors ASSUMED_RACE_LEG_MINUTES in combo-booking. Drives the card's
    // Done / on-track / up-next markers only, never the booked schedule.
    const RACE_STEP_MIN = 30;

    // Race steps. PREFERRED source: the bill's CURRENT lines re-read from
    // BMI (liveHeats) — office reschedules move heats after booking, and a
    // didn't-qualify Intermediate gets CONVERTED to a second Starter, so
    // both the times AND the labels come from BMI truth. Fallback (live
    // read absent): booking_metadata heat times stamped at booking, with
    // the booked-order assumption — the racer qualifies on the Starter
    // first, so the earliest heat is the Starter and the next is the
    // Intermediate, whether bowling runs in the middle or last.
    const liveHeats = Array.from(
      new Map(
        races
          .flatMap((r) => r.liveHeats ?? [])
          .map((h) => [`${h.start}|${h.name ?? ""}`, h] as const),
      ).values(),
    )
      .map((h) => ({ ...h, ms: etWallMs(h.start) }))
      .filter((h) => !Number.isNaN(h.ms))
      .sort((a, b) => a.ms - b.ms);
    // Track tag ("Blue" / "Red" / "Mega") from a BMI line name or a stored
    // heat track ("Blue Track") — the owner wants the track visible on every
    // race step, not just the tier.
    const trackTag = (s: string | null | undefined): string | null => {
      const m = (s ?? "").match(/\b(red|blue|mega)\b/i);
      return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : null;
    };
    const withTrack = (base: string, tag: string | null) => (tag ? `${base} · ${tag}` : base);
    let raceSteps: ComboScheduleStep[];
    if (liveHeats.length) {
      raceSteps = liveHeats.map((h, i) => {
        // BMI gives the REAL session window (stop − start, ~7-12 min) —
        // use it so "In progress"/"Done" flip at the actual session end.
        const stopMs = h.stop ? etWallMs(h.stop) : NaN;
        const realMin = (stopMs - h.ms) / 60_000;
        // BMI line names carry the track ("Starter Race Blue") — surface it
        // as "Starter Race · Blue" instead of hiding it.
        const base =
          h.name?.replace(/\s+(red|blue|mega)(\s+track)?$/i, "").trim() ||
          (i === 0 ? "Starter Race" : "Intermediate Race");
        // Session identity — the resolved Pandora heat number IS the session's
        // name everywhere else (track boards, guest SMS), so staff can match
        // the step to the called session at a glance (owner 2026-08-01).
        // Same-day live resolution only; historical/unresolved heats omit it.
        const heatTag = typeof h.heatNumber === "number" ? ` · Heat ${h.heatNumber}` : "";
        return {
          icon: "🏁",
          label: withTrack(base, trackTag(h.name)) + heatTag,
          iso: h.start,
          loc: "FastTrax",
          durationMin: Number.isFinite(realMin) && realMin > 0 ? realMin : RACE_STEP_MIN,
          // Live track truth (server-resolved, same-day only) — the marker
          // trusts this over the clock, like bowling trusts legStatus.
          raceState: h.raceState,
        };
      });
    } else {
      // heatId IS the heat's block-start ISO (booking state types),
      // persisted in the race leg's booking_metadata.heats — which also
      // stamps each heat's track/tier/category at booking time. One step per
      // DISTINCT physical session — a jr/adult party books separate start
      // times per tier (4+ sessions), so never cap at Starter+Intermediate.
      const heatTimes = Array.from(
        new Map(
          races
            .flatMap((r) => r.bookingMetadata?.heats ?? [])
            .filter((h): h is { heatId: string; track?: string; tier?: string; category?: string } =>
              !!h.heatId,
            )
            .map((h) => [`${h.heatId}|${h.category ?? ""}|${h.tier ?? ""}`, h] as const),
        ).values(),
      )
        .map((h) => ({
          iso: h.heatId,
          track: h.track,
          tier: h.tier,
          category: h.category,
          ms: etWallMs(h.heatId),
        }))
        .filter((h) => !Number.isNaN(h.ms))
        .sort((a, b) => a.ms - b.ms);
      raceSteps = heatTimes.map((h, i) => {
        // Old rows pre-date the tier stamp — fall back to the booked-order
        // assumption (earliest = Starter, next = Intermediate).
        const tier = h.tier ?? (i === 0 ? "starter" : "intermediate");
        const tierLabel =
          tier === "intermediate"
            ? "Intermediate Race"
            : tier === "starter"
              ? "Starter Race"
              : `${tier[0].toUpperCase()}${tier.slice(1)} Race`;
        return {
          icon: "🏁",
          label: withTrack(`${h.category === "junior" ? "Junior " : ""}${tierLabel}`, trackTag(h.track)),
          iso: h.iso,
          loc: "FastTrax",
          durationMin: RACE_STEP_MIN,
        };
      });
      if (!raceSteps.length) {
        // Race leg exists but no heat metadata at all — keep the placeholder
        // Starter row so the itinerary still shows the race is part of the visit.
        raceSteps = [
          { icon: "🏁", label: "Starter Race", iso: null, loc: "FastTrax", durationMin: RACE_STEP_MIN },
        ];
      }
    }
    const expectsIntermediate = (meta?.includes ?? []).some((s) => /intermediate/i.test(s));

    // Assemble the steps, then render in ACTUAL chronological order (a
    // pending/un-booked intermediate sorts last).
    const steps: ComboScheduleStep[] = [...raceSteps];
    if (bowling) {
      steps.push({
        icon: "🎳",
        label: "VIP Bowling",
        iso: bowling.bookedAt,
        lane: bowling.dayofOrderLane,
        loc: `HeadPinz ${centerLabel(anchor.centerCode)}`,
        durationMin: meta?.bowlingDurationMinutes ?? 90,
        // QAMF lane truth: arrived = lane open, completed = lane closed —
        // the marker trusts this over the clock.
        legStatus: bowling.status,
      });
    }
    // Is the Intermediate actually on the schedule? Live BMI truth keeps the
    // old ≥2-heats rule (a didn't-qualify Intermediate gets CONVERTED to a
    // second Starter — two heats means the plan is complete either way). The
    // metadata fallback keys on LABELS instead: a jr+adult party books two
    // Starter sessions, which is 2+ steps with the Intermediate still unbooked.
    const hasIntermediate = liveHeats.length
      ? raceSteps.length >= 2
      : raceSteps.some((s) => /intermediate/i.test(s.label));
    if (expectsIntermediate && !hasIntermediate) {
      // Intermediate is qualify-gated — booked later if the racer qualifies.
      steps.push({
        icon: "🏁",
        label: "Intermediate Race",
        iso: null,
        loc: "FastTrax",
        pending: true,
        durationMin: RACE_STEP_MIN,
      });
    }
    const schedule: ComboScheduleStep[] = steps.sort(
      (a, b) =>
        (a.iso ? etWallMs(a.iso) : Number.POSITIVE_INFINITY) -
        (b.iso ? etWallMs(b.iso) : Number.POSITIVE_INFINITY),
    );

    // Retiring a combo is a GROUP + SCHEDULE decision, not a status one:
    // legs flip to completed at check-in/settle while later itinerary
    // steps are still hours away (real case: both legs completed by 6pm
    // with a 7:24 race still ahead). Keep the combo active until 30 min
    // past its LAST scheduled step's end — or while the lane is open, or
    // while live track truth says a heat hasn't actually run yet (heats
    // routinely run 6-20+ min behind schedule; a 6h hard cap keeps a
    // data quirk from pinning a card forever). Retire all-cancelled
    // combos immediately.
    const stepEnds = steps.flatMap((s) => {
      if (!s.iso) return [];
      const ms = etWallMs(s.iso);
      return Number.isNaN(ms) ? [] : [ms + s.durationMin * 60_000];
    });
    const raceStillLive = steps.some((s) => s.raceState && s.raceState !== "finished");
    const maxEndMs = stepEnds.length ? Math.max(...stepEnds) : null;
    const scheduleOver =
      maxEndMs === null ||
      (nowMs >= maxEndMs + 30 * 60_000 && !raceStillLive) ||
      nowMs >= maxEndMs + 6 * 60 * 60_000;
    const laneOpen = bowling?.status === "arrived";
    const inactive = allLegsCancelled || (allTerminal && scheduleOver && !laneOpen);

    // Distinct day-of Square orders in this combo: after the split a combo
    // has TWO (racing → FastTrax, bowling → HeadPinz); pre-split combos share
    // ONE. Legs of the same order share that order's total, so collapse by
    // order id (keep one representative leg per order).
    const dayofOrders = Array.from(
      sorted
        .reduce((m, l) => {
          if (!l.squareDayofOrderId) return m;
          const cur = m.get(l.squareDayofOrderId);
          if (!cur || (l.totalCents ?? 0) > (cur.totalCents ?? 0)) m.set(l.squareDayofOrderId, l);
          return m;
        }, new Map<string, Reservation>())
        .values(),
    ).map((leg) => ({
      orderId: leg.squareDayofOrderId as string,
      leg,
      kind: leg.productKind === "race" ? ("Racing" as const) : ("Bowling" as const),
      totalCents: leg.totalCents ?? 0,
    }));

    return {
      key,
      comboId,
      meta,
      legs: sorted,
      bowling,
      races,
      anchor,
      guestName: anchor.guestName ?? "Guest",
      guestPhone: anchor.guestPhone,
      playerCount: anchor.playerCount,
      centerCode: anchor.centerCode,
      lane: bowling?.dayofOrderLane,
      dayofOrders,
      // Sum the DISTINCT day-of orders. After the split a combo's two orders
      // each carry their own total (racing + bowling); a pre-split combo has
      // one order so the sum is just that order. Never max (under-counts a
      // split) and never sum raw legs (double-counts a shared order).
      totalCents: dayofOrders.length
        ? dayofOrders.reduce((s, o) => s + o.totalCents, 0)
        : Math.max(0, ...sorted.map((l) => l.totalCents ?? 0)),
      // Pre-discount value = charged + stamped promo savings. Savings are
      // stamped once per Neon ROW (unified-reserve puts the cart-wide share
      // on the race anchor, the bowling rail its own share), so summing the
      // distinct legs never double-counts.
      grossCents:
        (dayofOrders.length
          ? dayofOrders.reduce((s, o) => s + o.totalCents, 0)
          : Math.max(0, ...sorted.map((l) => l.totalCents ?? 0))) +
        sorted.reduce((s, l) => s + (l.promoSavingsCents ?? 0), 0),
      schedule,
      inactive,
    };
  });
  // Order the cards by VISIT time — the first timed itinerary step. The old
  // anchor.bookedAt compare put race-anchored groups at the TOP of the page:
  // a race row's booked_at is the BOOKING timestamp (e.g. 4 AM), not the heat
  // time, and lexically comparing naive-ET against zoned ISO strings crosses
  // frames anyway. etWallMs puts both shapes in one frame.
  const groupSortMs = (g: ComboGroup): number => {
    const first = g.schedule.find((s) => s.iso);
    const ms = first?.iso ? etWallMs(first.iso) : NaN;
    if (!Number.isNaN(ms)) return ms;
    const fallback = etWallMs(g.anchor.eventAt ?? g.anchor.bookedAt);
    return Number.isNaN(fallback) ? Number.POSITIVE_INFINITY : fallback;
  };
  return groups.sort((a, b) => groupSortMs(a) - groupSortMs(b));
}

/** Schedule entry a main-list VIP row resolves its combo through. */
export interface ComboScheduleEntry {
  name: string;
  accent: string;
  centerCode: string;
  schedule: ComboScheduleStep[];
  inactive: boolean;
}

/**
 * Combo schedule lookup so a VIP row in the MAIN list can open its itinerary.
 * Keyed by every id a row might carry (deposit + each day-of order id), since
 * a main-list leg correlates to its combo by whichever id it has.
 * Deliberately built from ALL groups (not the visible subset) so main-list
 * retirement + itinerary still resolve for combos hidden from the cards.
 */
export function buildComboScheduleIndex(groups: ComboGroup[]): Map<string, ComboScheduleEntry> {
  const m = new Map<string, ComboScheduleEntry>();
  for (const g of groups) {
    const entry = {
      name: g.meta?.name ?? "VIP Combo",
      accent: g.meta?.accentColor ?? "#d4af37",
      centerCode: g.centerCode,
      schedule: g.schedule,
      inactive: g.inactive,
    };
    for (const leg of g.legs) {
      if (leg.squareDepositOrderId) m.set(leg.squareDepositOrderId, entry);
      if (leg.squareDayofOrderId) m.set(leg.squareDayofOrderId, entry);
    }
  }
  return m;
}

/**
 * Collapse VIP combo legs into ONE main-list row. A split combo has two
 * day-of orders (racing + bowling) = two reservation legs; show a single row
 * anchored on the bowling leg (it carries the lane + check-in actions) with
 * the COMBINED total and one view button per day-of order. Non-combo rows
 * pass through. Grouped on the shared deposit order — same key as the VIP
 * combo cards — so it survives the day-of split.
 */
export function mergeComboRows(
  filtered: Reservation[],
  hideCancelled: boolean,
  scheduleIndex: Map<string, ComboScheduleEntry>,
): Array<Reservation & { comboMerge?: ComboMergeInfo }> {
  const comboLegs = new Map<string, Reservation[]>();
  const out: Array<Reservation & { comboMerge?: ComboMergeInfo }> = [];
  for (const r of filtered) {
    if (r.comboSpecialId) {
      const k = comboGroupKey(r);
      const arr = comboLegs.get(k);
      if (arr) arr.push(r);
      else comboLegs.set(k, [r]);
    } else {
      out.push(r);
    }
  }
  for (const legs of comboLegs.values()) {
    const anchor = legs.find((l) => l.productKind === "open" || l.productKind === "kbf") ?? legs[0];
    // Whole-combo retirement (Active Only): drop the merged row only when
    // the GROUP is inactive — 30 min past its last scheduled step — never
    // on a single leg's status (legs flip to completed at check-in while
    // later steps are still ahead). Mirrors the VIP cards' rule.
    if (hideCancelled) {
      const entry =
        scheduleIndex.get(anchor.squareDepositOrderId ?? "") ??
        scheduleIndex.get(anchor.squareDayofOrderId ?? "");
      if (entry?.inactive) continue;
    }
    const byOrder = new Map<string, Reservation>();
    for (const l of legs)
      if (l.squareDayofOrderId && !byOrder.has(l.squareDayofOrderId))
        byOrder.set(l.squareDayofOrderId, l);
    const orders = Array.from(byOrder.values()).map((l) => ({
      orderId: l.squareDayofOrderId as string,
      kind: l.productKind === "race" ? ("Racing" as const) : ("Bowling" as const),
      leg: l,
    }));
    const totalCents = orders.reduce((s, o) => s + (o.leg.totalCents ?? 0), 0) || anchor.totalCents;
    const raceLeg = legs.find((l) => l.productKind === "race");
    const raceBillId = raceLeg?.bmiBillId;
    const raceShortUrl = raceLeg?.confirmationShortUrl;
    out.push({
      ...anchor,
      comboMerge: { totalCents, orders, legCount: legs.length, raceBillId, raceShortUrl },
    });
  }
  return out.sort((a, b) => (a.eventAt ?? a.bookedAt).localeCompare(b.eventAt ?? b.bookedAt));
}
