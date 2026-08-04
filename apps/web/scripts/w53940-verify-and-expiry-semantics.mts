/**
 * READ-ONLY: (a) verify the W53940 express removal landed, (b) learn what
 * Pandora's `waiverExpiry` actually means when it comes back NULL.
 *
 * (b) matters for root cause: /api/pandora derives `valid` from
 * `waiverExpiry > now`. Adam's is NULL. If PAST expiries exist in the wild then
 * NULL means "never signed" (so express was wrong the moment it was written);
 * if expiries are only ever future-or-null then BMI clears the field on lapse
 * and Adam's waiver could have been valid at booking and gone stale by race day
 * (a different bug: the memo/flag are never re-verified).
 *
 * Usage (from apps/web):  npx tsx scripts/w53940-verify-and-expiry-semantics.mts [sampleSize]
 * NO WRITES.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const SAMPLE = Number(process.argv[2] || 120);
const BILL_ID = "63000000005919831";
const CLIENT_KEY = "headpinzftmyers";
const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const PKEY = process.env.SWAGGER_ADMIN_KEY || "";
const LOC = "TXBSQN0FEKQ11";

const { default: redis } = await import("@/lib/redis");

// ── (a) verify ─────────────────────────────────────────────────────────
const raw = await redis.get(`bookingrecord:${BILL_ID}`);
console.log(`\nbookingrecord:${BILL_ID} → ${raw?.match(/"fastLane":\s*\w+/)?.[0] ?? "(no fastLane)"}`);

const BMI_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const SUB = process.env.BMI_SUBSCRIPTION_KEY || "";
const authRes = await fetch(`${BMI_URL}/auth/${CLIENT_KEY}/publicbooking`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "BMI-Subscription-Key": SUB },
  body: JSON.stringify({ Username: process.env.BMI_USERNAME, Password: process.env.BMI_PASSWORD }),
});
const auth = (await authRes.json()) as { AccessToken?: string; accessToken?: string };
const token = auth.AccessToken || auth.accessToken;
const ovRes = await fetch(`${BMI_URL}/public-booking/${CLIENT_KEY}/order/${BILL_ID}/overview`, {
  headers: {
    Authorization: `Bearer ${token}`,
    "BMI-Subscription-Key": SUB,
    "Accept-Language": "en",
  },
});
const ovText = await ovRes.text();
const memoHit = ovText.match(/"memo"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
console.log(`order overview ${ovRes.status}; memo field ${memoHit ? "→" : "not present in overview payload"}`);
if (memoHit) console.log(memoHit[1].replace(/\\n/g, "\n  "));
console.log(
  `overview mentions EXPRESS LANE: ${/EXPRESS LANE/i.test(ovText)} · NO VALID WAIVER: ${/NO VALID WAIVER/i.test(ovText)}`,
);

// ── (b) waiverExpiry semantics across a sample of real racers ──────────
const keys: string[] = [];
let cursor = "0";
do {
  const [next, batch] = (await redis.scan(cursor, "MATCH", "bookingrecord:*", "COUNT", 500)) as [
    string,
    string[],
  ];
  cursor = next;
  for (const k of batch) if (/^bookingrecord:\d+$/.test(k)) keys.push(k);
} while (cursor !== "0" && keys.length < SAMPLE * 3);

const personIds = new Set<string>();
for (const k of keys) {
  if (personIds.size >= SAMPLE) break;
  const r = await redis.get(k).catch(() => null);
  if (!r) continue;
  for (const m of r.matchAll(/"personId":"(\d+)"/g)) personIds.add(m[1]);
}
console.log(`\nsampling ${personIds.size} personIds from ${keys.length} booking records`);

let future = 0;
let past = 0;
let nul = 0;
let miss = 0;
const pastSamples: string[] = [];
const now = new Date();
for (const pid of personIds) {
  const res = await fetch(`${PANDORA_URL}/bmi/person/${LOC}/${pid}?picture=false&allRelated=false`, {
    headers: { Authorization: `Bearer ${PKEY}` },
  }).catch(() => null);
  if (!res || !res.ok) {
    miss++;
    continue;
  }
  const d = (await res.json().catch(() => null)) as { success?: boolean; data?: { waiverExpiry?: string | null } } | null;
  if (!d?.success) {
    miss++;
    continue;
  }
  const exp = d.data?.waiverExpiry ?? null;
  if (!exp) nul++;
  else if (new Date(exp) > now) future++;
  else {
    past++;
    if (pastSamples.length < 8) pastSamples.push(`${pid}=${exp}`);
  }
}
console.log(
  `\nwaiverExpiry: future=${future}  PAST=${past}  null=${nul}  unreadable=${miss}` +
    (pastSamples.length ? `\n  past examples: ${pastSamples.join(", ")}` : ""),
);
console.log(
  past > 0
    ? "\n→ PAST expiries DO exist: a lapsed waiver keeps its date. NULL = never signed."
    : "\n→ no PAST expiries in sample: null is ambiguous (never-signed OR cleared on lapse).",
);
process.exit(0);
