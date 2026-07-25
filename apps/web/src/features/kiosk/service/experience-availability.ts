/**
 * SERVER-side "is this Experience bookable TODAY?" computation for the kiosk.
 *
 * Runs the same feasibility the booking flow uses, but on the server so it can
 * be computed ONCE and cached (see app/api/kiosk/availability/route.ts) instead
 * of every kiosk browser hammering BMI/QAMF. The data-layer fetchers reach our
 * own /api/* proxies via apiBase() (absolute on the server), so this reuses the
 * exact client logic — no reimplementation.
 *
 *  - race-bowl (VIP combo): a full race → VIP-lane → race chain fits today.
 *  - ultimate-qualifier: any enabled variant for today's schedule has a
 *    Starter + Intermediate pair that clears the package gap.
 *  - every landing tile (owner 2026-07-19 "check all attractions as we near
 *    close"): bowling/KBF via the accurate QAMF scan, racing + each BMI
 *    attraction via "any future slot with capacity left today".
 *
 * Every check defaults to AVAILABLE on error (never false-lock a normally-open
 * experience because a vendor blipped); the route decides whether to cache.
 */
import { buildChains, getComboSpecial } from "~/features/combos";
import { comboMinHeadcount, comboReorderFallbackEnabled } from "~/features/combos/combo-specials";
import {
  candidatesForOrdering,
  fetchComboLegCandidates,
  type ComboLegPayload,
} from "~/features/combos/combo-booking";
import { bmiAdapter } from "~/features/booking/data/bmi";
import { newPartyMember, qamfCenterIdForCode, type CenterCode } from "~/features/booking";
import { violatesMinGapAfter } from "~/features/booking/service/conflict";
import {
  ATTRACTIONS,
  getClientKey,
  type LocationKey,
} from "~/features/booking/service/attractions";
import { getStaticProducts } from "@/app/book/race/data";
import type { FirstOpen } from "./first-available";
import { FASTTRAX_QAMF_CENTER_ID } from "@/lib/qamf-centers";
import { apiBase } from "@/lib/api-base";
import { businessDayYmdET } from "@/lib/race-business-day";
import {
  eligiblePackages,
  primaryTrack,
  scheduleForDate,
  type PackageDefinition,
} from "@/lib/packages";

/** The loosest gap the package heat picker ever allows (it drops 60→30 late in
 *  the day); mirrors PackageCard's gate so availability matches the card. */
const MIN_PACKAGE_GAP_MINUTES = 30;

/** The kiosk race grids' LOOSEST lead (096feb91: 15 min starters / 10 all
 *  others) — the tile stays live while any grid could still show a heat. The
 *  Ultimate Qualifier "next available" uses this SAME short lead so it matches
 *  the regular kiosk racing flow (owner 2026-07-25: a few minutes, not the
 *  combo's 75-min new-racer window). */
const RACE_LEAD_MS = 10 * 60_000;

export interface ExperienceAvailability {
  "race-bowl": boolean;
  "ultimate-qualifier": boolean;
  /** Any open/hourly bowling web offer has a bookable slot left today —
   *  false locks the kiosk's bowling tile (owner 2026-07-19). */
  bowling: boolean;
  kbf: boolean;
  race: boolean;
  "duck-pin": boolean;
  "gel-blaster": boolean;
  "laser-tag": boolean;
  /** Shuffly is per BUILDING (FT side vs HP side, separate BMI products) —
   *  both are computed; the tile looks up the side its kiosk brand resolves. */
  "shuffly-fasttrax": boolean;
  "shuffly-headpinz": boolean;
}

/** The soonest bookable slot per tile, for the kiosk's tile availability line.
 *  BMI attractions/racing carry a per-block count (freeSpots); QAMF bowling/KBF
 *  carry only the time (no lane count) → a time-only "Next lane · TIME" line.
 *  A key is ABSENT when we have no signal (fail-open) — the tile just omits the
 *  line rather than showing "0 left". */
export type ExperienceFirstOpen = Partial<
  Record<
    | "race-bowl"
    | "ultimate-qualifier"
    | "race"
    | "duck-pin"
    | "gel-blaster"
    | "laser-tag"
    | "shuffly-fasttrax"
    | "shuffly-headpinz"
    | "bowling"
    | "kbf",
    FirstOpen
  >
>;

export interface ExperienceAvailabilityResult {
  available: ExperienceAvailability;
  firstOpen: ExperienceFirstOpen;
}

/** open=false locks the tile; firstOpen (when known) feeds its availability
 *  line. A vendor blip resolves to `{ open: true }` with no firstOpen — never
 *  false-lock, never invent a count. */
interface SlotAvailability {
  open: boolean;
  firstOpen?: FirstOpen;
}

/** Resolve a first-open-slot probe into a tile's availability, failing OPEN
 *  (available, no count) on any throw so a vendor blip never locks the tile. */
async function resolveSlotAvailability(
  probe: Promise<FirstOpen | null>,
): Promise<SlotAvailability> {
  try {
    const slot = await probe;
    return { open: slot !== null, firstOpen: slot ?? undefined };
  } catch {
    return { open: true };
  }
}

/** VIP combo (race-bowl): the EARLIEST feasible race→VIP-lane→race chain today
 *  → the tile's "Next available" start. `freeSpots` = min seats across the
 *  chain's RACE legs (the binding constraint — the VIP lane is booked whole for
 *  the group and QAMF gives it no per-seat count). null = nothing fits today. */
async function comboFirstOpenToday(center: CenterCode, dateYmd: string): Promise<FirstOpen | null> {
  const combo = getComboSpecial("race-bowl");
  if (!combo?.enabled || combo.center !== center) return null;
  const centerId = qamfCenterIdForCode(center);
  if (centerId == null) return null;

  const party = Array.from({ length: comboMinHeadcount(combo) }, (_, i) =>
    newPartyMember({ firstName: `probe${i + 1}`, category: "adult", isNewRacer: true }),
  );
  const legCandidates = await fetchComboLegCandidates({ combo, dateYmd, party, centerId });
  let feasible = buildChains(
    legCandidates,
    combo.transitionMinutes,
    combo.components.map((l) => l.maxWaitMinutes ?? null),
  ).filter((c) => c.chain != null);
  if (feasible.length === 0 && comboReorderFallbackEnabled() && combo.fallbackComponents) {
    feasible = buildChains(
      candidatesForOrdering(combo.components, legCandidates, combo.fallbackComponents),
      combo.transitionMinutes,
      combo.fallbackComponents.map((l) => l.maxWaitMinutes ?? null),
      combo.fallbackComponents.map((l) => l.minWaitMinutes ?? null),
    ).filter((c) => c.chain != null);
  }
  if (feasible.length === 0) return null;
  // Earliest feasible chain by its anchor (first race) start.
  const earliest = feasible.reduce((a, b) => (b.anchor.startMs < a.anchor.startMs ? b : a));
  const raceSpots = (earliest.chain ?? [])
    .map((leg) => leg.payload as ComboLegPayload)
    .filter((pl): pl is Extract<ComboLegPayload, { kind: "race" }> => pl.kind === "race")
    .map((pl) => pl.candidate.freeSpots);
  const freeSpots = raceSpots.length > 0 ? Math.min(...raceSpots) : undefined;
  return { start: earliest.anchor.startIso, freeSpots };
}

/** Mirrors PackageCard's `blocked` gate — every component has heats today and
 *  the gap-race has a Starter→Intermediate pair that clears the gap — but also
 *  returns the EARLIEST bookable START heat (the Starter the guest books first)
 *  and its seats, for the tile's "Next available · N slots". null = won't fit. */
async function packageFirstOpen(
  pkg: PackageDefinition,
  dateYmd: string,
): Promise<FirstOpen | null> {
  const heatsByRef: Record<string, Array<{ start: string; stop: string; freeSpots: number }>> = {};
  for (const race of pkg.races) {
    const track = primaryTrack(race);
    try {
      const avail = await bmiAdapter.getAvailability({
        date: dateYmd,
        productId: track.productId,
        pageId: track.pageId,
        quantity: 1,
      });
      const blocks = (avail.proposals ?? [])
        .map((p) => p.blocks?.[0]?.block)
        .filter((b): b is NonNullable<typeof b> => Boolean(b));
      heatsByRef[race.ref] = blocks.map((b) => ({
        start: b.start,
        stop: b.stop,
        freeSpots: b.freeSpots,
      }));
    } catch {
      heatsByRef[race.ref] = [];
    }
  }
  // Only heats far enough out to still be bookable (now + the short racing
  // lead), so the "next available" can never be a heat that already started —
  // and it uses the same few-minute lead as the regular kiosk racing flow.
  const cutoffMs = Date.now() + RACE_LEAD_MS;
  const isFuture = (h: { start: string }) => naiveEtStartMs(h.start) >= cutoffMs;
  const earliestOf = (heats: Array<{ start: string; freeSpots: number }>) => {
    const future = heats.filter(isFuture);
    return future.length === 0
      ? null
      : future.reduce((a, b) => (naiveEtStartMs(b.start) < naiveEtStartMs(a.start) ? b : a));
  };

  const gateRace = pkg.races.find((r) => r.minMinutesAfterEndOf);
  if (!gateRace?.minMinutesAfterEndOf) {
    // No gap gate: bookable iff every race has a heat; start = first race's earliest.
    if (!pkg.races.every((r) => (heatsByRef[r.ref] ?? []).length > 0)) return null;
    const first = earliestOf(heatsByRef[pkg.races[0].ref] ?? []);
    return first ? { start: first.start, freeSpots: first.freeSpots } : null;
  }
  const prev = heatsByRef[gateRace.minMinutesAfterEndOf.ref] ?? []; // the Starter (booked first)
  const next = heatsByRef[gateRace.ref] ?? []; // the Intermediate (must clear the gap)
  if (prev.length === 0 || next.length === 0) return null;
  // Earliest FUTURE Starter heat that still has a valid Intermediate after it.
  const valid = prev.filter(
    (p) =>
      isFuture(p) &&
      next.some((n) => !violatesMinGapAfter(p.stop, n.start, MIN_PACKAGE_GAP_MINUTES)),
  );
  const start = earliestOf(valid);
  return start ? { start: start.start, freeSpots: start.freeSpots } : null;
}

/** The EARLIEST bookable QAMF slot today at one center for a kind set (null =
 *  none left). One cheap 30-min-grid scan of OUR availability route (which
 *  already applies day-of-week offers — KBF's Mon–Fri gate included — the close
 *  filter, and the now-floor). players=2 = the smallest lane party. QAMF returns
 *  bookable times but no lane count, so the returned FirstOpen carries `start`
 *  only — the tile shows a time-only "Next lane · TIME" line. Used for HeadPinz
 *  bowling/KBF AND FastTrax duckpin (now a QAMF center, 11542 — the BMI page it
 *  used to book is stale post-migration). */
async function qamfFirstOpenToday(
  centerId: number,
  dateYmd: string,
  kind: "open,hourly" | "kbf",
  opts?: { durationMinutes?: number },
): Promise<FirstOpen | null> {
  const qs = new URLSearchParams({
    centerId: String(centerId),
    players: "2",
    startDate: dateYmd,
    kind,
    stepMinutes: "30",
    leadMinutes: "0",
  });
  if (opts?.durationMinutes) {
    // Duration-accurate: only slots where a booking of THIS length genuinely
    // fits (lane free for the whole window), so "next available" reflects what
    // we actually sell — e.g. HeadPinz bowling's 1.5-hour offer, not an earlier
    // 1-hour slot. Accurate mode scans the day (no firstOnly early-exit).
    qs.set("durationMinutes", String(opts.durationMinutes));
    qs.set("optionCheck", "accurate");
  } else {
    // No fixed duration → any bookable slot; stop at the first (cheap).
    qs.set("firstOnly", "1");
  }
  const res = await fetch(`${apiBase()}/api/bowling/v2/availability?${qs}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`bowling availability ${res.status}`);
  const data = (await res.json()) as { Availabilities?: Array<{ BookedAt?: string }> };
  const rows = data.Availabilities ?? [];
  // The route sorts by BookedAt asc, but pick the min defensively.
  let earliest: string | null = null;
  for (const r of rows) {
    if (!r.BookedAt) continue;
    if (earliest == null || r.BookedAt < earliest) earliest = r.BookedAt;
  }
  if (!earliest) return null;
  // QAMF's BookedAt carries an ET offset ("…T14:00:00-04:00"); strip it to a
  // zone-less wall-clock so slotLabel renders it the same way as BMI starts.
  const start = earliest.replace(/[+-]\d{2}:\d{2}$/, "").replace(/Z$/, "");
  return { start }; // no freeSpots — QAMF gives no lane count
}

/** Server-safe ms for BMI's zone-less ET wall-clock ("2026-07-19T22:30:00").
 *  The kiosk client leans on the PC clock being ET; this runs on UTC Lambdas,
 *  so the ET offset is applied explicitly (same month-based DST approximation
 *  the bowling availability route uses). */
function naiveEtStartMs(start: string): number {
  const naive = start.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
  const month = parseInt(naive.slice(5, 7), 10);
  const tz = month >= 3 && month <= 11 ? "-04:00" : "-05:00";
  return new Date(`${naive}${tz}`).getTime();
}

/** The EARLIEST future slot with capacity today for one BMI product, or null if
 *  none. Returns the block's `{ start, freeSpots }` so the caller can both lock
 *  the tile (null → nothing left) and show the soonest opening + count. */
async function productFirstOpenSlot(args: {
  dateYmd: string;
  productId: string;
  pageId: string;
  clientKey?: string;
  leadMs: number;
}): Promise<FirstOpen | null> {
  const avail = await bmiAdapter.getAvailability({
    date: args.dateYmd,
    productId: args.productId,
    pageId: args.pageId,
    quantity: 1,
    clientKey: args.clientKey,
  });
  const cutoff = Date.now() + args.leadMs;
  let best: { ms: number; slot: FirstOpen } | null = null;
  for (const p of avail.proposals ?? []) {
    const b = p.blocks?.[0]?.block;
    if (!b || b.freeSpots < 1) continue;
    const ms = naiveEtStartMs(b.start);
    if (ms < cutoff) continue;
    // Proposals aren't guaranteed ordered — keep the earliest qualifying block.
    if (!best || ms < best.ms) best = { ms, slot: { start: b.start, freeSpots: b.freeSpots } };
  }
  return best?.slot ?? null;
}

/** One attraction at one BUILDING: the EARLIEST future slot across its products
 *  (null = nothing left today). No artificial lead (kiosk prime directive:
 *  "book now" — ASAP is fine). `freeSpots` on the returned slot is remaining
 *  lanes/tables (per-slot) or seats (per-person). */
async function attractionFirstOpenToday(
  slug: string,
  location: LocationKey,
  dateYmd: string,
): Promise<FirstOpen | null> {
  const config = ATTRACTIONS[slug];
  const pageId = config?.pageIds[location];
  if (!config || !pageId) return null;
  const products = config.products.filter((p) => p.location === location && !p.isCombo);
  let probed = false;
  let best: FirstOpen | null = null;
  for (const p of products) {
    try {
      const slot = await productFirstOpenSlot({
        dateYmd,
        productId: p.productId,
        pageId,
        clientKey: getClientKey(config, location),
        leadMs: 0,
      });
      probed = true;
      // A product may open earlier than another (e.g. 30-min vs 1-hour duckpin).
      if (slot && (!best || naiveEtStartMs(slot.start) < naiveEtStartMs(best.start))) best = slot;
    } catch {
      /* try the next product */
    }
  }
  // Every probe failed = no signal — throw so the caller's resolver fails OPEN
  // rather than false-locking the tile on a vendor blip.
  if (!probed && products.length > 0) throw new Error(`${slug}@${location}: every probe failed`);
  return best;
}

/** Racing: the EARLIEST heat far enough out for the kiosk grids across today's
 *  SINGLE-race products (null = none). Packs are excluded — they need multiple
 *  heats and carry their own Experiences-shelf gating (ultimate-qualifier).
 *  `freeSpots` is remaining seats in that heat (racing is per-person). */
async function racingFirstOpenToday(dateYmd: string): Promise<FirstOpen | null> {
  const products = [
    ...getStaticProducts(dateYmd, "new"),
    ...getStaticProducts(dateYmd, "existing"),
  ].filter((p) => p.packType === "none");
  const seen = new Set<string>();
  let probed = false;
  let best: FirstOpen | null = null;
  for (const p of products) {
    if (seen.has(p.productId)) continue;
    seen.add(p.productId);
    try {
      const slot = await productFirstOpenSlot({
        dateYmd,
        productId: p.productId,
        pageId: p.pageId,
        leadMs: RACE_LEAD_MS,
      });
      probed = true;
      if (slot && (!best || naiveEtStartMs(slot.start) < naiveEtStartMs(best.start))) best = slot;
    } catch {
      /* try the next product */
    }
  }
  if (!probed && seen.size > 0) throw new Error("racing: every probe failed");
  return best;
}

/** Ultimate Qualifier: earliest bookable start across its enabled variants
 *  today (null = none fit). Starter→Intermediate feasibility per variant. */
async function uqFirstOpenToday(dateYmd: string): Promise<FirstOpen | null> {
  const variants = eligiblePackages({
    racerType: "new",
    schedule: scheduleForDate(dateYmd),
  }).filter((p) => p.id.startsWith("ultimate-qualifier"));
  if (variants.length === 0) return null;
  const results = await Promise.all(variants.map((v) => packageFirstOpen(v, dateYmd)));
  const opens = results.filter((r): r is FirstOpen => r != null);
  if (opens.length === 0) return null;
  return opens.reduce((a, b) => (naiveEtStartMs(b.start) < naiveEtStartMs(a.start) ? b : a));
}

/** Compute availability for the Experiences-shelf items. Each check defaults to
 *  AVAILABLE if it throws — never false-lock on a vendor blip. Attractions and
 *  racing additionally carry their soonest-open slot for the tile availability
 *  line; a blip yields open-with-no-count (never a fabricated "0 left"). */
export async function computeExperienceAvailability(
  center: CenterCode,
): Promise<ExperienceAvailabilityResult> {
  // Same 2 AM-ET business-day rollover the kiosk (and the rest of the app) use,
  // so a post-midnight session still resolves to today's operating date.
  const dateYmd = businessDayYmdET();
  const fm = center === "fort-myers";
  // Nexus attractions live in the HeadPinz building at FM, and at Naples.
  const nexusLoc: LocationKey = fm ? "headpinz" : "naples";
  // Offerings a center doesn't carry resolve open+no-count untouched — their
  // tiles never render there, and open can never false-lock anything.
  const OPEN_NO_COUNT: SlotAvailability = { open: true };

  // HeadPinz bowling/KBF QAMF center for this location (null → no line).
  const hpCenterId = qamfCenterIdForCode(center);
  // Every check runs concurrently — one barrier. Experiences (combo + Ultimate
  // Qualifier) now carry their earliest feasible start + seats; bowling/KBF/
  // duckpin carry a time only (QAMF gives no lane count). All of this runs INSIDE
  // the Redis-cached /api/kiosk/availability compute (3m TTL, single-flight), so
  // the vendors are hit at most once per TTL per center.
  const [combo, uq, race, duckPin, gel, laser, shufFt, shufHp, bowling, kbf] = await Promise.all([
    resolveSlotAvailability(comboFirstOpenToday(center, dateYmd)),
    resolveSlotAvailability(uqFirstOpenToday(dateYmd)),
    fm ? resolveSlotAvailability(racingFirstOpenToday(dateYmd)) : Promise.resolve(OPEN_NO_COUNT),
    // Duckpin migrated to QAMF (FastTrax center 11542) — its old BMI page is
    // stale, so read availability from QAMF like the other lanes (time-only).
    fm
      ? resolveSlotAvailability(qamfFirstOpenToday(FASTTRAX_QAMF_CENTER_ID, dateYmd, "open,hourly"))
      : Promise.resolve(OPEN_NO_COUNT),
    resolveSlotAvailability(attractionFirstOpenToday("gel-blaster", nexusLoc, dateYmd)),
    resolveSlotAvailability(attractionFirstOpenToday("laser-tag", nexusLoc, dateYmd)),
    fm
      ? resolveSlotAvailability(attractionFirstOpenToday("shuffly", "fasttrax", dateYmd))
      : Promise.resolve(OPEN_NO_COUNT),
    fm
      ? resolveSlotAvailability(attractionFirstOpenToday("shuffly", "headpinz", dateYmd))
      : Promise.resolve(OPEN_NO_COUNT),
    // HeadPinz bowling: we sell the 1.5-hour booking, so the tile must reflect
    // when a 90-min booking genuinely fits — probing without a duration surfaced
    // an earlier 1-hour slot as "next available" (owner 2026-07-25). The 1-hour
    // late-night fallback is a separate follow-up (both systems must align).
    hpCenterId != null
      ? resolveSlotAvailability(
          qamfFirstOpenToday(hpCenterId, dateYmd, "open,hourly", { durationMinutes: 90 }),
        )
      : Promise.resolve(OPEN_NO_COUNT),
    hpCenterId != null
      ? resolveSlotAvailability(qamfFirstOpenToday(hpCenterId, dateYmd, "kbf"))
      : Promise.resolve(OPEN_NO_COUNT),
  ]);

  return {
    available: {
      "race-bowl": combo.open,
      "ultimate-qualifier": uq.open,
      bowling: bowling.open,
      kbf: kbf.open,
      race: race.open,
      "duck-pin": duckPin.open,
      "gel-blaster": gel.open,
      "laser-tag": laser.open,
      "shuffly-fasttrax": shufFt.open,
      "shuffly-headpinz": shufHp.open,
    },
    // Undefined values serialize away — absent key = "no line" on that tile.
    // Racing intentionally omitted: the tile still LOCKS via race.open, but shows
    // no availability line — the home-page race grid already covers heat times,
    // and a per-tier line was too busy (owner 2026-07-25).
    firstOpen: {
      "race-bowl": combo.firstOpen,
      "ultimate-qualifier": uq.firstOpen,
      "duck-pin": duckPin.firstOpen,
      "gel-blaster": gel.firstOpen,
      "laser-tag": laser.firstOpen,
      "shuffly-fasttrax": shufFt.firstOpen,
      "shuffly-headpinz": shufHp.firstOpen,
      bowling: bowling.firstOpen,
      kbf: kbf.firstOpen,
    },
  };
}
