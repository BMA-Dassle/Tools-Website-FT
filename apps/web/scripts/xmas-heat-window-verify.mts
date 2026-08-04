/**
 * READ-ONLY before/after proof for the Christmas in July racing-window change
 * (endTime 17:30 → 18:00).
 *
 * Pulls live BMI availability for 2026-07-30 on both event race products and
 * shows, per heat, whether the OLD window admitted it and whether the NEW one
 * does. The event funnel filter is a half-open range on the heat START time:
 *   blockMin >= winStart && blockMin < winEnd
 * (app/book/race/components/HeatPicker.tsx + app/event/[slug]/page.tsx)
 *
 * Usage (from apps/web): npx tsx scripts/xmas-heat-window-verify.mts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";

const DATE = "2026-07-30";
const OLD_END = 17 * 60 + 30; // 17:30
const NEW_END = 18 * 60; // 18:00
const WIN_START = 16 * 60 + 30; // 16:30

// xmas-in-july event race products (page 49504534, $0 build, adult starter).
const TRACKS = [
  { track: "Red", productId: 49503727, pageId: 49504534 },
  { track: "Blue", productId: 49504069, pageId: 49504534 },
];

const auth = await fetch(`${BMI_API_URL}/auth/${CLIENT_KEY}/publicbooking`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "BMI-Subscription-Key": SUB_KEY },
  body: JSON.stringify({ Username: process.env.BMI_USERNAME, Password: process.env.BMI_PASSWORD }),
});
if (!auth.ok) throw new Error(`BMI auth failed: ${auth.status}`);
const token = (await auth.json()).AccessToken;

const minOf = (iso: string) => {
  const tp = iso.replace(/Z$/, "").split("T")[1] ?? "";
  const [h, m] = tp.split(":").map(Number);
  return h * 60 + m;
};
const hhmm = (min: number) =>
  `${((Math.floor(min / 60) + 11) % 12) + 1}:${String(min % 60).padStart(2, "0")} ${min < 720 ? "AM" : "PM"}`;

for (const t of TRACKS) {
  const res = await fetch(
    `${BMI_API_URL}/public-booking/${CLIENT_KEY}/availability?date=${DATE}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "BMI-Subscription-Key": SUB_KEY,
        "Content-Type": "application/json",
        "Accept-Language": "en",
      },
      body: JSON.stringify({
        ProductId: t.productId,
        PageId: t.pageId,
        Quantity: 1,
        OrderId: null,
        PersonId: null,
        DynamicLines: [],
      }),
    },
  );
  if (!res.ok) {
    console.log(`${t.track}: availability ${res.status} ${(await res.text()).slice(0, 160)}\n`);
    continue;
  }
  const proposals = (await res.json()).proposals || [];
  const heats = proposals
    .map((p: { blocks?: { block?: { start?: string; stop?: string; freeSpots?: number } }[] }) => p.blocks?.[0]?.block)
    .filter((b: unknown): b is { start: string; stop: string; freeSpots: number } => !!b && !!(b as { start?: string }).start)
    .sort((a: { start: string }, b: { start: string }) => a.start.localeCompare(b.start));

  console.log(`── ${t.track} Track · ${DATE} ──────────────────────────`);
  console.log("start    | free | OLD 16:30–17:30 | NEW 16:30–18:00 | change");
  for (const h of heats) {
    const m = minOf(h.start);
    if (m < WIN_START - 30 || m > NEW_END + 30) continue; // keep the report tight
    const oldIn = m >= WIN_START && m < OLD_END;
    const newIn = m >= WIN_START && m < NEW_END;
    const change = oldIn === newIn ? "" : newIn ? "  ← NEWLY OPEN TO EVENT" : "  ← removed";
    console.log(
      `${hhmm(m).padEnd(8)} | ${String(h.freeSpots ?? "?").padStart(4)} | ${(oldIn ? "yes" : "no").padEnd(15)} | ${(newIn ? "yes" : "no").padEnd(15)} |${change}`,
    );
  }
  console.log();
}

process.exit(0);
