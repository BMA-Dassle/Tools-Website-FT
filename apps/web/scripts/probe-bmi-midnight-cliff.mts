/**
 * READ-ONLY probe: BMI public availability "midnight cliff".
 *
 * Confirms (first run 2026-08-01 ~12:20 AM ET) that BMI's public-booking
 * /availability endpoint treats the queried date as PAST at calendar midnight
 * (center-local), NOT at the ~2 AM business-day close its own dayplanner uses:
 *
 *   - date=<yesterday's business day, still running after midnight>
 *       → HTTP 200 {"proposals":[]}
 *   - date=<today> → full business day INCLUDING post-midnight blocks
 *       (e.g. 2026-08-01T11:00 … 2026-08-02T01:30, freeSpots=14)
 *
 * So after calendar midnight, the running night's remaining blocks appear in
 * NO query — the kiosk/web "Nothing left to book today" on every BMI tile
 * between midnight and close is BMI truth, not our bug.
 * See tasks/future/bmi-availability-midnight-cliff.md.
 *
 * Run from apps/web:  npx tsx scripts/probe-bmi-midnight-cliff.mts [YYYY-MM-DD ...]
 * (defaults: today and yesterday, ET)
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const KEY = "headpinzftmyers";
const SUB = process.env.BMI_SUBSCRIPTION_KEY || "";
const API = process.env.BMI_API_URL || "https://api.bmileisure.com";

const auth = await fetch(`${API}/auth/${KEY}/publicbooking`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "BMI-Subscription-Key": SUB },
  body: JSON.stringify({
    Username: process.env.BMI_USERNAME,
    Password: process.env.BMI_PASSWORD,
  }),
});
if (!auth.ok) {
  console.error("auth failed", auth.status, await auth.text());
  process.exit(1);
}
const tok = (await auth.json()).AccessToken;

// HeadPinz FM Nexus arena products (page 24909729).
const PRODUCTS = [
  { label: "Laser Tag (HP FM)", productId: 8976685, pageId: 24909729 },
  { label: "Gel Blaster (HP FM)", productId: 8976680, pageId: 24909729 },
];

const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const yesterday = new Date(etNow);
yesterday.setDate(yesterday.getDate() - 1);
const DATES = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [ymd(etNow), ymd(yesterday)];

for (const date of DATES) {
  for (const p of PRODUCTS) {
    const res = await fetch(`${API}/public-booking/${KEY}/availability?date=${date}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok}`,
        "BMI-Subscription-Key": SUB,
        "Content-Type": "application/json",
        "Accept-Language": "en",
      },
      body: JSON.stringify({
        ProductId: p.productId,
        PageId: p.pageId,
        Quantity: 1,
        OrderId: null,
        PersonId: null,
        DynamicLines: [],
      }),
    });
    console.log(`\n══════ ${p.label} — date=${date} → HTTP ${res.status} ══════`);
    if (!res.ok) {
      console.log((await res.text()).slice(0, 300));
      continue;
    }
    const data = (await res.json()) as {
      proposals?: Array<{
        blocks?: Array<{ block?: { start?: string; stop?: string; freeSpots?: number } }>;
      }>;
    };
    const props = data.proposals ?? [];
    console.log(`proposals: ${props.length}`);
    const rows = props
      .map((pr) => pr.blocks?.[0]?.block)
      .filter((b): b is NonNullable<typeof b> => Boolean(b))
      .map((b) => `  ${b.start} → ${b.stop}  freeSpots=${b.freeSpots}`)
      .sort();
    console.log(rows.join("\n") || "  (no blocks)");
  }
}
