/**
 * What the /book landing and the /book/nfl entry need to know about NFL Ticket,
 * resolved ONCE on the server.
 *
 * The point of this module is that "coming soon" and "bookable" are the SAME
 * switch. Race Sims could hardcode its teaser tile because sims have no booking
 * flow at all — there is nothing for the tile to disagree with. NFL does have a
 * flow, so a hardcoded tile would drift the moment someone flipped the
 * experience rows: the landing would still say Coming Soon while /book/nfl
 * happily took money, or the reverse. Both surfaces ask this instead.
 *
 * The switch is `bowling_experiences.is_active` on the two nfl-vip-* rows — one
 * UPDATE, no deploy — which is already the package's kill switch. Layered under
 * it is `nflCenterEnabled`, which fails closed for a centre with no block model
 * (Naples). A centre that cannot seat the package never advertises it, not even
 * as a teaser.
 *
 * `.server` and deliberately outside the feature barrel: it reads Neon, and a
 * client component importing the barrel must not drag the database driver into
 * the browser bundle.
 */

import { getBowlingExperiences } from "@/lib/bowling-db";
import { listNflGames } from "./espn.server";
import { nflCenterEnabled } from "./flags";
import { sellableGames, windowStartDateEt, bookedAtFor, gameLabel } from "./schedule";
import { centerHoursForDate } from "~/features/booking/service/bowling-hours";

/** What the landing tile renders. */
export interface NflTileData {
  /** Where the tile points. Null while the package is not yet bookable. */
  href: string | null;
  /** True when the tile should read "Coming Soon" and not be tappable. */
  comingSoon: boolean;
  /** "Sun, Sep 13 · Buccaneers at Bengals", or null when nothing is scheduled. */
  nextGame: string | null;
}

/** How far ahead the tile looks for something to tease. */
const TEASE_DAYS = 30;

const etToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

function addDays(dateEt: string, n: number): string {
  const d = new Date(`${dateEt}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Are the experience rows that price and sell the package active?
 *
 * Fail CLOSED on a read error. A Neon blip must not turn a Coming Soon tile
 * into a live booking link — the wrong direction of that mistake takes money
 * for a package the building is not ready to serve.
 */
export async function nflPackageSellable(centerCode: string): Promise<boolean> {
  try {
    const exps = await getBowlingExperiences(centerCode);
    return exps.some((e) => e.slug.startsWith("nfl-vip-"));
  } catch {
    return false;
  }
}

/**
 * Tile data for a landing scoped to `centerCode` (and its QAMF id), or null
 * when this centre should not show the tile at all.
 */
export async function nflTileData(args: {
  centerCode: string | null;
  qamfCenterId: number | null;
  /** `?location=` slug to carry into the entry, when the landing knows one. */
  locationParam?: string | null;
}): Promise<NflTileData | null> {
  const { centerCode, qamfCenterId, locationParam } = args;
  // No block model at this centre → the package cannot be seated there, so it
  // is not "coming soon" either. Nothing to show.
  if (!nflCenterEnabled(qamfCenterId)) return null;

  const sellable = centerCode ? await nflPackageSellable(centerCode) : false;

  let nextGame: string | null = null;
  try {
    const from = etToday();
    const games = await listNflGames(from, addDays(from, TEASE_DAYS));
    const hoursFor = (dateEt: string) => centerHoursForDate(qamfCenterId!, dateEt);
    const next = sellableGames({ games, nowMs: Date.now(), hoursForDate: hoursFor })[0];
    if (next) {
      const day = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        month: "short",
        day: "numeric",
      }).format(new Date(`${windowStartDateEt(next)}T12:00:00Z`));
      const open = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(bookedAtFor(next)));
      nextGame = `${gameLabel(next)} — ${day}, lanes open ${open}`;
    }
  } catch {
    nextGame = null; // fail soft: the tile is worth showing without a fixture
  }

  return {
    href: sellable ? `/book/nfl${locationParam ? `?location=${locationParam}` : ""}` : null,
    comingSoon: !sellable,
    nextGame,
  };
}
