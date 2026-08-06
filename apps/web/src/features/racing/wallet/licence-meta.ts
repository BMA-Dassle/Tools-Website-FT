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

function parts(iso: string, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return {};
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opts }).formatToParts(dt).map((p) => [
      p.type,
      p.value,
    ]),
  );
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
  const site = process.env.SMSTIM_SITE || "908";
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://headpinz.com";

  return {
    code: args.code,
    memberName: args.fullName.trim().toUpperCase(),
    // The SMS-Timing AUTHENTICATE url — the shape BMI's own register scans.
    // NOT the app's JSON-array payload, which the register rejects.
    memberQr: `https://smstim.in/${site}/authenticate/?login_code=${args.code}`,
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
