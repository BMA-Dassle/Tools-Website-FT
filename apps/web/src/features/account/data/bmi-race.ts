/**
 * BMI / Pandora race-account reads for the customer dashboard.
 *
 * PRECISION: BMI personIds are 17-digit bigints that exceed
 * Number.MAX_SAFE_INTEGER. Every body that carries one is read via
 * `res.text()` + `parseWithRawIds` so the id survives as a full string — never
 * `res.json()` / `Number()` (that rounds it and looks up the WRONG person).
 *
 * RESOLUTION: phone → personId is resolved lazily here (not stored in the
 * session: login stays fast, and a phone can map to several family members).
 * The resolved personId is cached in Redis for the session window so dashboard
 * refreshes don't re-hit the slow Office search. The cache is keyed by a hash of
 * the verified contact — it is a cache, never an identity/authorization record.
 */
import { createHash } from "crypto";
import { parseWithRawIds } from "@ft/db";
import { officeGet, BMI_CLIENT_KEY } from "@/lib/bmi-office-client";
import { PANDORA_LOCATION_MAP, PANDORA_DEFAULT_LOCATION_ID } from "@/lib/pandora-locations";
import redis from "@/lib/redis";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const PERSON_CACHE_TTL_SEC = 1800; // ~ account session idle window

export interface BmiPersonCandidate {
  personId: string;
  firstName: string;
  lastName: string;
}

export interface BmiPersonResolution {
  /** The chosen person when unambiguous. */
  person: BmiPersonCandidate | null;
  /** True when >1 person matched the phone — UI must show a picker, never guess. */
  ambiguous: boolean;
  candidates: BmiPersonCandidate[];
}

export interface PandoraWaiver {
  personId: string;
  firstName: string;
  lastName: string;
  waiverValid: boolean;
  waiverExpiry: string | null;
  lastVisit: string | null;
}

export interface RaceCredits {
  totalBalance: number;
  items: Array<{ kind: string; balance: number }>;
}

function last10(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * Pull a person array out of whatever envelope the Office search returns
 * (observed shapes vary: bare array, {results}, {persons}, {data}).
 */
function extractPersons(parsed: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
  const o = (parsed ?? {}) as Record<string, unknown>;
  for (const key of ["results", "persons", "people", "data", "items"]) {
    if (Array.isArray(o[key])) return o[key] as Array<Record<string, unknown>>;
  }
  return [];
}

function toCandidate(p: Record<string, unknown>): BmiPersonCandidate {
  const personId = str(p.personId ?? p.personID ?? p.id);
  return {
    personId,
    firstName: str(p.firstName ?? p.firstname ?? p.givenName),
    lastName: str(p.lastName ?? p.lastname ?? p.familyName),
  };
}

function personPhones(p: Record<string, unknown>): string[] {
  return [p.phoneNumber, p.phone, p.mobile, p.cellPhone, p.homePhone]
    .map((v) => (typeof v === "string" ? last10(v) : ""))
    .filter((d) => d.length === 10);
}

/**
 * Search the Office API by phone and resolve to a single personId when possible.
 * Disambiguation: keep only candidates whose phone exactly matches (last-10);
 * if exactly one survives, it's the person; if several, return them as
 * `candidates` with `ambiguous: true`. A digit-only personId is required (drops
 * malformed rows that would corrupt downstream calls).
 */
export async function searchBmiPersonByPhone(e164: string): Promise<BmiPersonResolution> {
  const empty: BmiPersonResolution = { person: null, ambiguous: false, candidates: [] };
  const digits = last10(e164);
  if (digits.length !== 10) return empty;

  const path = `/api/${BMI_CLIENT_KEY}/search/person?token=${encodeURIComponent(digits)}&maxResults=20`;
  const res = await officeGet(path);
  if (res.status >= 400) throw new Error(`Office person search failed: ${res.status}`);

  const parsed = parseWithRawIds(res.body);
  const rows = extractPersons(parsed);
  const phoneExact = rows.filter((p) => personPhones(p).includes(digits));
  // Prefer exact-phone matches; fall back to the raw result set if the search
  // matched on something else (e.g. a formatted phone we didn't normalize).
  const pool = phoneExact.length ? phoneExact : rows;
  const candidates = pool.map(toCandidate).filter((c) => /^\d+$/.test(c.personId));

  if (candidates.length === 0) return empty;
  if (candidates.length === 1) return { person: candidates[0], ambiguous: false, candidates };
  return { person: null, ambiguous: true, candidates };
}

/** Resolve+cache the personId for a verified contact (cache, not identity). */
export async function resolveBmiPerson(
  contact: string,
  e164: string,
): Promise<BmiPersonResolution> {
  const key = `acct:bmiperson:${createHash("sha256").update(contact).digest("hex").slice(0, 32)}`;
  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as BmiPersonResolution;
  } catch {
    /* cache miss / redis hiccup → resolve live */
  }
  const resolution = await searchBmiPersonByPhone(e164);
  // Cache only a definitive single-person resolution; re-resolve ambiguous/empty
  // so a later data fix surfaces without waiting out the TTL.
  if (resolution.person) {
    try {
      await redis.set(key, JSON.stringify(resolution), "EX", PERSON_CACHE_TTL_SEC);
    } catch {
      /* best-effort cache */
    }
  }
  return resolution;
}

/** Waiver status + names for a personId (Pandora). */
export async function getPandoraWaiver(
  personId: string,
  locationKey = "headpinz",
): Promise<PandoraWaiver | null> {
  const apiKey = process.env.SWAGGER_ADMIN_KEY || "";
  const locationId = PANDORA_LOCATION_MAP[locationKey] || PANDORA_DEFAULT_LOCATION_ID;
  const res = await fetch(
    `${PANDORA_URL}/bmi/person/${locationId}/${personId}?picture=false&allRelated=false`,
    { headers: { Authorization: `Bearer ${apiKey}` }, cache: "no-store" },
  );
  const data = parseWithRawIds<{ success?: boolean; data?: Record<string, unknown> }>(
    await res.text(),
  );
  if (!res.ok || !data.success || !data.data) return null;
  const person = data.data;
  const expiryRaw = person.waiverExpiry ? str(person.waiverExpiry) : null;
  const waiverValid = expiryRaw ? new Date(expiryRaw) > new Date() : false;
  return {
    personId,
    firstName: str(person.firstName),
    lastName: str(person.lastName),
    waiverValid,
    waiverExpiry: expiryRaw,
    lastVisit: person.lastVisit ? str(person.lastVisit) : null,
  };
}

/** Redeemable race credits/deposits for a personId (Office deposit history). */
export async function getRaceCredits(personId: string): Promise<RaceCredits> {
  const now = new Date();
  const from = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate())
    .toISOString()
    .split(".")[0];
  const until = now.toISOString().split(".")[0];
  const path = `/api/${BMI_CLIENT_KEY}/deposit/history?personId=${personId}&from=${encodeURIComponent(from)}&until=${encodeURIComponent(until)}`;
  const res = await officeGet(path);
  if (res.status >= 400) throw new Error(`Office deposit history failed: ${res.status}`);

  const parsed = parseWithRawIds(res.body);
  const rows = extractPersons(parsed); // same envelope-unwrapping logic
  const items = rows
    .map((r) => ({
      kind: str(r.depositKind ?? r.kind ?? r.name) || "Credit",
      balance: typeof r.balance === "number" ? r.balance : Number(r.balance) || 0,
    }))
    .filter((i) => i.balance > 0);
  const totalBalance = items.reduce((sum, i) => sum + i.balance, 0);
  return { totalBalance, items };
}
