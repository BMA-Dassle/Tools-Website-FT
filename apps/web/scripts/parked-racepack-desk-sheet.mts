/**
 * READ-ONLY: build the desk worksheet for the 9 PARKED race-pack rows in
 * bmi_deposit_failures (Square charged, Pandora addDeposit never landed,
 * recorded person ids 404). For each row: Neon queue row + sales_log twin
 * + live Square payment (cardholder name, amount, date, last4, receipt).
 *
 * Run from apps/web:  npx tsx scripts/parked-racepack-desk-sheet.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";
/* eslint-disable @typescript-eslint/no-explicit-any */
const sql = neon(process.env.DATABASE_URL!);

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQ_HEADERS = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Content-Type": "application/json",
  "Square-Version": "2025-01-23",
};

// ── 1. The parked queue rows ────────────────────────────────────────
const rows = (await sql`
  SELECT id, source, source_ref, location_id, person_id, deposit_kind_id, amount,
         attempts, last_error, created_at, notes
  FROM bmi_deposit_failures
  WHERE resolved_at IS NULL AND source = 'race-pack-square'
  ORDER BY id`) as any[];
console.log(`unresolved race-pack-square rows: ${rows.length}\n`);

async function sqGet(path: string): Promise<any> {
  const res = await fetch(`${SQUARE_BASE}${path}`, { headers: SQ_HEADERS });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* leave null */
  }
  if (!res.ok) return { __error: `${res.status} ${text.slice(0, 200)}` };
  return body;
}

// Fallback: no payment id in notes → scan payments at the location around
// the row's created_at and match the payment note's "Ref: {billId}".
async function findPaymentByBillRef(billId: string, createdAt: string): Promise<any | null> {
  const t = new Date(createdAt).getTime();
  const begin = new Date(t - 6 * 3600_000).toISOString();
  const end = new Date(t + 3600_000).toISOString();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({
      location_id: "LAB52GY480CJF",
      begin_time: begin,
      end_time: end,
      limit: "100",
    });
    if (cursor) qs.set("cursor", cursor);
    const data = await sqGet(`/payments?${qs}`);
    if (data.__error) {
      console.log(`    payment scan error: ${data.__error}`);
      return null;
    }
    for (const p of data.payments ?? []) {
      if (typeof p.note === "string" && p.note.includes(billId)) return p;
    }
    cursor = data.cursor;
    if (!cursor) break;
  }
  return null;
}

function describePayment(p: any): Record<string, unknown> {
  const card = p.card_details?.card;
  return {
    payment_id: p.id,
    status: p.status,
    created_at: p.created_at,
    amount: p.amount_money ? `$${(p.amount_money.amount / 100).toFixed(2)}` : null,
    refunded: p.refunded_money ? `$${(p.refunded_money.amount / 100).toFixed(2)}` : null,
    source: p.source_type,
    cardholder: card?.cardholder_name ?? null,
    card: card ? `${card.card_brand} ****${card.last_4}` : null,
    gift_card: p.source_type === "WALLET" || p.source_type === "SQUARE_ACCOUNT" ? "?" : undefined,
    buyer_email: p.buyer_email_address ?? null,
    customer_id: p.customer_id ?? null,
    note: p.note ?? null,
    receipt: p.receipt_url ?? null,
  };
}

for (const r of rows) {
  console.log("═".repeat(72));
  console.log(
    `row #${r.id}  credits=${r.amount}  created=${r.created_at}  attempts=${r.attempts}`,
  );
  console.log(`  bill_id(source_ref)=${r.source_ref}  dead_person_id=${r.person_id}`);
  console.log(`  kind=${r.deposit_kind_id}  last_error=${r.last_error}`);
  console.log(`  notes=${r.notes}`);

  // ── 2. sales_log twin (email / phone / product / total) ──────────
  const sales = (await sql`
    SELECT ts, reservation_number, race_product_names, total_usd, email, phone,
           deposit_credit_pending, package_id
    FROM sales_log
    WHERE bill_id = ${r.source_ref}
    ORDER BY ts`) as any[];
  if (sales.length === 0) console.log("  sales_log: NO ROW for this bill_id");
  for (const s of sales) {
    console.log(
      `  sales_log: ts=${s.ts} products=${JSON.stringify(s.race_product_names)} total=$${s.total_usd} email=${s.email} phone=${s.phone} pending=${s.deposit_credit_pending} resv=${s.reservation_number}`,
    );
  }

  // ── 3. Square payment(s) ──────────────────────────────────────────
  const noteIds = [...String(r.notes ?? "").matchAll(/\b(?:gc|card)=([A-Za-z0-9]{10,})/g)].map(
    (m) => m[1],
  );
  let payments: any[] = [];
  for (const pid of noteIds) {
    const data = await sqGet(`/payments/${pid}`);
    if (data.__error) console.log(`  square GET ${pid}: ${data.__error}`);
    else if (data.payment) payments.push(data.payment);
  }
  if (payments.length === 0) {
    console.log(`  no payment id in notes — scanning Square by note "Ref: ${r.source_ref}" …`);
    const found = await findPaymentByBillRef(String(r.source_ref), String(r.created_at));
    if (found) payments.push(found);
  }
  if (payments.length === 0) {
    console.log("  square: NO PAYMENT FOUND — needs manual Square dashboard search");
  }
  for (const p of payments) {
    console.log(`  square: ${JSON.stringify(describePayment(p), null, 2).replace(/\n/g, "\n  ")}`);
    if (p.customer_id) {
      const c = await sqGet(`/customers/${p.customer_id}`);
      if (c.customer) {
        console.log(
          `  square customer: ${c.customer.given_name ?? ""} ${c.customer.family_name ?? ""} email=${c.customer.email_address ?? "-"} phone=${c.customer.phone_number ?? "-"}`,
        );
      }
    }
  }
}
console.log("═".repeat(72));
console.log("done (read-only — no writes performed)");
