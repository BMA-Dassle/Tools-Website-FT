/**
 * Build the COMPLETE metaData for a racing licence.
 *
 * WHY THIS EXISTS. The pass template binds eleven fields, and until now the two
 * issue routes each sent their own partial subset — `/r/{code}` sent six keys,
 * `/t/{id}` sent four. Every key neither of them set (validUntil, waiver,
 * lastVisit, raceLabel, nextRaceLong) was written by NO code path at all, so
 * the first real racer to add a pass would have got one with blank fields
 * where a bound `${meta.x}` had nothing to resolve. That is the same class of
 * defect that shipped a live pass reading "missing: meta.code" on 2026-08-05 —
 * a pass looks fine everywhere except on the phone.
 *
 * One builder, both routes, so they cannot drift again.
 *
 * NOTHING HERE ISSUES OR BILLS. It only assembles strings; the caller decides
 * whether to create a pass (owner rule 2026-08-05: build it only when the racer
 * actually scans).
 */
import { PANDORA_DEFAULT_LOCATION_ID } from "@/lib/pandora-locations";
import { memberQrPayload } from "~/features/racing/licence/payload";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const TZ = "America/New_York";

/** Idle value for the event field. Written EXPLICITLY rather than omitted:
 *  leaving the key out blanks the field, and a blank counts as a change, which
 *  fired a "not checking in yet" alert on every push (owner, 2026-08-05). */
export const CHECKIN_IDLE = "Not checking in yet";

/** The licence year every racer's card runs to. A constant, not a per-racer
 *  date — BMI has no per-person licence expiry to read. */
export const LICENCE_VALID_UNTIL = "Oct 31st, 2026";

export interface LicenceMetaFull extends Record<string, string> {
  code: string;
  memberName: string;
  memberQr: string;
  licenceUrl: string;
  tier: string;
  races: string;
  validUntil: string;
  waiver: string;
  lastVisit: string;
  nextRace: string;
  nextRaceLong: string;
  raceLabel: string;
  checkinStatus: string;
}

/** "Aug 5th, 2026" — US order with an ordinal day. The guests reading this are
 *  in Florida, not London (owner, 2026-08-04). */
export function ordinal(d: number): string {
  if (d % 10 === 1 && d % 100 !== 11) return `${d}st`;
  if (d % 10 === 2 && d % 100 !== 12) return `${d}nd`;
  if (d % 10 === 3 && d % 100 !== 13) return `${d}rd`;
  return `${d}th`;
}

/**
 * Does this timestamp say WHICH zone it is in?
 *
 * TWO SOURCES, TWO CONVENTIONS, AND ONLY ONE SAYS SO:
 *   Pandora `scheduledStart`  "2026-08-07T02:48:00.000Z"  absolute UTC
 *   booking `heatStart`       "2026-08-06T22:48:00"       centre-local, no marker
 *
 * `new Date()` resolves a naive string in the SERVER's zone — ET on a developer
 * laptop, UTC on Vercel. So a booking heat rendered 10:48 PM in dev and 6:48 PM
 * in production: correct everywhere we tested, wrong for every guest
 * (2026-08-06, reported by racers).
 */
function hasZone(iso: string): boolean {
  return /(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(iso.trim());
}

function parts(iso: string, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const raw = String(iso ?? "").trim();
  if (!raw) return {};

  // NAIVE = already centre-local. Read the wall clock literally and never let a
  // Date constructor guess a zone for it. The weekday is derived from the same
  // literal components anchored in UTC, so it cannot drift either.
  // Date-only counts as naive too: "2027-01-16" through `new Date()` is UTC
  // midnight, which renders as JANUARY 15th in ET — a waiver expiring a day
  // early on every pass.
  const naive = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (naive && !hasZone(raw)) {
    const [, y, mo, d, h = "0", mi = "0"] = naive;
    const anchored = new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)),
    );
    return Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts })
        .formatToParts(anchored)
        .map((p) => [p.type, p.value]),
    );
  }

  const dt = new Date(raw);
  if (isNaN(dt.getTime())) return {};
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opts }).formatToParts(dt).map((p) => [
      p.type,
      p.value,
    ]),
  );
}

/**
 * A comparable epoch for either convention — for "is this heat still ahead of
 * us?" checks, which `new Date()` gets wrong on a naive string by the whole ET
 * offset and can therefore drop a heat that has not happened yet.
 */
export function heatEpoch(iso: string | null | undefined): number {
  const raw = String(iso ?? "").trim();
  if (!raw) return NaN;
  const naive = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (naive && !hasZone(raw)) {
    const [, y, mo, d, h, mi] = naive;
    // Treat the wall clock as UTC, ask what ET calls that instant, and the gap
    // between the two IS the zone offset for that date — which handles EDT and
    // EST without a table and never consults the server's own zone.
    const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
    const et = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(asUtc))
      .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
    const etAsUtc = Date.UTC(
      Number(et.year),
      Number(et.month) - 1,
      Number(et.day),
      Number(et.hour) % 24,
      Number(et.minute),
    );
    return asUtc + (asUtc - etAsUtc);
  }
  return new Date(raw).getTime();
}

export function formatLicenceDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const p = parts(iso, { month: "short", day: "numeric", year: "numeric" });
  if (!p.month) return "";
  return `${p.month} ${ordinal(Number(p.day))}, ${p.year}`;
}

export interface HeatForPass {
  scheduledStart: string;
  track: string;
  heatNumber?: number | null;
}

/**
 * The three renderings of one heat. They must always move together — a pass
 * showing one heat's time beside another heat's number is a credential
 * contradicting itself (seen live 2026-08-05).
 *
 * `scheduledStart` is GENUINE UTC from Pandora. Do not strip the Z: doing so
 * printed "Aug 6 · 2:36 AM" for a 10:36 PM heat, wrong by the whole ET offset
 * and wrong about the day.
 */
export function formatHeat(heat: HeatForPass | null | undefined): {
  nextRace: string;
  nextRaceLong: string;
  raceLabel: string;
} {
  if (!heat?.scheduledStart) return { nextRace: "", nextRaceLong: "", raceLabel: "" };
  const p = parts(heat.scheduledStart, {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  if (!p.month) return { nextRace: "", nextRaceLong: "", raceLabel: "" };

  const time = `${p.hour}:${p.minute} ${p.dayPeriod}`;
  const track = heat.track ? ` · ${heat.track}` : "";
  const raceLabel = heat.heatNumber != null ? `Heat ${heat.heatNumber}` : "";
  return {
    nextRace: `${p.month} ${p.day} · ${time}${track}`,
    nextRaceLong: `${p.weekday}, ${p.month} ${p.day} · ${time}${track}${raceLabel ? ` · ${raceLabel}` : ""}`,
    raceLabel,
  };
}

/** Highest qualification the racer holds — the pass shows one tier, not a list. */
export function tierFrom(memberships: readonly string[] | undefined): string {
  for (const tier of ["Pro", "Intermediate", "Starter"]) {
    if (memberships?.some((n) => n.toLowerCase().includes(tier.toLowerCase()))) return tier;
  }
  return "";
}

/** Waiver + last visit, the two fields only the person record carries.
 *  Best-effort by design: a slow Pandora must never cost a racer their pass. */
async function fetchPersonFacts(
  personId: string,
): Promise<{ waiverExpiry?: string; lastVisit?: string } | null> {
  try {
    const res = await fetch(
      `${PANDORA_URL}/bmi/person/${PANDORA_DEFAULT_LOCATION_ID}/${personId}?picture=false&allRelated=false`,
      {
        headers: { Authorization: `Bearer ${process.env.SWAGGER_ADMIN_KEY || ""}` },
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      },
    );
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success || !data.data) return null;
    const p = data.data as { waiverExpiry?: string; lastVisit?: string };
    return { waiverExpiry: p.waiverExpiry, lastVisit: p.lastVisit };
  } catch {
    return null;
  }
}

export interface BuildLicenceMetaArgs {
  personId: string;
  /** The 13-char BMI tag. Becomes the barcode; without it there is no pass. */
  code: string;
  fullName: string;
  /** From the Office lookup when the caller already paid for it. */
  races?: number | string | null;
  memberships?: readonly string[];
  /** Pre-known last visit (the Office match carries it) — saves nothing on its
   *  own, but lets a caller skip the person fetch entirely. */
  lastVisit?: string | null;
  /** The racer's heat, when the caller already holds one (an e-ticket does). */
  heat?: HeatForPass | null;
  /** Skip the Pandora person round trip. */
  skipPersonFetch?: boolean;
}

/**
 * Assemble every field the template binds. Never throws — a missing optional
 * degrades to "—" rather than leaving the key absent, because an ABSENT key
 * renders as a broken-looking blank on the pass while "—" reads as "we don't
 * know".
 */
export async function buildLicenceMeta(args: BuildLicenceMetaArgs): Promise<LicenceMetaFull> {
  const facts = args.skipPersonFetch ? null : await fetchPersonFacts(args.personId);

  const waiverIso = facts?.waiverExpiry ?? null;
  const waiverOk = waiverIso ? new Date(waiverIso).getTime() > Date.now() : false;
  const lastVisitIso = facts?.lastVisit ?? null;
  const lastVisit =
    formatLicenceDate(lastVisitIso) ||
    (args.lastVisit ? String(args.lastVisit) : "") ||
    "—";

  const heat = formatHeat(args.heat);
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://headpinz.com";

  return {
    code: args.code,
    memberName: args.fullName.trim().toUpperCase(),
    // One definition, shared with the racer hub — see licence/payload.ts.
    memberQr: memberQrPayload(args.code),
    licenceUrl: `${base}/r/${args.code}`,
    tier: tierFrom(args.memberships) || "—",
    races: args.races == null || args.races === "" ? "0" : String(args.races),
    validUntil: LICENCE_VALID_UNTIL,
    waiver: waiverIso ? (waiverOk ? `Signed · ${formatLicenceDate(waiverIso)}` : "Needs signing") : "—",
    lastVisit,
    // Empty when we do not know the heat — the pre-race cron fills all three
    // within two minutes for anyone racing inside its window.
    nextRace: heat.nextRace || "None in next 2 hrs",
    nextRaceLong: heat.nextRaceLong || "—",
    raceLabel: heat.raceLabel || "—",
    checkinStatus: CHECKIN_IDLE,
  };
}
