/**
 * Christmas in July — waiver recon (READ ONLY).
 *
 * Answers, before we touch anything:
 *   1. Who RSVP'd for the Fort Myers (racing) event?
 *   2. Which of them have a BMI personId?
 *   3. What does BMI actually say about their waiver right now (waiverExpiry)?
 *   4. Any minors (guardian must sign in person — never backfilled)?
 *   5. Is there an existing waiver_acceptances audit row for them?
 *
 * Usage (from apps/web):
 *   npx tsx scripts/xmas-waiver-recon.mts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const SLUG = "xmas-in-july";
const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";

const redis = (await import("@/lib/redis")).default;
const { resolvePandoraLocation } = await import("@/lib/pandora-locations");
const { getGroupEvent } = await import("@/lib/group-events");
const { sql, isDbConfigured } = await import("@/lib/db");

interface Rsvp {
  name: string;
  email: string;
  freeflow?: string[];
  reservations?: { type: string; track?: string; time?: string; billId?: string }[];
  personId?: string;
  location?: string;
  company?: string;
  guests?: number;
  phone?: string;
  confirmedAt?: string;
  updatedAt?: string;
}

const event = getGroupEvent(SLUG);
const locationID = resolvePandoraLocation(event?.pandoraLocation ?? "headpinz");
console.log(`event=${SLUG} pandoraLocation=${event?.pandoraLocation} → locationID=${locationID}`);

const emails: string[] = await redis.smembers(`groupevent:${SLUG}:rsvp-index`);
console.log(`rsvp-index: ${emails.length} emails\n`);

const rsvps: Rsvp[] = [];
for (const e of emails) {
  const raw = await redis.get(`groupevent:${SLUG}:rsvp:${e.toLowerCase()}`);
  if (raw) rsvps.push(JSON.parse(raw) as Rsvp);
}

const byLocation = new Map<string, number>();
for (const r of rsvps) byLocation.set(r.location || "(none)", (byLocation.get(r.location || "(none)") || 0) + 1);
console.log("RSVPs by location:", Object.fromEntries(byLocation));

const withRacing = rsvps.filter((r) => (r.reservations || []).some((x) => x.type === "racing"));
const withPerson = rsvps.filter((r) => r.personId);
console.log(`total RSVP records: ${rsvps.length}`);
console.log(`  with a racing reservation: ${withRacing.length}`);
console.log(`  with a BMI personId:       ${withPerson.length}`);
console.log(
  `  racing but NO personId:    ${withRacing.filter((r) => !r.personId).length}  ← cannot backfill\n`,
);

/** Read BMI person: waiverExpiry + birthdate (minor check). */
async function person(personId: string) {
  const res = await fetch(
    `${PANDORA_URL}/bmi/person/${locationID}/${personId}?picture=false&allRelated=false`,
    { headers: { Authorization: `Bearer ${API_KEY}` }, cache: "no-store" },
  );
  if (!res.ok) return { error: `HTTP ${res.status}` } as const;
  const d = await res.json();
  const p = d?.data ?? {};
  return {
    waiverExpiry: p.waiverExpiry ? String(p.waiverExpiry) : null,
    birthdate: p.birthdate ? String(p.birthdate) : null,
    firstName: p.firstName ?? "",
    lastName: p.lastName ?? "",
  } as const;
}

const ageOf = (bd: string | null) => {
  if (!bd) return null;
  const t = new Date(bd).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / (365.25 * 864e5));
};

// Audit rows already on file for this event.
const audited = new Set<string>();
if (isDbConfigured()) {
  try {
    const q = sql();
    const rows = (await q`
      SELECT person_id, method, ts FROM waiver_acceptances WHERE event_slug = ${SLUG}
    `) as { person_id: string }[];
    for (const r of rows) audited.add(String(r.person_id));
    console.log(`waiver_acceptances rows for ${SLUG}: ${rows.length}\n`);
  } catch (e) {
    console.log(`waiver_acceptances read failed: ${e instanceof Error ? e.message : e}\n`);
  }
}

const candidates = rsvps.filter((r) => r.personId);
const now = Date.now();
const buckets = { valid: [] as string[], expired: [] as string[], none: [] as string[], error: [] as string[], minor: [] as string[] };

console.log("personId    | waiverExpiry         | age | racing | audit | name / email");
console.log("------------|----------------------|-----|--------|-------|--------------------------");
for (const r of candidates) {
  const p = await person(r.personId!);
  const racing = (r.reservations || []).some((x) => x.type === "racing") ? "yes" : "no";
  const audit = audited.has(String(r.personId)) ? "yes" : "-";
  if ("error" in p) {
    buckets.error.push(`${r.personId} ${r.email} (${p.error})`);
    console.log(`${String(r.personId).padEnd(11)} | ${"ERROR".padEnd(20)} | ??? | ${racing.padEnd(6)} | ${audit.padEnd(5)} | ${r.name} <${r.email}>`);
    continue;
  }
  const age = ageOf(p.birthdate);
  const exp = p.waiverExpiry ? new Date(p.waiverExpiry).getTime() : 0;
  const state = !p.waiverExpiry ? "none" : exp > now ? "valid" : "expired";
  const line = `${r.personId} ${r.name} <${r.email}> racing=${racing}`;
  if (age !== null && age < 18) buckets.minor.push(line);
  buckets[state as "valid" | "expired" | "none"].push(line);
  console.log(
    `${String(r.personId).padEnd(11)} | ${(p.waiverExpiry ?? "—").slice(0, 20).padEnd(20)} | ${String(age ?? "?").padEnd(3)} | ${racing.padEnd(6)} | ${audit.padEnd(5)} | ${r.name} <${r.email}>`,
  );
}

console.log("\n── SUMMARY ─────────────────────────────");
console.log(`valid waiver on file : ${buckets.valid.length}`);
console.log(`EXPIRED waiver       : ${buckets.expired.length}`);
console.log(`NO waiver at all     : ${buckets.none.length}`);
console.log(`person read errors   : ${buckets.error.length}`);
console.log(`minors (<18)         : ${buckets.minor.length}  ← guardian signs in person, NEVER backfill`);
if (buckets.minor.length) console.log(buckets.minor.map((l) => `   ${l}`).join("\n"));
if (buckets.error.length) console.log("\nerrors:\n" + buckets.error.map((l) => `   ${l}`).join("\n"));

process.exit(0);
