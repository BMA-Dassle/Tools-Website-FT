/**
 * Kiosk race packs — CREDIT packs, the same SKUs the web sells (owner final
 * design 2026-07-18, validated by the 4-design/2-judge panel): a pack is
 * `raceCount` Pandora race credits granted to ONE named racer's account via
 * addDeposit, spent later (or immediately, for today's race) through the
 * existing checkout credits panel. Never a special kind of booking — no BMI
 * products, no pack/3 bill lines, no settle-machinery involvement.
 *
 * Kiosk rules (owner):
 *   - 3-race packs ONLY (web keeps 5/10): Mon–Thu $49.99 / Any-Day $59.99.
 *   - Fri/Sat/Sun (center-local day) HIDE the Mon–Thu pack entirely.
 *   - One pack → one person; new + returning racers both eligible.
 *   - Two surfaces: race product-step teaser (rides the booking's deposit
 *     order via the GZ extraLines seam) and a LOCKED standalone flow from the
 *     attract screen (own small order on the game-cards terminal rail).
 *
 * Everything money-facing stays server-re-derived from RACE_PACKS by slug —
 * the session/UI carries pointers only (displayed == charged rule).
 */
import { RACE_PACKS, getRacePack, racePackLabel, type RacePack } from "../data/packs";
import { getRaceProductById } from "./race-products";
import type { RaceHeatAssignment } from "../state/types";

/** KILL SWITCH — default ON (owner 2026-07-18: "push with flag on, we will
 *  turn off if needed"; owner owns the live smokes on real hardware).
 *  `NEXT_PUBLIC_KIOSK_RACE_PACKS_ENABLED=false` darkens BOTH surfaces (teaser +
 *  attract chip) and the grant rail instantly. */
export function kioskRacePacksEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_RACE_PACKS_ENABLED !== "false";
}

/** Where a pack is being sold — the two surfaces carry different catalogs
 *  (owner 2026-07-19): the in-race teaser stays 3-packs only (fast decision
 *  mid-booking), the standalone attract flow sells all six (3/5/10). */
export type PackSurface = "booking" | "standalone";

const KIOSK_PACK_SLUGS: Record<PackSurface, readonly string[]> = {
  booking: ["3-race-weekday", "3-race-anytime"],
  standalone: [
    "3-race-weekday",
    "3-race-anytime",
    "5-race-weekday",
    "5-race-anytime",
    "10-race-weekday",
    "10-race-anytime",
  ],
};

/** Is the center's local day a weekend day for pack purposes? Owner rule:
 *  Fri/Sat/Sun — the Mon–Thu pack is HIDDEN (not warned) on those days.
 *  Both centers are US-Eastern. */
export function isWeekendForPacks(now: Date = new Date()): boolean {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(now);
  return day === "Fri" || day === "Sat" || day === "Sun";
}

/** The packs the kiosk offers RIGHT NOW on a surface (day-filtered; smallest
 *  pack first, weekday before any-day within a size). */
export function kioskPackSkus(
  now: Date = new Date(),
  surface: PackSurface = "booking",
): RacePack[] {
  const weekend = isWeekendForPacks(now);
  return KIOSK_PACK_SLUGS[surface]
    .map((slug) => RACE_PACKS.find((p) => p.slug === slug))
    .filter((p): p is RacePack => !!p)
    .filter((p) => !(weekend && p.dayType === "weekday"))
    .sort((a, b) => a.raceCount - b.raceCount || a.price - b.price);
}

/** A pack purchase pointer as carried by the session/UI — slug + assignee only;
 *  the server re-derives price/kind/label from the catalog at charge time. */
export interface KioskPackSelection {
  slug: string;
  memberId: string;
}

/** Server-resolved pack purchase line (per pack, per person). */
export interface ResolvedKioskPack {
  slug: string;
  pack: RacePack;
  memberId: string;
  /** Raw BMI person id string — NEVER Number() it. */
  personId: string;
  memberName: string;
  label: string;
  priceCents: number;
}

/**
 * Resolve UI pack selections against the catalog + party — fail-closed: an
 * unknown slug, a slug the kiosk doesn't sell, a day-hidden slug, a missing
 * member, or a member without a BMI account all throw (nothing silently
 * drops from a paid order). Errors name the person where one exists.
 */
export function resolveKioskPacks(
  selections: KioskPackSelection[],
  party: Array<{ id: string; firstName: string; lastName?: string; bmiPersonId?: string | null }>,
  now: Date = new Date(),
  surface: PackSurface = "booking",
): ResolvedKioskPack[] {
  if (selections.length === 0) return [];
  const offered = new Set(kioskPackSkus(now, surface).map((p) => p.slug));
  const seen = new Set<string>();
  return selections.map((sel) => {
    const pack = getRacePack(sel.slug);
    if (!pack || !offered.has(sel.slug)) {
      throw new Error(`Race pack "${sel.slug}" isn't available on the kiosk today.`);
    }
    const member = party.find((m) => m.id === sel.memberId);
    if (!member) throw new Error("A race pack's racer is no longer in the group.");
    const memberName = `${member.firstName} ${member.lastName ?? ""}`.trim();
    if (!member.bmiPersonId) {
      throw new Error(`${memberName} needs a racer account before a pack can load onto it.`);
    }
    // One pack per person (owner) — the UI enforces replace semantics; this is
    // the server-side backstop.
    if (seen.has(member.id)) {
      throw new Error(`${memberName} already has a race pack in this order.`);
    }
    seen.add(member.id);
    return {
      slug: sel.slug,
      pack,
      memberId: member.id,
      personId: member.bmiPersonId,
      memberName,
      label: racePackLabel(pack),
      priceCents: Math.round(pack.price * 100),
    };
  });
}

/** Total cents for a resolved set (day-of line contribution / standalone
 *  order total). */
export function kioskPacksTotalCents(packs: ResolvedKioskPack[]): number {
  return packs.reduce((sum, p) => sum + p.priceCents, 0);
}

// ── Today's-race coverage (the owner sentence: "schedule one race and do a
// 3-race pack → we take one for payment and add two to account") ────────────

export interface PackCoverageRedemption {
  /** Raw BMI person id string — NEVER Number() it. */
  personId: string;
  depositKindId: string;
  /** Stable per-heat idempotency ref (same contract as race-credit redemptions). */
  ref: string;
}

export interface PackCoverage {
  /** The exact heat ASSIGNMENTS a pack covers (object identity — same contract
   *  as redeemedHeatSet): the charge builder drops these to $0. */
  heats: Set<RaceHeatAssignment>;
  /** Post-grant deductions (one credit per covered heat) for the EXISTING
   *  race-credit-redeem rail — run only AFTER the pack's credits granted. */
  redemptions: PackCoverageRedemption[];
  /** memberId → heats covered today (confirmation copy: "1 used, 2 banked"). */
  usedByMember: Map<string, number>;
}

/**
 * Which of the pack assignees' TODAY heats does their new pack cover?
 * Walked in session order (mirrors computeCreditRedemptions) so display and
 * charge cover the IDENTICAL heats. Excluded: heats already covered by
 * EXISTING credits (never double-cover), premium-package component heats
 * (bundle price includes them), and booked multi-race pack products (hidden on
 * the kiosk when this feature is on; belt-and-braces here). Cap = raceCount.
 * Day-locked packs can't mis-cover: weekday packs aren't offered Fri–Sun.
 */
export function computePackCoverage(
  session: {
    items: Array<{
      kind: string;
      packageIdAdult?: string | null;
      packageIdJunior?: string | null;
      heats?: RaceHeatAssignment[];
    }>;
  },
  packs: ResolvedKioskPack[],
  alreadyRedeemed: Set<RaceHeatAssignment>,
): PackCoverage {
  const heats = new Set<RaceHeatAssignment>();
  const redemptions: PackCoverageRedemption[] = [];
  const usedByMember = new Map<string, number>();
  if (packs.length === 0) return { heats, redemptions, usedByMember };
  const byMember = new Map(packs.map((p) => [p.memberId, p]));

  for (const item of session.items) {
    if (item.kind !== "race" || !item.heats) continue;
    for (const [idx, h] of item.heats.entries()) {
      if (!h.heatId || !h.assignedTo) continue;
      // Premium bundles price their own races — per CATEGORY: an adult package
      // must not block pack coverage of the junior side's single races.
      const heatPkg =
        (h.category ?? "adult") === "junior" ? item.packageIdJunior : item.packageIdAdult;
      if (heatPkg) continue;
      const pack = byMember.get(h.assignedTo);
      if (!pack) continue;
      if (alreadyRedeemed.has(h)) continue;
      const used = usedByMember.get(h.assignedTo) ?? 0;
      if (used >= pack.pack.raceCount) continue;
      // Booked multi-race pack products never get credit-covered (their price
      // is already a bundle) — resolvable per-track ids carry packType.
      const prod = getRaceProductById(h.productId);
      if (prod?.packType === "combo") continue;
      heats.add(h);
      redemptions.push({
        personId: pack.personId,
        depositKindId: pack.pack.depositKindId,
        ref: h.heatId ?? `pack-cover-${idx}`,
      });
      usedByMember.set(h.assignedTo, used + 1);
    }
  }
  return { heats, redemptions, usedByMember };
}
