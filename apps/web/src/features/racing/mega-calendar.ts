/**
 * WHICH CALENDAR DAYS RUN THE MEGA TRACK — one source of truth. PURE, no I/O.
 *
 * On a Mega day the barrier between Blue and Red comes out and the venue runs
 * ONE 2,108 ft circuit. That is not a cosmetic relabel: Mega is its own BMI
 * resource, its own product set, its own set of Pandora sessions. "Is this date
 * a Mega day" therefore decides what is sellable, which resources the crons and
 * the camera-assign page query, which track chips staff see, and what the
 * marketing surfaces say — and until this module existed it was answered by
 * twelve separate hardcodings of the literal Tuesday, scattered across booking,
 * kiosk, signage, admin, cron and SEO code.
 *
 * ── Windows, not a weekday ──
 * Mega ran every Tuesday and only Tuesday for years, which is why the literal
 * spread so easily. It is no longer true: Mega is added to Thursdays for the
 * Sep–Oct 2026 season (owner 2026-08-25). A season has an END, and an end date
 * that lives only in someone's head is the failure this module exists to
 * prevent — the Thursday rows below stop admitting Thursdays on 2026-11-01
 * without anyone remembering to edit anything.
 *
 * Adding or ending a Mega day = one entry in `MEGA_DAY_WINDOWS`, nothing else.
 *
 * ── Whose date decides ──
 * Every consumer asks about a SPECIFIC ET calendar date, never "now":
 *
 *   - A rule about a bookable thing asks about THAT thing's date, so a race on
 *     2026-10-29 resolves Mega while one on 2026-11-05 does not, in the same
 *     request.
 *   - Marketing/ops surfaces describing today ask `megaWindowTodayET()`.
 *   - The camera-assign surfaces pass the racing BUSINESS day (2 AM rollover),
 *     so a Mega night keeps its chips until 2 AM the next morning.
 *
 * ── This is the CALENDAR, not the live signal ──
 * Live boards must NOT guess Mega from the calendar: ops can run split tracks
 * on a Mega day, and a board stranded on an empty track is worse than one that
 * waited. They resolve mega mode through `megaLadder` in `./mega-mode`, which
 * consults the external flag, the called-heat data and BMI's dayplanner FIRST
 * and only falls through to this module when every upstream is dark.
 */
import { withinRecurringDayRule, etDay, type RecurringDayRule } from "@/lib/et-time";

/** A stretch of the calendar during which one weekday runs as a Mega day. */
export interface MegaDayWindow {
  /** `Date.getDay()` numbering — 0 Sun … 6 Sat. */
  weekday: number;
  /** The day on its own, for composed copy: "Tuesday". */
  dayName: string;
  /** Singular label: "Mega Tuesday". */
  label: string;
  /** Plural label: "Mega Tuesdays". */
  plural: string;
  /** First ET calendar date this window runs, `YYYY-MM-DD`, inclusive. */
  from: string;
  /**
   * Last ET calendar date, `YYYY-MM-DD`, inclusive. `null` = open-ended.
   *
   * REQUIRED, unlike `RecurringDayRule.until` — a limited-run Mega day whose
   * end date was merely forgotten would keep cancelling Blue and Red for every
   * matching weekday forever, so the type makes you write `null` on purpose.
   */
  until: string | null;
}

/**
 * The Mega calendar. Order does not matter — no date can match two windows
 * (they name different weekdays), and `megaWindowFor` returns the first match.
 */
export const MEGA_DAY_WINDOWS: readonly MegaDayWindow[] = [
  {
    // Mega Tuesday — the standing one. `from` reaches back past any date this
    // codebase will ever be asked about, which keeps the field required rather
    // than optional-and-forgotten.
    weekday: 2,
    dayName: "Tuesday",
    label: "Mega Tuesday",
    plural: "Mega Tuesdays",
    from: "0000-01-01",
    until: null,
  },
  {
    // Mega Thursday — added for the Sep–Oct 2026 season (owner 2026-08-25:
    // "September 3rd through end of October we're adding mega to Thursdays.
    // So that means no red or blue"). Ends itself on 2026-11-01; the last
    // Thursday inside the window is 2026-10-29.
    weekday: 4,
    dayName: "Thursday",
    label: "Mega Thursday",
    plural: "Mega Thursdays",
    from: "2026-09-03",
    until: "2026-10-31",
  },
];

function ruleFor(window: MegaDayWindow): RecurringDayRule {
  return { days: [window.weekday], from: window.from, until: window.until };
}

/**
 * The Mega window covering a date, or `null` if that date runs split tracks.
 *
 * Accepts what `scheduleForDate` accepts — a `Date`, a `YYYY-MM-DD` string, or
 * an ISO timestamp — and reads all three as a LOCAL calendar day, matching the
 * booking flow's long-standing parse. Pass `null`/`undefined` to ask about
 * today in EASTERN TIME (the walk-up case), which is a different question from
 * the server's local day and the one every "is it a Mega day right now"
 * consumer actually means.
 */
export function megaWindowFor(
  d: Date | string | null | undefined,
  now: Date = new Date(),
): MegaDayWindow | null {
  const ymd = d instanceof Date ? localYmd(d) : (d ?? null);
  return MEGA_DAY_WINDOWS.find((w) => withinRecurringDayRule(ruleFor(w), ymd, now)) ?? null;
}

/** Does this date run the Mega Track? See `megaWindowFor` for date handling. */
export function isMegaDay(d: Date | string | null | undefined, now: Date = new Date()): boolean {
  return megaWindowFor(d, now) !== null;
}

/** The Mega window for TODAY in Eastern Time, or `null` on a split-track day. */
export function megaWindowTodayET(now: Date = new Date()): MegaDayWindow | null {
  return megaWindowFor(null, now);
}

/** Is today (Eastern Time) a Mega day? */
export function isMegaDayTodayET(now: Date = new Date()): boolean {
  return megaWindowTodayET(now) !== null;
}

/**
 * Does `weekday` run as a Mega day as of `onIsoDate`?
 *
 * For surfaces that describe a WEEKDAY rather than a date — the schema.org
 * recurring event, "we run Mega on …" copy. Asking about a date keeps an
 * announced window from being published before it starts or after it ends.
 */
export function megaWindowForWeekdayOn(weekday: number, onIsoDate: string): MegaDayWindow | null {
  return (
    MEGA_DAY_WINDOWS.find(
      (w) =>
        w.weekday === weekday && onIsoDate >= w.from && (w.until == null || onIsoDate <= w.until),
    ) ?? null
  );
}

/**
 * Every Mega window in effect on `onIsoDate`, in weekday order — what the
 * venue's Mega schedule LOOKS like on that date.
 *
 * Copy reads from this rather than naming Tuesday, so a page rendered during
 * the Thursday season says so and the same page in November silently goes back
 * to saying Tuesdays. Marketing surfaces should pass today in ET; anything
 * describing a dated occurrence should pass that occurrence's date.
 */
export function megaWindowsOn(onIsoDate: string): MegaDayWindow[] {
  return MEGA_DAY_WINDOWS.filter((w) => megaWindowForWeekdayOn(w.weekday, onIsoDate) !== null).sort(
    (a, b) => a.weekday - b.weekday,
  );
}

/**
 * The Mega days in effect on `onIsoDate` as a spoken list.
 *
 *   megaDaysPhrase("2026-08-25")              → "Tuesdays"
 *   megaDaysPhrase("2026-09-03")              → "Tuesdays and Thursdays"
 *   megaDaysPhrase("2026-09-03", "singular")  → "Tuesday and Thursday"
 *
 * Both forms exist because both readings occur in copy — "Mega Track Tuesdays
 * and Thursdays" as a heading, "Every Tuesday and Thursday, we pull the
 * barriers" as a sentence — and deriving one from the other by trimming an "s"
 * is the kind of string surgery that eventually eats a letter it shouldn't.
 *
 * Empty string if no window is open, which cannot currently happen (Mega
 * Tuesday is open-ended) but is not worth crashing over.
 */
export function megaDaysPhrase(onIsoDate: string, form: "plural" | "singular" = "plural"): string {
  const names = megaWindowsOn(onIsoDate).map((w) =>
    form === "plural" ? `${w.dayName}s` : w.dayName,
  );
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The next Mega day on or after `fromIsoDate`, as `{ isoDate, window }`.
 *
 * Ask this — never "the next Tuesday" — for anything advertising a dated
 * occurrence. During the Thursday season the next Mega day is often a Thursday,
 * and a schema.org event that hardcodes Tuesday would advertise a date two days
 * later than the one guests can actually turn up for.
 *
 * Scans a bounded fortnight: the sparsest possible Mega calendar is one weekday
 * a week, so a match inside 14 days is guaranteed while any window is open.
 * Returns `null` only past the end of every window.
 */
export function nextMegaDay(
  fromIsoDate: string,
): { isoDate: string; window: MegaDayWindow } | null {
  // Noon UTC anchors the walk so adding days never trips a DST boundary, and
  // the UTC weekday of a noon-UTC instant is the calendar weekday of the date.
  const start = new Date(`${fromIsoDate}T12:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  for (let i = 0; i < 14; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const isoDate = d.toISOString().slice(0, 10);
    const window = megaWindowForWeekdayOn(d.getUTCDay(), isoDate);
    if (window) return { isoDate, window };
  }
  return null;
}

/** Today's ET calendar date, `YYYY-MM-DD` — the date marketing surfaces ask
 *  about. Re-exported so a consumer needs one import, not two. */
export function megaCalendarTodayET(now: Date = new Date()): string {
  return etDay(now).ymd;
}

/** A `Date`'s own LOCAL calendar day as `YYYY-MM-DD`. Matches how
 *  `scheduleForDate` has always read a `Date` (`d.getDay()`), so routing it
 *  through here changes no existing answer. */
function localYmd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
