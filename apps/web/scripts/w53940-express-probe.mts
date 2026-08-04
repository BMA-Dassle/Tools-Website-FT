/**
 * READ-ONLY probe for the W53940 false Express Lane (Adam Houghtaling, 7/28).
 *
 * Owner report: booked online, NO valid waiver on file (BMI person signature is
 * blank), yet the reservation memo says "** EXPRESS LANE ** — all waivers valid".
 *
 * Resolves the short link the memo carries → billId → the Redis booking record,
 * then re-runs BOTH express predicates and asks Pandora for the live waiver
 * truth per racer, so we can see WHICH input lied.
 *
 * Usage (from apps/web):  npx tsx scripts/w53940-express-probe.mts [shortCode]
 * NO WRITES.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { default: redis } = await import("@/lib/redis");
const { PANDORA_LOCATION_MAP, PANDORA_DEFAULT_LOCATION_ID } = await import(
  "@/lib/pandora-locations"
);

const code = process.argv[2] || "Aa2gTQED";
const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const KEY = process.env.SWAGGER_ADMIN_KEY || "";

const short = await redis.get(`short:${code}`);
console.log(`\nshort:${code} → ${short ?? "(missing)"}`);
if (!short) process.exit(1);

const sp = new URL(short).searchParams;
const billId = sp.get("billId") ?? sp.get("id") ?? short.match(/\/(\d{6,})(?:[/?#]|$)/)?.[1];
console.log(`billId → ${billId ?? "(could not parse)"}`);
if (!billId) process.exit(1);

const raw = await redis.get(`bookingrecord:${billId}`);
if (!raw) {
  console.log("bookingrecord: MISSING");
  process.exit(1);
}
const rec = JSON.parse(raw) as {
  fastLane?: boolean;
  racers?: Array<{ racerName?: string; personId?: string | null; sessionId?: unknown }>;
  contact?: { firstName?: string; lastName?: string };
  createdAt?: string;
  status?: string;
};
console.log(`\n── bookingrecord:${billId} ${"─".repeat(40)}`);
console.log(`createdAt : ${rec.createdAt ?? "?"}   status: ${rec.status ?? "?"}`);
console.log(`fastLane  : ${JSON.stringify(rec.fastLane)}`);
console.log(`racers    : ${rec.racers?.length ?? 0}`);

const locations = [
  ...new Set([PANDORA_DEFAULT_LOCATION_ID, ...Object.values(PANDORA_LOCATION_MAP)]),
];

for (const r of rec.racers ?? []) {
  console.log(`\n  • ${r.racerName ?? "?"}  personId=${r.personId ?? "NULL"} session=${String(r.sessionId ?? "-")}`);
  if (!r.personId) {
    console.log("    → no personId: by definition no waiver on record");
    continue;
  }
  for (const loc of locations) {
    const res = await fetch(
      `${PANDORA_URL}/bmi/person/${loc}/${r.personId}?picture=false&allRelated=false`,
      { headers: { Authorization: `Bearer ${KEY}` }, cache: "no-store" },
    ).catch(() => null);
    if (!res) {
      console.log(`    loc ${loc}: fetch failed`);
      continue;
    }
    const data = (await res.json().catch(() => null)) as
      | { success?: boolean; message?: string; data?: Record<string, unknown> }
      | null;
    if (!res.ok || !data?.success) {
      console.log(`    loc ${loc}: ${res.status} ${data?.message ?? "not found"}`);
      continue;
    }
    const p = data.data ?? {};
    const expiry = p.waiverExpiry ? new Date(String(p.waiverExpiry)) : null;
    const valid = expiry ? expiry > new Date() : false;
    console.log(
      `    loc ${loc}: ${String(p.firstName ?? "")} ${String(p.lastName ?? "")}  ` +
        `waiverExpiry=${p.waiverExpiry ?? "null"} → /api/pandora valid=${valid}`,
    );
    console.log(
      `      birthdate=${p.birthdate ?? "null"} lastVisit=${p.lastVisit ?? "null"} ` +
        `signature=${"signature" in p ? JSON.stringify(p.signature)?.slice(0, 40) : "(field absent)"}`,
    );
  }
}

// Express session index rows the checkin-alerts cron uses to reach express holders.
const idx = await redis.keys(`bookingrecord:express:session:*`).catch(() => [] as string[]);
const mine: string[] = [];
for (const k of idx) {
  const v = await redis.get(k).catch(() => null);
  if (v && String(v) === String(billId)) mine.push(k);
}
console.log(`\nexpress session index rows pointing at ${billId}: ${mine.length ? mine.join(", ") : "none"}`);
process.exit(0);
