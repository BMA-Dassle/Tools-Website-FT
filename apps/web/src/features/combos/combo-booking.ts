/**
 * Combo booking data layer — fetches the per-leg candidates the itinerary
 * engine chains over, and configures/holds the bowling item programmatically
 * (the combo wizard never renders the bowling steps).
 *
 * Registry-generic: candidates are produced PER LEG from the combo's
 * `components`, so future combos (other tiers, other durations, more legs)
 * are data changes. Attraction legs are not yet supported (the pricing gate
 * rejects them, and `fetchComboLegCandidates` throws explicitly).
 *
 * Client-side module (browser fetch via the existing /api proxies), used by
 * the combo steps.
 */

import {
  parseAvailabilities,
  probeAvailability,
  type AvailabilitySlot,
} from "~/components/features/booking/steps/bowling/availability-client";
import { bmiAdapter } from "~/features/booking/data/bmi";
import { scheduleForDate } from "~/features/booking/service/race-pricing";
import {
  productsForSchedule,
  type RaceCategory,
  type RaceProduct,
} from "~/features/booking/service/race-products";
import type { BookingSession, BowlingItem, PartyMember } from "~/features/booking/state/types";
import type {
  BowlingExperienceDurationOption,
  BowlingExperienceWithDetails,
} from "@/lib/bowling-db";

import { wallClockMs, type LegCandidate } from "./combo-itinerary";
import type { ComboLeg, ComboSpecial } from "./combo-specials";

const QAMF_CENTER_CODES: Record<number, string> = {
  9172: "TXBSQN0FEKQ11",
  3148: "PPTR5G2N0QXF7",
};

/** New racers can't start a heat inside this lead window (v1 parity). */
const NEW_RACER_LEAD_MINUTES = 75;

function isTodayEt(ymd: string): boolean {
  return ymd === new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/* ───────────────────────── race leg candidates ──────────────────────── */

/** What one bookable race-leg start needs per category present in the party. */
export interface ComboHeatCandidate {
  /** BMI wall-clock-in-Z start (the heatId the cart stores). */
  start: string;
  stop: string;
  /**
   * The PRIMARY category's track (adults when present, else juniors) — the
   * card identity in the grid, matching the normal Red/Blue heat picker.
   * One candidate per (start, track); other categories ride the same start
   * on whatever track they have (juniors are Blue-only off-Mega).
   */
  track: string | null;
  /** Min free spots across the categories (vs that category's headcount). */
  freeSpots: number;
  /** Per-category booking info for `entriesForPick`-style heat writes. */
  perCategory: Partial<
    Record<RaceCategory, { productId: string; track: string | null; freeSpots: number }>
  >;
}

export type ComboRaceLegPayload = { kind: "race"; tier: string; candidate: ComboHeatCandidate };
export type ComboBowlingLegPayload = {
  kind: "bowling";
  slot: AvailabilitySlot;
  experience: BowlingExperienceWithDetails;
  durationOption: BowlingExperienceDurationOption;
};
export type ComboLegPayload = ComboRaceLegPayload | ComboBowlingLegPayload;

function categoriesInParty(party: PartyMember[]): Array<{ category: RaceCategory; count: number }> {
  const counts: Record<RaceCategory, number> = { adult: 0, junior: 0 };
  for (const m of party) counts[(m.category ?? "adult") as RaceCategory] += 1;
  return (Object.keys(counts) as RaceCategory[])
    .filter((c) => counts[c] > 0)
    .map((category) => ({ category, count: counts[category] }));
}

/** Single-race products for (schedule, tier, category) — prefer the
 *  existing-racer entry; fall back to the new-racer one. Booking resolves the
 *  $0 build pair from (category:tier:track) either way. */
function productsForLeg(dateYmd: string, tier: string, category: RaceCategory): RaceProduct[] {
  const schedule = scheduleForDate(dateYmd);
  const pick = (racerType: "existing" | "new") =>
    productsForSchedule(schedule, racerType).filter(
      (p) => p.tier === tier && p.category === category && !p.packType && !p.trackProducts,
    );
  const existing = pick("existing");
  return existing.length ? existing : pick("new");
}

/**
 * Candidate starts for ONE race leg — one candidate per (start, PRIMARY
 * track), matching the normal Red/Blue heat grid. The primary category
 * (adults when present, else juniors) enumerates its per-track blocks; every
 * OTHER category present must have a block at the SAME start (its best
 * track) with enough free spots for its headcount — the combo books the
 * whole party onto one start per leg. When any racer is new and the date is
 * today, starts inside the 75-min lead window are dropped.
 */
export async function fetchRaceLegCandidates(args: {
  dateYmd: string;
  tier: string;
  party: PartyMember[];
}): Promise<ComboHeatCandidate[]> {
  const { dateYmd, tier, party } = args;
  const cats = categoriesInParty(party);
  if (cats.length === 0) return [];

  type BlockInfo = { stop: string; freeSpots: number; productId: string; track: string | null };
  // Per category: "start|track" → block (primary enumerates per-track);
  // plus per category: start → best block across tracks (secondary match).
  const perCatByStartTrack = new Map<RaceCategory, Map<string, BlockInfo & { start: string }>>();
  const perCatBestByStart = new Map<RaceCategory, Map<string, BlockInfo>>();

  // All (category × track-product) availability calls fire in PARALLEL — they
  // were serial awaits, which made the start-time grid feel stuck on a blind
  // spinner for multi-track tiers.
  const catResults = await Promise.all(
    cats.map(async ({ category }) => {
      const products = productsForLeg(dateYmd, tier, category);
      if (products.length === 0) return { category, byStartTrack: null, bestByStart: null };
      const byStartTrack = new Map<string, BlockInfo & { start: string }>();
      const bestByStart = new Map<string, BlockInfo>();
      const availabilities = await Promise.all(
        products.map(async (product) => ({
          product,
          availability: await bmiAdapter.getAvailability({
            date: dateYmd,
            productId: product.productId,
            pageId: product.pageId,
            quantity: 1,
          }),
        })),
      );
      for (const { product, availability } of availabilities) {
        for (const proposal of availability.proposals ?? []) {
          const block = proposal.blocks?.[0]?.block;
          if (!block?.start) continue;
          const info: BlockInfo = {
            stop: block.stop,
            freeSpots: block.freeSpots,
            productId: product.productId,
            track: (product.track as string | null) ?? null,
          };
          byStartTrack.set(`${block.start}|${info.track ?? ""}`, { ...info, start: block.start });
          const prev = bestByStart.get(block.start);
          if (!prev || info.freeSpots > prev.freeSpots) bestByStart.set(block.start, info);
        }
      }
      return { category, byStartTrack, bestByStart };
    }),
  );
  for (const r of catResults) {
    // No product for this (tier, category, schedule) — e.g. junior Starter on
    // Mega Tuesday doesn't exist → the whole leg is infeasible.
    if (!r.byStartTrack || !r.bestByStart) return [];
    perCatByStartTrack.set(r.category, r.byStartTrack);
    perCatBestByStart.set(r.category, r.bestByStart);
  }

  const anyNewRacer = party.some((m) => m.isNewRacer);
  const leadCutoffMs =
    anyNewRacer && isTodayEt(dateYmd) ? Date.now() + NEW_RACER_LEAD_MINUTES * 60_000 : null;

  // Primary category drives the (start, track) cards; secondaries must match
  // the start with capacity on their best track.
  const [primary, ...rest] = cats;
  const candidates: ComboHeatCandidate[] = [];
  for (const base of perCatByStartTrack.get(primary.category)!.values()) {
    if (base.freeSpots < primary.count) continue;
    const perCategory: ComboHeatCandidate["perCategory"] = {
      [primary.category]: {
        productId: base.productId,
        track: base.track,
        freeSpots: base.freeSpots,
      },
    };
    let ok = true;
    let minFree = base.freeSpots;
    for (const { category, count } of rest) {
      const match = perCatBestByStart.get(category)!.get(base.start);
      if (!match || match.freeSpots < count) {
        ok = false;
        break;
      }
      perCategory[category] = {
        productId: match.productId,
        track: match.track,
        freeSpots: match.freeSpots,
      };
      minFree = Math.min(minFree, match.freeSpots);
    }
    if (!ok) continue;
    if (leadCutoffMs != null && wallClockMs(base.start) < leadCutoffMs) continue;
    candidates.push({
      start: base.start,
      stop: base.stop,
      track: base.track,
      freeSpots: minFree,
      perCategory,
    });
  }
  return candidates.sort(
    (a, b) =>
      wallClockMs(a.start) - wallClockMs(b.start) || (a.track ?? "").localeCompare(b.track ?? ""),
  );
}

/* ──────────────────────── bowling leg candidates ────────────────────── */

export interface ComboBowlingCandidate {
  slot: AvailabilitySlot;
  experience: BowlingExperienceWithDetails;
  durationOption: BowlingExperienceDurationOption;
}

/**
 * Candidate lane slots for a bowling leg: experiences of the leg's TIER
 * (VIP when `vip`, regular otherwise) valid on the date that offer EXACTLY
 * the leg's duration, from a full-day 30-min probe.
 */
export async function fetchBowlingLegCandidates(args: {
  centerId: number;
  dateYmd: string;
  players: number;
  durationMinutes: number;
  vip?: boolean;
}): Promise<ComboBowlingCandidate[]> {
  const { centerId, dateYmd, players, durationMinutes, vip = false } = args;
  const centerCode = QAMF_CENTER_CODES[centerId];
  if (!centerCode) return [];

  const expRes = await fetch(`/api/bowling/v2/experiences?centerCode=${centerCode}`);
  const expData = await expRes.json().catch(() => []);
  const all: BowlingExperienceWithDetails[] = Array.isArray(expData) ? expData : [];
  const dow = new Date(`${dateYmd}T12:00:00`).getDay();
  const eligible = all
    .map((exp) => ({
      exp,
      durationOption: (exp.durationOptions ?? []).find(
        (d) => d.durationMinutes === durationMinutes,
      ),
    }))
    .filter(
      (
        e,
      ): e is {
        exp: BowlingExperienceWithDetails;
        durationOption: BowlingExperienceDurationOption;
      } =>
        !!e.durationOption &&
        e.exp.isVip === vip &&
        e.exp.kind !== "kbf" &&
        (!Array.isArray(e.exp.daysOfWeek) ||
          e.exp.daysOfWeek.length === 0 ||
          e.exp.daysOfWeek.includes(dow)),
    );
  if (eligible.length === 0) return [];

  const slots = parseAvailabilities(
    await probeAvailability(
      `/api/bowling/v2/availability?centerId=${centerId}&players=${players}&startDate=${dateYmd}&kind=open,hourly&stepMinutes=30`,
    ),
  );

  const out: ComboBowlingCandidate[] = [];
  for (const slot of slots) {
    const match = eligible.find((e) => e.exp.qamfWebOfferId === slot.webOfferId);
    if (!match) continue;
    // QAMF tells us which Time options are bookable at this start — require
    // the leg's exact duration when the list is present.
    if (
      slot.availableTimeOptionIds?.length &&
      !slot.availableTimeOptionIds.includes(match.durationOption.qamfOptionId)
    ) {
      continue;
    }
    out.push({ slot, experience: match.exp, durationOption: match.durationOption });
  }
  return out.sort((a, b) => wallClockMs(a.slot.bookedAt) - wallClockMs(b.slot.bookedAt));
}

/* ───────────────── leg-generic candidate assembly ───────────────────── */

/** Heat-block length fallback when BMI returns no stop (defensive). */
const DEFAULT_RACE_LEG_MINUTES = 30;

/**
 * Fetch every leg's candidates for `buildChains`, in the combo's itinerary
 * order. Legs load IN PARALLEL (BMI dayplanner + the QAMF full-day probe are
 * each seconds-slow; serializing them doubled the spinner). `onLegDone`
 * fires per leg as it resolves so the wizard can show a live checklist
 * instead of a blind spinner. Attraction legs throw — typed for
 * forward-compat, not yet built.
 */
export async function fetchComboLegCandidates(args: {
  combo: ComboSpecial;
  dateYmd: string;
  party: PartyMember[];
  centerId: number;
  onLegDone?: (legIndex: number) => void;
}): Promise<Array<Array<LegCandidate<ComboLegPayload>>>> {
  const { combo, dateYmd, party, centerId, onLegDone } = args;
  return Promise.all(
    combo.components.map(async (leg, i) => {
      const candidates = await legCandidates(leg, { combo, dateYmd, party, centerId });
      onLegDone?.(i);
      return candidates;
    }),
  );
}

async function legCandidates(
  leg: ComboLeg,
  ctx: { combo: ComboSpecial; dateYmd: string; party: PartyMember[]; centerId: number },
): Promise<Array<LegCandidate<ComboLegPayload>>> {
  if (leg.kind === "race") {
    const candidates = await fetchRaceLegCandidates({
      dateYmd: ctx.dateYmd,
      tier: leg.tier,
      party: ctx.party,
    });
    return candidates.map((candidate) => {
      const startMs = wallClockMs(candidate.start);
      const endMs = candidate.stop
        ? wallClockMs(candidate.stop)
        : startMs + DEFAULT_RACE_LEG_MINUTES * 60_000;
      return {
        startIso: candidate.start,
        startMs,
        endMs,
        payload: { kind: "race", tier: leg.tier, candidate } satisfies ComboRaceLegPayload,
      };
    });
  }
  if (leg.kind === "bowling") {
    const candidates = await fetchBowlingLegCandidates({
      centerId: ctx.centerId,
      dateYmd: ctx.dateYmd,
      players: ctx.party.length,
      durationMinutes: leg.durationMinutes,
      vip: leg.vip ?? false,
    });
    return candidates.map(({ slot, experience, durationOption }) => {
      const startMs = wallClockMs(slot.bookedAt);
      return {
        startIso: slot.bookedAt,
        startMs,
        endMs: startMs + leg.durationMinutes * 60_000,
        payload: { kind: "bowling", slot, experience, durationOption },
      };
    });
  }
  throw new Error(`Combo leg kind "${leg.kind}" is not supported by the wizard yet`);
}

/* ───────────── bowling item programmatic config + hold ──────────────── */

/** ET hour (0–26 chip notation) + minute from a QAMF offset ISO. */
function etHourMinute(iso: string): { hour: number; minute: number } {
  const naive = iso.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
  const d = new Date(naive);
  const h = d.getHours();
  return { hour: h < 6 ? h + 24 : h, minute: d.getMinutes() };
}

/**
 * The BowlingItem patch that fully configures the combo's bowling leg from a
 * picked candidate — what the bowling wizard steps would have written
 * (mirrors BowlingOfferStep.buildLineItems for per-lane hourly experiences).
 * The QAMF hold is NOT created here (see holdComboBowling).
 */
export function comboBowlingPatch(
  candidate: ComboBowlingCandidate,
  players: number,
  dateYmd: string,
): Partial<BowlingItem> {
  const { slot, experience, durationOption } = candidate;
  const laneCount = Math.max(1, Math.ceil(players / 6));
  const isPerLane = experience.kind === "hourly" || experience.slug.startsWith("pizza-bowl");
  const qtyMultiplier = isPerLane ? laneCount : players;

  const lineItems = (experience.items ?? []).map((ei) => {
    const isPrimary = ei.sortOrder === 0;
    const useOverride = isPrimary && durationOption.overrideSquareProductId;
    return {
      squareProductId: useOverride ? durationOption.overrideSquareProductId! : ei.squareProductId,
      quantity: isPrimary
        ? ei.quantity * qtyMultiplier * durationOption.squareMultiplier
        : ei.quantity * laneCount,
      label: ei.label,
      priceCents: useOverride
        ? (durationOption.overridePriceCents ?? ei.priceCents)
        : ei.priceCents,
      depositPct: useOverride
        ? (durationOption.overrideDepositPct ?? ei.depositPct)
        : ei.depositPct,
      squareCatalogObjectId: useOverride
        ? (durationOption.overrideCatalogObjectId ?? ei.squareCatalogObjectId)
        : ei.squareCatalogObjectId,
    };
  });

  const { hour, minute } = etHourMinute(slot.bookedAt);
  return {
    variant: "hourly",
    tier: experience.isVip ? "vip" : "regular",
    date: dateYmd,
    hour,
    minute,
    bookedAt: slot.bookedAt,
    experienceId: experience.id,
    experienceSlug: experience.slug,
    webOfferId: slot.webOfferId,
    optionId: durationOption.qamfOptionId,
    optionType: slot.optionType ?? "Time",
    laneCount,
    durationMinutes: durationOption.durationMinutes,
    durationMultiplier: durationOption.squareMultiplier,
    playerCount: players,
    lineItems,
    rawItems: [],
    hasBookingFee: true,
  };
}

/**
 * Create the QAMF temporary hold for a combo bowling leg that was configured
 * via `comboBowlingPatch`. Idempotent: a live hold on the item is kept.
 * Returns the reservation id (throws on failure — the caller surfaces it).
 */
export async function holdComboBowling(args: {
  session: BookingSession;
  item: BowlingItem;
  centerId: number;
}): Promise<string> {
  const { item, centerId } = args;
  if (item.qamfReservationId) return item.qamfReservationId;
  if (!item.webOfferId || !item.bookedAt) {
    throw new Error("Bowling leg isn't configured yet");
  }
  const res = await fetch("/api/bowling/v2/reserve/hold", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      centerId,
      webOfferId: item.webOfferId,
      optionId: item.optionId,
      optionType: item.optionType ?? "Time",
      bookedAt: item.bookedAt,
      players: item.playerCount,
      service: "BookForLater",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.qamfReservationId) {
    throw new Error(data.error ?? "Couldn't hold the bowling lane — please pick another time.");
  }
  return data.qamfReservationId as string;
}

/** Release a combo bowling hold (best-effort — QAMF holds TTL out anyway). */
export async function releaseComboBowlingHold(item: BowlingItem): Promise<void> {
  if (!item.qamfReservationId || !item.qamfCenterId) return;
  try {
    await fetch(`/api/bowling/v2/reserve/hold/${item.qamfReservationId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ centerId: item.qamfCenterId }),
    });
  } catch {
    /* TTLs out server-side */
  }
}
