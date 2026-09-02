/**
 * Backfill HeadPinz Rewards points for race / attraction bookings that were
 * never credited.
 *
 * WHY: Square does not accrue on its own for Orders-API orders, and the
 * race-dayof-pay cron never called AccumulateLoyaltyPoints (bowling's
 * processLaneOpen did). Every fully-paid, customer-linked race order since
 * 2026-05-31 therefore earned the guest nothing. Measured 2026-08-27 against
 * Square's ledger: 1,161 of 1,166 such orders had zero accrual events —
 * $100,095.49 of eligible spend, ~1,000,268 Pinz.
 *
 * HOW: for each candidate we ask Square directly whether that order already has
 * a loyalty event (`order_filter`), and only accrue the ones that do not. Square
 * recomputes the points from the order's own catalog lines and the program's
 * accrual rule + exclusions, so the guest gets exactly what they should have got
 * — we never invent a number.
 *
 * DRY RUN BY DEFAULT. Nothing is written without --apply.
 *
 *   npx tsx scripts/loyalty-race-backfill.mts                  # plan only
 *   npx tsx scripts/loyalty-race-backfill.mts --only=21759     # one row, plan
 *   npx tsx scripts/loyalty-race-backfill.mts --only=21759 --apply
 *   npx tsx scripts/loyalty-race-backfill.mts --apply          # credit everyone
 *
 * Idempotent: the key is `backfill-loyalty-{reservationId}`, and the
 * already-accrued check runs per row, so a re-run cannot double-credit.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync, writeFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const APPLY = process.argv.includes("--apply");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
/**
 * --enrolled-only restricts the credit to bookings made when the guest was
 * ALREADY a rewards member. Without it, ~109 bookings belong to people who
 * joined after that race — crediting those is goodwill, not a correction, so it
 * is an explicit choice rather than a silent default either way.
 */
const ENROLLED_ONLY = process.argv.includes("--enrolled-only");
const KINDS = (
  process.argv.find((a) => a.startsWith("--kinds="))?.split("=")[1] ?? "race,attraction"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SQUARE_BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2024-12-18",
  "Content-Type": "application/json",
};

async function sq(path: string, body?: unknown): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${SQUARE_BASE}${path}`, {
      method: body ? "POST" : "GET",
      headers: H,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((s) => setTimeout(s, 800 * (attempt + 1)));
      continue;
    }
    return { _err: `${res.status} ${text.slice(0, 200)}` };
  }
  return { _err: "retries exhausted" };
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array(items.length) as R[];
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

const { sql } = await import("@ft/db");
const q = sql();

const rows = (await q.query(
  `SELECT id, booked_at, guest_name, guest_phone, product_kind, total_cents,
          square_customer_id AS cid, square_dayof_order_id AS oid
     FROM bowling_reservations
    WHERE product_kind = ANY($1)
      AND square_customer_id IS NOT NULL
      AND square_dayof_order_id IS NOT NULL
      AND total_cents > 0
      AND status <> 'cancelled'
      ${ONLY ? "AND id = $2" : ""}
    ORDER BY booked_at`,
  ONLY ? [KINDS, Number(ONLY)] : [KINDS],
)) as any[];

console.log(
  `${APPLY ? "APPLY" : "DRY RUN"} — kinds=${KINDS.join(",")}${ONLY ? ` only=${ONLY}` : ""}`,
);
console.log(`${rows.length} paid, customer-linked bookings to examine\n`);
if (rows.length === 0) process.exit(0);

// Which customers hold a loyalty account (30 ids max per search).
const cids = [...new Set(rows.map((r) => r.cid))] as string[];
const acctOf = new Map<string, string>();
// enrolled_at comes back on the search response — no extra round trip needed.
const enrolledAt = new Map<string, string>();
for (let i = 0; i < cids.length; i += 30) {
  const res = await sq("/loyalty/accounts/search", {
    query: { customer_ids: cids.slice(i, i + 30) },
    limit: 200,
  });
  for (const a of res.loyalty_accounts ?? []) {
    acctOf.set(a.customer_id, a.id);
    enrolledAt.set(a.id, a.enrolled_at ?? a.created_at ?? "");
  }
}
let members = rows.filter((r) => acctOf.has(r.cid));
console.log(
  `  ${acctOf.size}/${cids.length} customers are rewards members → ${members.length} bookings\n`,
);

if (ENROLLED_ONLY) {
  const before = members.length;
  members = members.filter((r) => {
    const en = enrolledAt.get(acctOf.get(r.cid)!);
    return en ? new Date(en).getTime() <= new Date(r.booked_at).getTime() : false;
  });
  console.log(
    `  --enrolled-only: dropped ${before - members.length} booking(s) made before the guest joined → ${members.length}\n`,
  );
}

type Row = (typeof members)[number];
interface Plan {
  row: Row;
  acct: string;
  locationId?: string;
  gross: number;
  state?: string;
  due?: number | null;
  already: boolean;
  skip?: string;
}

let scanned = 0;
const plans = await pool(members, 8, async (r: Row): Promise<Plan> => {
  const acct = acctOf.get(r.cid)!;
  const [ord, ev] = await Promise.all([
    sq(`/orders/${r.oid}`),
    sq("/loyalty/events/search", {
      query: { filter: { order_filter: { order_id: r.oid } } },
      limit: 30,
    }),
  ]);
  if (++scanned % 200 === 0) console.log(`  scanned ${scanned}/${members.length}`);
  const o = ord.order;
  if (!o)
    return {
      row: r,
      acct,
      gross: 0,
      already: false,
      skip: `order unreadable (${ord._err ?? "?"})`,
    };
  const due = o.net_amount_due_money?.amount ?? null;
  const gross = (o.line_items ?? []).reduce(
    (s: number, li: any) => s + (li.gross_sales_money?.amount ?? 0),
    0,
  );
  const already = (ev.events ?? []).some((e: any) => e.type === "ACCUMULATE_POINTS");
  return {
    row: r,
    acct,
    locationId: o.location_id,
    gross,
    state: o.state,
    due,
    already,
    skip: due !== 0 ? `not fully paid (due ${due})` : undefined,
  };
});

const todo = plans.filter((p) => !p.already && !p.skip);
const alreadyDone = plans.filter((p) => p.already);
const skipped = plans.filter((p) => p.skip);
const estPts = todo.reduce((s, p) => s + Math.floor((p.gross / 100) * 10), 0);

console.log(`\n═══ PLAN ═══`);
console.log(`  already credited      : ${alreadyDone.length}`);
console.log(`  skipped (not payable) : ${skipped.length}`);
console.log(`  TO CREDIT             : ${todo.length}`);
console.log(
  `  eligible gross        : $${(todo.reduce((s, p) => s + p.gross, 0) / 100).toFixed(2)}`,
);
console.log(`  estimated Pinz        : ${estPts}  (Square computes the real figure)`);
console.log(
  `  guest value           : ~$${((estPts / 1000) * 10).toFixed(2)} at 1000 Pinz = $10\n`,
);

for (const p of todo.slice(0, ONLY ? 50 : 20))
  console.log(
    `   id=${String(p.row.id).padEnd(6)} ${new Date(p.row.booked_at).toISOString().slice(0, 10)} ` +
      `${String(p.row.guest_name).slice(0, 22).padEnd(22)} ${p.row.product_kind} ` +
      `gross=$${(p.gross / 100).toFixed(2).padStart(7)} → ~${Math.floor((p.gross / 100) * 10)} Pinz  acct=${p.acct}`,
  );
if (!ONLY && todo.length > 20) console.log(`   … and ${todo.length - 20} more`);

if (!APPLY) {
  // Dump the WHOLE plan, not the 20 rows printed above — a credit to hundreds of
  // real guest accounts should be reviewable in full before anyone types --apply.
  const csv = [
    "reservation_id,booked_on,guest_name,guest_phone,kind,eligible_gross_usd,est_pinz,loyalty_account,order_id",
    ...todo.map((p) =>
      [
        p.row.id,
        new Date(p.row.booked_at).toISOString().slice(0, 10),
        `"${String(p.row.guest_name ?? "").replace(/"/g, "''")}"`,
        p.row.guest_phone ?? "",
        p.row.product_kind,
        (p.gross / 100).toFixed(2),
        Math.floor((p.gross / 100) * 10),
        p.acct,
        p.row.oid,
      ].join(","),
    ),
  ].join("\n");
  writeFileSync("loyalty-race-backfill-plan.csv", csv);

  // Per-guest roll-up: what any ONE guest is about to receive. A single account
  // with an implausible total is the cheapest signal that something is wrong.
  const byAcct = new Map<string, { name: string; rows: number; pts: number; gross: number }>();
  for (const p of todo) {
    const g = byAcct.get(p.acct) ?? { name: String(p.row.guest_name ?? ""), rows: 0, pts: 0, gross: 0 };
    g.rows++;
    g.pts += Math.floor((p.gross / 100) * 10);
    g.gross += p.gross;
    byAcct.set(p.acct, g);
  }
  const perGuest = [...byAcct.entries()].sort((a, b) => b[1].pts - a[1].pts);
  console.log(`\n═══ PER-GUEST ROLL-UP ═══`);
  console.log(`  distinct rewards accounts to credit : ${perGuest.length}`);
  console.log(`  largest single credit               : ${perGuest[0]?.[1].pts ?? 0} Pinz (~$${(((perGuest[0]?.[1].pts ?? 0) / 1000) * 10).toFixed(2)})`);
  const median = perGuest.length ? perGuest[Math.floor(perGuest.length / 2)][1].pts : 0;
  console.log(`  median credit                       : ${median} Pinz (~$${((median / 1000) * 10).toFixed(2)})`);
  console.log(`\n  top 10 credits:`);
  for (const [acct, g] of perGuest.slice(0, 10))
    console.log(
      `    ${String(g.name).slice(0, 24).padEnd(24)} ${String(g.rows).padStart(3)} bookings  ` +
        `$${(g.gross / 100).toFixed(2).padStart(8)}  → ${String(g.pts).padStart(6)} Pinz  ${acct}`,
    );

  writeFileSync(
    "loyalty-race-backfill-plan.json",
    JSON.stringify(
      {
        generatedFor: "dry run",
        kinds: KINDS,
        examined: rows.length,
        members: members.length,
        alreadyCredited: alreadyDone.length,
        notPayable: skipped.map((p) => ({ id: p.row.id, why: p.skip })),
        toCredit: todo.length,
        eligibleGrossCents: todo.reduce((s, p) => s + p.gross, 0),
        estimatedPinz: estPts,
        distinctAccounts: perGuest.length,
        rows: todo.map((p) => ({
          id: p.row.id,
          bookedAt: p.row.booked_at,
          name: p.row.guest_name,
          phone: p.row.guest_phone,
          kind: p.row.product_kind,
          grossCents: p.gross,
          estPinz: Math.floor((p.gross / 100) * 10),
          acct: p.acct,
          orderId: p.row.oid,
          orderState: p.state,
        })),
      },
      null,
      1,
    ),
  );

  console.log(`\n  full plan → apps/web/loyalty-race-backfill-plan.csv (${todo.length} rows)`);
  console.log(`            → apps/web/loyalty-race-backfill-plan.json`);
  console.log(`\nDRY RUN — nothing written to Square.`);
  console.log(
    `Next: --only=<id> --apply on ONE booking first, confirm in Square, then the rest.`,
  );
  process.exit(0);
}

console.log(`\n═══ APPLYING ═══`);
let ok = 0,
  failed = 0,
  points = 0;
const log: any[] = [];
const results = await pool(todo, 4, async (p) => {
  const res = await sq(`/loyalty/accounts/${p.acct}/accumulate`, {
    accumulate_points: { order_id: p.row.oid },
    location_id: p.locationId,
    idempotency_key: `backfill-loyalty-${p.row.id}`,
  });
  if (res._err) {
    failed++;
    console.log(`   ✗ id=${p.row.id} ${p.row.guest_name}: ${res._err}`);
    return { id: p.row.id, ok: false, err: res._err };
  }
  const pts = (res.events ?? []).reduce(
    (s: number, e: any) => s + (e.accumulate_points?.points ?? 0),
    0,
  );
  ok++;
  points += pts;
  console.log(`   ✓ id=${p.row.id} ${String(p.row.guest_name).slice(0, 22)} +${pts} Pinz`);
  return { id: p.row.id, ok: true, points: pts, acct: p.acct, order: p.row.oid };
});
log.push(...results);

console.log(`\n═══ DONE ═══`);
console.log(
  `  credited : ${ok} bookings, ${points} Pinz (~$${((points / 1000) * 10).toFixed(2)} guest value)`,
);
console.log(`  failed   : ${failed}`);
writeFileSync("loyalty-race-backfill-result.json", JSON.stringify(log, null, 1));
console.log(`  per-row result → apps/web/loyalty-race-backfill-result.json`);
process.exit(failed > 0 ? 1 : 0);
