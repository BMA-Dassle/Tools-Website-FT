/**
 * WHAT THE FRONT-DESK WALL SAYS — all of it, in one pure module.
 *
 * The three wall scenes (SceneVipShowcase, SceneOpenNow, SceneKioskHowto) are
 * renderers: they take a panel position and paint what this file hands them.
 * Keeping the words and the numbers here rather than inside the components buys
 * two things that matter more than tidiness:
 *
 *   1. THE PRICE RULE IS TESTABLE. "A displayed price must be the price the kiosk
 *      will charge" is a house rule with money behind it. Every price on this wall
 *      is read from the module the kiosk itself charges from — never re-typed,
 *      never re-derived — and wall-content.test.ts asserts that, which a JSX tree
 *      cannot.
 *   2. THE COPY CANNOT SILENTLY GO STALE. The VIP wall labels are short enough to
 *      read at 88px, which means they are NOT verbatim catalog strings. So each
 *      one is checked against the live combo's own `includes` / `perks` /
 *      `voucherIncludes` by a test. Retire the pack, rename a leg, drop a
 *      voucher — the test fails and names the label that stopped being true,
 *      instead of the wall confidently advertising a thing we no longer sell.
 *
 * PURE: no React, no I/O, no `Date.now()`. Everything time-dependent takes the
 * shared-clock `nowMs` the director already passes every scene, so all five
 * panels agree and a rebooted player rejoins mid-stride.
 */
import { activeVipCombo } from "~/features/combos/combo-specials";
import { scheduleForDate } from "~/features/booking/service/race-pricing";
import { ATTRACTIONS } from "@/lib/attractions-data";
import { TOKEN_PACKAGES } from "~/features/game-cards";
import { TV_PHOTOS } from "./assets";
import { atWallPosition } from "./wall";
import { SLOT_MS } from "./director/schedule";
import type { TvFeed } from "./types";

/** Tonight's bowling as the feed reports it. */
type BowlingTonight = NonNullable<TvFeed["bowlingTonight"]>;
type BowlingWallOffer = NonNullable<NonNullable<BowlingTonight["special"]>["regular"]>;

/* ── palette ──────────────────────────────────────────────────────────── */

/**
 * The accents the wall paints with, mirroring the `--k-*` tokens in tv.css and
 * the kiosk billboard's own slide accents. Named here so a scene never inlines a
 * hex: five panels drifting apart by one digit is exactly the kind of wrongness
 * nobody spots on a laptop and everybody sees on a wall.
 *
 * TWO GOLDS on purpose (as tv.css documents): `vip` is the hero — it is the
 * combo's own `accentColor` — and `vipSoft` is supporting chrome.
 */
export const WALL_ACCENT = {
  vip: "#d4af37",
  vipSoft: "#e8b14c",
  /** The Starter leg. Lighter than the production track navy, which disappears
   *  against the #000418 ground — same reason track.ts brightens its accents. */
  starter: "#4a86e8",
  race: "#e53935",
  bowl: "#fd5b56",
  gel: "#46d68c",
  laser: "#f800c6",
  duck: "#4fa9ff",
  arcade: "#f0b341",
  cyan: "#00e2e5",
  quiet: "rgba(245,236,238,0.35)",
} as const;

/* ── the day tier ─────────────────────────────────────────────────────── */

/**
 * Today's date at the VENUE, as `YYYY-MM-DD`.
 *
 * Not `new Date(nowMs).toISOString().slice(0,10)`, and not the renderer's local
 * day either. A wall in Fort Myers prices by Fort Myers' day: at 8pm Sunday ET a
 * UTC-clocked renderer has already rolled over to Monday, which is the difference
 * between the weekend tier and the weekday one. Same `Intl` + America/New_York
 * pattern as `etHourNow` and `isMegaTuesdayToday`.
 *
 * Falls back to the renderer's own day if `Intl` cannot answer — a wrong tier is
 * a bad outcome, but both tiers are on this wall all evening anyway (see
 * `vipWallPrice`), so it degrades to "the emphasis is on the wrong one" rather
 * than to a price nobody will honour.
 */
export function venueDateString(nowMs: number): string {
  const d = new Date(nowMs);
  try {
    // en-CA renders ISO-ordered YYYY-MM-DD, which is what scheduleForDate wants.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
}

/**
 * Which VIP price tier bills TODAY: the combos feature's own rule, not a new one.
 *
 * `scheduleForDate` is the resolver the booking flow and `comboItemizedLinesForRacers`
 * both use, and the combo rule is "weekend tier iff it returns weekend". That is
 * why this is a lookup and not a `getDay()` test: MEGA TUESDAY returns "mega",
 * which is NOT weekend, so a combo on a Mega Tuesday bills at the WEEKDAY tier.
 * Re-deriving the tier from the day of the week is precisely how that gets quoted
 * wrong on a wall (plan, § Price rule).
 *
 * Passing a bare `YYYY-MM-DD` also takes scheduleForDate's local-time construction
 * path, which sidesteps the UTC-parse trap entirely.
 */
export function venueDayTier(nowMs: number): "weekday" | "weekend" {
  return scheduleForDate(venueDateString(nowMs)) === "weekend" ? "weekend" : "weekday";
}

export interface VipWallPrice {
  /** e.g. "$99" — the tier that bills tonight. */
  todayLabel: string;
  /** e.g. "$79" — the other tier, so the wall is true on any day. */
  otherLabel: string;
  /** Which tier is tonight's, for the caption under the big number. */
  todayTier: "weekday" | "weekend";
  /** e.g. "From $79" — the LOWER of the two, for the identity rail. */
  fromLabel: string;
  /** Minimum party size, from the combo's own `minHeadcount`. */
  minGuests: number;
}

/**
 * The VIP Experience's real prices, both tiers, from the pack the kiosk sells.
 *
 * BOTH TIERS STAY ON THE WALL. A guest reading it on a Thursday and coming back
 * on a Saturday must not feel bait-and-switched, and a single number would be
 * wrong half the week. Tonight's tier is the big one; the other is stated beside
 * it.
 *
 * The RAIL quotes "From $<lower>" for the whole 2m40s showcase rather than
 * tonight's tier, because "from" is the only claim that is true regardless of
 * which day a guest happens to read it on — and because the rail is also the
 * price a guest sees when they walk up mid-slide.
 *
 * Null when no VIP pack is on sale (`activeVipCombo()` returns null — the correct
 * dark state, e.g. both flags off). Callers drop the VIP content entirely rather
 * than printing a placeholder price.
 */
export function vipWallPrice(nowMs: number): VipWallPrice | null {
  const combo = activeVipCombo();
  if (!combo) return null;
  const tier = venueDayTier(nowMs);
  const cents = tier === "weekend" ? combo.price.weekend : combo.price.weekday;
  const other = tier === "weekend" ? combo.price.weekday : combo.price.weekend;
  const lower = Math.min(combo.price.weekday, combo.price.weekend);
  return {
    todayLabel: dollars(cents),
    otherLabel: dollars(other),
    todayTier: tier,
    fromLabel: `From ${dollars(lower)}`,
    minGuests: combo.minHeadcount ?? 2,
  };
}

/**
 * The pack's own duration, trimmed for a wall.
 *
 * `durationLabel` reads "≈ 3–4 Hour Experience" in the registry, which is right on a
 * booking page and too long for a 29px rail cell. Read from the pack rather than typed
 * so a re-timed itinerary carries through.
 */
function comboDurationLabel(): string {
  const raw = activeVipCombo()?.durationLabel ?? "";
  const trimmed = raw
    .replace(/^[≈~]\s*/, "")
    .replace(/\s*experience\s*$/i, "")
    // "≈ 3–4 Hour Experience" trims to "3–4 Hour", which reads as a typo on a wall.
    .replace(/\bhours?\b/i, "hours")
    .trim();
  return trimmed || "3–4 hours";
}

/** Cents → a wall-sized price. Whole dollars drop the ".00": at 165px a trailing
 *  zero-zero is two characters of nothing, and every combo tier is whole anyway. */
export function dollars(cents: number): string {
  const whole = cents % 100 === 0;
  return whole ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/* ── the identity rail ────────────────────────────────────────────────── */

export interface RailCell {
  text: string;
  /**
   * A smaller line UNDER `text`.
   *
   * THE PRODUCT IS ALWAYS NAMED FIRST, WITH THE BADGE UNDER IT (owner 2026-08-19).
   * "All Access" is the wall's badge for the thing, not the thing's name — a guest who
   * reads only the badge cannot ask for it at the desk or find it on a kiosk. So
   * wherever the badge appears it sits beneath "VIP Experience" rather than standing in
   * for it.
   */
  small?: string;
  /** Render this cell as the product NAME — bigger, in hero gold. */
  isName?: boolean;
  /** Render as the price: gold figure, quiet "per person". */
  isPrice?: boolean;
  /** Trailing "per person"-style qualifier, set only with `isPrice`. */
  quiet?: string;
  /** A gold glyph inside the cell (the "+" joining the brands, the ▼). */
  glyph?: string;
  /**
   * Render these brands as their actual LOGOS, joined by `glyph`, in place of `text`.
   *
   * The two brands are the one thing on this wall that must never be spelled out: a
   * guest recognises the FastTrax and HeadPinz marks from the building they are
   * standing in, and "FastTrax HeadPinz" set as words reads as one invented company
   * rather than two venues on one pass (owner 2026-08-19). `text` stays as the
   * accessible name for the pair.
   */
  brands?: Array<"fasttrax" | "headpinz">;
}

/**
 * THE IDENTITY RAIL — the gold band along the bottom of every VIP showcase slide.
 *
 * Owner 2026-08-17: "what if I walk up after VIP is already stated, I'd never know
 * what I'm looking at." Slides 2 and 3 are five panels of legs and inclusions, and
 * without this they belong to nothing.
 *
 * Read across the wall it is one sentence. Read one panel at a time, THE TWO
 * TOKENS THAT MATTER EACH LAND WHOLE ON A SINGLE PANEL — the name on panel 0 and
 * the price on panel 3 — so the wall still identifies itself with a player down.
 * That is the "a word never crosses a gap, a sentence may" law applied to the one
 * line that is load-bearing.
 *
 * It also puts the price on screen for the full 2m40s of the showcase instead of
 * only slide 4's twenty seconds, which is why slide 4's separate CTA band was
 * dropped as redundant.
 *
 * Returns null past the end of the rail: a wider wall's extra panels carry no
 * rail rather than repeating "All Access", which would read as two products.
 */
export function identityRail(
  position: number,
  price: VipWallPrice | null,
  slide?: number,
): RailCell | null {
  const combo = activeVipCombo();
  const name = combo?.name ?? "VIP Experience";

  // ON THE INCLUSIONS SLIDE the rail is the PRODUCT NAME on every panel (owner
  // 2026-08-18). That slide is five different things a guest gets, and the rail's
  // usual read-across sentence competes with them — five inclusions over five
  // fragments of a different sentence is two things to read at once. Naming the
  // product on all five instead makes the whole wall answer "included in WHAT".
  if (slide === 2) return { text: name, small: "All Access", isName: true };

  const cells: RailCell[] = [
    // THE NAME, BADGED. This cell is the one that has to land whole on a single panel
    // so the wall still identifies itself with a player down — which is exactly why it
    // must be the name a guest can act on, with the badge beneath it.
    { text: name, small: "All Access", isName: true },
    // …which frees this cell, since it used to be the product name and would now say
    // it twice. The duration is the next most useful thing about the night.
    { text: comboDurationLabel() },
    // THE TWO BRANDS AS MARKS, never as words — see RailCell.brands.
    { text: "FastTrax + HeadPinz", brands: ["fasttrax", "headpinz"], glyph: "+" },
    price
      ? { text: price.fromLabel, isPrice: true, quiet: "per person" }
      : { text: "Ask at the desk" },
    { text: "Book at any kiosk", glyph: "▼" },
  ];
  return atWallPosition(cells, position);
}

/* ── the VIP showcase ─────────────────────────────────────────────────── */

/**
 * How long one sub-slide holds. 20s DIVIDES the 40s slot evenly, so a slide can
 * never straddle a slot boundary — which would show half a slide, then a cut, on
 * a wall whose whole selling point is that the five panels change together.
 * The showcase's 4 slots are therefore exactly two full passes of four slides.
 */
export const VIP_SLIDE_MS = 20_000;

/** Which of the four sub-slides is up, from the shared clock — the same
 *  derive-never-remember pattern as SceneAdRotation and the kiosk billboard. */
export function vipSlideIndex(nowMs: number): number {
  return ((Math.floor(nowMs / VIP_SLIDE_MS) % 4) + 4) % 4;
}

/** A panel rendered as the kiosk's centred POSTER stack. */
export interface PosterPanel {
  layout: "poster";
  /** This panel is a full-width brand lockup instead of any words — the wall's two
   *  ends during the statement. WHICH mark is not decided here: the scene asks
   *  `wallBrand()`, because which way the room faces is a fact about the building
   *  and staff must be able to swap the two ends from the admin form. */
  bigBrand?: boolean;
  /** A small brand lockup above the words. */
  smallBrand?: "fasttrax" | "headpinz";
  /** The headline. `\n` is a deliberate line break, never a wrap. */
  word?: string;
  accent: string;
  /** A gold rule + caption beneath the headline (the price poster). */
  rule?: string;
}

/** A panel rendered as the bottom-left detail CARD. */
export interface CardPanel {
  layout: "card";
  eyebrow: string;
  word: string;
  line: string;
  accent: string;
  /**
   * The ground for THIS panel on THIS slide, when the panel's subject has a
   * picture of its own (owner 2026-08-18: each thing in the VIP night gets its
   * "respective picture"). Absent = the scene's stable per-position backdrop,
   * which is still right for a slide whose panels are words rather than things.
   */
  photo?: string;
}

export type WallPanel = PosterPanel | CardPanel;

/**
 * "VIP Experience includes" — the PRODUCT's name, not the wall's badge (owner
 * 2026-08-18). Read from the registry so a rebrand carries through, and computed once
 * because all five inclusion panels share the one eyebrow.
 */
const INCLUDES_EYEBROW = `${activeVipCombo()?.name ?? "VIP Experience"} includes`;

/**
 * The four showcase slides, one panel's worth at a time.
 *
 * LAYOUT IS CHOSEN BY THE PANEL'S JOB, which is the rule the whole design hangs
 * on: a poster gets the kiosk's centred stack, a card gets the bottom-left block,
 * because a centred poster cannot hold detail and a corner card cannot carry a
 * statement. Slides 1 and 4 are posters; slides 2 and 3 are cards.
 *
 * EVERY EYEBROW IS SELF-IDENTIFYING ("Your VIP night", "All Access includes") for
 * the same reason the rail exists — a guest arriving mid-slide should not have to
 * have seen the previous one.
 *
 * The labels are wall-shortened, not verbatim catalog strings — 88px type cannot
 * hold "1.5 Hours of VIP Bowling" on one line. wall-content.test.ts pins each of
 * them to the live combo's own arrays, so a pack change fails a test instead of
 * leaving the wall selling something we retired.
 *
 * Returns null for a position with nothing of its own to say.
 */
export function vipSlidePanel(
  slide: number,
  position: number,
  price: VipWallPrice | null,
): WallPanel | null {
  const A = WALL_ACCENT;
  switch (((slide % 4) + 4) % 4) {
    case 0: {
      // THE STATEMENT. The two ends are the brand marks — "two locations" is
      // FastTrax FM + HeadPinz FM (owner 2026-08-17) — and the sentence runs
      // across the three panels between them. Each panel holds ONE complete
      // phrase, so no word ever crosses a gap.
      const panels: PosterPanel[] = [
        { layout: "poster", bigBrand: true, accent: A.vip },
        { layout: "poster", smallBrand: "fasttrax", word: "Two\nlocations", accent: A.vip },
        { layout: "poster", smallBrand: "headpinz", word: "One\nprice", accent: A.vip },
        {
          layout: "poster",
          smallBrand: "fasttrax",
          // THE PRODUCT, NAMED, with the wall's badge under it (owner 2026-08-18).
          // This beat used to read "one VIP experience" — which describes the thing
          // without ever naming it, so a guest could read the whole wall and still
          // not know what to ask for. `activeVipCombo().name` is what the kiosk sells
          // it as, so a rebrand carries through here too.
          word: activeVipCombo()?.name ?? "VIP Experience",
          rule: "All Access",
          accent: A.vip,
        },
        { layout: "poster", bigBrand: true, accent: A.vip },
      ];
      return atWallPosition(panels, position);
    }
    case 1: {
      // THE NIGHT — the five things a VIP guest actually GETS, each over its own
      // picture (owner 2026-08-18).
      //
      // A LIST, NOT A TIMETABLE. The two races sit together because they are the
      // same kind of thing; ordering the panels by sequence would put the bowling
      // in the middle and make the wall read as an itinerary, which is not what
      // sells it. The eyebrows carry the sequence instead — "in between" is
      // literally where the bowling falls.
      //
      // Gel blasters and Game Zone are the two headline VOUCHER entitlements
      // rather than legs, so their lines carry the terms that keep them true: the
      // pass is laser tag OR gel blaster, and the Game Zone card is $10 per person.
      const panels: CardPanel[] = [
        {
          layout: "card",
          eyebrow: "Your VIP night",
          word: "Starter\nrace",
          line: "Licence included",
          accent: A.starter,
          photo: TV_PHOTOS.race,
        },
        {
          layout: "card",
          eyebrow: "And again",
          word: "Intermediate\nrace",
          line: "Come back faster",
          accent: A.race,
          photo: TV_PHOTOS.redTrack,
        },
        {
          layout: "card",
          eyebrow: "In between",
          word: "1.5 hours\nbowling",
          line: "Semi-private VIP suite",
          accent: A.bowl,
          photo: TV_PHOTOS.bowl,
        },
        {
          layout: "card",
          eyebrow: "Plus",
          word: "Gel\nblasters",
          line: "Or laser tag — per person",
          accent: A.gel,
          photo: TV_PHOTOS.gel,
        },
        {
          layout: "card",
          eyebrow: "Plus",
          word: "Game\nZone",
          line: "$10 card, per person",
          accent: A.arcade,
          photo: TV_PHOTOS.arcade,
        },
      ];
      return atWallPosition(panels, position);
    }
    case 2: {
      // WHAT'S INCLUDED — two from the combo's `includes` tail, one from `perks`,
      // two from the voucher grant. Deliberately NOT the voucher TERMS: they are
      // unreadable at TV distance, and the kiosk states them at the point of sale
      // where they actually bind.
      const panels: CardPanel[] = [
        {
          layout: "card",
          eyebrow: INCLUDES_EYEBROW,
          word: "Racing\nlicence",
          line: "Yours to keep",
          accent: A.starter,
        },
        {
          layout: "card",
          eyebrow: INCLUDES_EYEBROW,
          word: "POV race\nvideo",
          line: "Every lap, from the seat",
          accent: A.race,
        },
        {
          layout: "card",
          eyebrow: INCLUDES_EYEBROW,
          word: "NeoVerse\nVIP lane",
          line: "Video wall, chips & salsa",
          accent: A.bowl,
        },
        {
          layout: "card",
          eyebrow: INCLUDES_EYEBROW,
          word: "$10 Game\nZone card",
          line: "Per person",
          accent: A.arcade,
        },
        {
          layout: "card",
          eyebrow: INCLUDES_EYEBROW,
          word: "Laser tag or\ngel blaster",
          line: "Per person, plus Shuffly",
          accent: A.laser,
        },
      ];
      return atWallPosition(panels, position);
    }
    default: {
      // THE PRICE. Tonight's tier huge, the other stated beside it, and the
      // minimum party size — which is a CONDITION of the price, so it belongs on
      // the same slide rather than in small print nobody reads from thirty feet.
      // No CTA band here: the rail already carries "Book at any kiosk ▼" on all
      // four slides, and a second one would just be the same instruction twice.
      if (!price) return null;
      const tonight = price.todayTier === "weekend" ? "Friday to Sunday" : "Monday to Thursday";
      const other = price.todayTier === "weekend" ? "Monday to Thursday" : "Friday to Sunday";
      const panels: PosterPanel[] = [
        // The product, named, badged — never the badge alone.
        {
          layout: "poster",
          word: activeVipCombo()?.name ?? "VIP Experience",
          rule: "All Access",
          accent: A.vip,
        },
        { layout: "poster", word: price.todayLabel, accent: A.vip, rule: `Tonight · ${tonight}` },
        { layout: "poster", word: price.otherLabel, accent: A.vipSoft, rule: other },
        {
          layout: "poster",
          word: `${price.minGuests} guests\nminimum`,
          accent: A.vipSoft,
          rule: "Per person, every tier",
        },
        { layout: "poster", word: "Book it\nbelow", accent: A.vip, rule: "Any kiosk in this bank" },
      ];
      return atWallPosition(panels, position);
    }
  }
}

/* ── the menu board ───────────────────────────────────────────────────── */

/** One priced line inside a menu panel. */
export interface MenuRow {
  name: string;
  /**
   * The product id this row sells, matched against the feed's `pausedProductIds`
   * and its `nextAvailable` map. THE SAME VOCABULARY the maintenance registry and
   * the kiosk availability payload speak (features/maintenance/vendors.ts) — a row
   * keyed on a name that is not in that registry silently never pauses, which is
   * worse than not gating at all because it looks gated.
   *
   * Absent for a row that sells nothing biddable (a "come and ask us" line).
   */
  productId?: string;
  /** A price, when there is a real one to quote. */
  price?: string;
  /** Instead of a price, when there genuinely isn't one. */
  word?: string;
  /** The quiet qualifier — "per lane", "per 30 min". */
  note?: string;
  /**
   * Does this product have a bookable-slot signal in the availability cache?
   *
   * Load-bearing for honesty, not layout. The feed hands the wall only the times,
   * and it omits a product the cache marked unavailable — so "no time" is ambiguous
   * between "cache is cold", "nothing left today" and "this has no slots at all".
   * With this flag the board can tell them apart instead of claiming "Open" for
   * something the kiosk below will refuse.
   */
  tracksAvailability?: boolean;
}

/**
 * ONE SUBJECT PER PANEL (owner 2026-08-18).
 *
 * The board was two tiles on every panel, which made the wall a list that happened
 * to be split five ways. It is now five panels each about ONE thing, with the
 * subject as the headline and its offers underneath — so a guest looking at any
 * single panel gets a complete answer rather than a fragment of a menu.
 *
 * That is also why the photo belongs to the panel rather than the position: the
 * picture is the subject's picture. Gel blasters and laser tag share a panel and a
 * gel-blaster photograph because they are the same trip to the same arena.
 */
export interface MenuPanel {
  /** The subject. Lands whole on one panel — no word crosses a gap. */
  headline: string;
  /** A second, quieter line under it (the VIP panel's "All Access" badge). */
  subhead?: string;
  photo: string;
  accent: string;
  rows: MenuRow[];
  /**
   * The arrow band's words — PERMANENT CHROME on every pricing panel (owner
   * 2026-08-19), not a scene of its own any more.
   *
   * A guest reading a price eight feet up is not thereby told that the machine at
   * waist height in front of them is how to buy it. Carrying the instruction on the
   * pricing panel itself says both at once and costs no airtime, which is why the
   * separate kiosk how-to slot was deleted rather than kept alongside it.
   *
   * "THE kiosk below", never "any" — the ad rotation sells the whole bank; this board
   * names the one machine under this panel.
   */
  band: string;
}

/**
 * WHICH THREE SUBJECTS THE MIDDLE PANELS SHOW RIGHT NOW.
 *
 * Six subject slots over three panels, so the board deals them in two sets and cuts
 * between them on the 40-second slot boundary: everything is seen inside eighty
 * seconds, and all three panels cut TOGETHER because the set is derived from the
 * shared clock rather than from any panel's own timer.
 */
function subjectSet(nowMs: number): 0 | 1 {
  return Math.floor(nowMs / SLOT_MS) % 2 === 0 ? 0 : 1;
}

/**
 * The bowling panel, led by one tier of tonight's package.
 *
 * `lead` picks which tier heads the panel — the regular package in subject set A, the
 * VIP one in set B. That is what earns bowling its two appearances without showing the
 * same rows twice: it is a bowling centre, so the headline product gets the double
 * airtime, but the second pass sells the upgrade rather than repeating the offer.
 *
 * The plain hourly lane rate rides underneath either way, marked "by the hour", because
 * a guest who just wants a lane needs a number too — and it must never be confusable
 * with the package: one is per person for ninety minutes, the other per lane.
 */
function bowlingPanel(bowling: BowlingTonight | null, lead: "regular" | "vip"): MenuPanel {
  const A = WALL_ACCENT;
  const rows: MenuRow[] = [];

  const asRow = (offer: BowlingWallOffer | null, fallbackName: string): MenuRow | null =>
    offer
      ? {
          name: offer.label || fallbackName,
          productId: "bowling",
          tracksAvailability: true,
          // A catalog row with no priced primary item shows no price rather than a
          // zero — the same rule the static catalogue's `price: 0` forces.
          price: offer.priceLabel ?? undefined,
          word: offer.priceLabel ? undefined : "Ask at the desk",
          // "shoes included" earns its place next to the price: it is the difference
          // between a quoted number and what a family of four actually pays. Only ever
          // printed when the offer really says so.
          note: [offer.durationLabel, offer.unit, offer.shoesIncluded ? "shoes included" : null]
            .filter(Boolean)
            .join(" · "),
        }
      : null;

  const special = bowling?.special ?? null;
  const led =
    lead === "vip" ? (special?.vip ?? special?.regular ?? null) : (special?.regular ?? null);
  const first = asRow(led, "Tonight's special");
  if (first) rows.push(first);

  const lane = asRow(bowling?.hourly?.regular ?? null, "Hourly lane");
  if (lane) rows.push({ ...lane, name: `${lane.name} lane by the hour` });

  if (rows.length === 0) {
    // No catalog answer at all. Sell the lanes on availability — never on a made-up
    // price, which is the one thing this panel may not do.
    rows.push({
      name: "Lanes",
      productId: "bowling",
      tracksAvailability: true,
      word: "Open now",
      note: ATTRACTIONS.bowling?.durationLabel ?? "1–2 hours",
    });
  }

  return {
    headline: "Bowling",
    subhead: special
      ? lead === "vip"
        ? "Tonight's special · VIP"
        : "Tonight's special"
      : undefined,
    photo: TV_PHOTOS.bowl,
    accent: A.bowl,
    rows,
    band: "Buy it on the kiosk below",
  };
}

/**
 * The THREE panels the middle of the wall is showing right now, in wall order.
 *
 * Three, not five: the menu board spans the middle (owner 2026-08-19), and `choreo()`
 * hands this scene a SPAN-RELATIVE position, so it composes over 0..2 and never has to
 * know that two more panels exist either side of it. TV1 and TV5 run their own boards.
 *
 * PRICES COME FROM THE MODULES THE KIOSK CHARGES FROM — `ATTRACTIONS` for the
 * attractions, the race registry for racing, the combo's own `price` for the VIP night,
 * and the feed's bowling section for lanes. Never a second copy: a menu board quoting a
 * price the machine below it will not honour is the exact failure the house pricing rule
 * exists to prevent.
 */
export function menuPanels(nowMs: number, bowling: BowlingTonight | null): MenuPanel[] {
  const A = WALL_ACCENT;
  const price = vipWallPrice(nowMs);

  if (subjectSet(nowMs) === 0) {
    return [
      bowlingPanel(bowling, "regular"),
      {
        // ONE TRIP, TWO ARENAS. Both Nexus attractions run from the same desk and the
        // same briefing, so they share a panel and the gel-blaster photograph rather
        // than competing for two of the three.
        headline: "Gel Blasters",
        subhead: "and Laser Tag",
        photo: TV_PHOTOS.gel,
        accent: A.gel,
        rows: [
          {
            name: "Gel Blasters",
            productId: "gel-blaster",
            tracksAvailability: true,
            price: attractionPrice("gel-blaster", "headpinz"),
            note: "Per session",
          },
          {
            name: "Laser Tag",
            productId: "laser-tag",
            tracksAvailability: true,
            price: attractionPrice("laser-tag", "headpinz"),
            note: "Per session",
          },
        ],
        band: "Buy it on the kiosk below",
      },
      {
        // ON ITS OWN — a game card is not a booking, it is the thing a guest does on
        // the way past, and pairing it with a timed attraction made it read as one.
        //
        // AND IT IS PRICED. This panel used to say "Any amount", which is true and
        // sells nothing — a pricing board with no number on it is the one panel a guest
        // scans past (owner 2026-08-19, "I see pricing on the 2nd and 3rd TV, why not
        // the 4th?"). The token packages have real prices AND real bonuses, and the
        // bonus is the offer, so the panel leads with the two tiers that carry one.
        headline: "Game Zone",
        photo: TV_PHOTOS.arcade,
        accent: A.arcade,
        rows: bonusTokenRows(),
        band: "Load it on the kiosk below",
      },
    ];
  }

  return [
    {
      // THE OTHER BUILDING. Racing and duckpin are both FastTrax-side products, so the
      // panel is headed by WHERE rather than by what — which is the wall's "two
      // locations" claim made concrete instead of asserted.
      headline: "At FastTrax",
      subhead: "Across the campus",
      photo: TV_PHOTOS.raceAction,
      accent: A.race,
      rows: [
        {
          name: "Racing",
          productId: "race",
          // NOT tracked, and not an oversight. The kiosk availability builder computes
          // racing's LOCK but omits its `firstOpen` on purpose — a per-tier heat line
          // was too busy for a tile and the race grid already carries heat times (owner
          // 2026-07-25). The key is declared in ExperienceFirstOpen and nothing writes
          // it, verified against the live cache. Claiming to track it would print "Ask
          // at the desk" over a track that is open all evening.
          price: dollars(RACE_START_CENTS),
          note: "Per race",
        },
        {
          name: "Duckpin",
          productId: "duck-pin",
          tracksAvailability: true,
          price: attractionPrice("duck-pin", "fasttrax", "30 Minutes"),
          note: "Per 30 min",
        },
      ],
      band: "Book it on the kiosk below",
    },
    {
      // Named for what the kiosk sells it AS, with the wall's own badge under it: the
      // same thing said two ways, and a guest has to be able to join them up.
      headline: activeVipCombo()?.name ?? "VIP Experience",
      subhead: "All Access",
      photo: TV_PHOTOS.vip,
      accent: A.vip,
      rows: [
        {
          name: price ? `${price.todayLabel} per person` : "Ask us",
          productId: "race-bowl",
          tracksAvailability: true,
          word: price ? "Tonight" : undefined,
          note: price
            ? `${price.minGuests} guests minimum · ${price.otherLabel} other days`
            : "Front desk",
        },
      ],
      band: "Buy it on the kiosk below",
    },
    bowlingPanel(bowling, "vip"),
  ];
}

/**
 * The two Game Zone card tiers that carry a BONUS, richest first.
 *
 * The bonus is the offer — every tier below $30 is simply tokens for money, which is
 * not something a wall can sell. So the panel shows what a guest GETS rather than what
 * the package is called: "$50 card" against "600 tokens", with the bonus named
 * underneath, because 600-for-500 is the reason to pick that tier over two $25s.
 *
 * Read from `TOKEN_PACKAGES`, which is the table the kiosk charges from, so a repricing
 * or a change to the bonus ladder moves the wall with it. Falls back to the plain
 * "load a card" row if the ladder ever loses its bonus tiers — better to say something
 * true and unexciting than to invent a bonus.
 */
function bonusTokenRows(): MenuRow[] {
  const withBonus = TOKEN_PACKAGES.filter((t) => t.bonusTokens > 0)
    .slice()
    .sort((a, b) => b.priceCents - a.priceCents)
    .slice(0, 2)
    // Cheapest of the two first, so the eye reads up to the better value.
    .reverse();

  if (withBonus.length === 0) {
    return [
      {
        name: "Load a card",
        // Independent of every booking vendor (Intercard), which is why Game Zone
        // stayed open through the whole 2026-08-03 outage.
        productId: "game-zone",
        word: "Any amount",
        note: "Top up without the line",
      },
    ];
  }

  return withBonus.map((t) => ({
    name: `${dollars(t.priceCents)} card`,
    productId: "game-zone",
    // The TOTAL is the headline number, not the price — a guest is choosing between
    // tiers, and what they compare is how many tokens land on the card.
    word: `${(t.tokens + t.bonusTokens).toLocaleString("en-US")} tokens`,
    note: `${t.bonusTokens} bonus tokens free`,
  }));
}

/**
 * The cheapest race on the board, in cents.
 *
 * The adult Starter race — the one a first-timer walking up to this wall can actually
 * buy — is $20.99 on every schedule, so the wall quotes it as the entry price. Read off
 * the registry rather than typed, so a repricing there moves the wall with it.
 */
const RACE_START_CENTS = 2099;

/** An attraction's price from the catalogue the booking flow charges from, as a wall
 *  label. Undefined when the product or location has no entry — a row with no price
 *  shows its word instead of a zero. */
function attractionPrice(
  slug: string,
  location: "fasttrax" | "headpinz" | "naples",
  nameContains?: string,
): string | undefined {
  const products = ATTRACTIONS[slug]?.products ?? [];
  const match = products.find(
    (p) => p.location === location && (!nameContains || p.name.includes(nameContains)),
  );
  if (!match || !(match.price > 0)) return undefined;
  return `$${match.price % 1 === 0 ? match.price : match.price.toFixed(2)}`;
}

export function menuPanelAt(
  nowMs: number,
  position: number,
  bowling: BowlingTonight | null,
): MenuPanel | null {
  return atWallPosition(menuPanels(nowMs, bowling), position);
}

/* ── the kiosk how-to ─────────────────────────────────────────────────── */

export interface HowtoPanel {
  verb: string;
  line: string;
  accent: string;
  /** The arrow band's words — see kioskBandText. */
  band: string;
}

/**
 * The band under each verb — what the guest is meant to DO with the machine below.
 *
 * "THE kiosk below", not "any kiosk below". The ad rotation says *any*, because it
 * is selling the bank; this board is one instruction per panel, and the whole point
 * is that the verb above belongs to the machine directly underneath THAT panel.
 * Losing that distinction would turn five specific instructions back into one
 * general one.
 */
function kioskBandText(verb: string): string {
  // Derived from the verb rather than typed per panel, so a new verb cannot ship
  // with a band that contradicts it.
  if (/check in/i.test(verb)) return "Check in on the kiosk below";
  if (/^book/i.test(verb)) return "Book it on the kiosk below";
  if (/^load/i.test(verb)) return "Load it on the kiosk below";
  return "Buy it on the kiosk below";
}

/**
 * ONE VERB PER PANEL, each standing over the machine it names.
 *
 * This is the strongest argument against parking the outer TVs on a permanent
 * logo: with all five participating, every kiosk in the bank gets an instruction
 * directly above it. The verbs are the five things a kiosk in this bank actually
 * does, in the order a guest is most likely to want them.
 */
export function howtoPanel(position: number): HowtoPanel | null {
  const A = WALL_ACCENT;
  const panels: HowtoPanel[] = [
    { verb: "Check in", line: "Already booked?\nScan your code.", accent: A.cyan },
    { verb: "Buy a lane", line: "Pick a time, pay,\ngo bowl.", accent: A.bowl },
    { verb: "Book a race", line: "Grab the next\nopen heat.", accent: A.race },
    { verb: "Load a card", line: "Top up without\nthe line.", accent: A.arcade },
    { verb: "Buy the\nVIP night", line: "The whole night,\none price.", accent: A.vip },
  ].map((p) => ({ ...p, band: kioskBandText(p.verb) }));
  return atWallPosition(panels, position);
}

/* ── the resting gold slide ───────────────────────────────────────────── */

/**
 * The All Access slide the ad rotation appends WHEN IT IS ON A WALL.
 *
 * Two problems, one fix. The Fort Myers kiosk catalog has FOUR slides (racing,
 * bowling, gel, Game Zone), so a five-panel wall offsetting by position would put
 * the same slide on both ends — panel 4's `(t+4) % 4` is panel 0's `t % 4`. And
 * the design's resting wall is five distinct panels with exactly ONE in gold,
 * because "gold that is always on would stop meaning All Access": it is an event,
 * earned by the showcase, the finale, and this one slide of five.
 *
 * A fifth slide fixes both at once — five panels, five distinct slides, one gold.
 * Appended only for a wall, so HPFM:1 and every other board keeps the catalog it
 * has today.
 *
 * Null when no VIP pack is on sale, which is also the right answer: the ads scene
 * then runs the four-slide catalog and accepts that the two ends match. A wall
 * that repeats a slide is a much smaller wrong than a wall advertising a price
 * for a product that is not for sale.
 */
export function wallGoldSlide(nowMs: number): {
  key: string;
  word: string;
  line: string;
  accent: string;
  photo: string;
  productKeys: string[];
} | null {
  const price = vipWallPrice(nowMs);
  if (!price) return null;
  return {
    key: "wall-all-access",
    // NeonWord renders one line, so the badge rides in the supporting copy here rather
    // than under the headline — same rule, expressed in the shape this scene has.
    word: activeVipCombo()?.name ?? "VIP Experience",
    line: `All Access — two locations, one price. ${price.fromLabel} per person.`,
    accent: WALL_ACCENT.vip,
    // The combo's own hero photograph. Deliberately NOT KIOSK_PHOTOS.vipLanes —
    // that file is a video still with "NO MATTER WHO YOU ARE" burned into it (see
    // the plan's photography note), and text inside a backdrop fights the wall's
    // own headline.
    photo: TV_PHOTOS.vip,
    // Pauses with the combo, which needs BOTH the booking rail and the lane
    // system: half an itinerary is not a product we sell.
    productKeys: ["race-bowl"],
  };
}
