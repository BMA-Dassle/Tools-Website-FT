/**
 * Static center-hours + date helpers for the bowling/KBF steps.
 *
 * Extracted verbatim from BowlingSlotsStep.tsx (2026-07-19) so the kiosk time
 * step and the v3 bowling steps can share them without importing a step
 * component. Pure module — no fetching, no React.
 */

import type { BookingSession } from "../state/types";
import { findOffering } from "../activities-catalog";
import { HP_LOCATIONS } from "@/lib/headpinz-locations";
import { getPublicReopenMinutes } from "@/lib/group-events";
import {
  FASTTRAX_QAMF_CENTER_ID,
  FASTTRAX_CENTER_CODE,
  fasttraxDuckpinHours,
} from "@/lib/qamf-centers";

const ACTIVITY_ICON: Record<string, string> = {
  "gel-blaster": "🔫",
  "laser-tag": "🎯",
  "duck-pin": "🎳",
  shuffly: "🎲",
};

export interface OtherActivity {
  key: string;
  label: string;
  icon: string;
  timeLabel: string;
  /** ET hour in 0-26 notation, matching the time chips (or null if unscheduled). */
  hour: number | null;
}

/** Wall-clock hour (0-26) of a race/attraction ISO. These are stored as
 *  wall-clock-in-Z notation (see RaceHeatPickerStep.parseLocal), so a naive
 *  local parse yields the intended ET hour on any browser. */
export function wallClockHour(iso: string): number {
  const h = new Date(iso.replace(/Z$/, "")).getHours();
  return h < 6 ? h + 24 : h; // post-midnight → 24-26 (matches chip notation)
}

export function wallClockLabel(iso: string): string {
  return new Date(iso.replace(/Z$/, "")).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function bowlingTimeLabel(hour: number, minute: number | null): string {
  const ampm = hour % 24 >= 12 ? "PM" : "AM";
  const hr = hour % 12 || 12;
  return `${hr}:${String(minute ?? 0).padStart(2, "0")} ${ampm}`;
}

/**
 * Other cart activities scheduled on `date`, sorted by time — so the bowling
 * time picker can show (and mark) when the customer is already booked that day.
 */
export function otherActivitiesOnDate(
  session: BookingSession,
  currentId: string,
  date: string,
): OtherActivity[] {
  const out: OtherActivity[] = [];
  for (const it of session.items) {
    if (it.id === currentId) continue;
    if (it.kind === "race") {
      const seen = new Set<string>();
      for (const h of it.heats) {
        if (!h.heatId) continue;
        const naive = h.heatId.replace(/Z$/, "");
        if (!naive.startsWith(date) || seen.has(naive)) continue;
        seen.add(naive);
        out.push({
          key: `${it.id}:${naive}`,
          label: "Racing",
          icon: "🏁",
          timeLabel: wallClockLabel(h.heatId),
          hour: wallClockHour(h.heatId),
        });
      }
    } else if (it.kind === "attraction") {
      if (it.date !== date || !it.slot) continue;
      out.push({
        key: it.id,
        label: findOffering(it.slug ?? "")?.displayName ?? "Activity",
        icon: ACTIVITY_ICON[it.slug ?? ""] ?? "📍",
        timeLabel: wallClockLabel(it.slot),
        hour: wallClockHour(it.slot),
      });
    } else if (it.kind === "racesim") {
      if (it.date !== date || !it.slot) continue;
      out.push({
        key: it.id,
        label: "Race Sims",
        icon: "🏁",
        timeLabel: wallClockLabel(it.slot),
        hour: wallClockHour(it.slot),
      });
    } else if (it.kind === "bowling" || it.kind === "kbf") {
      // bowling | kbf — ET hour lives on item.hour directly.
      if (it.date !== date || it.hour == null) continue;
      out.push({
        key: it.id,
        label: it.kind === "kbf" ? "Kids Bowl Free" : "Bowling",
        icon: "🎳",
        timeLabel: bowlingTimeLabel(it.hour, it.minute),
        hour: it.hour,
      });
    }
  }
  return out.sort((a, b) => (a.hour ?? 99) - (b.hour ?? 99));
}

export const CENTERS: Record<number, { hpSlug: string; name: string }> = {
  9172: { hpSlug: "fort-myers", name: "HeadPinz Fort Myers" },
  3148: { hpSlug: "naples", name: "HeadPinz Naples" },
  // FastTrax duckpin shares the Fort Myers building, so it reuses FM hours.
  [FASTTRAX_QAMF_CENTER_ID]: { hpSlug: "fort-myers", name: "FastTrax" },
};

/** QAMF center ID → Square center code. Single source of truth — was
 *  duplicated in the availability route, fix-open-duration, and the offer
 *  step before 2026-07-19. */
export const QAMF_TO_CENTER_CODE: Record<number, string> = {
  9172: "TXBSQN0FEKQ11",
  3148: "PPTR5G2N0QXF7",
  [FASTTRAX_QAMF_CENTER_ID]: FASTTRAX_CENTER_CODE,
};

/**
 * { open, close } hours (0-26 notation) for a QAMF center on a date.
 * Sun-Thu → hours, Fri-Sat → hoursWeekend. Fallback mirrors the
 * availability route's historical default (open 9, close 26).
 */
export function centerHoursForDate(
  centerId: number,
  dateStr: string,
): { open: number; close: number } {
  // FastTrax duckpin (11542) shares the FM complex but closes earlier — use its
  // own hours, never fort-myers' midnight/2 AM (would over-run the clamp/grid).
  if (centerId === FASTTRAX_QAMF_CENTER_ID) return fasttraxDuckpinHours(dateStr);
  const slug = CENTERS[centerId]?.hpSlug;
  const loc = slug ? HP_LOCATIONS[slug] : undefined;
  if (!loc) return { open: 9, close: 26 };
  const dow = new Date(`${dateStr}T12:00:00`).getDay();
  const isWeekend = dow === 5 || dow === 6;
  return parseHoursRange(isWeekend ? loc.hoursWeekend : loc.hours);
}

function ymdFromDate(dt: Date): string {
  return dt.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function todayYmd(): string {
  return ymdFromDate(new Date());
}

export function etNowMinutes(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    timeZone: "America/New_York",
  }).formatToParts(new Date());
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return h * 60 + m;
}

/** Today's operating date: before 2 AM on a weekend night, "today" is still
 *  yesterday's operating day (Fri/Sat close at 2 AM). */
export function effectiveToday(): string {
  const today = todayYmd();
  const nowMins = etNowMinutes();
  if (nowMins >= 120) return today;
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() - 1);
  const yesterday = ymdFromDate(d);
  const dow = new Date(`${yesterday}T12:00:00`).getDay();
  if (dow === 5 || dow === 6) return yesterday;
  return today;
}

export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + n);
  return ymdFromDate(d);
}

/**
 * How far ahead QAMF (Conqueror) sells lanes on the web — the "Book for later"
 * advance limit configured on the HeadPinz web offers at BOTH centers. Ops
 * raised it 30 → 45 days on 2026-08-24 (owner: "all should allow 45 days
 * out"); probed the same day, day 45 returns lanes and day 46 returns none.
 * Every calendar that offers a lane (bowling steps, the VIP combo's date step)
 * caps on this ONE constant, so a future change is a one-line edit — a
 * calendar that offers a later date than QAMF sells sends the guest into a
 * start-time grid where every slot "won't fit" (2026-08-24 VIP report).
 */
export const BOWLING_WEB_HORIZON_DAYS = 45;

/** Last date a lane can be booked online, inclusive (today + horizon, ET). */
export function bowlingHorizonMaxDate(today: string = todayYmd()): string {
  return addDays(today, BOWLING_WEB_HORIZON_DAYS);
}

function parseHourToken(token: string): number {
  const match = token.trim().match(/^(\d+)(AM|PM)$/i);
  if (!match) return 11;
  let h = parseInt(match[1], 10);
  const period = match[2].toUpperCase();
  if (period === "PM" && h !== 12) h += 12;
  else if (period === "AM" && h === 12) h = 24;
  else if (period === "AM" && h < 9) h += 24;
  return h;
}

export function parseHoursRange(hoursStr: string): { open: number; close: number } {
  const timePart = hoursStr.split(" ").pop() ?? "11AM-2AM";
  const dash = timePart.lastIndexOf("-");
  return {
    open: parseHourToken(timePart.slice(0, dash)),
    close: parseHourToken(timePart.slice(dash + 1)),
  };
}

/** Vendor wall-clock ISO → ET minutes-since-midnight in 0-26h notation.
 *  Race/attraction ISOs are wall-clock-in-Z; QAMF bookedAt carries an ET
 *  offset — stripping either suffix and parsing naively yields the intended
 *  ET wall time on ANY browser TZ. */
export function wallMinutes(iso: string): number | null {
  const naive = iso.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
  const d = new Date(naive);
  if (Number.isNaN(d.getTime())) return null;
  const m = d.getHours() * 60 + d.getMinutes();
  return m < 6 * 60 ? m + 24 * 60 : m;
}

/** Flat per-activity window the combo engine schedules with. */
const ASSUMED_ACTIVITY_MINUTES = 30;
const MIN_BOWLING_MINUTES = 60;

/**
 * Duration-aware cart-conflict predicate for a bowling time pick (generalized
 * from KioskBowlingTimeStep's busy/conflictOf, 2026-07-19): returns a
 * function mapping a candidate bookedAt ISO to a human label of the cart item
 * it overlaps, or null when clear. Only same-date items count. The candidate
 * occupies [start, start + durationMinutes); race heats/attraction slots
 * occupy ~30 min; other bowling items use their real duration when known.
 */
export function bowlingCartConflicts(
  session: BookingSession,
  currentId: string,
  date: string | null,
  durationMinutes: number | null,
): (bookedAtIso: string) => string | null {
  const busy: Array<{ startMin: number; endMin: number; label: string }> = [];
  for (const other of session.items) {
    if (other.id === currentId) continue;
    if (other.kind === "race") {
      const seen = new Set<string>();
      for (const h of other.heats) {
        if (!h.heatId || seen.has(h.heatId)) continue;
        seen.add(h.heatId);
        if (date && !h.heatId.replace(/Z$/, "").startsWith(date)) continue;
        const m = wallMinutes(h.heatId);
        if (m != null)
          busy.push({ startMin: m, endMin: m + ASSUMED_ACTIVITY_MINUTES, label: "You're racing" });
      }
    } else if (other.kind === "attraction" && other.slot) {
      if (date && other.date !== date) continue;
      const m = wallMinutes(other.slot);
      if (m != null)
        busy.push({ startMin: m, endMin: m + ASSUMED_ACTIVITY_MINUTES, label: "You're booked" });
    } else if ((other.kind === "bowling" || other.kind === "kbf") && other.hour != null) {
      if (date && other.date !== date) continue;
      const start = other.hour * 60 + (other.minute ?? 0);
      busy.push({
        startMin: start,
        endMin: start + (other.durationMinutes ?? MIN_BOWLING_MINUTES),
        label: "You're bowling",
      });
    }
  }
  const dur = durationMinutes ?? MIN_BOWLING_MINUTES;
  return (bookedAtIso: string) => {
    const start = wallMinutes(bookedAtIso);
    if (start == null) return null;
    const end = start + dur;
    const hit = busy.find((b) => start < b.endMin && end > b.startMin);
    return hit ? hit.label : null;
  };
}

/**
 * Bookable hours (0-26 notation) for a date — STATIC, no QAMF probe. Center
 * open→close (weekday vs weekend), minus hours already past when the date is
 * today, with the KBF Friday 5 PM cap. The package step is what checks real
 * availability for the chosen hour (and widens to next-available if it's full),
 * so the chips load instantly. (v1 parity: time chips are static operating
 * hours; availability is resolved on selection.)
 */
export function operatingHours(centerHpSlug: string, dateStr: string, isKbf: boolean): number[] {
  const dow = new Date(`${dateStr}T12:00:00`).getDay();
  const isWeekend = dow === 5 || dow === 6;
  const loc = HP_LOCATIONS[centerHpSlug];
  const range = loc
    ? parseHoursRange(isWeekend ? loc.hoursWeekend : loc.hours)
    : isWeekend
      ? { open: 11, close: 26 }
      : { open: 11, close: 24 };
  let hours = Array.from({ length: range.close - range.open }, (_, i) => i + range.open);

  // KBF Friday: cap at 5 PM (v1 parity — BowlingWizard.tsx:1430)
  if (isKbf && dow === 5) hours = hours.filter((h) => h < 17);

  // Morning-only buyout: drop hours that end before the public reopen time
  // (an hour stays if its last :45 start is at-or-after reopen). The offer step
  // further drops the pre-reopen minute starts within the boundary hour.
  const reopenMins = getPublicReopenMinutes(dateStr);
  if (reopenMins != null) hours = hours.filter((h) => h * 60 + 45 >= reopenMins);

  // For today, drop hours already passed (15-min booking lead).
  if (dateStr === todayYmd()) {
    const nm = etNowMinutes();
    hours = hours.filter((h) => h * 60 + 45 >= nm + 15);
  }
  return hours;
}
