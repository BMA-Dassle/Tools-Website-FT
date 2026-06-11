// READ-ONLY audit: find v2-checkout payments that charged via /api/square/pay
// with NO booking created (the June 2026 Apple Pay wallet-bypass incident).
//
// Detection: a Square payment whose note contains "Ref: cart-" is ALWAYS an
// orphan — legitimate v2 charges run through the reserve routes, which write
// different notes ("Deposit – X#### – date" etc.). For each hit we cross-match
// the buyer email against bowling_reservations (±1 day) to tell apart
// "staff manually rebooked them" from "customer got nothing".
//
// Usage: node apps/web/scripts/audit-orphan-cart-payments.mjs [begin-date]
//        begin-date defaults to 2026-06-01.
import fs from "fs";
import { neon } from "@neondatabase/serverless";

const env = fs.readFileSync("c:/GIT/Tools-Website-FT/apps/web/.env.local", "utf8");
const grab = (k) =>
  env
    .match(new RegExp(`^${k}=(.+)$`, "m"))[1]
    .trim()
    .replace(/^["']|["']$/g, "");
const tok = grab("SQUARE_ACCESS_TOKEN");
const sql = neon(grab("DATABASE_URL"));

const BASE = "https://connect.squareup.com/v2";
const H = { Authorization: `Bearer ${tok}`, "Square-Version": "2024-12-18" };
const LOCS = {
  LAB52GY480CJF: "FastTrax FM",
  TXBSQN0FEKQ11: "HeadPinz FM",
  PPTR5G2N0QXF7: "HeadPinz Naples",
};
const begin = `${process.argv[2] ?? "2026-06-01"}T00:00:00Z`;

const hits = [];
for (const loc of Object.keys(LOCS)) {
  let cursor;
  do {
    const qs = new URLSearchParams({ begin_time: begin, location_id: loc, limit: "100" });
    if (cursor) qs.set("cursor", cursor);
    const res = await fetch(`${BASE}/payments?${qs}`, { headers: H });
    const body = await res.json();
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    for (const p of body.payments ?? []) {
      if ((p.note ?? "").includes("Ref: cart-")) hits.push(p);
    }
    cursor = body.cursor;
  } while (cursor);
}
hits.sort((a, b) => a.created_at.localeCompare(b.created_at));

console.log(`${hits.length} orphan cart-ref payment(s) since ${begin}\n`);

const byEmail = new Map();
let totalCents = 0;
for (const p of hits) {
  const email = p.buyer_email_address ?? "(no email)";
  byEmail.set(email, (byEmail.get(email) ?? 0) + 1);
  if (p.status === "COMPLETED") totalCents += p.amount_money.amount;

  // Any reservation for this buyer within ±1 day of the charge means staff
  // (or a card retry) eventually got them booked — refund decision differs.
  let match = [];
  if (p.buyer_email_address) {
    match = await sql`
      SELECT qamf_reservation_id, center_code, status, booked_at
      FROM bowling_reservations
      WHERE guest_email ILIKE ${p.buyer_email_address}
        AND inserted_at BETWEEN ${p.created_at}::timestamptz - interval '1 day'
                            AND ${p.created_at}::timestamptz + interval '1 day'`;
  }
  const booked =
    match.length > 0
      ? `REBOOKED: ${match.map((m) => `${m.qamf_reservation_id} @ ${LOCS[m.center_code] ?? m.center_code} (${m.status})`).join(", ")}`
      : "NO BOOKING FOUND";

  console.log(
    `${p.created_at}  $${(p.amount_money.amount / 100).toFixed(2).padStart(7)}  ${p.status.padEnd(9)}` +
      `  ${LOCS[p.location_id] ?? p.location_id}  ${email}\n` +
      `    payment=${p.id}  order=${p.order_id}  ${booked}`,
  );
}

console.log(`\nTotal completed: $${(totalCents / 100).toFixed(2)}`);
const repeats = [...byEmail].filter(([, n]) => n > 1);
if (repeats.length) {
  console.log("Charged more than once (retry victims):");
  for (const [email, n] of repeats) console.log(`  ${n}x ${email}`);
}
