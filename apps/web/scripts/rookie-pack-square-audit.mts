/**
 * READ-ONLY: every Square order carrying a "Rookie Pack" line since the kiosk
 * mixed-party auto-enroll shipped (d63fc584, 2026-07-19). sales_log never
 * records the kiosk's rookie_pack flag (kiosk-post-reserve doesn't send it), so
 * Square is the only truth for what was actually charged.
 *
 * Two DIFFERENT things are both named "Rookie Pack" in Square:
 *   - PACKAGE flow  — the full bundle (race + license + POV). Unit ≈ $25.97–
 *     $36.98 pre-tax. The guest tapped a package card on the product step.
 *   - FLAG flow     — license ($4.99) + POV ($5) only = $9.99 pre-tax. Either
 *     the license/POV chooser's "Rookie Pack" radio, or the kiosk's
 *     mixed-party AUTO-ENROLL (no chooser shown at all).
 * Unit price is the discriminator.
 *
 *   node --env-file=apps/web/.env.local apps/web/scripts/rookie-pack-square-audit.mts
 */
import { readFileSync } from "node:fs";
for (const path of ["apps/web/.env.local", ".env.local"]) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
    break;
  } catch {
    /* next */
  }
}
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${TOKEN}`,
  "Square-Version": "2024-12-18",
  "Content-Type": "application/json",
};
const LOC: Record<string, string> = {
  TXBSQN0FEKQ11: "HP Fort Myers",
  PPTR5G2N0QXF7: "HP Naples",
  LAB52GY480CJF: "FastTrax",
};
const SINCE = "2026-07-19T00:00:00Z";

/** Line names that represent A RACER RACING (one seat each). */
const RACE_LINE =
  /karting|junior racing|race pack|starter|intermediate|^pro |mega|ultimate qualifier|grand prix|endurance/i;
/** Lines that are add-ons, not seats. */
const NON_SEAT = /rookie pack|license|pov|viewpoint|token|game ?card|activation|laser|bowl|arcade/i;

let cursor: string | undefined;
const orders: any[] = [];
do {
  const res = await fetch(`${BASE}/orders/search`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      location_ids: Object.keys(LOC),
      cursor,
      limit: 500,
      query: {
        filter: { date_time_filter: { created_at: { start_at: SINCE } } },
        sort: { sort_field: "CREATED_AT", sort_order: "ASC" },
      },
    }),
  });
  const j: any = await res.json();
  if (!res.ok) {
    console.error("square error", res.status, JSON.stringify(j).slice(0, 400));
    process.exit(1);
  }
  orders.push(...(j.orders ?? []));
  cursor = j.cursor;
} while (cursor);
console.error(`scanned ${orders.length} Square orders since ${SINCE}`);

const hits = orders
  .map((o) => {
    const rookie = (o.line_items ?? []).filter((li: any) =>
      String(li.name ?? "").toLowerCase().includes("rookie"),
    );
    if (rookie.length === 0) return null;
    const packQty = rookie.reduce((s: number, li: any) => s + Number(li.quantity ?? 0), 0);
    // base_price_money is the pre-tax unit; fall back to total/qty.
    const unitCents =
      Number(rookie[0].base_price_money?.amount ?? 0) ||
      Math.round(
        rookie.reduce((s: number, li: any) => s + Number(li.total_money?.amount ?? 0), 0) /
          Math.max(1, packQty),
      );
    const packCents = rookie.reduce(
      (s: number, li: any) => s + Number(li.total_money?.amount ?? 0),
      0,
    );
    const seats = (o.line_items ?? []).filter(
      (li: any) => RACE_LINE.test(String(li.name ?? "")) && !NON_SEAT.test(String(li.name ?? "")),
    );
    const seatQty = seats.reduce((s: number, li: any) => s + Number(li.quantity ?? 0), 0);
    return {
      id: o.id,
      created: String(o.created_at).slice(0, 16),
      loc: LOC[o.location_id] ?? o.location_id,
      state: o.state,
      total: (Number(o.total_money?.amount ?? 0) / 100).toFixed(2),
      packQty,
      unitCents,
      flagFlow: unitCents > 0 && unitCents < 1500, // $9.99 license+POV bundle
      packDollars: (packCents / 100).toFixed(2),
      seatQty,
      names: (o.line_items ?? []).map((li: any) => `${li.name} x${li.quantity}`).join(" | "),
    };
  })
  .filter(Boolean) as any[];

const live = hits.filter((h) => h.state !== "CANCELED");
const flag = live.filter((h) => h.flagFlow);
const pkg = live.filter((h) => !h.flagFlow);
// The auto-enroll signature: license+POV pack for FEWER people than are racing
// = a MIXED party = the kiosk hid the chooser.
const autoEnroll = flag.filter((h) => h.seatQty > h.packQty);
const chosen = flag.filter((h) => h.seatQty > 0 && h.seatQty <= h.packQty);
const noSeats = flag.filter((h) => h.seatQty === 0);
const $ = (rows: any[]) => rows.reduce((s, r) => s + Number(r.packDollars), 0).toFixed(2);

console.log(`\nOrders with a "Rookie Pack" line since 2026-07-19 (non-canceled): ${live.length}`);
console.log(`  PACKAGE flow (full bundle, unit >= $15): ${pkg.length}  $${$(pkg)}`);
console.log(`  FLAG flow ($9.99 license+POV):           ${flag.length}  $${$(flag)}`);
console.log(
  `     ├─ MIXED party, packs < racers → kiosk AUTO-ENROLLED, no chooser: ${autoEnroll.length}  $${$(autoEnroll)}`,
);
console.log(`     ├─ packs >= racers (chooser was visible):                      ${chosen.length}  $${$(chosen)}`);
console.log(`     └─ no race seat line on the order (unclassifiable):            ${noSeats.length}  $${$(noSeats)}`);

console.log("\n── AUTO-ENROLLED orders (guest was never shown a choice) ──");
for (const h of autoEnroll) {
  console.log(
    `${h.created}  ${h.loc.padEnd(13)} ${h.state.padEnd(9)} total=$${h.total.padStart(8)}  packs=${h.packQty} ($${h.packDollars})  racers=${h.seatQty}`,
  );
  console.log(`    ${h.names}`);
}

console.log("\n── distinct line-item names across all Rookie Pack orders (classifier check) ──");
const tally = new Map<string, number>();
for (const h of live) {
  for (const part of h.names.split(" | ")) {
    const name = part.replace(/ x[\d.]+$/, "");
    tally.set(name, (tally.get(name) ?? 0) + 1);
  }
}
for (const [name, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(
    `  ${String(count).padStart(4)}  ${name}` +
      (RACE_LINE.test(name) && !NON_SEAT.test(name) ? "   [counted as a racer seat]" : ""),
  );
}
