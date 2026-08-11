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
// Type-only import (erased at compile) — this registry is client-shared and
// must never pull the voucher DB module's runtime (@ft/db) into a bundle.
import type { VoucherItem } from "~/features/game-cards/data/vouchers-db";

/**
 * Redeem-later entitlements a combo booking GRANTS, minted as ONE native
 * voucher code per booking after the deposit captures (combo-voucher.ts).
 * Not transferable; expiry runs from the VISIT (race) date, not purchase.
 */
export interface ComboVoucherGrant {
  /** Items minted once PER RACER (e.g. a game card each). */
  perGuest: VoucherItem[];
  /** Items minted once PER BOOKING (e.g. one shared Shuffly hour). */
  perBooking: VoucherItem[];
  /** expires_at = visit date + this many months (owner: "1 year from race date"). */
  expiresMonthsFromVisit: number;
}

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
  | { kind: "race"; tier: RaceTier; maxWaitMinutes?: number; minWaitMinutes?: number }
  /** `vip: true` books a VIP lane experience (semi-private suite, NeoVerse
   *  wall, chips & salsa) instead of a regular lane. `maxWaitMinutes` caps,
   *  and `minWaitMinutes` floors, the idle gap BEFORE this leg (from the
   *  previous leg's end): a chain only counts as feasible when this leg starts
   *  within [prevEnd + max(transitionMinutes, minWaitMinutes), prevEnd +
   *  maxWaitMinutes]. minWaitMinutes backs the reorder fallback's "at least one
   *  session between the two races" rule. */
  | {
      kind: "bowling";
      durationMinutes: number;
      vip?: boolean;
      maxWaitMinutes?: number;
      minWaitMinutes?: number;
    }
  /** Forward-compat — typed, but the wizard/gate reject it until built. */
  | { kind: "attraction"; slug: string; maxWaitMinutes?: number; minWaitMinutes?: number };

export interface ComboSpecial {
  /** Kebab slug — route param + session.comboSpecialId. */
  id: string;
  name: string;
  shortDescription: string;
  longDescription: string;
  /** Display bullets, e.g. ["1 Starter Race", "1.5 Hours of Bowling", …]. */
  includes: string[];
  /**
   * Redeem-later voucher inclusions, rendered as their OWN labeled section
   * (owner 2026-07-31): the shared terms live once in `note` instead of a
   * "(voucher — when available, up to 1 year)" suffix repeated on every line.
   * Absent = the combo grants no vouchers (v1).
   */
  voucherIncludes?: { title?: string; items: string[]; note: string };
  /** Optional Spanish overrides for the guest-facing marketing copy (kiosk ES
   *  locale). Web + emails keep the English fields; the kiosk falls back to
   *  English per-field when an es value is absent. First-pass translation. */
  es?: {
    shortDescription?: string;
    longDescription?: string;
    durationLabel?: string;
    includes?: string[];
    voucherIncludes?: { title?: string; items?: string[]; note?: string };
    qualifyFallbackNote?: string;
  };
  heroImage: string;
  accentColor: string;
  /** Physical complex. Racing is Fort Myers-only. */
  center: CenterCode;
  /** Per-PERSON price in CENTS by day tier (Mega Tuesday = weekday). */
  price: { weekday: number; weekend: number };
  /**
   * Minimum party size required to book this combo (owner policy — the VIP
   * lane is a shared semi-private suite, so it sells for ≥2 guests). The party
   * step's gate blocks advancing below this; absent = 1 (no minimum).
   */
  minHeadcount?: number;
  /** ORDERED visit itinerary. */
  components: ComboLeg[];
  /**
   * Alternate leg ordering, tried ONLY when the primary `components` ordering
   * yields no feasible chain for a given start-hour (flag-gated — see
   * `comboReorderFallbackEnabled`). MUST share the same leg 0 as `components`
   * (the customer still picks that start time); only the later legs reorder.
   * Each leg carries its own min/max wait so the reorder stays bounded (e.g.
   * the Ultimate VIP fallback runs race → race → lane with a 20–45 min gap
   * between the races and a ≤45 min gap before the lane). Absent = no fallback.
   */
  fallbackComponents?: ComboLeg[];
  /** Short note shown on a start-time tile that resolved via `fallbackComponents`. */
  fallbackNote?: string;
  /**
   * When true, the customer-facing checkout review collapses the combo's
   * itemized revenue-split lines (races / POV / license / lane / shoes) into a
   * SINGLE "{name} × {racers}" line at the summed price — so the package reads
   * as one all-inclusive price, not a parts list. DISPLAY ONLY: the charge
   * stays itemized across the two day-of orders, and the collapsed total equals
   * the itemized sum, so displayed total === charged total. Other (non-combo)
   * cart items still show individually.
   */
  flatCartDisplay?: boolean;
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
  /**
   * Redeem-later entitlements: one native voucher (HPW code) minted per
   * booking, carrying perGuest items × racer count + perBooking items,
   * expiring `expiresMonthsFromVisit` after the visit date. Absent = the
   * combo grants nothing beyond its booked itinerary.
   */
  voucherGrant?: ComboVoucherGrant;
  /**
   * Quantity rules for the $0 included lines re-attached to the bowling
   * day-of order (e.g. chips & salsa). The QAMF experience seeds one per
   * LANE; a rule re-sizes that line to ceil(players / guestsPerUnit) on the
   * Square order (owner 2026-07-31: chips = 1 per 3 people). $0 lines only —
   * totals, deposit and the displayed==charged tripwire are untouched.
   */
  inclusionQtyRules?: Array<{ catalogObjectId: string; guestsPerUnit: number }>;
  /** Short admin-board badge (e.g. "VIP V2"); absent = the generic "VIP". */
  adminShortLabel?: string;
  enabled: boolean;
  displayOrder?: number;
  /** Optional seasonal window for future combos (mirrors discount-codes). */
  availability?: { startsAt?: string; expiresAt?: string; allowedWeekdays?: number[] };
}

/**
 * V2 pack flag: DEFAULT ON — the V2 pack goes live on deploy (owner
 * 2026-07-31: "flags on by default"). Kill switch: set the literal "false" in
 * Vercel + redeploy (NEXT_PUBLIC_* is build-baked).
 */
const COMBO_RACE_BOWL_V2_ENABLED = process.env.NEXT_PUBLIC_COMBO_RACE_BOWL_V2_ENABLED !== "false";

/**
 * V1 flag — RETIRED at the V2 cutover (owner 2026-07-31). Revive-only switch:
 * v1 sells again ONLY when explicitly set "true" AND v2 is killed. The
 * `!V2` guard is structural: the two entries share a guest-facing name, so
 * both-on would render duplicate cards on every enabledCombos() surface —
 * no combination of env values can produce that. The entry itself stays in
 * code so historical bookings keep resolving (admin badges, receipts, memos).
 */
const COMBO_RACE_BOWL_ENABLED =
  process.env.NEXT_PUBLIC_COMBO_RACE_BOWL_ENABLED === "true" && !COMBO_RACE_BOWL_V2_ENABLED;

/**
 * Reorder-fallback flag: default OFF (ships dark per the v2 cutover rule).
 * When on, a combo's `fallbackComponents` ordering is tried for any start-hour
 * the normal ordering can't fill. Flip `NEXT_PUBLIC_COMBO_REORDER_FALLBACK=true`
 * in Vercel after ops signs off.
 */
export function comboReorderFallbackEnabled(): boolean {
  return process.env.NEXT_PUBLIC_COMBO_REORDER_FALLBACK === "true";
}

/**
 * Group-match flag: default ON unless explicitly "false" (additive/advisory —
 * it only badges the start grid and annotates the staff email). When a VIP
 * combo is already booked on a date, later bookings are steered onto the same
 * schedule so staff walk both groups to HeadPinz together (owner 2026-07-06).
 */
export function comboGroupMatchEnabled(): boolean {
  return process.env.NEXT_PUBLIC_COMBO_GROUP_MATCH !== "false";
}

/**
 * Junior-mirror flag: default ON (owner 2026-07-06). A mixed adult+junior
 * party books juniors on the junior heat nearest the adult heat of each race
 * leg — right AROUND it, either side (owner 2026-07-14: "juniors can race
 * before, for sure"; ties prefer after), restriction-rule-aware and
 * join-preferring (see pickJuniorMirror in combo-booking.ts) — instead of
 * requiring a junior block at the SAME start, which never aligns in practice,
 * so mixed parties were effectively unbookable. Kill switch:
 * `NEXT_PUBLIC_COMBO_JUNIOR_MIRROR=false` in Vercel (+ redeploy —
 * build-baked) restores the exact same-start behavior.
 */
export function comboJuniorMirrorEnabled(): boolean {
  return process.env.NEXT_PUBLIC_COMBO_JUNIOR_MIRROR !== "false";
}

export const COMBO_SPECIALS: ComboSpecial[] = [
  {
    id: "race-bowl",
    name: "VIP Experience",
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
    es: {
      shortDescription:
        "Una experiencia completa de 3 horas: carrera Starter, 1.5 horas de boliche VIP y luego " +
        "una carrera Intermediate — licencia, video POV y beneficios de pista VIP incluidos. Un " +
        "precio, una reservación.",
      longDescription:
        "Tres horas de la noche premium completa de FastTrax + HeadPinz: califica en una carrera " +
        "Starter, toma una pista VIP semiprivada para 1.5 horas de boliche y luego regresa más " +
        "rápido en una carrera Intermediate. La licencia de carreras, el video POV y los " +
        "beneficios de pista VIP (muro de video NeoVerse, chips y salsa, glow premium) están todos " +
        "incluidos. Elige una hora de inicio — 2, 4, 6, 8 o 10 PM — y nosotros programamos el resto.",
      durationLabel: "≈ Experiencia de 3 horas",
      qualifyFallbackNote:
        "¿No calificaste? No hay problema — convertimos tu carrera Intermediate en una segunda " +
        "carrera Starter, o te damos un crédito de carrera.",
      includes: [
        "Carrera Starter",
        "1.5 horas de boliche VIP",
        "Carrera Intermediate",
        "Licencia de carreras + video POV",
      ],
    },
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
    // Owner: the VIP experience is a shared semi-private suite — book ≥2 guests.
    minHeadcount: 2,
    components: [
      { kind: "race", tier: "starter" },
      // Owner rule: assume racing takes 30 min, then bowl 15 min after — so the
      // lane floors at race-start + 45 (e.g. a 2 PM race → 2:45 lane). The 30 min
      // is the assumed race leg (see ASSUMED_RACE_LEG_MINUTES) and the 15 min is
      // the global transition buffer, so NO minWaitMinutes is needed here. The
      // 75-min ceiling (from the assumed race end) leaves a wide fallback window
      // so a lane still surfaces if the ideal :45 slot is taken.
      { kind: "bowling", durationMinutes: 90, vip: true, maxWaitMinutes: 75 },
      { kind: "race", tier: "intermediate" },
    ],
    // Fallback (flag-gated): when no lane fits within 60 min of the first race
    // (e.g. a league owns the VIP lanes mid-evening), run both races up front
    // and bowl last on a later lane. Races ≥20 min apart (one session between),
    // ≤45 min apart (no stranding when Mega heats are sparse), lane ≤45 min
    // after race 2. Recovers slots the in-the-middle order can't reach.
    fallbackComponents: [
      { kind: "race", tier: "starter" },
      { kind: "race", tier: "intermediate", minWaitMinutes: 20, maxWaitMinutes: 45 },
      { kind: "bowling", durationMinutes: 90, vip: true, maxWaitMinutes: 45 },
    ],
    fallbackNote:
      "Both races run first, then your VIP lane — your lane time opens later in the evening.",
    // Show the cart as one all-inclusive "VIP Experience" line, not the
    // itemized license/POV/lane parts (charge stays itemized under the hood).
    flatCartDisplay: true,
    transitionMinutes: 15,
    includesLicense: true,
    includedPovPerRacer: 1,
    startHours: [14, 16, 18, 20, 22],
    premium: true,
    // Collapsed split (owner 2026-06-23): ONE line per center, not an itemized
    // parts list. The flat per-person price routes as a single FastTrax racing
    // line + a single HeadPinz bowling line, each to its center's own day-of
    // order + dedicated catalog item — so combo revenue stops sharing the
    // Ultimate Qualifier / VIP Bowling reporting buckets. License, POV, and shoes
    // are FOLDED INTO these amounts (the $0 BMI records still book; no separate
    // Square lines). Weekend uplift is SHARED: FastTrax $44→$49, HeadPinz $21→$26.
    // Sums to 6500 wd / 7500 we per person. Because each entity has exactly one
    // line, comboItemizedLines aggregates to a single line per order. Portal
    // breakdown (internal, owner 2026-06-23): FastTrax $44/$49 = Starter $17/$19.50
    // + Intermediate $17/$19.50 + POV $5 + License $5; HeadPinz $21/$26 =
    // VIP lane $16/$21 + Shoes $5.
    revenueSplit: [
      {
        key: "vip-racing",
        label: "VIP Experience",
        entity: "fasttrax-fm",
        catalogObjectId: SQUARE_CATALOG_IDS.VIP_EXPERIENCE_RACING,
        weekdayCents: 4400,
        weekendCents: 4900,
        appliesTo: "allRacers",
      },
      {
        key: "vip-bowling",
        label: "VIP Experience",
        entity: "headpinz-fm",
        catalogObjectId: SQUARE_CATALOG_IDS.VIP_EXPERIENCE_BOWLING,
        weekdayCents: 2100,
        weekendCents: 2600,
        appliesTo: "allRacers",
      },
    ],
    enabled: COMBO_RACE_BOWL_ENABLED,
    displayOrder: 10,
  },
  // ── V2 pack (owner 2026-07-31): $79 wd / $99 we + redeem-later vouchers ──
  // Same itinerary and guest-facing NAME as race-bowl (the shared name keeps
  // the checkout flat-display and receipt collapse matchers working); new
  // price, per-person Game Zone + laser/gel voucher items, a shared Shuffly
  // hour, and chips re-sized to 1 per 3 guests. Ships dark; the cutover flips
  // v1 off and v2 on in one redeploy (see COMBO_RACE_BOWL_V2_ENABLED).
  {
    id: "race-bowl-v2",
    name: "VIP Experience",
    shortDescription:
      "A 3–4 hour experience: Starter race, 1.5 hours of VIP bowling, then an Intermediate " +
      "race — license, POV video and VIP lane perks included. Plus a $10 Game Zone bonus card, " +
      "a Laser Tag or Gel Blaster pass, and an hour of Shuffly by voucher. One price, one booking.",
    longDescription:
      "Three to four hours of the full FastTrax + HeadPinz premium night: qualify on a Starter race, " +
      "take over a semi-private VIP lane for 1.5 hours of bowling, then come back faster on " +
      "an Intermediate race. Racing license, POV race video, and VIP lane perks (NeoVerse " +
      "video wall, chips & salsa, premium glow) are all included — plus a voucher good for a " +
      "$10 Game Zone bonus card per person, Laser Tag OR Gel Blaster per person, and an hour " +
      "of Shuffly, valid up to 1 year from your race date (when available, not transferable). " +
      "Pick a start time — 2, 4, 6, 8, or 10 PM — and we schedule the rest.",
    durationLabel: "≈ 3–4 Hour Experience",
    qualifyFallbackNote:
      "Didn't qualify? No problem — we'll convert your Intermediate to a second Starter race, or issue you a race credit.",
    includes: [
      "Starter Race",
      "1.5 Hours of VIP Bowling",
      "Intermediate Race",
      "Racing License",
      "POV Race Video",
    ],
    // One labeled section instead of a per-line "(voucher — when available…)"
    // suffix ×3 (owner 2026-07-31). The note carries the shared terms once.
    voucherIncludes: {
      title: "Plus vouchers to your favorite attractions",
      items: [
        "$10 Game Zone Bonus Card — per person",
        "Laser Tag OR Gel Blaster — per person",
        "1 Hour of Shuffly AR Shuffleboard",
      ],
      note: "One code covers them all — valid up to 1 year from your race date, when available. Not transferable.",
    },
    es: {
      shortDescription:
        "Una experiencia de 3–4 horas: carrera Starter, 1.5 horas de boliche VIP y luego " +
        "una carrera Intermediate — licencia, video POV y beneficios de pista VIP incluidos. " +
        "Además una tarjeta Game Zone de $10, un pase de Laser Tag o Gel Blaster y una hora de " +
        "Shuffly por cupón. Un precio, una reservación.",
      longDescription:
        "De tres a cuatro horas de la noche premium completa de FastTrax + HeadPinz: califica en una carrera " +
        "Starter, toma una pista VIP semiprivada para 1.5 horas de boliche y luego regresa más " +
        "rápido en una carrera Intermediate. La licencia de carreras, el video POV y los " +
        "beneficios de pista VIP (muro de video NeoVerse, chips y salsa, glow premium) están todos " +
        "incluidos — además un cupón por una tarjeta Game Zone de $10 por persona, Laser Tag O " +
        "Gel Blaster por persona y una hora de Shuffly, válido hasta 1 año desde tu fecha de " +
        "carrera (según disponibilidad, no transferible). Elige una hora de inicio — 2, 4, 6, 8 o " +
        "10 PM — y nosotros programamos el resto.",
      durationLabel: "≈ Experiencia de 3–4 horas",
      qualifyFallbackNote:
        "¿No calificaste? No hay problema — convertimos tu carrera Intermediate en una segunda " +
        "carrera Starter, o te damos un crédito de carrera.",
      includes: [
        "Carrera Starter",
        "1.5 horas de boliche VIP",
        "Carrera Intermediate",
        "Licencia de carreras",
        "Video POV de tu carrera",
      ],
      voucherIncludes: {
        title: "Además, cupones para tus atracciones favoritas",
        items: [
          "Tarjeta Game Zone de $10 — por persona",
          "Laser Tag O Gel Blaster — por persona",
          "1 hora de Shuffly AR Shuffleboard",
        ],
        note: "Un solo código los cubre todos — válido hasta 1 año desde tu fecha de carrera, según disponibilidad. No transferible.",
      },
    },
    perks: [
      "Semi-private 8-lane VIP area",
      "NeoVerse video wall",
      "Complimentary chips & salsa (1 per 3 guests)",
      "Bowling shoes included",
      "HyperBowling + premium glow lighting",
    ],
    heroImage:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/pricing-combos.webp",
    accentColor: "#FFD700",
    center: "fort-myers",
    price: { weekday: 7900, weekend: 9900 },
    // Owner: the VIP experience is a shared semi-private suite — book ≥2 guests.
    minHeadcount: 2,
    components: [
      { kind: "race", tier: "starter" },
      { kind: "bowling", durationMinutes: 90, vip: true, maxWaitMinutes: 75 },
      { kind: "race", tier: "intermediate" },
    ],
    fallbackComponents: [
      { kind: "race", tier: "starter" },
      { kind: "race", tier: "intermediate", minWaitMinutes: 20, maxWaitMinutes: 45 },
      { kind: "bowling", durationMinutes: 90, vip: true, maxWaitMinutes: 45 },
    ],
    fallbackNote:
      "Both races run first, then your VIP lane — your lane time opens later in the evening.",
    flatCartDisplay: true,
    transitionMinutes: 15,
    includesLicense: true,
    includedPovPerRacer: 1,
    startHours: [14, 16, 18, 20, 22],
    premium: true,
    // V2 split (owner 2026-07-31): the +$14 wd / +$24 we uplift over v1 is
    // shared EVENLY — FastTrax $44→$51 / $49→$61, HeadPinz $21→$28 / $26→$38.
    // Sums to 7900 wd / 9900 we per person. The voucher entitlements (Game
    // Zone card, laser/gel, Shuffly) are unfunded until redemption — no
    // separate Square line; same fold-in model as license/POV/shoes.
    revenueSplit: [
      {
        key: "vip-racing",
        label: "VIP Experience",
        entity: "fasttrax-fm",
        catalogObjectId: SQUARE_CATALOG_IDS.VIP_EXPERIENCE_RACING,
        weekdayCents: 5100,
        weekendCents: 6100,
        appliesTo: "allRacers",
      },
      {
        key: "vip-bowling",
        label: "VIP Experience",
        entity: "headpinz-fm",
        catalogObjectId: SQUARE_CATALOG_IDS.VIP_EXPERIENCE_BOWLING,
        weekdayCents: 2800,
        weekendCents: 3800,
        appliesTo: "allRacers",
      },
    ],
    // Redeem-later grant: ONE voucher per booking (owner: "one voucher that
    // pulls up all their entitlements"), 1 year from the RACE date, not
    // transferable. Per racer: a $10 Game Zone card (100 bonus tokens) + a
    // laser-tag-OR-gel-blaster pass; per booking: one Shuffly hour (the
    // product is per-table, seats up to 10).
    voucherGrant: {
      perGuest: [
        { kind: "gamezone", tokens: 0, bonusTokens: 100, bonusCashDollars: 0 },
        { kind: "attraction-choice", slugs: ["laser-tag", "gel-blaster"], qty: 1 },
      ],
      perBooking: [{ kind: "attraction", slug: "shuffly", qty: 1 }],
      expiresMonthsFromVisit: 12,
    },
    // Chips & salsa: the QAMF experience seeds 1/lane; owner 2026-07-31 —
    // 1 per 3 guests (round up) on the HeadPinz day-of order.
    inclusionQtyRules: [{ catalogObjectId: "LHZXWYO72N5QFX4CGYKRVPZX", guestsPerUnit: 3 }],
    adminShortLabel: "VIP V2",
    enabled: COMBO_RACE_BOWL_V2_ENABLED,
    displayOrder: 11,
  },
];

/** Look up a combo by id (enabled or not — callers gate separately). */
export function getComboSpecial(id: string): ComboSpecial | null {
  return COMBO_SPECIALS.find((c) => c.id === id) ?? null;
}

/**
 * The LIVE VIP Experience pack — v2 today; v1 only if explicitly revived.
 * Consumers that used to hardcode "race-bowl" (kiosk availability, the
 * anchor-reserve rule, the attract chip) resolve through THIS so a pack
 * cutover is a flag concern, never a call-site hunt. Null = no VIP pack on
 * sale (anchor reserve lifts, kiosk tile hides — the correct dark state).
 */
export function activeVipCombo(): ComboSpecial | null {
  return (
    COMBO_SPECIALS.find((c) => c.enabled && (c.id === "race-bowl-v2" || c.id === "race-bowl")) ??
    null
  );
}

/** Admin-board badge for a combo booking ("VIP" for v1, "VIP V2" for the V2
 *  pack). Falls back to "VIP" for unknown/legacy ids so historical rows keep
 *  their badge even after a registry entry retires. */
export function comboAdminLabel(comboSpecialId: string | null | undefined): string {
  if (!comboSpecialId) return "VIP";
  return getComboSpecial(comboSpecialId)?.adminShortLabel ?? "VIP";
}

/**
 * Is this booking a VIP Experience? Drives the BMI "Confirmation -
 * VIP" state stamp (`~/features/combos/vip-state.server`) as well as any other
 * "treat this as VIP" decision.
 *
 * Every combo special shipped to date IS a VIP pack — `race-bowl` and
 * `race-bowl-v2` are both literally named "VIP Experience" (rebranded from
 * "Ultimate VIP Experience" 2026-08-10; historical Square/BMI rows keep the
 * old name, which still contains the new one as a substring) — and
 * `comboAdminLabel` above already assumes the same for ids that have left the
 * registry, so historical rows keep their badge. Keying off "has a
 * comboSpecialId" therefore also covers legacy rows a registry lookup misses.
 *
 * If a non-VIP combo special ever ships, give `ComboSpecial` a `vip: false`
 * and gate HERE — this is the single predicate every VIP rail consults.
 *
 * Pure (no BMI/Office imports) so server rails can branch on it without
 * dragging the node `https` chain in behind a lazy import.
 */
export function isVipComboBooking(comboSpecialId: string | null | undefined): boolean {
  return typeof comboSpecialId === "string" && comboSpecialId.length > 0;
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

/** Minimum party size to book this combo (defaults to 1 when unset). */
export function comboMinHeadcount(combo: ComboSpecial): number {
  return Math.max(1, Math.floor(combo.minHeadcount ?? 1));
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
 * Stable identity for a leg, independent of its position in an ordering. Lets
 * the reorder fallback map its reordered leg list back to the candidate arrays
 * already fetched for the primary `components` order — so the reorder needs NO
 * extra BMI/QAMF calls. (starter & intermediate races have distinct tiers; the
 * lane is distinguished by duration + vip — so keys are unique within a combo.)
 */
export function legKey(leg: ComboLeg): string {
  if (leg.kind === "race") return `race:${leg.tier}`;
  if (leg.kind === "bowling") return `bowl:${leg.durationMinutes}:${leg.vip ? "vip" : "reg"}`;
  return `attr:${leg.slug}`;
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
export function comboReservationNote(
  combo: ComboSpecial,
  lane?: string | null,
  orderedComponents?: ComboLeg[],
): string {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  // The actual booked order — the reorder fallback passes its ordering so the
  // memo's numbered visit plan matches what staff will run. Defaults to the
  // primary (in-the-middle) ordering.
  const legs = orderedComponents ?? combo.components;
  let sawStarter = false;
  const steps = legs.map((leg, i) => {
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
