/**
 * Simulate the kiosk per-tile availability check at an arbitrary moment â€”
 * positive-case guard for /api/kiosk/availability's logic (owner 2026-07-19:
 * "do a test simulating 1pm tomorrow, make sure stuff appears like racing").
 *
 * Replicates experience-availability.ts's per-tile rules with an INJECTED
 * clock, against the LIVE site's proxies (read-only):
 *   - race: any single-race product for the date's schedule with a heat
 *     â‰¥10 min past SIM_NOW (packs excluded)
 *   - attractions: any future BMI slot with capacity per building
 *   - bowling/kbf: the accurate availability scan for the date (the route
 *     itself floors "now" only for today, so a future date needs no sim)
 *
 * Usage: npx tsx scripts/sim-kiosk-availability.mts [YYYY-MM-DD] [HH:MM]
 *        (defaults: tomorrow, 13:00 ET)
 */
import { getStaticProducts } from "../app/book/race/data";
import { ATTRACTIONS, getClientKey, type LocationKey } from "../lib/attractions-data";

const BASE = "https://fasttraxent.com";

const dateArg = process.argv[2];
const timeArg = process.argv[3] ?? "13:00";
const dateYmd =
  dateArg ??
  (() => {
    const now = new Date(Date.now() + 24 * 3600_000);
    return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  })();
const month = parseInt(dateYmd.slice(5, 7), 10);
const TZ = month >= 3 && month <= 11 ? "-04:00" : "-05:00";
const SIM_NOW_MS = new Date(`${dateYmd}T${timeArg}:00${TZ}`).getTime();
console.log(`SIM: ${dateYmd} ${timeArg} ET (nowMs=${SIM_NOW_MS})\n`);

function naiveEtStartMs(start: string): number {
  const naive = start.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
  return new Date(`${naive}${TZ}`).getTime();
}

interface Block {
  start: string;
  freeSpots: number;
}

async function bmiBlocks(productId: string, pageId: string, clientKey?: string): Promise<Block[]> {
  const qs = new URLSearchParams({ endpoint: "availability", date: dateYmd });
  if (clientKey) qs.set("clientKey", clientKey);
  const res = await fetch(`${BASE}/api/bmi?${qs.toString()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ProductId: Number(productId),
      PageId: Number(pageId),
      Quantity: 1,
      OrderId: null,
      PersonId: null,
      DynamicLines: [],
    }),
  });
  if (!res.ok) throw new Error(`bmi availability ${res.status}`);
  const data = (await res.json()) as {
    proposals?: Array<{ blocks?: Array<{ block?: Block }> }>;
  };
  return (data.proposals ?? [])
    .map((p) => p.blocks?.[0]?.block)
    .filter((b): b is Block => Boolean(b));
}

function futureOf(blocks: Block[], leadMs: number): Block[] {
  return blocks.filter((b) => b.freeSpots >= 1 && naiveEtStartMs(b.start) >= SIM_NOW_MS + leadMs);
}

async function simRace(): Promise<void> {
  const products = [
    ...getStaticProducts(dateYmd, "new"),
    ...getStaticProducts(dateYmd, "existing"),
  ].filter((p) => p.packType === "none");
  const seen = new Set<string>();
  let available = false;
  for (const p of products) {
    if (seen.has(p.productId)) continue;
    seen.add(p.productId);
    try {
      const future = futureOf(await bmiBlocks(p.productId, p.pageId), 10 * 60_000);
      const first = future[0]?.start.slice(11, 16) ?? "â€”";
      console.log(
        `  race ${p.name} (${p.productId}): ${future.length} future heats, first ${first}`,
      );
      if (future.length > 0) available = true;
    } catch (err) {
      console.log(`  race ${p.name} (${p.productId}): probe failed (${(err as Error).message})`);
    }
  }
  console.log(`RACE â†’ ${available ? "AVAILABLE" : "LOCKED"}\n`);
}

async function simAttraction(slug: string, location: LocationKey): Promise<void> {
  const config = ATTRACTIONS[slug];
  const pageId = config?.pageIds[location];
  if (!config || !pageId) {
    console.log(`${slug}@${location} â†’ no config/page (LOCKED)\n`);
    return;
  }
  let available = false;
  for (const p of config.products.filter((x) => x.location === location && !x.isCombo)) {
    try {
      const future = futureOf(
        await bmiBlocks(p.productId, pageId, getClientKey(config, location)),
        0,
      );
      const first = future[0]?.start.slice(11, 16) ?? "â€”";
      console.log(`  ${slug} ${p.name}: ${future.length} future slots, first ${first}`);
      if (future.length > 0) available = true;
    } catch (err) {
      console.log(`  ${slug} ${p.name}: probe failed (${(err as Error).message})`);
    }
  }
  console.log(`${slug.toUpperCase()}@${location} â†’ ${available ? "AVAILABLE" : "LOCKED"}\n`);
}

async function simBowling(kind: string): Promise<void> {
  const res = await fetch(
    `${BASE}/api/bowling/v2/availability?centerId=9172&players=2&startDate=${dateYmd}` +
      `&kind=${kind}&stepMinutes=30&leadMinutes=0`,
  );
  const data = (await res.json()) as { Availabilities?: Array<{ BookedAt: string }> };
  const n = data.Availabilities?.length ?? 0;
  console.log(
    `BOWLING kind=${kind} â†’ ${n > 0 ? "AVAILABLE" : "LOCKED"} (${n} slots` +
      `${n ? `, first ${data.Availabilities![0].BookedAt.slice(11, 16)}` : ""})\n`,
  );
}

async function main(): Promise<void> {
  await simRace();
  await simAttraction("duck-pin", "fasttrax");
  await simAttraction("gel-blaster", "headpinz");
  await simAttraction("laser-tag", "headpinz");
  await simAttraction("shuffly", "fasttrax");
  await simAttraction("shuffly", "headpinz");
  await simBowling("open,hourly");
  await simBowling("kbf");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
