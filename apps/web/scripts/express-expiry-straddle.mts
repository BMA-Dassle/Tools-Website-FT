/**
 * Does a waiver that LAPSES BETWEEN BOOKING AND RACE DAY explain the false
 * express lane? (W53940 / Adam Houghtaling, 7/28.)
 *
 * The retro question is unanswerable directly — Pandora returns
 * `waiverExpiry: null` once a waiver is no longer valid, so a lapsed date is
 * unreadable after the fact. But the mechanism is testable going FORWARD:
 * for every express reservation whose race is still in the future, the racers'
 * waivers are valid NOW (so their expiry dates ARE readable). Any reservation
 * whose waiver expires BEFORE its own race date is the same bug, already
 * baked in and waiting to happen.
 *
 * Finding even one proves the trigger: express is computed at booking time and
 * never re-verified, so a waiver expiring in the gap leaves the front desk a
 * memo that says "all waivers valid" on a day when they aren't.
 *
 * Usage (from apps/web):  npx tsx scripts/express-expiry-straddle.mts
 * NO WRITES.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const PKEY = process.env.SWAGGER_ADMIN_KEY || "";
const LOC = "TXBSQN0FEKQ11";
const TODAY = new Date().toISOString().slice(0, 10);

const { default: redis } = await import("@/lib/redis");

interface Rec {
  fastLane?: boolean;
  date?: string | null;
  createdAt?: string;
  reservationNumber?: string;
  contact?: { firstName?: string; lastName?: string };
  racers?: Array<{ racerName?: string; personId?: string | null }>;
}

const keys: string[] = [];
let cursor = "0";
do {
  const [next, batch] = (await redis.scan(cursor, "MATCH", "bookingrecord:*", "COUNT", 500)) as [
    string,
    string[],
  ];
  cursor = next;
  for (const k of batch) if (/^bookingrecord:\d+$/.test(k)) keys.push(k);
} while (cursor !== "0");

const expiryCache = new Map<string, string | null>();
async function expiryOf(personId: string): Promise<string | null> {
  if (expiryCache.has(personId)) return expiryCache.get(personId)!;
  let exp: string | null = null;
  try {
    const res = await fetch(
      `${PANDORA_URL}/bmi/person/${LOC}/${personId}?picture=false&allRelated=false`,
      { headers: { Authorization: `Bearer ${PKEY}` } },
    );
    const d = (await res.json()) as { success?: boolean; data?: { waiverExpiry?: string | null } };
    if (res.ok && d?.success) exp = d.data?.waiverExpiry ?? null;
  } catch {
    /* unreadable — treated as unknown below */
  }
  expiryCache.set(personId, exp);
  return exp;
}

console.log(`\nExpress reservations with a race still ahead of ${TODAY}\n${"─".repeat(86)}`);

let future = 0;
let straddles = 0;
let leadSum = 0;
let leadN = 0;
const rows: string[] = [];

for (const key of keys) {
  const raw = await redis.get(key).catch(() => null);
  if (!raw) continue;
  let rec: Rec;
  try {
    rec = JSON.parse(raw) as Rec;
  } catch {
    continue;
  }
  if (rec.fastLane !== true) continue;
  const date = rec.date ?? "";
  if (!date || date <= TODAY) continue;
  future++;

  if (rec.createdAt) {
    const lead = (new Date(`${date}T12:00:00Z`).getTime() - new Date(rec.createdAt).getTime()) / 86_400_000;
    if (lead >= 0) {
      leadSum += lead;
      leadN++;
    }
  }

  const who = `${rec.reservationNumber ?? key.slice(14)} ${rec.contact?.firstName ?? ""} ${rec.contact?.lastName ?? ""}`.trim();
  const seen = new Set<string>();
  const doomed: string[] = [];
  for (const r of rec.racers ?? []) {
    if (!r.personId || seen.has(r.personId)) continue;
    seen.add(r.personId);
    const exp = await expiryOf(r.personId);
    const expDay = exp ? exp.slice(0, 10) : null;
    if (!expDay) doomed.push(`${r.racerName ?? r.personId}: NO valid waiver already`);
    else if (expDay < date) doomed.push(`${r.racerName ?? r.personId}: waiver expires ${expDay}, races ${date}`);
  }
  if (doomed.length > 0) {
    straddles++;
    rows.push(`  ✗ ${who}  (booked ${rec.createdAt?.slice(0, 10) ?? "?"})\n      ${doomed.join("\n      ")}`);
  }
}

console.log(rows.join("\n") || "  (none)");
console.log(
  `${"─".repeat(86)}\n${future} future express reservation(s) · ${straddles} already doomed` +
    (leadN ? ` · mean booking lead ${(leadSum / leadN).toFixed(1)} days` : "") +
    "\n",
);
process.exit(0);
