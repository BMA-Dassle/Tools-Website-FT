/**
 * Pure formatters for the admin reservations board.
 * Extracted verbatim from app/admin/[token]/reservations/ReservationsClient.tsx.
 */
import { CENTERS, CENTER_LABELS_BY_SLUG, DAYOF_SOURCE_LABELS } from "./constants";

export function dayofSourceLabel(source: string): string {
  return DAYOF_SOURCE_LABELS[source] ?? source.toUpperCase();
}

/** Resolve a center label whether the row stored a Square location ID or a slug. */
export function centerLabel(code: string): string {
  return CENTERS[code] ?? CENTER_LABELS_BY_SLUG[code] ?? code;
}

/** Compact center tag: HPN (HeadPinz Naples), HPFM (HeadPinz Fort Myers), FT (FastTrax). */
export function centerShortOf(code: string): string {
  const label = centerLabel(code);
  if (label === "Naples") return "HPN";
  if (label === "FastTrax") return "FT";
  return "HPFM";
}

export function todayET(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}

/**
 * Schedule times arrive in two shapes: bowling `booked_at` is offset-aware
 * (…Z / …-04:00); race `heatId`s are NAIVE ET wall-clock (`…T20:30:00`, no
 * zone — see booking state types). Format both as the ET wall-clock time the
 * guest actually experiences, independent of the viewer's browser timezone.
 */
export function fmtClock(iso: string): string {
  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso);
  if (hasZone) return fmtTime(iso);
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  let h = Number(m[1]);
  const mer = h < 12 ? "AM" : "PM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${mer}`;
}

/** Comparable ET wall-clock ms for either shape — so a naive heatId and an
 *  offset-aware bowling slot sort correctly regardless of browser timezone. */
export function etWallMs(iso: string): number {
  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso);
  if (!hasZone) return Date.parse(iso + "Z");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hh = g("hour") === "24" ? "00" : g("hour");
  return Date.parse(`${g("year")}-${g("month")}-${g("day")}T${hh}:${g("minute")}:${g("second")}Z`);
}

/** "Now" in the same ET-wall-clock-ms frame as etWallMs, so a naive heatId
 *  compares against the current moment correctly in any browser timezone. */
export function nowEtWallMs(): number {
  return etWallMs(new Date().toISOString());
}

/** Compact duration: 42 → "42m", 95 → "1h 35m". */
export function fmtDurShort(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? `${h}h ${r ? `${r}m` : ""}`.trim() : `${r}m`;
}

export function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** "1234-5678-9012-3456" display for a gift-card GAN. */
export function ganDisplay(gan: string): string {
  return gan.replace(/(.{4})(?=.)/g, "$1-");
}
