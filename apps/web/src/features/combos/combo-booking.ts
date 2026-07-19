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
import {
  bmiAdapter,
  type BmiAvailabilityResponse,
  type BmiBlock,
} from "~/features/booking/data/bmi";
import { apiBase } from "@/lib/api-base";
import { scheduleForDate } from "~/features/booking/service/race-pricing";
import {
  productsForSchedule,
  singleRaceProductsOnTrack,
  type RaceCategory,
  type RaceProduct,
  type RaceTier,
} from "~/features/booking/service/race-products";
import {
  evaluateRaceRestrictions,
  type RestrictionBlock,
  type TrackTierBlock,
} from "~/features/booking/service/race-restriction-rules";
import type { BookingSession, BowlingItem, PartyMember } from "~/features/booking/state/types";
import type {
  BowlingExperienceDurationOption,
  BowlingExperienceWithDetails,
} from "@/lib/bowling-db";

import { wallClockMs, type LegCandidate } from "./combo-itinerary";
import {
  comboJuniorMirrorEnabled,
  legKey,
  type ComboLeg,
  type ComboSpecial,
} from "./combo-specials";

const QAMF_CENTER_CODES: Record<number, string> = {
  9172: "TXBSQN0FEKQ11",
  3148: "PPTR5G2N0QXF7",
};

/** New racers can't start a heat inside this lead window (v1 parity). */
const NEW_RACER_LEAD_MINUTES = 75;

/**
 * Junior mirror window: the junior heat must start within this many minutes of
 * the adult heat — three 12-min grid slots, in EITHER direction (owner
 * 2026-07-14: "juniors can race before, for sure"; up to two slots is the
 * comfortable norm, the third slot is allowed with a guest-facing warning —
 * see JUNIOR_MIRROR_COMFORT_MINUTES). The nearest legal slot always wins, so
 * the far edge is only used when nothing closer works. No legal junior slot
 * in the window → the candidate is dropped (greyed start tile), same
 * presentation as any other infeasible chain.
 */
export const JUNIOR_MIRROR_WINDOW_MINUTES = 36;

/**
 * Beyond this many minutes from the adult heat (i.e. the third grid slot),
 * the schedule card warns the guest about the gap (owner 2026-07-14: "we can
 * go to three with warning to guest"). Read by ComboSteps' schedule renderer.
 */
export const JUNIOR_MIRROR_COMFORT_MINUTES = 24;

/** What `pickJuniorMirror` hands the injected legality predicate per slot. */
export interface JuniorMirrorSlot<B> {
  start: string;
  startMs: number;
  block: B;
}

/**
 * The junior block NEAREST the adult heat (either side, exact-distance tie
 * prefers after), within the mirror window, with room for every junior in the
 * party, passing the injected `isSlotAllowed` predicate (restriction rules +
 * new-racer lead cutoff — injected so this stays pure and unit-testable).
 * Never the adult heat's own start: on a shared track that's a physical
 * double-book, and simultaneous parent/junior races aren't a thing we sell.
 * Join-preference falls out of the restriction engine, not this function — an
 * occupied joinable session near the adult heat simply passes the predicate
 * while an empty slot beside another junior session doesn't.
 * `blocksByStart` is that category's best-block-per-start map from
 * `fetchRaceLegCandidates`.
 */
export function pickJuniorMirror<B extends { freeSpots: number }>(
  blocksByStart: Map<string, B>,
  adultStartMs: number,
  juniorCount: number,
  opts?: {
    windowBeforeMinutes?: number;
    windowAfterMinutes?: number;
    isSlotAllowed?: (slot: JuniorMirrorSlot<B>) => boolean;
  },
): (B & { start: string }) | null {
  const beforeMs = (opts?.windowBeforeMinutes ?? JUNIOR_MIRROR_WINDOW_MINUTES) * 60_000;
  const afterMs = (opts?.windowAfterMinutes ?? JUNIOR_MIRROR_WINDOW_MINUTES) * 60_000;
  let best: (B & { start: string; startMs: number }) | null = null;
  for (const [start, block] of blocksByStart) {
    const startMs = wallClockMs(start);
    if (startMs === adultStartMs) continue;
    if (startMs < adultStartMs - beforeMs || startMs > adultStartMs + afterMs) continue;
    if (block.freeSpots < juniorCount) continue;
    if (opts?.isSlotAllowed && !opts.isSlotAllowed({ start, startMs, block })) continue;
    if (!best) {
      best = { ...block, start, startMs };
      continue;
    }
    const dist = Math.abs(startMs - adultStartMs);
    const bestDist = Math.abs(best.startMs - adultStartMs);
    if (dist < bestDist || (dist === bestDist && startMs > adultStartMs)) {
      best = { ...block, start, startMs };
    }
  }
  if (!best) return null;
  const { startMs: _startMs, ...rest } = best;
  return rest as B & { start: string };
}

function isTodayEt(ymd: string): boolean {
  return ymd === new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/* ───────────────────────── race leg candidates ──────────────────────── */

/**
 * Per-wizard-load availability memo: "date|productId" → the shared fetch.
 * `fetchComboLegCandidates` creates ONE map per load so the cross-tier
 * restriction unions (~6 products per track, needed by BOTH race legs) are
 * fetched once, not once per leg. All cached fetches are quantity 1 — the
 * union is an occupancy signal, and the leg primaries already fetch at 1.
 */
export type RaceAvailabilityCache = Map<string, Promise<BmiAvailabilityResponse>>;

function cachedAvailability(
  cache: RaceAvailabilityCache,
  req: { date: string; productId: string; pageId: string },
): Promise<BmiAvailabilityResponse> {
  const key = `${req.date}|${req.productId}`;
  let p = cache.get(key);
  if (!p) {
    p = bmiAdapter.getAvailability({
      date: req.date,
      productId: req.productId,
      pageId: req.pageId,
      quantity: 1,
    });
    // A cached rejection is re-awaited by every consumer; swallow the floating
    // one so a failed union member never surfaces as an unhandled rejection.
    p.catch(() => {});
    cache.set(key, p);
  }
  return p;
}

/** Availability proposals → RestrictionBlocks (wallClockMs epoch basis —
 *  every block AND candidate in one evaluator call must share it). */
function availabilityToBlocks(av: BmiAvailabilityResponse): RestrictionBlock[] {
  return (av.proposals ?? [])
    .map((p) => p.blocks?.[0]?.block)
    .filter((b): b is BmiBlock => !!b?.start)
    .map((b) => ({ startMs: wallClockMs(b.start), freeSpots: b.freeSpots, capacity: b.capacity }));
}

/**
 * Pure legality-predicate factory for combo leg slots: restriction rules +
 * the new-racer lead cutoff, per (tier, category). Exported for direct unit
 * tests (no bmiAdapter mock needed). Union maps degrade in the safe
 * direction for a PRE-filter: a track missing from `allTierByTrack` (a union
 * member failed to load) makes `reserveStarterRoomPerClockHour` no-op
 * (fail-open — the server guard in assertHeatBookable stays authoritative),
 * while a partial junior union merely sees fewer occupied heats (also open).
 * `expressEligible` is pinned false: waiverValid is unread in the combo
 * party, the server guard resolves the same way, and the opening window
 * (ends 1:24 PM weekday) is out of reach of every combo start grid anyway.
 */
export function makeComboRestrictionCheck(args: {
  tier: string;
  category: RaceCategory;
  nowMs: number;
  leadCutoffMs: number | null;
  /** Own-tier blocks per track (the candidate category's leg products). */
  productBlocksByTrack: Map<string, RestrictionBlock[]>;
  /** All junior tiers merged, per track (categoryTrackBlocks signal). */
  juniorUnionByTrack?: Map<string, RestrictionBlock[]>;
  /** All tiers+categories per track; a track maps to undefined when any
   *  member fetch failed (fail-open for the starter-room rule). */
  allTierByTrack?: Map<string, TrackTierBlock[] | undefined>;
}): (slot: { start: string; startMs: number; track: string | null }) => boolean {
  return ({ start, startMs, track }) => {
    if (args.leadCutoffMs != null && startMs < args.leadCutoffMs) return false;
    const verdict = evaluateRaceRestrictions({
      tier: args.tier as RaceTier,
      category: args.category,
      track,
      candidateStartMs: startMs,
      candidateStartLocal: start,
      nowMs: args.nowMs,
      productBlocks: args.productBlocksByTrack.get(track ?? "") ?? [],
      categoryTrackBlocks:
        args.category === "junior" ? args.juniorUnionByTrack?.get(track ?? "") : undefined,
      trackAllTierBlocks: args.allTierByTrack?.get(track ?? ""),
      expressEligible: false,
      isComboBooking: true,
    });
    return !verdict.blocked;
  };
}

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
  /**
   * Per-category booking info for `entriesForPick`-style heat writes.
   * `start`/`stop` are set only when the category races at a DIFFERENT time
   * than the anchor (the junior mirror — juniors race on the nearest legal
   * junior heat, either side of the adult one); absent = the category shares
   * the candidate's `start` (current same-start behavior, always the case for
   * the primary category).
   */
  perCategory: Partial<
    Record<
      RaceCategory,
      {
        productId: string;
        track: string | null;
        freeSpots: number;
        start?: string;
        stop?: string;
      }
    >
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
  /** Shared per-wizard-load availability memo (see RaceAvailabilityCache). */
  cache?: RaceAvailabilityCache;
}): Promise<ComboHeatCandidate[]> {
  const { dateYmd, tier, party, cache = new Map() } = args;
  const cats = categoriesInParty(party);
  if (cats.length === 0) return [];

  type BlockInfo = { stop: string; freeSpots: number; productId: string; track: string | null };
  // Per category: "start|track" → block (primary enumerates per-track);
  // plus per category: start → best block across tracks (secondary match);
  // plus per category: track → own-tier RestrictionBlocks (evaluator signal).
  const perCatByStartTrack = new Map<RaceCategory, Map<string, BlockInfo & { start: string }>>();
  const perCatBestByStart = new Map<RaceCategory, Map<string, BlockInfo>>();
  const perCatBlocksByTrack = new Map<RaceCategory, Map<string, RestrictionBlock[]>>();
  const legTracksByCategory = new Map<RaceCategory, string[]>();

  // All (category × track-product) availability calls fire in PARALLEL — they
  // were serial awaits, which made the start-time grid feel stuck on a blind
  // spinner for multi-track tiers.
  const catResults = await Promise.all(
    cats.map(async ({ category }) => {
      const products = productsForLeg(dateYmd, tier, category);
      if (products.length === 0)
        return { category, byStartTrack: null, bestByStart: null, blocksByTrack: null, products };
      const byStartTrack = new Map<string, BlockInfo & { start: string }>();
      const bestByStart = new Map<string, BlockInfo>();
      const blocksByTrack = new Map<string, RestrictionBlock[]>();
      const availabilities = await Promise.all(
        products.map(async (product) => ({
          product,
          availability: await cachedAvailability(cache, {
            date: dateYmd,
            productId: product.productId,
            pageId: product.pageId,
          }),
        })),
      );
      for (const { product, availability } of availabilities) {
        const track = (product.track as string | null) ?? null;
        const trackBlocks = blocksByTrack.get(track ?? "") ?? [];
        for (const proposal of availability.proposals ?? []) {
          const block = proposal.blocks?.[0]?.block;
          if (!block?.start) continue;
          const info: BlockInfo = {
            stop: block.stop,
            freeSpots: block.freeSpots,
            productId: product.productId,
            track,
          };
          byStartTrack.set(`${block.start}|${info.track ?? ""}`, { ...info, start: block.start });
          const prev = bestByStart.get(block.start);
          if (!prev || info.freeSpots > prev.freeSpots) bestByStart.set(block.start, info);
          trackBlocks.push({
            startMs: wallClockMs(block.start),
            freeSpots: block.freeSpots,
            capacity: block.capacity,
          });
        }
        blocksByTrack.set(track ?? "", trackBlocks);
      }
      return { category, byStartTrack, bestByStart, blocksByTrack, products };
    }),
  );
  for (const r of catResults) {
    // No product for this (tier, category, schedule) — e.g. junior Starter on
    // Mega Tuesday doesn't exist → the whole leg is infeasible.
    if (!r.byStartTrack || !r.bestByStart || !r.blocksByTrack) return [];
    perCatByStartTrack.set(r.category, r.byStartTrack);
    perCatBestByStart.set(r.category, r.bestByStart);
    perCatBlocksByTrack.set(r.category, r.blocksByTrack);
    legTracksByCategory.set(r.category, [
      ...new Set(r.products.map((p) => p.track).filter((t): t is string => !!t)),
    ]);
  }

  // Cross-tier occupancy unions for the restriction evaluator — mirrors the
  // server guard's fan-out (assertHeatBookable). Junior candidates always need
  // their track's unions (junior back-to-back + starter-room); adult
  // candidates only when the leg isn't adult Starter (starter-room guards
  // int/pro — adult Starter has no union-fed rule). Best-effort per product:
  // junior union degrades open (fewer occupied heats seen); the all-tier union
  // is dropped for a track when ANY member failed, because a partial union
  // UNDERCOUNTS Starter room and would false-block — the server guard stays
  // authoritative either way.
  const unionTracks = new Set<string>();
  for (const [category, tracks] of legTracksByCategory) {
    if (category === "junior" || tier !== "starter") tracks.forEach((t) => unionTracks.add(t));
  }
  const juniorUnionByTrack = new Map<string, RestrictionBlock[]>();
  const allTierByTrack = new Map<string, TrackTierBlock[] | undefined>();
  if (unionTracks.size > 0) {
    const schedule = scheduleForDate(dateYmd);
    await Promise.all(
      [...unionTracks].map(async (track) => {
        let unionProducts = singleRaceProductsOnTrack(track, schedule, "existing");
        if (unionProducts.length === 0)
          unionProducts = singleRaceProductsOnTrack(track, schedule, "new");
        const fetched = await Promise.all(
          unionProducts.map(async (p) => {
            try {
              const av = await cachedAvailability(cache, {
                date: dateYmd,
                productId: p.productId,
                pageId: p.pageId,
              });
              return { p, blocks: availabilityToBlocks(av) };
            } catch {
              return null; // best-effort — see note above
            }
          }),
        );
        const all: TrackTierBlock[] = [];
        const junior: RestrictionBlock[] = [];
        let complete = true;
        for (const f of fetched) {
          if (!f) {
            complete = false;
            continue;
          }
          const adultStarter = f.p.tier === "starter" && f.p.category === "adult";
          all.push(...f.blocks.map((b) => ({ ...b, adultStarter })));
          if (f.p.category === "junior") junior.push(...f.blocks);
        }
        if (junior.length > 0) juniorUnionByTrack.set(track, junior);
        allTierByTrack.set(track, complete ? all : undefined);
      }),
    );
  }

  const anyNewRacer = party.some((m) => m.isNewRacer);
  const leadCutoffMs =
    anyNewRacer && isTodayEt(dateYmd) ? Date.now() + NEW_RACER_LEAD_MINUTES * 60_000 : null;
  const nowMs = Date.now();

  // Primary category drives the (start, track) cards; secondaries must match
  // the start with capacity on their best track. Every candidate slot —
  // primary, same-start secondary, and junior mirror — must pass the
  // restriction rules HERE so the grid never offers a start the hold
  // (assertHeatBookable) would reject after the fact.
  const [primary, ...rest] = cats;
  const primaryAllowed = makeComboRestrictionCheck({
    tier,
    category: primary.category,
    nowMs,
    leadCutoffMs,
    productBlocksByTrack: perCatBlocksByTrack.get(primary.category)!,
    juniorUnionByTrack,
    allTierByTrack,
  });
  const juniorAllowed = rest.some((c) => c.category === "junior")
    ? makeComboRestrictionCheck({
        tier,
        category: "junior",
        nowMs,
        leadCutoffMs,
        productBlocksByTrack: perCatBlocksByTrack.get("junior") ?? new Map(),
        juniorUnionByTrack,
        allTierByTrack,
      })
    : null;
  const candidates: ComboHeatCandidate[] = [];
  for (const base of perCatByStartTrack.get(primary.category)!.values()) {
    if (base.freeSpots < primary.count) continue;
    if (
      !primaryAllowed({ start: base.start, startMs: wallClockMs(base.start), track: base.track })
    ) {
      continue;
    }
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
      // Junior mirror (flag-gated): juniors race right AROUND the adult heat
      // (nearest slot either side — see pickJuniorMirror) instead of needing a
      // junior block at the SAME start (which never aligns — junior sessions
      // run their own grid, so mixed parties were effectively unbookable).
      // `rest` only contains juniors when adults are the primary category, so
      // `base` is always the adult heat here.
      if (category === "junior" && comboJuniorMirrorEnabled()) {
        const mirror = pickJuniorMirror(
          perCatBestByStart.get(category)!,
          wallClockMs(base.start),
          count,
          {
            isSlotAllowed: (slot) =>
              juniorAllowed!({ start: slot.start, startMs: slot.startMs, track: slot.block.track }),
          },
        );
        if (!mirror) {
          ok = false;
          break;
        }
        perCategory[category] = {
          productId: mirror.productId,
          track: mirror.track,
          freeSpots: mirror.freeSpots,
          start: mirror.start,
          stop: mirror.stop,
        };
        minFree = Math.min(minFree, mirror.freeSpots);
        continue;
      }
      const match = perCatBestByStart.get(category)!.get(base.start);
      if (!match || match.freeSpots < count) {
        ok = false;
        break;
      }
      // Legacy same-start path (mirror kill-switch off): the junior share of
      // the slot still has to clear the junior rules on ITS track.
      if (
        category === "junior" &&
        juniorAllowed &&
        !juniorAllowed({ start: base.start, startMs: wallClockMs(base.start), track: match.track })
      ) {
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

  const expRes = await fetch(`${apiBase()}/api/bowling/v2/experiences?centerCode=${centerCode}`);
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

  // 15-min granularity (not 30) so a lane at :45 past the hour is surfaced —
  // race-start + 45 (e.g. a 2 PM race → 2:45 lane) must be a real candidate,
  // else the engine rounds bowling up to the next :00/:30 slot. Doubles the
  // QAMF probe count for the day; acceptable for the combo wizard's spinner.
  const slots = parseAvailabilities(
    await probeAvailability(
      `/api/bowling/v2/availability?centerId=${centerId}&players=${players}&startDate=${dateYmd}&kind=open,hourly&stepMinutes=15`,
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

/**
 * Assumed wall-clock length of a race leg for combo SCHEDULING (owner rule:
 * "assume racing takes 30 minutes, then start bowling 15 minutes after that").
 * The BMI heat block is only the ~12-min on-track time, not the full
 * check-in / briefing / results / walk-to-HeadPinz experience — scheduling
 * off the raw block landed the lane mid-experience. We deliberately ignore
 * BMI's stop here and reserve a flat 30 min; combined with the 15-min
 * transition buffer this floors bowling at race-start + 45. The real heat
 * start/stop is still carried in the payload for booking + display.
 */
const ASSUMED_RACE_LEG_MINUTES = 30;

/**
 * Scheduling end of a race-leg candidate: the LAST category's race start (a
 * junior mirror may run after the adult heat; a BEFORE-mirror leaves the
 * adult heat last) + the flat 30-min leg duration — so the next leg's wait
 * window (bowling maxWaitMinutes, transition buffer) measures from the final
 * race of the leg. Pure — unit-tested directly.
 */
export function raceLegEndMs(candidate: ComboHeatCandidate): number {
  const lastStartMs = Math.max(
    wallClockMs(candidate.start),
    ...Object.values(candidate.perCategory).map((c) =>
      c.start ? wallClockMs(c.start) : wallClockMs(candidate.start),
    ),
  );
  return lastStartMs + ASSUMED_RACE_LEG_MINUTES * 60_000;
}

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
  // One availability memo per wizard load: both race legs share the same
  // cross-tier restriction unions, so each (date, product) is fetched once.
  const cache: RaceAvailabilityCache = new Map();
  return Promise.all(
    combo.components.map(async (leg, i) => {
      const candidates = await legCandidates(leg, { combo, dateYmd, party, centerId, cache });
      onLegDone?.(i);
      return candidates;
    }),
  );
}

/**
 * Reindex the candidate arrays fetched for one ordering (`primaryComponents`)
 * onto another ordering of the SAME legs (e.g. a combo's `fallbackComponents`).
 * Matched by `legKey`, so the reorder fallback reuses the single
 * `fetchComboLegCandidates` result — NO extra BMI/QAMF calls. Legs with no
 * match (shouldn't happen for a same-legs reordering) map to an empty array.
 */
export function candidatesForOrdering<T>(
  primaryComponents: ComboLeg[],
  primaryCandidates: Array<Array<LegCandidate<T>>>,
  ordering: ComboLeg[],
): Array<Array<LegCandidate<T>>> {
  const byKey = new Map<string, Array<LegCandidate<T>>>();
  primaryComponents.forEach((leg, i) => byKey.set(legKey(leg), primaryCandidates[i] ?? []));
  return ordering.map((leg) => byKey.get(legKey(leg)) ?? []);
}

async function legCandidates(
  leg: ComboLeg,
  ctx: {
    combo: ComboSpecial;
    dateYmd: string;
    party: PartyMember[];
    centerId: number;
    cache?: RaceAvailabilityCache;
  },
): Promise<Array<LegCandidate<ComboLegPayload>>> {
  if (leg.kind === "race") {
    const candidates = await fetchRaceLegCandidates({
      dateYmd: ctx.dateYmd,
      tier: leg.tier,
      party: ctx.party,
      cache: ctx.cache,
    });
    return candidates.map((candidate) => {
      const startMs = wallClockMs(candidate.start);
      // Schedule off a flat 30-min race leg, NOT the ~12-min BMI heat block —
      // see ASSUMED_RACE_LEG_MINUTES — measured from the leg's LAST race (a
      // mirrored junior heat pushes the end out; see raceLegEndMs).
      // (candidate.start/stop stay intact in the payload for booking + display.)
      return {
        startIso: candidate.start,
        startMs,
        endMs: raceLegEndMs(candidate),
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
