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
 *
 * Both default to AVAILABLE on error (never false-lock a normally-open
 * experience because a vendor blipped); the route decides whether to cache.
 */
import { buildChains, getComboSpecial } from "~/features/combos";
import { comboMinHeadcount, comboReorderFallbackEnabled } from "~/features/combos/combo-specials";
import { candidatesForOrdering, fetchComboLegCandidates } from "~/features/combos/combo-booking";
import { bmiAdapter } from "~/features/booking/data/bmi";
import { newPartyMember, qamfCenterIdForCode, type CenterCode } from "~/features/booking";
import { violatesMinGapAfter } from "~/features/booking/service/conflict";
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

export interface ExperienceAvailability {
  "race-bowl": boolean;
  "ultimate-qualifier": boolean;
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
  const [combo, uq] = await Promise.all([
    isComboBookableToday(center, dateYmd).catch(() => true),
    isUltimateQualifierBookableToday(dateYmd).catch(() => true),
  ]);
  return { "race-bowl": combo, "ultimate-qualifier": uq };
}
