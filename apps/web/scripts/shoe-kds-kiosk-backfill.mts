/**
 * Backfill shoe-size KDS lines onto day-of Square orders that are missing them
 * (the 2026-07-29 kiosk gap: sizes reached Neon but never the Square order).
 *
 * Dry-run by default; APPLY=1 to write. Tuning: SOURCE (default kiosk),
 * SINCE_HOURS (default 2).
 *
 * Only OPEN orders can be fixed — Square refuses updates to COMPLETED/CANCELED,
 * and a paid-out order has already reached the KDS. Judgement call before you
 * APPLY: for a party that has already been served shoes at the desk, a late KDS
 * ticket can produce a duplicate pair. Backfill ahead of arrival, not behind it.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const APPLY = process.env.APPLY === "1";
const SOURCE = process.env.SOURCE ?? "kiosk";
const SINCE_HOURS = Number(process.env.SINCE_HOURS ?? 2);

const { sql } = await import("@/lib/db");
const { syncShoeKdsLineItems, SHOE_KDS_CATALOG_ID } = await import("@/lib/bowling-shoe-kds");
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
  status: string;
  booked_at: string;
  guest_name: string | null;
  square_dayof_order_id: string;
}

interface SqLineItem {
  uid: string;
  name?: string;
  note?: string;
  catalog_object_id?: string;
}

const rows = (await q`
  SELECT br.id, br.booking_source, br.status, br.booked_at, br.guest_name,
         br.square_dayof_order_id
  FROM bowling_reservations br
  JOIN bowling_reservation_players brp ON brp.reservation_id = br.id
  WHERE br.booking_source = ${SOURCE}
    AND br.square_dayof_order_id IS NOT NULL
    AND br.status NOT IN ('cancelled', 'no_show')
    AND brp.shoe_size IS NOT NULL AND brp.shoe_size <> ''
    AND br.booked_at > now() - make_interval(hours => ${SINCE_HOURS})
  GROUP BY br.id
  ORDER BY br.booked_at
`) as Row[];

console.log(
  `\n══ ${SOURCE} bookings with sizes, booked_at >= now()-${SINCE_HOURS}h: ${rows.length} ` +
    `(APPLY=${APPLY}) ══\n`,
);

for (const r of rows) {
  const players = (await q`
    SELECT name, shoe_size FROM bowling_reservation_players
    WHERE reservation_id = ${r.id} ORDER BY slot
  `) as Array<{ name: string | null; shoe_size: string | null }>;

  const or = await fetch(`${SQ}/orders/${r.square_dayof_order_id}`, {
    headers: sqHeaders,
    cache: "no-store",
  });
  if (!or.ok) {
    console.log(`  id=${r.id} order GET HTTP ${or.status} — skip`);
    continue;
  }
  const body = (await or.json()) as { order?: { state: string; line_items?: SqLineItem[] } };
  const state = body.order?.state ?? "UNKNOWN";
  const kds = (body.order?.line_items ?? []).filter(
    (li) => li.catalog_object_id === SHOE_KDS_CATALOG_ID,
  );
  const sizes = players.filter((p) => p.shoe_size).map((p) => `${p.shoe_size}/${p.name}`);
  console.log(
    `  id=${r.id} "${r.guest_name}" ${String(r.booked_at).slice(0, 24)} status=${r.status}\n` +
      `     order=${r.square_dayof_order_id} state=${state} existingKds=${kds.length} ` +
      `neonSizes=[${sizes.join(", ")}]`,
  );

  if (kds.length > 0) {
    console.log(`     → already has shoe-KDS lines, nothing to do`);
    continue;
  }
  if (state !== "OPEN") {
    console.log(`     → order ${state}, Square will not accept an update — cannot backfill`);
    continue;
  }
  if (!APPLY) {
    console.log(`     → WOULD SYNC ${sizes.length} line(s) (dry-run)`);
    continue;
  }
  await syncShoeKdsLineItems({
    orderId: r.square_dayof_order_id,
    players: players.map((p) => ({ name: p.name, shoeSize: p.shoe_size })),
    idempotencyKey: `shoe-kds-backfill-${r.id}-${Date.now()}`,
    logLabel: "shoe-kds-backfill",
  });
  console.log(`     → SYNCED`);
}
