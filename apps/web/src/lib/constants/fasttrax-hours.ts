/**
 * FastTrax (Fort Myers) operating hours — ONE source of truth.
 *
 * Before this module the same four lines lived hardcoded in five places (nav,
 * footer, homepage hours pills, LocalBusiness/Restaurant JSON-LD, the /racing
 * FAQ) plus two behavioural surfaces (the live-races operating window and the
 * race opening-heats express-only rule). An hours change meant seven edits and
 * guaranteed drift.
 *
 * ── Effective dates, not a flip ──
 * Hours changes are announced ahead of time, so a plain edit would publish the
 * NEW hours during the days we still run the OLD ones — guests show up two
 * hours early or miss the last heats. Every consumer therefore asks for the
 * hours **on a specific ET calendar date**:
 *
 *   - Marketing surfaces (nav/footer/pills/JSON-LD/FAQ) ask for TODAY in ET.
 *   - The race opening-heats rule asks for the HEAT's own date, so a heat on
 *     Aug 8 keeps the 1 PM window while a heat on Aug 11 gets the 3 PM one —
 *     both correct at the same instant.
 *
 * Adding the next change = one entry in `SCHEDULE_ERAS`, nothing else.
 *
 * ── Current eras ──
 *   until 2026-08-09: Mon–Fri open 1:00 PM
 *   from  2026-08-10: Mon–Fri open 3:00 PM  (owner 2026-08-05)
 *
 * Sat/Sun (11:00 AM) and every closing time are unchanged by that move.
 *
 * NOTE: these are FASTTRAX hours. HeadPinz hours live with the HeadPinz
 * location config (`components/headpinz/Footer.tsx` HP_LOCATIONS) — different
 * building, different schedule.
 */

/** Minutes since center-local midnight for an `HH:MM` clock time. */
const at = (hour: number, minute = 0): number => hour * 60 + minute;

export interface FasttraxDayHours {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Full uppercase day name, as the nav renders it ("MONDAY"). */
  day: string;
  /** Open time, minutes since center-local midnight. */
  openMinutes: number;
  /**
   * Close time, minutes since center-local midnight. Values > 1440 mean "after
   * midnight" (Fri/Sat close at 1440 = 12:00 AM); nothing currently runs past
   * midnight, but the encoding keeps `close > open` true if that changes.
   */
  closeMinutes: number;
}

/** A contiguous period during which the weekly schedule is unchanged. */
interface ScheduleEra {
  /** First ET calendar date (`YYYY-MM-DD`) this schedule is in effect. */
  from: string;
  /** Open time Mon–Fri. */
  weekdayOpen: number;
  /** Open time Sat + Sun. */
  weekendOpen: number;
  /** Close time by weekday (0 = Sun … 6 = Sat). */
  close: Record<number, number>;
}

const CLOSE_TIMES: Record<number, number> = {
  0: at(23), // Sun 11:00 PM
  1: at(23), // Mon
  2: at(23), // Tue
  3: at(23), // Wed
  4: at(23), // Thu
  5: at(24), // Fri 12:00 AM
  6: at(24), // Sat 12:00 AM
};

/**
 * Newest era FIRST — `scheduleEraFor` returns the first entry whose `from` is
 * on or before the requested date.
 */
const SCHEDULE_ERAS: ScheduleEra[] = [
  {
    // Mon–Fri open moves 1 PM → 3 PM (owner 2026-08-05, announced for the 10th).
    from: "2026-08-10",
    weekdayOpen: at(15),
    weekendOpen: at(11),
    close: CLOSE_TIMES,
  },
  {
    from: "0000-01-01", // everything before the change
    weekdayOpen: at(13),
    weekendOpen: at(11),
    close: CLOSE_TIMES,
  },
];

/** ET calendar date the Mon–Fri 3:00 PM open takes effect (`YYYY-MM-DD`). */
export const FASTTRAX_LATE_OPEN_FROM = SCHEDULE_ERAS[0].from;

const DAY_NAMES = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

/** Today's ET calendar date as `YYYY-MM-DD` (en-CA formats ISO-style). */
export function etDateIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Today's ET weekday (0 = Sunday … 6 = Saturday). */
export function etWeekday(now: Date = new Date()): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
  }).format(now);
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(
    name,
  );
}

/** Calendar weekday (0 = Sun) of an ET date string — TZ-independent (parsed as UTC). */
export function weekdayOfIsoDate(isoDate: string): number {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return -1;
  const [, y, mo, d] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

function scheduleEraFor(isoDate: string): ScheduleEra {
  // String compare is safe: both sides are zero-padded YYYY-MM-DD.
  return SCHEDULE_ERAS.find((e) => isoDate >= e.from) ?? SCHEDULE_ERAS[SCHEDULE_ERAS.length - 1];
}

/** The full week's hours in effect on an ET calendar date, keyed 0 = Sun … 6 = Sat. */
export function fasttraxWeekHours(isoDate: string): Record<number, FasttraxDayHours> {
  const era = scheduleEraFor(isoDate);
  const week: Record<number, FasttraxDayHours> = {};
  for (let weekday = 0; weekday <= 6; weekday++) {
    week[weekday] = {
      weekday,
      day: DAY_NAMES[weekday],
      openMinutes: weekday === 0 || weekday === 6 ? era.weekendOpen : era.weekdayOpen,
      closeMinutes: era.close[weekday],
    };
  }
  return week;
}

/** Hours for one weekday, as they stand on `isoDate`. */
export function fasttraxHoursFor(weekday: number, isoDate: string): FasttraxDayHours {
  return fasttraxWeekHours(isoDate)[weekday];
}

/** Hours for the ET date `isoDate` itself (its own weekday, its own era). */
export function fasttraxHoursOnDate(isoDate: string): FasttraxDayHours | null {
  const weekday = weekdayOfIsoDate(isoDate);
  return weekday < 0 ? null : fasttraxWeekHours(isoDate)[weekday];
}

/** The week's hours as they stand right now (ET). */
export function fasttraxWeekHoursNow(now: Date = new Date()): Record<number, FasttraxDayHours> {
  return fasttraxWeekHours(etDateIso(now));
}

/** Today's hours (ET weekday + today's era). */
export function fasttraxHoursToday(now: Date = new Date()): FasttraxDayHours {
  return fasttraxWeekHoursNow(now)[etWeekday(now)];
}

// ────────────────────────────── formatting ──────────────────────────────

/** `900` → `"3:00 PM"`; `1440` → `"12:00 AM"` (midnight reads as the next day). */
export function formatHoursClock(minutes: number): string {
  const total = ((minutes % 1440) + 1440) % 1440;
  const h24 = Math.floor(total / 60);
  const mm = String(total % 60).padStart(2, "0");
  const suffix = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${mm} ${suffix}`;
}

/** `"3:00 PM – 11:00 PM"` (en dash, matching the live site). */
export function formatHoursRange(hours: FasttraxDayHours): string {
  return `${formatHoursClock(hours.openMinutes)} – ${formatHoursClock(hours.closeMinutes)}`;
}

/** `"3-11 PM"` / `"3 PM-12 AM"` — the terse form the SEO FAQ copy uses. */
export function formatHoursRangeTerse(hours: FasttraxDayHours): string {
  const open = formatHoursClock(hours.openMinutes).replace(":00", "");
  const close = formatHoursClock(hours.closeMinutes).replace(":00", "");
  const [openTime, openSuffix] = open.split(" ");
  const [closeTime, closeSuffix] = close.split(" ");
  // Drop the redundant first suffix only when both ends share it AND the range
  // stays inside one day ("3-11 PM"). An 11 AM → midnight day formats its close
  // as "12 AM", which shares the suffix but is the NEXT day: collapsing it to
  // "11-12 AM" would read as a one-hour morning window.
  const sameHalfSameDay = openSuffix === closeSuffix && hours.closeMinutes < 1440;
  return sameHalfSameDay
    ? `${openTime}-${closeTime} ${closeSuffix}`
    : `${openTime} ${openSuffix}-${closeTime} ${closeSuffix}`;
}

/** `"HH:MM"` — schema.org OpeningHoursSpecification clock format. */
export function formatHoursIso(minutes: number): string {
  const total = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// ─────────────────────────── grouping / schema ──────────────────────────

const SCHEMA_DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Monday-first display order — how the footer and JSON-LD group the week. */
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export interface HoursGroup {
  /** Weekday numbers in this group, in display order. */
  weekdays: number[];
  openMinutes: number;
  closeMinutes: number;
}

/**
 * Collapse the week into runs of consecutive days that share the same hours,
 * Monday-first (→ Mon–Thu / Fri / Sat / Sun today, and the same four groups
 * after the 3 PM move). Used by the footer, the homepage hours pills and the
 * JSON-LD opening-hours spec so all three can never disagree.
 */
export function fasttraxHoursGroups(isoDate: string): HoursGroup[] {
  const week = fasttraxWeekHours(isoDate);
  const groups: HoursGroup[] = [];
  for (const weekday of DISPLAY_ORDER) {
    const { openMinutes, closeMinutes } = week[weekday];
    const last = groups[groups.length - 1];
    if (last && last.openMinutes === openMinutes && last.closeMinutes === closeMinutes) {
      last.weekdays.push(weekday);
    } else {
      groups.push({ weekdays: [weekday], openMinutes, closeMinutes });
    }
  }
  return groups;
}

const SHORT_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** `"Mon–Thu"` for a multi-day group, `"Fri"` for a single day (en dash). */
export function formatHoursGroupLabel(group: HoursGroup): string {
  const first = SHORT_DAY_NAMES[group.weekdays[0]];
  if (group.weekdays.length === 1) return first;
  return `${first}–${SHORT_DAY_NAMES[group.weekdays[group.weekdays.length - 1]]}`;
}

/** schema.org `openingHoursSpecification` for the hours in effect on `isoDate`. */
export function fasttraxOpeningHoursSpec(isoDate: string): Array<{
  "@type": "OpeningHoursSpecification";
  dayOfWeek: string | string[];
  opens: string;
  closes: string;
}> {
  return fasttraxHoursGroups(isoDate).map((g) => {
    const days = g.weekdays.map((d) => SCHEMA_DAY_NAMES[d]);
    return {
      "@type": "OpeningHoursSpecification" as const,
      dayOfWeek: days.length === 1 ? days[0] : days,
      opens: formatHoursIso(g.openMinutes),
      closes: formatHoursIso(g.closeMinutes),
    };
  });
}
