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
import { candidatesForOrdering, fetchComboLegCandidates } from "~/features/combos/combo-booking";
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
 *  others) — the tile stays live while any grid could still show a heat. */
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

async function isComboBookableToday(center: CenterCode, dateYmd: string): Promise<boolean> {
  const combo = getComboSpecial("race-bowl");
  if (!combo?.enabled || combo.center !== center) return false;
  const centerId = qamfCenterIdForCode(center);
  if (centerId == null) return false;

  const party = Array.from({ length: comboMinHeadcount(combo) }, (_, i) =>
    newPartyMember({ firstName: `probe${i + 1}`, category: "adult", isNewRacer: true }),
  );
  const legCandidates = await fetchComboLegCandidates({ combo, dateYmd, party, centerId });
  let feasible = buildChains(
    legCandidates,
    combo.transitionMinutes,
    combo.components.map((l) => l.maxWaitMinutes ?? null),
  ).some((c) => c.chain != null);
  if (!feasible && comboReorderFallbackEnabled() && combo.fallbackComponents) {
    feasible = buildChains(
      candidatesForOrdering(combo.components, legCandidates, combo.fallbackComponents),
      combo.transitionMinutes,
      combo.fallbackComponents.map((l) => l.maxWaitMinutes ?? null),
      combo.fallbackComponents.map((l) => l.minWaitMinutes ?? null),
    ).some((c) => c.chain != null);
  }
  return feasible;
}

/** Mirrors PackageCard's `blocked` gate: every component has heats today, and
 *  the gap-race has at least one Starter→Intermediate pair that clears the gap. */
async function isPackageBookableToday(pkg: PackageDefinition, dateYmd: string): Promise<boolean> {
  const heatsByRef: Record<string, Array<{ start: string; stop: string }>> = {};
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
      heatsByRef[race.ref] = blocks.map((b) => ({ start: b.start, stop: b.stop }));
    } catch {
      heatsByRef[race.ref] = [];
    }
  }
  const gateRace = pkg.races.find((r) => r.minMinutesAfterEndOf);
  if (!gateRace?.minMinutesAfterEndOf) {
    return pkg.races.every((r) => (heatsByRef[r.ref] ?? []).length > 0);
  }
  const prev = heatsByRef[gateRace.minMinutesAfterEndOf.ref] ?? [];
  const next = heatsByRef[gateRace.ref] ?? [];
  if (prev.length === 0 || next.length === 0) return false;
  return prev.some((p) =>
    next.some((n) => !violatesMinGapAfter(p.stop, n.start, MIN_PACKAGE_GAP_MINUTES)),
  );
}

/** The EARLIEST bookable bowling slot today for a kind set (null = none left).
 *  One cheap 30-min-grid scan of OUR availability route (which already applies
 *  day-of-week offers — KBF's Mon–Fri gate included — the close filter, and the
 *  now-floor). players=2 = the smallest lane party. QAMF returns bookable times
 *  but no lane count, so the returned FirstOpen carries `start` only — the tile
 *  shows a time-only "Next lane · TIME" line. */
async function bowlingFirstOpenToday(
  center: CenterCode,
  dateYmd: string,
  kind: "open,hourly" | "kbf",
): Promise<FirstOpen | null> {
  const centerId = qamfCenterIdForCode(center);
  if (centerId == null) return null;
  const res = await fetch(
    `${apiBase()}/api/bowling/v2/availability?centerId=${centerId}&players=2` +
      `&startDate=${dateYmd}&kind=${kind}&stepMinutes=30&leadMinutes=0`,
    { cache: "no-store" },
  );
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

async function isUltimateQualifierBookableToday(dateYmd: string): Promise<boolean> {
  const variants = eligiblePackages({
    racerType: "new",
    schedule: scheduleForDate(dateYmd),
  }).filter((p) => p.id.startsWith("ultimate-qualifier"));
  if (variants.length === 0) return false;
  const results = await Promise.all(variants.map((v) => isPackageBookableToday(v, dateYmd)));
  return results.some(Boolean);
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

  // Boolean-only checks (combos carry no per-slot data) and the slot-carrying
  // checks run concurrently — one barrier, no lost parallelism. Bowling/KBF
  // carry a time only (QAMF gives no lane count) → a time-only tile line. All of
  // this runs INSIDE the Redis-cached /api/kiosk/availability compute (300s TTL,
  // single-flight), so the vendors are hit at most once per TTL per center.
  const boolsP = Promise.all([
    isComboBookableToday(center, dateYmd).catch(() => true),
    isUltimateQualifierBookableToday(dateYmd).catch(() => true),
  ]);
  const slotsP = Promise.all([
    fm ? resolveSlotAvailability(racingFirstOpenToday(dateYmd)) : Promise.resolve(OPEN_NO_COUNT),
    fm
      ? resolveSlotAvailability(attractionFirstOpenToday("duck-pin", "fasttrax", dateYmd))
      : Promise.resolve(OPEN_NO_COUNT),
    resolveSlotAvailability(attractionFirstOpenToday("gel-blaster", nexusLoc, dateYmd)),
    resolveSlotAvailability(attractionFirstOpenToday("laser-tag", nexusLoc, dateYmd)),
    fm
      ? resolveSlotAvailability(attractionFirstOpenToday("shuffly", "fasttrax", dateYmd))
      : Promise.resolve(OPEN_NO_COUNT),
    fm
      ? resolveSlotAvailability(attractionFirstOpenToday("shuffly", "headpinz", dateYmd))
      : Promise.resolve(OPEN_NO_COUNT),
    resolveSlotAvailability(bowlingFirstOpenToday(center, dateYmd, "open,hourly")),
    resolveSlotAvailability(bowlingFirstOpenToday(center, dateYmd, "kbf")),
  ]);
  const [[combo, uq], [race, duckPin, gel, laser, shufFt, shufHp, bowling, kbf]] =
    await Promise.all([boolsP, slotsP]);

  return {
    available: {
      "race-bowl": combo,
      "ultimate-qualifier": uq,
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
    firstOpen: {
      race: race.firstOpen,
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
