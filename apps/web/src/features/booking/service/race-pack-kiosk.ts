/**
 * Kiosk race packs — CREDIT packs, the same SKUs the web sells (owner final
 * design 2026-07-18, validated by the 4-design/2-judge panel): a pack is
 * `raceCount` Pandora race credits granted to ONE named racer's account via
 * addDeposit, spent later (or immediately, for today's race) through the
 * existing checkout credits panel. Never a special kind of booking — no BMI
 * products, no pack/3 bill lines, no settle-machinery involvement.
 *
 * Kiosk rules (owner):
 *   - All six SKUs, the same catalog the web sells: 3/5/10 races × Mon–Thu /
 *     Any-Day ($49.99 → $199.99).
 *   - Fri/Sat/Sun (center-local day) HIDE the Mon–Thu packs entirely.
 *   - One pack → one person; new + returning racers both eligible.
 *   - Two surfaces: race product-step teaser (rides the booking's deposit
 *     order via the GZ extraLines seam) and a LOCKED standalone flow from the
 *     attract screen (own small order on the game-cards terminal rail).
 *
 * Everything money-facing stays server-re-derived from RACE_PACKS by slug —
 * the session/UI carries pointers only (displayed == charged rule).
 */
import {
  RACE_PACKS,
  BOGO_SALE_SLUGS,
  bogoSaleActive,
  getRacePack,
  racePackLabel,
  type RacePack,
} from "../data/packs";
import { dayBucket, memberEligibleCreditTotal } from "../data/race-credits";
import { getRaceProductById } from "./race-products";
import type { RaceHeatAssignment } from "../state/types";

/** KILL SWITCH — default ON (owner 2026-07-18: "push with flag on, we will
 *  turn off if needed"; owner owns the live smokes on real hardware).
 *  `NEXT_PUBLIC_KIOSK_RACE_PACKS_ENABLED=false` darkens EVERY sell surface —
 *  kiosk teaser + attract chip AND the web booking flow (returning racers,
 *  2026-08-10) — and the grant rail instantly. Kiosk-born name kept: the env
 *  var is load-bearing in deploys. */
export function kioskRacePacksEnabled(): boolean {
  return process.env.NEXT_PUBLIC_KIOSK_RACE_PACKS_ENABLED !== "false";
}

/** FastTrax-license-on-pack-purchase KILL SWITCH — default ON (owner 2026-07-25:
 *  push on so it shows on the preview). Gates BOTH the kiosk standalone and web
 *  /book/race-packs license lines + registration. Turn OFF with
 *  `NEXT_PUBLIC_RACE_PACK_LICENSE=false`.
 *  ⚠ Still verify BMI registration live before it fronts real guests — the
 *  /api/test/license-diag smoke must show the "License Fee" membership attaches. */
export function racePackLicenseEnabled(): boolean {
  return process.env.NEXT_PUBLIC_RACE_PACK_LICENSE !== "false";
}

/** Which flow a pack was bought through — a LEDGER label (the `surface` column
 *  on race_pack_purchases), not a catalog switch: both flows sell the same six
 *  SKUs. `booking` = the race product-step teaser, riding the booking's own
 *  deposit order; `standalone` = the locked attract-screen flow with its own
 *  small reader order. */
export type PackSurface = "booking" | "standalone";

/** THE STANDING pack catalog — one list for every surface (owner 2026-08-03).
 *  The in-booking teaser used to be 3-packs only ("fast decision mid-booking",
 *  owner 2026-07-19), which left a returning racer who wanted a 5- or 10-pack
 *  with no door at all: mid-flow the teaser was the only pack surface, and the
 *  bigger packs lived exclusively in the standalone flow — reachable only by
 *  abandoning the booking and paying on a second reader tap. Zero 5/10 packs
 *  ever sold through a booking; every one came from standalone. Keeping ONE
 *  list is also what stops the two surfaces from drifting again.
 *
 *  LIMITED-TIME SKUs are the one exception, and they are not in this list —
 *  they reach the in-booking surfaces only, via `packSlugsAt`. The standing
 *  catalog stays surface-agnostic precisely because none of it is restricted by
 *  tier or racer history; anything that is cannot be sold by a screen with no
 *  filter (owner 2026-08-13). */
const STANDING_PACK_SLUGS: readonly string[] = [
  "3-race-weekday",
  "3-race-anytime",
  "5-race-weekday",
  "5-race-anytime",
  "10-race-weekday",
  "10-race-anytime",
];

/**
 * The standing catalog plus any live limited-time SKUs, at `now` — IN-BOOKING
 * surfaces only (`packSkusForRaceDate`).
 *
 * A limited-time SKU is deliberately NOT in the standalone walk-up catalog
 * (`kioskPackSkus`). The two BOGO SKUs are tier-restricted (adult $20.99 /
 * junior $15.99) and the standalone screen has no tier to restrict against: it
 * lists every SKU per racer with no eligibility filter, so both landed as two
 * identical "2 RACES / Mon–Thu" tiles differing only in price. Live 2026-08-13,
 * that mis-sold juniors the ADULT price when they tapped the first tile and
 * dead-ended them at prepare when they tapped their own. Owner: BOGO does not
 * belong on that screen. In-booking surfaces DO carry a tier (the pay-mode page
 * is per category, and the picker filters by `packFitsMember`), which is where
 * the sale is sold.
 *
 * ONE list still feeds the in-booking sell surfaces AND `resolveKioskPacks`'s
 * fail-closed slug check, so the sale window is enforced on the SERVER by
 * construction: a cached page or a hand-rolled POST that still names a BOGO slug
 * after the deadline — or on the standalone rail at all — gets "isn't available"
 * from the resolver rather than a discounted charge. That is also why the window
 * is not merely a UI condition: the session carries slug pointers only, and the
 * server re-derives the price.
 */
function packSlugsAt(now: Date): readonly string[] {
  return bogoSaleActive(now) ? [...STANDING_PACK_SLUGS, ...BOGO_SALE_SLUGS] : STANDING_PACK_SLUGS;
}

/** Catalog order for a sell surface: smallest pack first, weekday before
 *  any-day within a size, and the Mon–Thu SKUs dropped entirely on a weekend
 *  (owner day rule — hidden, never warned). */
function skusFor(slugs: readonly string[], weekend: boolean): RacePack[] {
  return slugs
    .map((slug) => RACE_PACKS.find((p) => p.slug === slug))
    .filter((p): p is RacePack => !!p)
    .filter((p) => !(weekend && p.dayType === "weekday"))
    .sort((a, b) => a.raceCount - b.raceCount || a.price - b.price);
}

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

/** The packs the STANDALONE walk-up flow offers RIGHT NOW (day-filtered;
 *  smallest pack first, weekday before any-day within a size). Purchase day ==
 *  race day there, so the day rule reads the wall clock.
 *
 *  THE STANDING CATALOG ONLY — no limited-time SKUs (see `packSlugsAt`): that
 *  screen has no tier to restrict a tier-priced SKU against. In-booking
 *  surfaces must use packSkusForRaceDate: they carry a category, and a web
 *  booking's race can be days away, where the day rule is about the RACE day. */
export function kioskPackSkus(now: Date = new Date()): RacePack[] {
  return skusFor(STANDING_PACK_SLUGS, isWeekendForPacks(now));
}

/**
 * The packs an IN-BOOKING surface may offer for a race on `raceDate` — the
 * standing catalog PLUS any live limited-time SKU. The Mon–Thu pack hides when
 * the BOOKED race falls Fri–Sun: its first credit covers that race at checkout,
 * and a weekday credit can't (owner day rule; `dayBucket` is the same Fri–Sun
 * split the credit-redeem rail uses). Null (no date picked yet) falls back to
 * the wall clock.
 */
export function packSkusForRaceDate(
  raceDate: string | null | undefined,
  now: Date = new Date(),
): RacePack[] {
  const weekend = raceDate ? dayBucket(raceDate) === "weekend" : isWeekendForPacks(now);
  return skusFor(packSlugsAt(now), weekend);
}

/** A pack purchase pointer as carried by the session/UI — slug + assignee only;
 *  the server re-derives price/kind/label from the catalog at charge time. */
export interface KioskPackSelection {
  slug: string;
  memberId: string;
}

/**
 * Apply a multi-select pack pick: everyone in `memberIds` gets `slug` (replacing
 * any other pack they held — one pack per racer), and anyone who previously held
 * `slug` but is NOT in `memberIds` loses it (the picker seeds its checkboxes
 * with the current holders, so an uncheck is an explicit removal). Members not
 * involved keep their other-slug packs untouched. Returns undefined when the
 * result is empty (the session stores no `creditPacks` key rather than `[]`).
 */
export function applyPackSelection(
  picks: KioskPackSelection[],
  slug: string,
  memberIds: string[],
): KioskPackSelection[] | undefined {
  const ids = new Set(memberIds);
  const next = picks.filter((p) => p.slug !== slug && !ids.has(p.memberId));
  for (const memberId of memberIds) next.push({ slug, memberId });
  return next.length > 0 ? next : undefined;
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
 * unknown slug, a slug the surface doesn't sell, a day-hidden slug, a missing
 * member, or a member without a BMI account all throw (nothing silently
 * drops from a paid order). Errors name the person where one exists.
 *
 * `opts.raceDate` (in-booking surfaces) keys the day rule to the BOOKED race
 * day — a weekday pack against a Fri–Sun race date throws here, at charge
 * time, so displayed can never drift from charged. Standalone walk-up callers
 * omit it (purchase day == race day).
 *
 * `opts.surface` picks WHICH CATALOG is sellable, and is passed explicitly
 * rather than inferred from `raceDate`: "standalone" gets the standing SKUs
 * only, so a limited-time tier-priced SKU can never be charged on the screen
 * that has no tier to check it against (see `packSlugsAt`). Inferring it from a
 * missing raceDate would have conflated the walk-up rail with an in-booking
 * caller whose date isn't picked yet.
 */
export function resolveKioskPacks(
  selections: KioskPackSelection[],
  party: Array<{
    id: string;
    firstName: string;
    lastName?: string;
    bmiPersonId?: string | null;
    /** Racer tier — gates `pack.category` (the BOGO adult/junior split). */
    category?: "adult" | "junior";
    /** First-time racer — gates `pack.racerType`. */
    isNewRacer?: boolean;
  }>,
  opts: { now?: Date; raceDate?: string | null; surface?: PackSurface } = {},
): ResolvedKioskPack[] {
  if (selections.length === 0) return [];
  const offered = new Set(
    (opts.surface === "standalone"
      ? kioskPackSkus(opts.now ?? new Date())
      : packSkusForRaceDate(opts.raceDate ?? null, opts.now)
    ).map((p) => p.slug),
  );
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
    // Tier-restricted pack (the BOGO adult/junior split). Without this an adult
    // could put the cheaper junior SKU on their own selection and redeem those
    // credits against adult heats — the session carries slug pointers only, so
    // hiding the tile is not a control. Defaults to "adult", matching how every
    // other category read in the booking flow treats a missing value.
    if (pack.category && (member.category ?? "adult") !== pack.category) {
      throw new Error(
        `${racePackLabel(pack)} is for ${pack.category} racers — ${memberName} isn't one.`,
      );
    }
    // History-restricted pack (BOGO is returning-racers-only; new racers get the
    // `bogo-weekday` PACKAGE instead, which books both heats outright). Belt and
    // braces: a credit is also the wrong instrument for a new racer, since
    // redemption requires `!isNewRacer` and would refuse them in-session.
    if (pack.racerType === "existing" && member.isNewRacer) {
      throw new Error(
        `${racePackLabel(pack)} is for returning racers — ${memberName} is racing with us for the first time.`,
      );
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

/**
 * Resolve EVERY race item's `creditPacks` against ITS OWN race date — the one
 * entry point for session-level money surfaces (reserve charge, checkout
 * review, voucher base), so none of them can forget the per-item day rule.
 * Fail-closed like resolveKioskPacks (a weekday pack pointed at a weekend race
 * date throws instead of silently charging).
 */
export function resolveSessionPacks(
  session: {
    items: Array<{ kind: string; date?: string | null; creditPacks?: KioskPackSelection[] }>;
    /**
     * MUST carry `category` + `isNewRacer`. They are optional on
     * `resolveKioskPacks`'s party, so a narrower type here still compiles — and
     * silently defeats the checks: `category` would default to "adult" (refusing
     * a junior their own junior pack) and `isNewRacer` would read falsy (letting
     * a new racer buy a returning-only pack). Structural typing gives no warning,
     * so the fields are named explicitly rather than inherited by accident.
     */
    party: Array<{
      id: string;
      firstName: string;
      lastName?: string;
      bmiPersonId?: string | null;
      category?: "adult" | "junior";
      isNewRacer?: boolean;
    }>;
  },
  now?: Date,
): ResolvedKioskPack[] {
  return session.items.flatMap((i) =>
    i.kind === "race" && (i.creditPacks?.length ?? 0) > 0
      ? resolveKioskPacks(i.creditPacks!, session.party, { now, raceDate: i.date ?? null })
      : [],
  );
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
 * Which of the pack assignees' BOOKED heats does their new pack cover?
 * Walked in session order (mirrors computeCreditRedemptions) so display and
 * charge cover the IDENTICAL heats. Excluded: heats already covered by
 * EXISTING credits (never double-cover), premium-package component heats
 * (bundle price includes them), booked multi-race pack products (hidden on
 * the kiosk when this feature is on; belt-and-braces here), and — for a
 * weekday-locked pack — heats on an item whose race DATE falls Fri–Sun
 * (belt-and-braces under the offer/resolve day rule, which keys off the race
 * date now that the web booking flow sells packs too; a weekday credit can't
 * pay a weekend race). Cap = raceCount.
 */
export function computePackCoverage(
  session: {
    items: Array<{
      kind: string;
      date?: string | null;
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
      if (pack.pack.dayType === "weekday" && item.date && dayBucket(item.date) === "weekend") {
        continue;
      }
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

// ── Product-step coverage PREVIEW ("covered by pack" pricing) ────────────────

export type CoverageSource = "cart-pack" | "account-credits";

export interface CoveredMemberPreview {
  source: CoverageSource;
  /** account-credits only: total credits eligible on `raceDate`. */
  credits?: number;
}

/**
 * Which party members' NEXT race today is already paid for — DISPLAY ONLY.
 * Drives the race product step's covered pricing + "now pick your race"
 * guidance; charging never reads this (the charge path re-derives coverage
 * server-side via computePackCoverage / the credit-redeem rail).
 *
 * A member is covered when they hold an in-cart credit pack (`item.creditPacks`
 * pointer — always valid today, the sell surface is day-gated) or when their
 * account has credits eligible on `raceDate` (same eligibility the checkout's
 * default-ON redeem opt-in uses: bmiPersonId + !isNewRacer + eligible total).
 * An in-cart pack wins over account credits so copy names what they just did.
 */
export function coveredMembersPreview(
  item: { creditPacks?: Array<{ slug: string; memberId: string }> | undefined },
  party: Array<{
    id: string;
    bmiPersonId?: string | null;
    isNewRacer?: boolean;
    creditBalances?: Array<{ kind: string; balance: number }>;
  }>,
  raceDate: string | null,
): Map<string, CoveredMemberPreview> {
  const covered = new Map<string, CoveredMemberPreview>();
  for (const m of party) {
    if (!m.bmiPersonId || m.isNewRacer) continue;
    const credits = memberEligibleCreditTotal(m.creditBalances, raceDate);
    if (credits > 0) covered.set(m.id, { source: "account-credits", credits });
  }
  for (const sel of item.creditPacks ?? []) {
    if (!getRacePack(sel.slug)) continue;
    const member = party.find((m) => m.id === sel.memberId);
    if (!member?.bmiPersonId) continue;
    covered.set(sel.memberId, { source: "cart-pack" });
  }
  return covered;
}
