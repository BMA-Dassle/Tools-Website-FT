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

/** Any bowling slot left today for a kind set? One cheap 30-min-grid scan of
 *  OUR availability route (which already applies day-of-week offers — KBF's
 *  Mon–Fri gate included — the close filter, and the now-floor). players=2 =
 *  the smallest lane party. */
async function isBowlingBookableToday(
  center: CenterCode,
  dateYmd: string,
  kind: "open,hourly" | "kbf",
): Promise<boolean> {
  const centerId = qamfCenterIdForCode(center);
  if (centerId == null) return false;
  const res = await fetch(
    `${apiBase()}/api/bowling/v2/availability?centerId=${centerId}&players=2` +
      `&startDate=${dateYmd}&kind=${kind}&stepMinutes=30&leadMinutes=0`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`bowling availability ${res.status}`);
  const data = (await res.json()) as { Availabilities?: unknown[] };
  return (data.Availabilities ?? []).length > 0;
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

/** Does one BMI product still have a future slot with capacity today? */
async function productHasFutureSlot(args: {
  dateYmd: string;
  productId: string;
  pageId: string;
  clientKey?: string;
  leadMs: number;
}): Promise<boolean> {
  const avail = await bmiAdapter.getAvailability({
    date: args.dateYmd,
    productId: args.productId,
    pageId: args.pageId,
    quantity: 1,
    clientKey: args.clientKey,
  });
  const cutoff = Date.now() + args.leadMs;
  return (avail.proposals ?? []).some((p) => {
    const b = p.blocks?.[0]?.block;
    return !!b && b.freeSpots >= 1 && naiveEtStartMs(b.start) >= cutoff;
  });
}

/** One attraction at one BUILDING: any future slot on any of its products.
 *  No artificial lead (kiosk prime directive: "book now" — ASAP is fine). */
async function isAttractionBookableToday(
  slug: string,
  location: LocationKey,
  dateYmd: string,
): Promise<boolean> {
  const config = ATTRACTIONS[slug];
  const pageId = config?.pageIds[location];
  if (!config || !pageId) return false;
  const products = config.products.filter((p) => p.location === location && !p.isCombo);
  let probed = false;
  for (const p of products) {
    try {
      const hit = await productHasFutureSlot({
        dateYmd,
        productId: p.productId,
        pageId,
        clientKey: getClientKey(config, location),
        leadMs: 0,
      });
      probed = true;
      if (hit) return true;
    } catch {
      /* try the next product */
    }
  }
  // Every probe failed = no signal — throw so the caller's .catch fails OPEN
  // rather than false-locking the tile on a vendor blip.
  if (!probed && products.length > 0) throw new Error(`${slug}@${location}: every probe failed`);
  return false;
}

/** Racing: any SINGLE-race product on today's schedule still has a heat far
 *  enough out for the kiosk grids. Packs are excluded — they need multiple
 *  heats and carry their own Experiences-shelf gating (ultimate-qualifier). */
async function isRacingBookableToday(dateYmd: string): Promise<boolean> {
  const products = [
    ...getStaticProducts(dateYmd, "new"),
    ...getStaticProducts(dateYmd, "existing"),
  ].filter((p) => p.packType === "none");
  const seen = new Set<string>();
  let probed = false;
  for (const p of products) {
    if (seen.has(p.productId)) continue;
    seen.add(p.productId);
    try {
      const hit = await productHasFutureSlot({
        dateYmd,
        productId: p.productId,
        pageId: p.pageId,
        leadMs: RACE_LEAD_MS,
      });
      probed = true;
      if (hit) return true;
    } catch {
      /* try the next product */
    }
  }
  if (!probed && seen.size > 0) throw new Error("racing: every probe failed");
  return false;
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
 *  AVAILABLE if it throws — never false-lock on a vendor blip. */
export async function computeExperienceAvailability(
  center: CenterCode,
): Promise<ExperienceAvailability> {
  // Same 2 AM-ET business-day rollover the kiosk (and the rest of the app) use,
  // so a post-midnight session still resolves to today's operating date.
  const dateYmd = businessDayYmdET();
  const fm = center === "fort-myers";
  // Nexus attractions live in the HeadPinz building at FM, and at Naples.
  const nexusLoc: LocationKey = fm ? "headpinz" : "naples";
  // Offerings a center doesn't carry resolve TRUE untouched — their tiles
  // never render there, and true can never false-lock anything.
  const [combo, uq, bowling, kbf, race, duckPin, gel, laser, shufFt, shufHp] = await Promise.all([
    isComboBookableToday(center, dateYmd).catch(() => true),
    isUltimateQualifierBookableToday(dateYmd).catch(() => true),
    isBowlingBookableToday(center, dateYmd, "open,hourly").catch(() => true),
    isBowlingBookableToday(center, dateYmd, "kbf").catch(() => true),
    fm ? isRacingBookableToday(dateYmd).catch(() => true) : Promise.resolve(true),
    fm ? isAttractionBookableToday("duck-pin", "fasttrax", dateYmd).catch(() => true) : true,
    isAttractionBookableToday("gel-blaster", nexusLoc, dateYmd).catch(() => true),
    isAttractionBookableToday("laser-tag", nexusLoc, dateYmd).catch(() => true),
    fm ? isAttractionBookableToday("shuffly", "fasttrax", dateYmd).catch(() => true) : true,
    fm ? isAttractionBookableToday("shuffly", "headpinz", dateYmd).catch(() => true) : true,
  ]);
  return {
    "race-bowl": combo,
    "ultimate-qualifier": uq,
    bowling,
    kbf,
    race,
    "duck-pin": duckPin,
    "gel-blaster": gel,
    "laser-tag": laser,
    "shuffly-fasttrax": shufFt,
    "shuffly-headpinz": shufHp,
  };
}
