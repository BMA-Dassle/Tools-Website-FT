/**
 * WHAT THE FRONT-DESK WALL SAYS — all of it, in one pure module.
 *
 * The two wall scenes (SceneVipShowcase, SceneOpenNow) are renderers: they take a
 * panel position and paint what this file hands them. Keeping the words and the
 * numbers here rather than inside the components buys two things that matter more
 * than tidiness:
 *
 *   1. THE PRICE RULE IS TESTABLE. "A displayed price must be the price the kiosk
 *      will charge" is a house rule with money behind it. Every price on this wall
 *      is read from the module the kiosk itself charges from — never re-typed,
 *      never re-derived — and wall-content.test.ts asserts that, which a JSX tree
 *      cannot.
 *   2. THE COPY CANNOT SILENTLY GO STALE. The VIP showcase is now ARTWORK, so its
 *      prices and promises live in pixels where no test can read them. `VIP_ART_CLAIMS`
 *      writes them down instead, and a test pins every one to the live pack. Reprice
 *      the combo and the build fails naming the slide to re-export — rather than the
 *      wall quietly advertising last season's price to a lobby full of people.
 *
 * PURE: no React, no I/O, no `Date.now()`. Everything time-dependent takes the
 * shared-clock `nowMs` the director already passes every scene, so all five
 * panels agree and a rebooted player rejoins mid-stride.
 */
import { activeVipCombo } from "~/features/combos/combo-specials";
import { scheduleForDate } from "~/features/booking/service/race-pricing";
import { ATTRACTIONS } from "@/lib/attractions-data";
import { TOKEN_PACKAGES } from "~/features/game-cards";
import { TV_PHOTOS, TV_WALL_FILMS, TV_WALL_VIP_ART } from "./assets";
import { atWallPosition } from "./wall";
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
 * pattern as `etHourNow` and mega-calendar's `megaCalendarTodayET`.
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
  /** e.g. "From $79" — the LOWER of the two, for a one-line quote. */
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

/**
 * A wall price split into the part that gets the big type and the part that does not.
 *
 * "$67.50" reads as a single enormous number at 170px and the cents dominate a
 * neighbouring "$45" three feet away, which makes the cheaper lane look dearer. The
 * dollars carry the size; the cents ride small and high, the way a menu board has
 * always set them. Returns `cents: null` for a whole-dollar price, and for anything
 * that is not a price at all ("Open now"), so a caller can render either without
 * asking what it was given.
 */
export function splitPrice(label: string): { main: string; cents: string | null } {
  const m = /^(\$[\d,]+)\.(\d{2})$/.exec(label.trim());
  if (!m) return { main: label, cents: null };
  return { main: m[1], cents: m[2] };
}

/* ── the VIP showcase, as artwork ─────────────────────────────────────── */

/**
 * WHAT THE ARTWORK SAYS OUT LOUD — the claims burned into the five PNGs.
 *
 * The showcase used to be drawn in code from the live pack, so a repricing moved
 * the wall by itself. It is now the owner's exported artwork (2026-09-01), which
 * is a better-looking wall and a WORSE-behaved one: `$79` and `$99` are pixels
 * now, and pixels do not follow the catalog.
 *
 * So the claims are written down here and pinned to the live pack by a test. The
 * moment the combo is repriced, renamed, re-timed or loses a leg, the build fails
 * naming what the wall is still promising — and the fix is to re-export the slide
 * and re-run `scripts/upload-tv-wall-vip-slides.mjs`, not to edit this constant
 * until it goes green.
 *
 * This is the same posture as the old copy pin, moved up a level: it can no longer
 * make the wall correct, so its whole job is to refuse to let it go quietly wrong.
 */
export const VIP_ART_CLAIMS = {
  /** Panel 4 prints these two figures, in dollars. */
  priceWeekdayCents: 7900,
  priceWeekendCents: 9900,
  /** Panel 1 prints the product name. */
  name: "VIP Experience",
  /** Panel 2 prints "3–4 HOURS" — matched against the pack's own durationLabel. */
  durationContains: "3–4",
  /** Panel 3's promises, each matched against the pack's own `includes`. */
  includes: ["1.5 Hours of VIP Bowling", "Racing License", "POV Race Video"],
  /** Panel 3 says "TWO RACES", so the pack must still carry exactly two race legs. */
  raceLegs: 2,
} as const;

export interface VipSlideArt {
  /** The transparent artwork for this panel. */
  art: string;
  /** The photograph it is laid over. */
  photo: string;
  /** What this panel says, for the accessible name — the art carries no text nodes. */
  alt: string;
  /** This panel holds the booking QR, which is rendered live rather than baked. */
  qr?: boolean;
}

/**
 * THE FIVE PANELS OF THE VIP SHOWCASE, left to right.
 *
 * ONE PICTURE, NOT FIVE SLIDES. The old showcase cycled four sub-slides on every
 * panel; this is a single composition that reads ACROSS the wall — the product is
 * named on panel 0, the sentence runs through the middle three, and panel 4 is the
 * ask. That is the thing a five-panel wall can do that five separate screens
 * cannot, and it is why the artwork is per-position and never rotates.
 *
 * THE PHOTOGRAPH IS THE POINT OF THE TRANSPARENCY. Each PNG is gold artwork on a
 * clear ground, so the venue shows through underneath; the pairing below is
 * deliberate rather than decorative — the two ends carry racing (where the night
 * starts and where it is sold), and the middle three carry the rooms the sentence
 * is talking about.
 *
 * Deliberately avoids TV_PHOTOS.vipLanes — it is a video still with "NO MATTER WHO
 * YOU ARE" burned into the frame, and burned-in words under burned-in artwork is
 * two headlines fighting.
 */
const VIP_SLIDE_ART: readonly VipSlideArt[] = [
  {
    art: TV_WALL_VIP_ART[0],
    photo: TV_PHOTOS.race,
    alt: "The VIP Experience — race next door, bowl VIP here",
  },
  {
    art: TV_WALL_VIP_ART[1],
    photo: TV_PHOTOS.arcade,
    alt: "3 to 4 hours. One price. One booking.",
  },
  {
    art: TV_WALL_VIP_ART[2],
    photo: TV_PHOTOS.redTrack,
    alt: "Two races plus 1.5 hours of VIP bowling — licence and POV video included",
  },
  {
    art: TV_WALL_VIP_ART[3],
    photo: TV_PHOTOS.bowl,
    alt: "79 dollars Monday to Thursday, 99 dollars Friday to Sunday, per person",
  },
  {
    art: TV_WALL_VIP_ART[4],
    photo: TV_PHOTOS.gel,
    alt: "Book it — scan the code, or book on the kiosk below",
    qr: true,
  },
];

/**
 * The artwork for THIS panel, or null past the end of the set.
 *
 * A wall wider than five leaves its extra panels on the bare ground rather than
 * repeating a slide: the composition is a sentence, and a repeated fragment reads
 * as a stutter.
 */
export function vipSlideArtAt(position: number): VipSlideArt | null {
  return atWallPosition(VIP_SLIDE_ART, position);
}

/**
 * Where panel 5's QR sends a phone.
 *
 * Derived from the pack's own id, so swapping the active combo moves the link
 * with it instead of quietly pointing a wall full of people at a retired product.
 * Absolute and on the HeadPinz host because a phone camera has no notion of the
 * origin the TV happens to be running on.
 */
export function vipBookingUrl(): string | null {
  const combo = activeVipCombo();
  return combo ? `https://headpinz.com/book/combo/${combo.id}/v2` : null;
}

/**
 * THE QR PLATE, in canvas pixels — measured off the artwork itself.
 *
 * Panel 5 ships with a QR already drawn into it, and that one is not ours to
 * trust: it was produced by the design tool and points wherever it pointed the day
 * it was exported. The scene paints a live code over the top, generated from
 * `vipBookingUrl()`, so the wall can never advertise a dead link.
 *
 * These bounds are the white plate in the PNG (opaque near-white, below the
 * wordmark), so the replacement lands exactly on the plate and the artwork's own
 * gold frame still surrounds it.
 */
export const VIP_QR_PLATE = { left: 677, top: 386, width: 512, height: 524 } as const;

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
  /**
   * Instead of a price, when there genuinely isn't one ("Open now", "Any amount").
   *
   * Set SMALLER than a price on purpose: it is a sentence standing in for a number,
   * and at price size it would shout down the real prices either side of it on the
   * wall. The big right-hand figure is always money — see `bonusTokenRows` for the
   * one panel that used to break that rule.
   */
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
 * ONE SUBJECT PER PANEL, AND THE SUBJECT NEVER MOVES (owner 2026-09-01).
 *
 * The board used to deal six subjects across three panels in two sets, cutting on
 * the slot boundary. That was a rotation nobody caught the whole of: a guest at the
 * desk for ninety seconds saw half the menu, and the panel they happened to look at
 * was showing something different by the time they looked back. It also left the two
 * ends out of the pricing job entirely — which is how the wall ended up with a TV
 * doing nothing while prices took turns on the ones beside it.
 *
 * There are now four priced subjects on four panels, permanently, and nothing
 * rotates. `MenuPanel` is indexed by PHYSICAL wall position, which is also what makes
 * a panel safe to drop out of the board: TV1 always shows the check-in list, and TV5
 * steps aside for a party greeting when there is one, and neither reflows the others
 * because no panel's subject depends on how many panels are participating.
 */
export interface MenuPanel {
  /** The subject. Lands whole on one panel — no word crosses a gap. */
  headline: string;
  /** A quieter line ABOVE the headline, naming the place or the offer. */
  eyebrow?: string;
  photo: string;
  accent: string;
  /**
   * At most TWO. The board is read from across a lobby now — the price is 170px
   * and a row is a third of the panel's height — so a third row would have to
   * shrink all of them back to the size that was not being noticed.
   */
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
  /**
   * The marketing reels this panel alternates between when it holds the video turn.
   *
   * Absent on a panel with nothing filmed. Present does NOT mean "playing" — see
   * `wallVideoAt`, which grants the turn to ONE panel at a time.
   */
  films?: readonly string[];
}

/** How many rows a panel may carry — see `MenuPanel.rows`. */
const MAX_ROWS = 2;

/* ── the video turn ───────────────────────────────────────────────────── */

/**
 * ONE PANEL AT A TIME, AND WHICH ONE IS DERIVED FROM THE CLOCK.
 *
 * "No more than one TV should play a video ad at the same time so have them rotate
 * through" (owner 2026-09-01). Two reasons that is the right constraint and not just a
 * taste: five reels playing at once is five simultaneous decodes on three player PCs,
 * and — the real one — a wall where everything moves has nothing for the eye to land
 * on. One moving panel among four still ones is a focal point; four is noise.
 *
 * Derived, never assigned. The turn is `floor(now / WALL_VIDEO_TURN_MS) % holders`, so
 * all five panels agree on who is playing with no message passing between them, exactly
 * as they agree on which scene is up. There is no token to hand over and nothing to
 * resynchronise after a panel reboots.
 *
 * Two minutes a turn, matching one full pricing-plus-artwork cycle, so a panel holds the
 * video for its whole stretch rather than starting one halfway through.
 */
export const WALL_VIDEO_TURN_MS = 120_000;

/** The wall positions that have anything filmed, left to right. */
const FILMED_POSITIONS = [1, 3, 4] as const;

export interface WallVideoTurn {
  /** The wall position allowed to play video right now. */
  position: number;
  /** Which of that panel's films — it advances each time the turn comes round, so a
   *  panel with two reels alternates rather than replaying the same one. */
  filmIndex: number;
}

export function wallVideoAt(nowMs: number): WallVideoTurn {
  const turn = Math.floor(nowMs / WALL_VIDEO_TURN_MS);
  const n = FILMED_POSITIONS.length;
  // `%` twice keeps a negative clock (a wildly wrong RTC) in range.
  const slot = ((turn % n) + n) % n;
  return {
    position: FILMED_POSITIONS[slot],
    // How many complete rounds have passed = how many turns THIS panel has had.
    filmIndex: Math.max(0, Math.floor(turn / n)),
  };
}

/**
 * The film this panel should be playing right now, or null.
 *
 * Null for every panel that is not holding the turn, for a panel with nothing filmed,
 * and — deliberately — for the whole wall during the VIP artwork, which the caller
 * expresses by simply not rendering this scene. The reels stop because the element is
 * unmounted, not because it is hidden: a paused-but-mounted video still holds its
 * decoder (owner: "they should stop for the VIP ad that shows on all screens").
 */
export function panelFilmAt(nowMs: number, position: number, panel: MenuPanel): string | null {
  if (!panel.films || panel.films.length === 0) return null;
  const turn = wallVideoAt(nowMs);
  if (turn.position !== position) return null;
  return panel.films[turn.filmIndex % panel.films.length] ?? null;
}

/**
 * The bowling panel: tonight's package, and the VIP tier of it underneath.
 *
 * Bowling gets ONE panel now rather than two turns in a rotation, so the two rows
 * have to be the two a guest actually chooses between — the standard package and the
 * VIP one. The plain hourly lane rate is the understudy for either, and rides only
 * when the catalog has no special to lead with, because a bare hourly rate next to a
 * package price is the pair most easily misread: one is per person for ninety
 * minutes, the other per lane.
 */
function bowlingPanel(bowling: BowlingTonight | null): MenuPanel {
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
  const lead = asRow(special?.regular ?? null, "Tonight's special");
  if (lead) rows.push(lead);
  const vip = asRow(special?.vip ?? null, "VIP lanes");
  if (vip) rows.push(vip);

  if (rows.length < MAX_ROWS) {
    const lane = asRow(bowling?.hourly?.regular ?? null, "Hourly lane");
    if (lane) rows.push({ ...lane, name: `${lane.name} lane by the hour` });
  }

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
    eyebrow: special ? "Tonight at HeadPinz" : "At HeadPinz",
    photo: TV_PHOTOS.bowl,
    accent: A.bowl,
    rows: rows.slice(0, MAX_ROWS),
    band: "Buy it on the kiosk below",
    films: TV_WALL_FILMS.bowling,
  };
}

/**
 * The five panels of the wall, INDEXED BY PHYSICAL POSITION.
 *
 * Position 0 is the VIP pack, and in practice nobody ever sees it: TV1's own
 * check-in board always has something to say, so it keeps that panel all evening.
 * It is here because a wall must degrade to something rather than to a hole — if
 * that board ever went quiet, VIP pricing is the right thing to find in its place,
 * and it is the one subject that can never be empty.
 *
 * PRICES COME FROM THE MODULES THE KIOSK CHARGES FROM — `ATTRACTIONS` for the
 * attractions, the race registry for racing, the combo's own `price` for the VIP
 * night, and the feed's bowling section for lanes. Never a second copy: a menu board
 * quoting a price the machine below it will not honour is the exact failure the
 * house pricing rule exists to prevent.
 */
export function menuPanels(nowMs: number, bowling: BowlingTonight | null): MenuPanel[] {
  const A = WALL_ACCENT;
  const price = vipWallPrice(nowMs);

  return [
    {
      // THE UNDERSTUDY (see the note above) — never reached while TV1 has a list.
      headline: activeVipCombo()?.name ?? "VIP Experience",
      eyebrow: "All Access",
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
    bowlingPanel(bowling),
    {
      // ONE TRIP, TWO ARENAS. Both Nexus attractions run from the same desk and the
      // same briefing, so they share a panel and the gel-blaster photograph rather
      // than taking two of the four.
      headline: "Gel Blasters",
      eyebrow: "One arena · two games",
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
      // PRICED, not "any amount". A pricing board with no number on it is the one
      // panel a guest scans past (owner 2026-08-19). The token packages have real
      // prices AND real bonuses, and the bonus is the offer, so the panel leads with
      // the two tiers that carry one.
      headline: "Game Zone",
      eyebrow: "Hundreds of games",
      photo: TV_PHOTOS.arcade,
      accent: A.arcade,
      rows: bonusTokenRows(),
      band: "Load it on the kiosk below",
      films: TV_WALL_FILMS.gameZone,
    },
    {
      // THE OTHER BUILDING. Racing and duckpin are both FastTrax-side products, so the
      // panel is headed by WHERE rather than by what — which is the wall's "two
      // locations" claim made concrete instead of asserted.
      headline: "At FastTrax",
      eyebrow: "Across the campus",
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
      films: TV_WALL_FILMS.fastTrax,
    },
  ];
}

/**
 * The two Game Zone card tiers that carry a BONUS, richest first.
 *
 * The bonus is the offer — every tier below $30 is simply tokens for money, which is
 * not something a wall can sell. So only the tiers carrying one appear.
 *
 * THE BIG NUMBER ON THE RIGHT IS ALWAYS MONEY (owner 2026-09-01, looking at the live
 * panel: "Game zone needs to follow standard. Pricing on right, tokens on left"). This
 * row used to lead with the token TOTAL in the price position, on the reasoning that a
 * guest compares tokens rather than dollars — which made Game Zone the one panel on the
 * wall where the huge right-hand figure was not a price. Across five panels read from
 * thirty feet, consistency of POSITION beats a better argument about any single panel:
 * "600" where "$45" sits on the next screen is read as a price before it is read as
 * anything else. So the tokens are the row's name and the price is the figure.
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
    .slice(0, MAX_ROWS)
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
    name: `${(t.tokens + t.bonusTokens).toLocaleString("en-US")} tokens`,
    productId: "game-zone",
    price: dollars(t.priceCents),
    note: `Includes ${t.bonusTokens} bonus tokens`,
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
