/**
 * READ-ONLY forensics: find Ryan Reiff's Have-A-Ball signup.
 *
 * Checks, in order:
 *   1. Redis  — every `league:haveaball:signup:*` record (our source of truth)
 *   2. Square — every subscription at the HeadPinz FM location, resolved to a
 *      customer + plan variation, so we can see the real HAB roster
 *   3. Square — customer scan for "reiff" / "ryan" (catches a customer+card
 *      created with NO subscription, i.e. the flow died after saveCard)
 *   4. Square — payments/orders touching any matched customer
 *
 * Usage: npx tsx scripts/reiff-hab-hunt.mts
 */
import { readFileSync } from "node:fs";
import Redis from "ioredis";

// ---- env (no dotenv dependency) -------------------------------------------
const envRaw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
function envVal(key: string): string {
  if (process.env[key]) return process.env[key] as string;
  const m = envRaw.match(new RegExp(`^${key}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : "";
}
const SQUARE_TOKEN = envVal("SQUARE_ACCESS_TOKEN");
const REDIS_URL = envVal("REDIS_URL");
if (!SQUARE_TOKEN) throw new Error("SQUARE_ACCESS_TOKEN missing");
if (!REDIS_URL) throw new Error("REDIS_URL missing");

const SQUARE_BASE = "https://connect.squareup.com/v2";
const HEADERS = {
  Authorization: `Bearer ${SQUARE_TOKEN}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};
const HAB_LOCATION_ID = "TXBSQN0FEKQ11";
const HAB_PLAN_ID = "LAKSOX2AKTJ7AAY6UTPYK7E7";
const HAB_VARIATIONS = new Set([
  "VGQZDMULELNJNVLC3SUSY2R3",
  "3J7LPA4KLZ25BOOYPBJBCLJM",
  "ZERDVGN2OHTR4PFV67DSD2IH",
  "7LUSLN3DHFSHRRCXTLN56SWY",
  "TVLPFCHCPHGVZNFEXMG5X35O",
  "2ULH65AUVNG4D2EX4PAUC5GL",
  "LQIT4BG2FFS5ZQEO4433545U",
  "GWX46J37YAPSSKQC2W6J4YEG",
  "2POXMBXRGHEVEGZMWDMCZI5D",
  "NVQBYL5ATAEVB3CM6EIYBA45",
  "HAQ4JRDW3N7WJROQTR77XFGA",
  "664QU2SYYHXJMH2M5TOUTSWH",
]);

const NEEDLE = /reiff|ryan/i;
const STRICT = /reiff/i;

async function sq(path: string, init?: RequestInit) {
  const res = await fetch(`${SQUARE_BASE}${path}`, { ...init, headers: HEADERS });
  const text = await res.text();
  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) console.error(`  ! ${res.status} ${path}: ${text.slice(0, 300)}`);
  return json;
}

// =========================================================================
// 1. Redis HAB signup records
// =========================================================================
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });

console.log("=".repeat(78));
console.log("1. REDIS — Have-A-Ball signup records");
console.log("=".repeat(78));

const indexIds: string[] = await redis.zrevrange("league:haveaball:all", 0, -1);
console.log(`index league:haveaball:all → ${indexIds.length} id(s)`);

// Also scan raw keys, in case the index expired but records survived (or vice versa).
const scanned: string[] = [];
let cursor = "0";
do {
  const [next, keys] = await redis.scan(cursor, "MATCH", "league:haveaball:*", "COUNT", 500);
  cursor = next;
  scanned.push(...keys);
} while (cursor !== "0");
console.log(`SCAN league:haveaball:* → ${scanned.length} key(s)`);
for (const k of scanned) console.log(`   key: ${k}`);

const redisRecords: any[] = [];
const signupKeys = scanned.filter((k) => k.startsWith("league:haveaball:signup:"));
const allKeys = new Set([
  ...signupKeys,
  ...indexIds.map((id) => `league:haveaball:signup:${id}`),
]);
for (const key of allKeys) {
  const raw = await redis.get(key);
  if (!raw) {
    console.log(`   ${key} → MISSING (in index, no record)`);
    continue;
  }
  try {
    redisRecords.push({ key, ...JSON.parse(raw) });
  } catch {
    console.log(`   ${key} → unparseable: ${raw.slice(0, 200)}`);
  }
}

console.log(`\nparsed ${redisRecords.length} record(s):`);
for (const r of redisRecords) {
  const hit = NEEDLE.test(`${r.firstName} ${r.lastName} ${r.email}`) ? "  <<< MATCH" : "";
  console.log(
    `   ${r.signedUpAt ?? "?"}  ${r.firstName ?? ""} ${r.lastName ?? ""}  ${r.email ?? ""}  ` +
      `${r.phone ?? ""}  sub=${r.subscriptionId ?? "?"}  cust=${r.customerId ?? "?"}  ` +
      `start=${r.startDate ?? "?"} remaining=${r.remainingCharges ?? "?"}${hit}`,
  );
}
const redisHits = redisRecords.filter((r) =>
  NEEDLE.test(`${r.firstName} ${r.lastName} ${r.email}`),
);
if (redisHits.length) console.log("\nRedis MATCHES:\n" + JSON.stringify(redisHits, null, 2));
else console.log("\n>>> NO Redis record matching /reiff|ryan/");

// =========================================================================
// 2. Square subscriptions at the HAB location
// =========================================================================
console.log("\n" + "=".repeat(78));
console.log("2. SQUARE — subscriptions at HeadPinz FM (TXBSQN0FEKQ11)");
console.log("=".repeat(78));

const subs: any[] = [];
let subCursor: string | undefined;
do {
  const body: any = { query: { filter: { location_ids: [HAB_LOCATION_ID] } }, limit: 200 };
  if (subCursor) body.cursor = subCursor;
  const data = await sq("/subscriptions/search", { method: "POST", body: JSON.stringify(body) });
  subs.push(...(data.subscriptions ?? []));
  subCursor = data.cursor;
} while (subCursor);
console.log(`${subs.length} subscription(s) at this location`);

const custCache = new Map<string, any>();
async function customer(id: string) {
  if (!id) return null;
  if (custCache.has(id)) return custCache.get(id);
  const d = await sq(`/customers/${id}`);
  custCache.set(id, d.customer ?? null);
  return d.customer ?? null;
}

const habSubs = subs.filter((s) => HAB_VARIATIONS.has(s.plan_variation_id));
console.log(`${habSubs.length} of those are on a Have-A-Ball plan variation\n`);

const rows: any[] = [];
for (const s of subs) {
  const c = await customer(s.customer_id);
  const name = `${c?.given_name ?? ""} ${c?.family_name ?? ""}`.trim();
  const isHab = HAB_VARIATIONS.has(s.plan_variation_id);
  rows.push({ s, c, name, isHab });
}
rows.sort((a, b) => String(b.s.created_at).localeCompare(String(a.s.created_at)));
for (const { s, c, name, isHab } of rows) {
  const hit = NEEDLE.test(`${name} ${c?.email_address ?? ""} ${c?.note ?? ""}`) ? "  <<< MATCH" : "";
  console.log(
    `   ${isHab ? "HAB" : "---"}  created=${s.created_at?.slice(0, 10)}  status=${s.status}  ` +
      `start=${s.start_date}  charged_thru=${s.charged_through_date ?? "-"}  ` +
      `var=${s.plan_variation_id}  sub=${s.id}  ${name}  ${c?.email_address ?? ""}${hit}`,
  );
}
const subHits = rows.filter((r) => NEEDLE.test(`${r.name} ${r.c?.email_address ?? ""} ${r.c?.note ?? ""}`));
if (subHits.length) {
  console.log("\nSubscription MATCHES (full):");
  for (const h of subHits) console.log(JSON.stringify({ subscription: h.s, customer: h.c }, null, 2));
} else {
  console.log("\n>>> NO subscription at this location for /reiff|ryan/");
}

// =========================================================================
// 3. Square customer scan — did we create a customer + card but no sub?
// =========================================================================
console.log("\n" + "=".repeat(78));
console.log("3. SQUARE — customer scan for /reiff|ryan/ (created 2026-05-01 onward)");
console.log("=".repeat(78));

const custHits: any[] = [];
let cCursor: string | undefined;
let scannedCust = 0;
do {
  const body: any = {
    query: {
      filter: { created_at: { start_at: "2026-05-01T00:00:00Z" } },
      sort: { field: "CREATED_AT", order: "DESC" },
    },
    limit: 100,
  };
  if (cCursor) body.cursor = cCursor;
  const data = await sq("/customers/search", { method: "POST", body: JSON.stringify(body) });
  const batch = data.customers ?? [];
  scannedCust += batch.length;
  for (const c of batch) {
    const blob = `${c.given_name ?? ""} ${c.family_name ?? ""} ${c.email_address ?? ""} ${c.note ?? ""} ${c.phone_number ?? ""}`;
    if (STRICT.test(blob)) custHits.push(c);
  }
  cCursor = data.cursor;
} while (cCursor);
console.log(`scanned ${scannedCust} customer(s) created since 2026-05-01`);
console.log(`${custHits.length} matching /reiff/`);
for (const c of custHits) {
  console.log(
    `   ${c.created_at?.slice(0, 19)}  ${c.given_name ?? ""} ${c.family_name ?? ""}  ` +
      `${c.email_address ?? ""}  ${c.phone_number ?? ""}  id=${c.id}  note=${JSON.stringify(c.note ?? "")}`,
  );
}

// =========================================================================
// 4. For each matched customer: cards, subscriptions, payments
// =========================================================================
console.log("\n" + "=".repeat(78));
console.log("4. SQUARE — cards / subs / payments for each matched customer");
console.log("=".repeat(78));

const targets = new Set<string>([
  ...custHits.map((c) => c.id),
  ...subHits.map((h) => h.s.customer_id),
  ...redisHits.map((r) => r.customerId).filter(Boolean),
]);
console.log(`${targets.size} target customer id(s)\n`);

for (const cid of targets) {
  const c = await customer(cid);
  console.log("-".repeat(70));
  console.log(
    `CUSTOMER ${cid}  ${c?.given_name ?? ""} ${c?.family_name ?? ""}  ${c?.email_address ?? ""}`,
  );
  console.log(`  created=${c?.created_at}  note=${JSON.stringify(c?.note ?? "")}`);

  const cards = await sq(`/cards?customer_id=${cid}`);
  console.log(`  cards: ${(cards.cards ?? []).length}`);
  for (const cd of cards.cards ?? []) {
    console.log(
      `    ${cd.id}  ${cd.card_brand} ••${cd.last_4}  exp=${cd.exp_month}/${cd.exp_year}  enabled=${cd.enabled}  created=${cd.created_at ?? "?"}`,
    );
  }

  const cSubs = await sq("/subscriptions/search", {
    method: "POST",
    body: JSON.stringify({ query: { filter: { customer_ids: [cid] } }, limit: 100 }),
  });
  console.log(`  subscriptions: ${(cSubs.subscriptions ?? []).length}`);
  for (const s of cSubs.subscriptions ?? []) {
    console.log(
      `    ${s.id}  status=${s.status}  loc=${s.location_id}  var=${s.plan_variation_id}  ` +
        `start=${s.start_date}  canceled=${s.canceled_date ?? "-"}  charged_thru=${s.charged_through_date ?? "-"}  created=${s.created_at}`,
    );
    console.log(`      full: ${JSON.stringify(s)}`);
  }

  const orders = await sq("/orders/search", {
    method: "POST",
    body: JSON.stringify({
      location_ids: [HAB_LOCATION_ID],
      query: { filter: { customer_filter: { customer_ids: [cid] } } },
      limit: 100,
    }),
  });
  console.log(`  orders @ FM: ${(orders.orders ?? []).length}`);
  for (const o of orders.orders ?? []) {
    console.log(
      `    ${o.id}  state=${o.state}  total=${o.total_money?.amount ?? 0}  created=${o.created_at}  ` +
        `lines=${(o.line_items ?? []).map((li: any) => li.name).join("|")}`,
    );
  }
}

await redis.quit();
console.log("\ndone.");
