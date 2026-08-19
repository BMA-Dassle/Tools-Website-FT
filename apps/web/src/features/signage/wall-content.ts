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
import { TV_PHOTOS } from "./assets";
import { atWallPosition, chunkAcrossWall } from "./wall";

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

/** Cents → a wall-sized price. Whole dollars drop the ".00": at 165px a trailing
 *  zero-zero is two characters of nothing, and every combo tier is whole anyway. */
export function dollars(cents: number): string {
  const whole = cents % 100 === 0;
  return whole ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/* ── the identity rail ────────────────────────────────────────────────── */

export interface RailCell {
  text: string;
  /** Render this cell as the product NAME — bigger, in hero gold. */
  isName?: boolean;
  /** Render as the price: gold figure, quiet "per person". */
  isPrice?: boolean;
  /** Trailing "per person"-style qualifier, set only with `isPrice`. */
  quiet?: string;
  /** A gold glyph inside the cell (the "+" joining the brands, the ▼). */
  glyph?: string;
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
export function identityRail(position: number, price: VipWallPrice | null): RailCell | null {
  const combo = activeVipCombo();
  const cells: RailCell[] = [
    { text: "All Access", isName: true },
    { text: combo?.name ?? "VIP Experience" },
    { text: "FastTrax HeadPinz", glyph: "+" },
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
}

export type WallPanel = PosterPanel | CardPanel;

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
        { layout: "poster", smallBrand: "fasttrax", word: "One VIP\nexperience", accent: A.vip },
        { layout: "poster", bigBrand: true, accent: A.vip },
      ];
      return atWallPosition(panels, position);
    }
    case 1: {
      // THE NIGHT — the three legs of the itinerary, in order, each on its own
      // panel between the duration and the promise. The wall opens and closes on
      // "one booking" on purpose: it is the thing that makes three legs a product.
      const panels: CardPanel[] = [
        {
          layout: "card",
          eyebrow: "Your VIP night",
          word: "3–4\nhours",
          line: "One booking",
          accent: A.vip,
        },
        {
          layout: "card",
          eyebrow: "Leg one",
          word: "Starter\nrace",
          line: "Licence included",
          accent: A.starter,
        },
        {
          layout: "card",
          eyebrow: "Leg two",
          word: "1.5 hrs\nVIP bowling",
          line: "Semi-private suite",
          accent: A.bowl,
        },
        {
          layout: "card",
          eyebrow: "Leg three",
          word: "Intermediate\nrace",
          line: "Come back faster",
          accent: A.race,
        },
        {
          layout: "card",
          eyebrow: "And",
          word: "One\nbooking",
          line: "We schedule the rest",
          accent: A.vip,
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
          eyebrow: "All Access includes",
          word: "Racing\nlicence",
          line: "Yours to keep",
          accent: A.starter,
        },
        {
          layout: "card",
          eyebrow: "All Access includes",
          word: "POV race\nvideo",
          line: "Every lap, from the seat",
          accent: A.race,
        },
        {
          layout: "card",
          eyebrow: "All Access includes",
          word: "NeoVerse\nVIP lane",
          line: "Video wall, chips & salsa",
          accent: A.bowl,
        },
        {
          layout: "card",
          eyebrow: "All Access includes",
          word: "$10 Game\nZone card",
          line: "Per person",
          accent: A.arcade,
        },
        {
          layout: "card",
          eyebrow: "All Access includes",
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
        { layout: "poster", word: "All\nAccess", accent: A.vip },
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

export interface MenuTile {
  /** Staff/guest-facing attraction name. */
  name: string;
  accent: string;
  /**
   * The product id this tile sells, matched against the feed's
   * `pausedProductIds` and its `nextAvailable` map. THE SAME VOCABULARY the
   * maintenance registry and the kiosk availability payload speak
   * (features/maintenance/vendors.ts) — a tile keyed on a name that is not in
   * that registry silently never pauses, which is worse than not gating at all
   * because it looks gated.
   */
  productId: string;
  /** A price, when there is a real static one. */
  price?: string;
  /** Instead of a price, when there isn't one — see the bowling note below. */
  word?: string;
  /** The quiet second line, e.g. "per hour". */
  note?: string;
  /**
   * Does this product HAVE a bookable-slot signal in the availability cache?
   *
   * Load-bearing for honesty, not for layout. The feed hands the wall only the
   * times, and it deliberately omits a product the cache has marked unavailable —
   * so "no time for this product" is ambiguous between "the cache is cold",
   * "nothing left to book today" and "this product has no slots to begin with".
   *
   * With this flag the board can tell them apart: a tile that TRACKS availability
   * and has no time while the cache is warm says so, instead of claiming "Open"
   * for something the kiosk below will refuse. A tile that does not track it (a
   * game card, a birthday enquiry) is open whenever the building is.
   */
  tracksAvailability?: boolean;
}

/**
 * The ten tiles, in wall reading order.
 *
 * PRICES COME FROM THE MODULES THE KIOSK CHARGES FROM. `ATTRACTIONS` for the
 * attractions, `RACE_START_PRICE` from the race registry, the combo's own
 * `price` for All Access. Never a second copy — a menu board quoting a price the
 * machine below it will not honour is the exact failure the pricing rule exists
 * to prevent.
 *
 * BOWLING SHOWS AVAILABILITY, NOT A PRICE. Lane pricing is dynamic through QAMF
 * and the static catalogue carries `price: 0`; inventing a lane price would be
 * that same mismatch, deliberately committed. Game Zone is the same shape for a
 * different reason — a game card is loaded with whatever the guest chooses.
 */
export function menuTiles(nowMs: number): MenuTile[] {
  const A = WALL_ACCENT;
  const price = vipWallPrice(nowMs);
  const tiles: MenuTile[] = [
    {
      name: "Bowling",
      accent: A.bowl,
      productId: "bowling",
      tracksAvailability: true,
      // No price: QAMF-dynamic. See the note above.
      word: "Lanes open",
      // The catalogue's own duration label, not a price — and deliberately not
      // "ask at the desk", which the status line already says when there is no
      // bookable slot left. Two lines telling a guest the same thing wastes the
      // one line that could have told them something else.
      note: ATTRACTIONS.bowling?.durationLabel ?? "1–2 hours",
    },
    {
      name: "Laser Tag",
      accent: A.laser,
      productId: "laser-tag",
      tracksAvailability: true,
      price: attractionPrice("laser-tag", "headpinz"),
      note: "Per session",
    },
    {
      name: "Gel Blasters",
      accent: A.gel,
      productId: "gel-blaster",
      tracksAvailability: true,
      price: attractionPrice("gel-blaster", "headpinz"),
      note: "Per session",
    },
    {
      name: "Shuffly",
      accent: A.arcade,
      productId: "shuffly-headpinz",
      tracksAvailability: true,
      price: attractionPrice("shuffly", "headpinz", "1 Hour"),
      note: "Per hour",
    },
    {
      name: "Racing",
      accent: A.race,
      productId: "race",
      tracksAvailability: true,
      price: dollars(RACE_START_CENTS),
      note: "Per race",
    },
    {
      name: "Game Zone",
      accent: A.arcade,
      productId: "game-zone",
      // A card is loaded with whatever the guest chooses — there is no price.
      word: "Load a card",
      note: "At any kiosk",
    },
    {
      name: "Duckpin",
      accent: A.duck,
      productId: "duck-pin",
      tracksAvailability: true,
      price: attractionPrice("duck-pin", "fasttrax", "30 Minutes"),
      note: "Per 30 min",
    },
    {
      name: "Kids Bowl Free",
      accent: A.gel,
      productId: "kbf",
      tracksAvailability: true,
      word: "Mon–Fri",
      note: "Register free",
    },
    {
      name: "All Access",
      accent: A.vip,
      productId: "race-bowl",
      tracksAvailability: true,
      price: price?.todayLabel,
      word: price ? undefined : "Ask us",
      note: "Per person, tonight",
    },
    {
      name: "Birthdays",
      accent: A.cyan,
      // Deliberately unclassified in the maintenance registry, so it never
      // pauses: a birthday enquiry is a conversation at the desk, not a vendor
      // booking, and it stays sellable through any outage.
      productId: "birthday-party",
      word: "Ask us",
      note: "Front desk",
    },
  ];
  return tiles;
}

/**
 * This panel's share of the menu board — a CONTIGUOUS run, so the pairings the
 * list was written with survive: the two headline attractions open the wall and
 * All Access lands at the far end beside the HeadPinz mark. Ten tiles over five
 * panels is two each, and no two panels ever repeat a tile.
 */
export function menuTilesFor(nowMs: number, position: number, count: number): MenuTile[] {
  return chunkAcrossWall(menuTiles(nowMs), position, count);
}

/**
 * The cheapest race on the board, in cents.
 *
 * The adult Starter race — the one a first-timer walking up to this wall can
 * actually buy — is $20.99 on every schedule, so the wall quotes it as the entry
 * price. Read off the registry rather than typed, so a repricing there moves the
 * wall with it.
 */
const RACE_START_CENTS = 2099;

/** An attraction's price from the catalogue the booking flow charges from, as a
 *  wall label. Undefined when the product or location has no entry — a tile with
 *  no price shows its word instead of a zero. */
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

/* ── the kiosk how-to ─────────────────────────────────────────────────── */

export interface HowtoPanel {
  verb: string;
  line: string;
  accent: string;
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
  ];
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
    word: "All Access",
    line: `Two locations, one price. ${price.fromLabel} per person.`,
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
