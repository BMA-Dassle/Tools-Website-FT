/**
 * Probe why the kiosk gel-blaster / KBF tiles stay selectable when nothing is
 * left tonight. Replicates the exact server-side availability probes:
 *  1. BMI availability for gel-blaster (product 8976680, page 24909729, FM/HP)
 *     and laser-tag (control — its tile showed a line).
 *  2. Prints raw proposal blocks + what productFirstOpenSlot would conclude.
 */
import fs from "node:fs";
import path from "node:path";

// Minimal .env.local loader (no deps)
const envPath = path.resolve(import.meta.dirname, "../.env.local");
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const CLIENT = "headpinzftmyers";

async function getToken(): Promise<string> {
  const res = await fetch(`${BMI_API_URL}/auth/${CLIENT}/publicbooking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "BMI-Subscription-Key": BMI_SUB_KEY },
    body: JSON.stringify({
      Username: process.env.BMI_USERNAME || "",
      Password: process.env.BMI_PASSWORD || "",
    }),
  });
  if (!res.ok) throw new Error(`auth ${res.status}`);
  const data = await res.json();
  return data.AccessToken || data.accessToken;
}

function businessDayYmdET(): string {
  // 2 AM ET rollover, same as the app
  const now = new Date(Date.now() - (4 * 60 + 120) * 60_000); // ET offset (-4) minus 2h rollover
  return now.toISOString().slice(0, 10);
}

async function probe(token: string, label: string, productId: number, pageId: number, date: string) {
  const url = `${BMI_API_URL}/public-booking/${CLIENT}/availability?date=${date}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "BMI-Subscription-Key": BMI_SUB_KEY,
      "Content-Type": "application/json",
      "Accept-Language": "en",
    },
    body: JSON.stringify({
      ProductId: productId,
      PageId: pageId,
      Quantity: 1,
      OrderId: null,
      PersonId: null,
      DynamicLines: [],
    }),
  });
  const text = await res.text();
  console.log(`\n=== ${label} (product ${productId}) — HTTP ${res.status}, ${text.length} bytes`);
  if (!res.ok) {
    console.log(`  ERROR BODY: ${text.slice(0, 500)}`);
    console.log(`  → adapter THROWS → attractionFirstOpenToday fails → tile FAILS OPEN (selectable, no line)`);
    return;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.log(`  UNPARSEABLE: ${text.slice(0, 300)}`);
    return;
  }
  const proposals = parsed.proposals ?? parsed.Proposals ?? [];
  console.log(`  proposals: ${proposals.length}`);
  const blocks = proposals
    .map((p: any) => p.blocks?.[0]?.block ?? p.Blocks?.[0]?.Block)
    .filter(Boolean);
  for (const b of blocks.slice(0, 40)) {
    console.log(`   block start=${b.start ?? b.Start} freeSpots=${b.freeSpots ?? b.FreeSpots}`);
  }
  if (blocks.length === 0) console.log(`  (no blocks) → probe returns null → tile should LOCK`);
}

const token = await getToken();
const date = businessDayYmdET();
console.log(`business day: ${date}, now UTC: ${new Date().toISOString()}`);
await probe(token, "laser-tag HP-FM, business day", 8976685, 24909729, date);
await probe(token, "laser-tag HP-FM, calendar today (+1)", 8976685, 24909729, "2026-08-02");
await probe(token, "gel-blaster HP-FM, business day", 8976680, 24909729, date);
await probe(token, "gel-blaster HP-FM, calendar today (+1)", 8976680, 24909729, "2026-08-02");
