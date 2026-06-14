/**
 * Combo Specials — declarative registry. The single source of truth for
 * (a) the marketing cards (attractions / pricing / home teaser / booking
 * landing) and (b) the v2 booking flow's guided itinerary + fixed pricing.
 *
 * Adding a future combo is a DATA change here, not a UI/booking refactor:
 * `components` is the ORDERED visit itinerary (legs), and the wizard, the
 * chain-feasibility engine (combo-itinerary.ts), and the pricing gate
 * (combo-pricing.ts) are all driven by it. Race legs may use any tier;
 * bowling legs any duration; `transitionMinutes` is the walk buffer
 * between legs. Attraction legs are typed for forward-compat but NOT yet
 * supported by the wizard (the gate rejects them).
 *
 * NAMING: in this codebase "combo" alone already means the 3-pack race SKUs
 * (`packType: "combo"`). This feature is "combo SPECIALS" — always
 * `comboSpecialId` / `ComboSpecial`, never bare `comboId`.
 *
 * See tasks/combo-specials-plan.md (Revision 2) for the locked owner
 * decisions:
 *  - guided itinerary: Starter race → 1.5h bowling → Intermediate race;
 *    the customer picks ONE start time, the system schedules the rest
 *  - Mon–Thu (incl. Mega Tuesday) = weekday tier; Fri–Sun = weekend tier
 *  - 100% of the combo price is charged upfront at booking
 *  - juniors can't run the combo on Mega Tuesday (no junior Starter Mega
 *    product) — feasibility gating surfaces this as "no times"
 */

import { scheduleForDate } from "~/features/booking/service/race-pricing";
import type { RaceTier } from "~/features/booking/service/race-products";
import type { CenterCode } from "~/features/booking/types";
import { SQUARE_CATALOG_IDS } from "~/features/booking/data/square-catalog-map";

/**
 * Which Square location/entity a revenue line books to. Each maps to a Square
 * location id at reserve time, producing ONE day-of order per entity present.
 * A combo's flat per-person price is itemized across these lines so revenue
 * lands at the entity that owns it (racing → FastTrax, bowling → HeadPinz).
 * Generic so cross-center attraction combos reuse it.
 */
export type ComboEntity = "fasttrax-fm" | "headpinz-fm";

/** One itemized revenue line of a combo's flat per-person price. */
export interface ComboRevenueLine {
  key: string;
  /** Day-of order line name. */
  label: string;
  /** Owning entity → its own Square day-of order + location tax. */
  entity: ComboEntity;
  /** Real Square catalog VARIATION id; the line uses a base_price_money override. */
  catalogObjectId: string;
  /** Per-person cents by day tier (Mega Tuesday = weekday). */
  weekdayCents: number;
  weekendCents: number;
  /** "allRacers" books for every racer; "newRacersOnly" only for new racers
   *  (the license). A skipped newRacersOnly line reallocates its cents to
   *  `reallocateTo` so the per-person total stays exact. */
  appliesTo: "allRacers" | "newRacersOnly";
  reallocateTo?: string;
}

/**
 * One leg of a combo's visit itinerary, in order. A race leg = ONE heat per
 * racer at the given tier (a future "2 starter races" combo = two race legs).
 */
export type ComboLeg =
  | { kind: "race"; tier: RaceTier; maxWaitMinutes?: number }
  /** `vip: true` books a VIP lane experience (semi-private suite, NeoVerse
   *  wall, chips & salsa) instead of a regular lane. `maxWaitMinutes` caps
   *  the idle gap BEFORE this leg (from the previous leg's end): a chain
   *  only counts as feasible when this leg starts within
   *  [prevEnd + transitionMinutes, prevEnd + maxWaitMinutes]. */
  | { kind: "bowling"; durationMinutes: number; vip?: boolean; maxWaitMinutes?: number }
  /** Forward-compat — typed, but the wizard/gate reject it until built. */
  | { kind: "attraction"; slug: string; maxWaitMinutes?: number };

export interface ComboSpecial {
  /** Kebab slug — route param + session.comboSpecialId. */
  id: string;
  name: string;
  shortDescription: string;
  longDescription: string;
  /** Display bullets, e.g. ["1 Starter Race", "1.5 Hours of Bowling", …]. */
  includes: string[];
  heroImage: string;
  accentColor: string;
  /** Physical complex. Racing is Fort Myers-only. */
  center: CenterCode;
  /** Per-PERSON price in CENTS by day tier (Mega Tuesday = weekday). */
  price: { weekday: number; weekend: number };
  /** ORDERED visit itinerary. */
  components: ComboLeg[];
  /** Walk buffer between legs (minutes) — owner default 15. */
  transitionMinutes: number;
  /**
   * The racing license ($4.99/new racer) is INCLUDED in the combo price —
   * the $0 BMI license record still books, but no separate Square line.
   */
  includesLicense: boolean;
  /**
   * POV race videos INCLUDED in the price, per racer. The combo auto-sells
   * this many per racer (BMI $0 record) and suppresses the Square POV line.
   */
  includedPovPerRacer: number;
  /**
   * Restrict the start-time grid to these ET hours (0–26 chip notation, e.g.
   * [14, 16, 18, 20] = 2/4/6/8 PM): each hour shows ONE slot per track — the
   * first feasible first-leg start inside that hour — greyed out when no
   * full itinerary (incl. the lane) fits from it. Absent = every start.
   */
  startHours?: number[];
  /**
   * Premium presentation: double-size marketing tile (2 columns on desktop,
   * taller on mobile), gold treatment, perks list.
   */
  premium?: boolean;
  /** Extra experience perks shown on premium surfaces (e.g. VIP lane perks). */
  perks?: string[];
  /** Visit-length label shown on the marketing surfaces (e.g. "≈ 3-Hour
   *  Experience"). The schedule modal shows the REAL assembled duration. */
  durationLabel?: string;
  /**
   * Customer-facing policy when a qualify-gated leg can't run (guest didn't
   * qualify in the Starter). Shown on the booking screens AND stamped into
   * the ops bill memo.
   */
  qualifyFallbackNote?: string;
  /**
   * Itemized per-person revenue split (Model A). Each line books to its
   * entity's Square day-of order via a real catalog variation + price
   * override; the lines sum to the flat per-person price for the day tier.
   * Absent = single flat combo line on one order (legacy behavior).
   */
  revenueSplit?: ComboRevenueLine[];
  enabled: boolean;
  displayOrder?: number;
  /** Optional seasonal window for future combos (mirrors discount-codes). */
  availability?: { startsAt?: string; expiresAt?: string; allowedWeekdays?: number[] };
}

/**
 * Flag: default ON unless explicitly set to "false" (plan §booking layer —
 * Vercel prod keeps it "false" until the staff canary passes).
 */
const COMBO_RACE_BOWL_ENABLED = process.env.NEXT_PUBLIC_COMBO_RACE_BOWL_ENABLED !== "false";

export const COMBO_SPECIALS: ComboSpecial[] = [
  {
    id: "race-bowl",
    name: "Ultimate VIP Experience",
    shortDescription:
      "A full 3-hour experience: Starter race, 1.5 hours of VIP bowling, then an Intermediate " +
      "race — license, POV video and VIP lane perks included. One price, one booking.",
    longDescription:
      "Three hours of the full FastTrax + HeadPinz premium night: qualify on a Starter race, " +
      "take over a semi-private VIP lane for 1.5 hours of bowling, then come back faster on " +
      "an Intermediate race. Racing license, POV race video, and VIP lane perks (NeoVerse " +
      "video wall, chips & salsa, premium glow) are all included. Pick a start time — " +
      "2, 4, 6, 8, or 10 PM — and we schedule the rest.",
    durationLabel: "≈ 3-Hour Experience",
    qualifyFallbackNote:
      "Didn't qualify? No problem — we'll convert your Intermediate to a second Starter race, or issue you a race credit.",
    includes: [
      "Starter Race",
      "1.5 Hours of VIP Bowling",
      "Intermediate Race",
      "Racing License + POV Video",
    ],
    perks: [
      "Semi-private 8-lane VIP area",
      "NeoVerse video wall",
      "Complimentary chips & salsa",
      "Bowling shoes included",
      "HyperBowling + premium glow lighting",
    ],
    heroImage:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/pricing-combos.webp",
    accentColor: "#FFD700",
    center: "fort-myers",
    price: { weekday: 6500, weekend: 7500 },
    components: [
      { kind: "race", tier: "starter" },
      // Owner: the lane must start within 60 minutes of the first race —
      // otherwise the start time doesn't show as available.
      { kind: "bowling", durationMinutes: 90, vip: true, maxWaitMinutes: 60 },
      { kind: "race", tier: "intermediate" },
    ],
    transitionMinutes: 15,
    includesLicense: true,
    includedPovPerRacer: 1,
    startHours: [14, 16, 18, 20, 22],
    premium: true,
    // Model A (owner-approved 2026-06-13): itemized split → two day-of orders.
    // FastTrax racing (flat both tiers) + HeadPinz VIP bowling (weekend uplift
    // on the bowling line). Sums to 6500 wd / 7500 we per person; returning
    // racers' skipped $4.99 license rolls onto the Starter Race line.
    revenueSplit: [
      {
        key: "starter-race",
        label: "Starter Race",
        entity: "fasttrax-fm",
        catalogObjectId: SQUARE_CATALOG_IDS.ULTIMATE_QUALIFIER,
        weekdayCents: 1700,
        weekendCents: 1700,
        appliesTo: "allRacers",
      },
      {
        key: "intermediate-race",
        label: "Intermediate Race",
        entity: "fasttrax-fm",
        catalogObjectId: SQUARE_CATALOG_IDS.ULTIMATE_QUALIFIER,
        weekdayCents: 1700,
        weekendCents: 1700,
        appliesTo: "allRacers",
      },
      {
        key: "pov",
        label: "POV Video",
        entity: "fasttrax-fm",
        catalogObjectId: SQUARE_CATALOG_IDS.POV,
        weekdayCents: 500,
        weekendCents: 500,
        appliesTo: "allRacers",
      },
      {
        key: "license",
        label: "FastTrax License",
        entity: "fasttrax-fm",
        catalogObjectId: SQUARE_CATALOG_IDS.LICENSE,
        weekdayCents: 499,
        weekendCents: 499,
        appliesTo: "newRacersOnly",
        reallocateTo: "starter-race",
      },
      {
        key: "vip-bowling",
        label: "VIP Bowling",
        entity: "headpinz-fm",
        catalogObjectId: SQUARE_CATALOG_IDS.VIP_BOWLING,
        weekdayCents: 1601,
        weekendCents: 2601,
        appliesTo: "allRacers",
      },
      {
        key: "shoes",
        label: "Shoes",
        entity: "headpinz-fm",
        catalogObjectId: SQUARE_CATALOG_IDS.SHOE_RENTAL,
        weekdayCents: 500,
        weekendCents: 500,
        appliesTo: "allRacers",
      },
    ],
    enabled: COMBO_RACE_BOWL_ENABLED,
    displayOrder: 10,
  },
];

/** Look up a combo by id (enabled or not — callers gate separately). */
export function getComboSpecial(id: string): ComboSpecial | null {
  return COMBO_SPECIALS.find((c) => c.id === id) ?? null;
}

/** Is the combo within its availability window (if it has one)? */
export function comboAvailableOn(combo: ComboSpecial, dateYmd: string | Date): boolean {
  const a = combo.availability;
  if (!a) return true;
  const d = typeof dateYmd === "string" ? dateYmd.split("T")[0] : toYmd(dateYmd);
  if (a.startsAt && d < a.startsAt.split("T")[0]) return false;
  if (a.expiresAt && d > a.expiresAt.split("T")[0]) return false;
  if (a.allowedWeekdays && a.allowedWeekdays.length > 0) {
    const day = localDay(d);
    if (!a.allowedWeekdays.includes(day)) return false;
  }
  return true;
}

/** Enabled combos in display order — what the marketing surfaces render. */
export function enabledCombos(): ComboSpecial[] {
  return COMBO_SPECIALS.filter((c) => c.enabled).sort(
    (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0),
  );
}

/**
 * Per-person combo price (cents) for a calendar date. Reuses the race
 * schedule resolution: `weekend` (Fri/Sat/Sun) → weekend tier; `weekday`
 * AND `mega` (Tuesday) → weekday tier — Mega Tuesday is priced as weekday
 * by locked owner decision.
 */
export function comboPriceCentsForDate(combo: ComboSpecial, dateYmd: string | Date): number {
  return scheduleForDate(dateYmd) === "weekend" ? combo.price.weekend : combo.price.weekday;
}

/** Total combo price (cents) for a date × headcount. */
export function comboTotalCents(
  combo: ComboSpecial,
  dateYmd: string | Date,
  headcount: number,
): number {
  return comboPriceCentsForDate(combo, dateYmd) * Math.max(0, Math.floor(headcount));
}

/** The combo's race legs, in itinerary order. */
export function comboRaceLegs(combo: ComboSpecial): Array<Extract<ComboLeg, { kind: "race" }>> {
  return combo.components.filter((c): c is Extract<ComboLeg, { kind: "race" }> => {
    return c.kind === "race";
  });
}

/** The fixed bowling leg (first `bowling` entry), if the combo has one. */
export function comboBowlingComponent(
  combo: ComboSpecial,
): Extract<ComboLeg, { kind: "bowling" }> | null {
  return (
    combo.components.find((c): c is Extract<ComboLeg, { kind: "bowling" }> => {
      return c.kind === "bowling";
    }) ?? null
  );
}

/** Heats the combo books per racer = one per race leg. */
export function comboHeatsPerRacer(combo: ComboSpecial): number {
  return comboRaceLegs(combo).length;
}

/**
 * Human label for the combo's fixed start times, e.g. "2 · 4 · 6 · 8 · 10 PM"
 * — derived from `startHours` (0–26 chip notation) so adding/removing a slot
 * is a one-line registry change. Returns "" when the combo has no fixed grid.
 */
export function comboStartHoursLabel(combo: ComboSpecial): string {
  const hours = combo.startHours;
  if (!hours?.length) return "";
  const mer = (h: number) => (h % 24 < 12 ? "AM" : "PM");
  const h12 = (h: number) => h % 12 || 12;
  const sameMeridiem = hours.every((h) => mer(h) === mer(hours[0]));
  if (sameMeridiem) {
    return `${hours.map(h12).join(" · ")} ${mer(hours[0])}`;
  }
  return hours.map((h) => `${h12(h)} ${mer(h)}`).join(" · ");
}

/**
 * Staff-facing combo note for the BMI RESERVATION MEMO (owner ask, 2026-06-11):
 * staff must see at a glance that this is the VIP package, that license/POV/
 * perks/shoes are already paid, the visit order — race, bowling, then the next
 * race ONLY IF the guest qualified in the Starter — and the assigned bowling
 * lane (QAMF). Registry-driven so future combos describe themselves.
 *
 * Written via buildReservationMemo on the confirmation page (the single
 * OVERWRITING booking/memo field), NOT a separate write — a separate write
 * gets clobbered by that combined memo.
 */
export function comboReservationNote(combo: ComboSpecial, lane?: string | null): string {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  let sawStarter = false;
  const steps = combo.components.map((leg, i) => {
    if (leg.kind === "race") {
      const qualified = sawStarter && leg.tier !== "starter" ? " (ONLY IF QUALIFIED)" : "";
      if (leg.tier === "starter") sawStarter = true;
      return `${i + 1}) ${cap(leg.tier)} Race${qualified}`;
    }
    if (leg.kind === "bowling") {
      const hours = leg.durationMinutes / 60;
      const laneStr = lane ? ` — Lane ${lane}` : "";
      return `${i + 1}) ${hours % 1 === 0 ? hours : hours.toFixed(1)}hr ${
        leg.vip ? "VIP " : ""
      }Bowling at HeadPinz${laneStr}`;
    }
    return `${i + 1}) ${leg.slug}`;
  });
  const included = [
    combo.includesLicense ? "racing license" : null,
    combo.includedPovPerRacer > 0 ? "POV video" : null,
    combo.perks?.length ? "VIP lane perks + shoes" : null,
  ]
    .filter(Boolean)
    .join(" + ");
  return (
    `*** ${combo.name.toUpperCase()} (VIP COMBO) *** Paid online at the flat per-person rate` +
    (included ? ` — ${included} INCLUDED, do not charge separately` : "") +
    `. Visit plan: ${steps.join(" -> ")}.` +
    (lane ? ` Bowling lane: ${lane}.` : "") +
    (combo.qualifyFallbackNote
      ? ` If a racer does NOT qualify: convert their later race to a second Starter race OR issue a race credit.`
      : "") +
    ` Bowling is a separate HeadPinz/QAMF reservation on the same Square order (settles at lane-open).`
  );
}

/* ── local helpers ─────────────────────────────────────────────────── */

function toYmd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Day-of-week (0–6) of a YYYY-MM-DD via local-time construction (UTC-trap safe). */
function localDay(ymd: string): number {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return new Date(ymd).getDay();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
}
