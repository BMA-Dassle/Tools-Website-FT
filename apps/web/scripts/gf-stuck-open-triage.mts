/** READ-ONLY triage of specific stuck-OPEN past GF day-of orders.
 * For each id: dump status/paid markers + settlement markers, fetch the day-of
 * order, and (if a gift card is linked) its balance — to tell "POS-settled, OPEN
 * is fine" apart from "money parked on a card, order never settled". */
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
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL!);
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const BASE = "https://connect.squareup.com/v2";
const H = { Authorization: `Bearer ${TOKEN}`, "Square-Version": "2024-12-18", "Content-Type": "application/json" };
const D = (c: number | null | undefined) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);
const IDS = (process.argv[2] ?? "48,10,117,58,160,59").split(",").map((s) => Number(s.trim()));

const rows = (await sql`
  SELECT id, event_name, event_number, center_code, event_date, status,
         total_cents, deposit_due_cents, balance_cents,
         deposit_paid_at, balance_paid_at, dayof_paid_at,
         square_dayof_order_id, square_gift_card_id, square_gift_card_gan,
         square_settled_order_id, contract_short_id, bmi_reservation_id
  FROM group_function_quotes
  WHERE id = ANY(${IDS})
  ORDER BY event_date
`) as any[];

async function getOrder(id: string) {
  const res = await fetch(`${BASE}/orders/${id}`, { headers: H });
  const o = (await res.json().catch(() => ({}))).order;
  if (!o) return null;
  return {
    state: o.state as string,
    total: o.total_money?.amount ?? 0,
    due: o.net_amount_due_money?.amount ?? 0,
    paid: o.total_money?.amount ? (o.total_money.amount - (o.net_amount_due_money?.amount ?? 0)) : 0,
    location: o.location_id,
    created: o.created_at,
    tenders: (o.tenders ?? []).length,
  };
}
async function getGiftCard(id: string) {
  const res = await fetch(`${BASE}/gift-cards/${id}`, { headers: H });
  const g = (await res.json().catch(() => ({}))).gift_card;
  return g ? { state: g.state, balance: g.balance_money?.amount ?? 0 } : null;
}

for (const r of rows) {
  const ed = (r.event_date instanceof Date ? r.event_date.toISOString() : String(r.event_date)).slice(0, 16);
  console.log(`\n━━━ gf#${r.id}  #${r.event_number}  "${r.event_name}"  (${r.center_code})  ${ed} ━━━`);
  console.log(
    `  status=${r.status}  total=${D(r.total_cents)}  depositDue=${D(r.deposit_due_cents)}  balance=${D(r.balance_cents)}`,
  );
  console.log(
    `  deposit_paid_at=${r.deposit_paid_at ?? "—"}  balance_paid_at=${r.balance_paid_at ?? "—"}  dayof_paid_at=${r.dayof_paid_at ?? "—"}`,
  );
  console.log(
    `  square_settled_order_id=${r.square_settled_order_id ?? "—"}   (set ⇒ POS-settled, OPEN day-of is EXPECTED)`,
  );
  console.log(`  giftCardId=${r.square_gift_card_id ?? "—"}  gan=${r.square_gift_card_gan ?? "—"}`);

  for (const oid of [r.square_dayof_order_id].filter(Boolean)) {
    const o = await getOrder(String(oid));
    if (!o) {
      console.log(`  day-of order ${oid}: FETCH-FAIL`);
      continue;
    }
    console.log(
      `  day-of order ${String(oid).slice(0, 10)}…  state=${o.state}  total=${D(o.total)}  paid=${D(o.paid)}  due=${D(o.due)}  tenders=${o.tenders}  created=${String(o.created).slice(0, 10)}`,
    );
  }
  if (r.square_gift_card_id) {
    const g = await getGiftCard(String(r.square_gift_card_id));
    if (g) {
      const due = r.balance_cents ?? r.total_cents ?? 0;
      console.log(
        `  GIFT CARD  state=${g.state}  balance=${D(g.balance)}   ${g.balance > 0 ? `⚠ MONEY PARKED — covers day-of? ${g.balance >= due}` : "(empty — already spent)"}`,
      );
    } else {
      console.log(`  GIFT CARD ${r.square_gift_card_id}: FETCH-FAIL`);
    }
  }

  // Audit log: was this closed by square-settled-close?
  try {
    const log = (await sql`
      SELECT event, created_at FROM group_function_audit_log
      WHERE quote_id = ${r.id} ORDER BY created_at`) as any[];
    if (log.length) console.log(`  audit: ${log.map((l) => l.event).join(", ")}`);
  } catch {
    /* table may differ */
  }
}
process.exit(0);
