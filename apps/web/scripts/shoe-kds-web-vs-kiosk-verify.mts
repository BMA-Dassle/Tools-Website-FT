/**
 * Shoe sizes on the day-of Square order: are they actually there?
 *
 * Shoe SIZES ride the day-of order as $0 line items under a fixed KDS catalog
 * item — that is what the shoe desk reads. Three producers can write them, and
 * on 2026-07-29 only two of them ran (the kiosk's reserve route had no call at
 * all), which is invisible unless you check the artifact.
 *
 * For every recent reservation that recorded at least one shoe size in Neon,
 * prints whether its day-of order carries shoe-KDS lines, tallied by
 * booking_source. A healthy run is 0 MISSING in every source. READ-ONLY.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const { SHOE_KDS_CATALOG_ID } = await import("@/lib/bowling-shoe-kds");
const q = sql();

const SQ = "https://connect.squareup.com/v2";
const sqHeaders = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN ?? ""}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};

interface Row {
  id: number;
  booking_source: string | null;
  product_kind: string | null;
  center_code: string | null;
  booked_at: string;
  guest_name: string | null;
  square_dayof_order_id: string;
  sized: number;
  slots: number;
  sizes: string | null;
}

interface SqLineItem {
  uid: string;
  name?: string;
  note?: string;
  catalog_object_id?: string;
}

const DAYS = Number(process.env.DAYS ?? 10);

const rows = (await q`
  SELECT br.id, br.booking_source, br.product_kind, br.center_code, br.booked_at,
         br.guest_name, br.square_dayof_order_id,
         count(*) FILTER (WHERE brp.shoe_size IS NOT NULL AND brp.shoe_size <> '') AS sized,
         count(*) AS slots,
         string_agg(DISTINCT brp.shoe_size, ' / ') FILTER (WHERE brp.shoe_size IS NOT NULL) AS sizes
  FROM bowling_reservations br
  JOIN bowling_reservation_players brp ON brp.reservation_id = br.id
  WHERE br.booked_at > now() - make_interval(days => ${DAYS})
    AND br.square_dayof_order_id IS NOT NULL
  GROUP BY br.id
  HAVING count(*) FILTER (WHERE brp.shoe_size IS NOT NULL AND brp.shoe_size <> '') > 0
  ORDER BY br.booked_at DESC
  LIMIT 40
`) as Row[];

console.log(
  `\n══ reservations with shoe sizes in Neon (last ${DAYS}d, has day-of order): ${rows.length} ══\n`,
);

const tally: Record<string, { withKds: number; without: number }> = {};

for (const r of rows) {
  const or = await fetch(`${SQ}/orders/${r.square_dayof_order_id}`, {
    headers: sqHeaders,
    cache: "no-store",
  });
  let verdict = `HTTP ${or.status}`;
  let kdsCount = 0;
  if (or.ok) {
    const body = (await or.json()) as { order?: { line_items?: SqLineItem[] } };
    const kds = (body.order?.line_items ?? []).filter(
      (li) => li.catalog_object_id === SHOE_KDS_CATALOG_ID,
    );
    kdsCount = kds.length;
    verdict =
      kdsCount > 0
        ? `KDS ✓ ${kdsCount} line(s): ${kds.map((k) => `${k.name}/${k.note ?? "-"}`).join(", ")}`
        : "KDS ✗ NONE";
  }
  const src = String(r.booking_source);
  tally[src] ??= { withKds: 0, without: 0 };
  if (kdsCount > 0) tally[src].withKds++;
  else tally[src].without++;

  console.log(
    `  id=${r.id} src=${src.padEnd(9)} kind=${String(r.product_kind).padEnd(11)} ` +
      `sized=${r.sized}/${r.slots} sizes="${r.sizes}" ${String(r.booked_at).slice(0, 24)}\n` +
      `      "${r.guest_name}" order=${r.square_dayof_order_id} → ${verdict}`,
  );
}

console.log(`\n══ tally by booking_source ══`);
for (const [src, t] of Object.entries(tally)) {
  console.log(`  ${src.padEnd(10)} shoe-KDS present: ${t.withKds}   MISSING: ${t.without}`);
}
