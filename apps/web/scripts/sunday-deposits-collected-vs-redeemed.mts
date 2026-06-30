/**
 * READ-ONLY: For deposit eGift cards COLLECTED on Sunday 2026-06-14 (ET),
 * across ALL sources (bowling/combo reservations + group-function quotes),
 * report how many of THOSE have since been REDEEMED.
 *
 * Collected =
 *   - bowling_reservations.booked_at (ET date) == DAY  AND square_gift_card_id set
 *     (combo VIP legs included; both legs share ONE gift card → dedup by gc id)
 *   - group_function_quotes.deposit_paid_at (ET date) == DAY AND a gift card gan set
 * Redeemed = the gift card has at least one REDEEM activity in Square.
 *
 * No writes. GET /gift-cards + GET /gift-cards/activities only.
 *   node --env-file=apps/web/.env.local apps/web/scripts/sunday-deposits-collected-vs-redeemed.mts
 */
import { readFileSync } from "node:fs";

// Load apps/web/.env.local regardless of cwd (mirrors the other scripts).
for (const path of ["apps/web/.env.local", ".env.local"]) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
    break;
  } catch {
    /* try next */
  }
}

const { neon } = await import("@neondatabase/serverless");
const DATABASE_URL = process.env.DATABASE_URL!;
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";
const DAY = process.argv[2] ?? "2026-06-14";
if (!DATABASE_URL || !TOKEN) {
  console.error("Need DATABASE_URL + SQUARE_ACCESS_TOKEN (use --env-file=apps/web/.env.local)");
  process.exit(1);
}
const sql = neon(DATABASE_URL);
const H = {
  Authorization: `Bearer ${TOKEN}`,
  "Square-Version": SQUARE_VERSION,
  "Content-Type": "application/json",
};

type Dep = {
  source: string;
  ref: string;
  gcId?: string;
  gan?: string;
  cents: number;
};

// 1) Bowling + combo reservations collected on DAY (ET) with a gift card.
// Pass "bowling" as 2nd arg to restrict to bowling proper (open + kbf),
// excluding race / attraction / combo legs. Default = all kinds.
const ONLY_BOWLING = process.argv[3] === "bowling";
const bowling = (await sql`
  SELECT id, product_kind, combo_special_id, square_gift_card_id, square_gift_card_gan,
         deposit_cents, status, guest_name
  FROM bowling_reservations
  WHERE (booked_at AT TIME ZONE 'America/New_York')::date = ${DAY}::date
    AND square_gift_card_id IS NOT NULL
    AND square_gift_card_id <> ''
    ${ONLY_BOWLING ? sql`AND product_kind IN ('open','kbf') AND combo_special_id IS NULL` : sql``}
  ORDER BY id
`) as any[];

// 2) Group-function quotes whose deposit was paid on DAY (ET) with a gift card.
const gf = (await sql`
  SELECT id, event_name, event_number, square_gift_card_gan, deposit_due_cents, status
  FROM group_function_quotes
  WHERE (deposit_paid_at AT TIME ZONE 'America/New_York')::date = ${DAY}::date
    AND square_gift_card_gan IS NOT NULL
    AND square_gift_card_gan <> ''
    AND status NOT IN ('cancelled','denied')
  ORDER BY id
`) as any[];

const deposits: Dep[] = [
  ...bowling.map((r) => ({
    source: r.combo_special_id ? `combo:${r.product_kind}` : `bowling:${r.product_kind}`,
    ref: `res#${r.id} ${r.guest_name ?? ""} ${r.combo_special_id ? `[combo ${r.combo_special_id}]` : ""}`.trim(),
    gcId: r.square_gift_card_id as string,
    gan: (r.square_gift_card_gan as string) ?? undefined,
    cents: r.deposit_cents ?? 0,
  })),
  ...gf.map((r) => ({
    source: "group-function",
    ref: `gf#${r.id} ${r.event_name} #${r.event_number ?? "?"}`,
    gan: r.square_gift_card_gan as string,
    cents: r.deposit_due_cents ?? 0,
  })),
];

console.log(`Sunday ${DAY} (ET): ${bowling.length} bowling/combo reservation rows + ${gf.length} GF quotes with a deposit gift card.\n`);

// Dedup by gift card identity. Combos share ONE gc across two legs → count once.
// Group-function rows may store a comma/array of GANs (>$2k chunked); split them.
type Card = { key: string; gcId?: string; gan?: string; sources: Set<string>; refs: Set<string>; cents: number };
const cards = new Map<string, Card>();
function addCard(gcId: string | undefined, gan: string | undefined, d: Dep) {
  const key = gcId ?? `gan:${gan}`;
  let c = cards.get(key);
  if (!c) {
    c = { key, gcId, gan, sources: new Set(), refs: new Set(), cents: 0 };
    cards.set(key, c);
  }
  c.sources.add(d.source);
  c.refs.add(d.ref);
  c.cents += d.cents;
}
for (const d of deposits) {
  if (d.gcId) {
    addCard(d.gcId, d.gan, d);
  } else if (d.gan) {
    for (const g of String(d.gan).replace(/[[\]"]/g, "").split(/[,\s]+/).filter(Boolean)) {
      addCard(undefined, g, { ...d, cents: 0 }); // cents counted once below via first
    }
  }
}

async function sq(path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: H });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && !data.errors, status: res.status, data };
}

// Resolve a GAN → gift card id when we only have the GAN (GF rows).
async function gcIdFromGan(gan: string): Promise<string | undefined> {
  const res = await fetch(`${BASE}/gift-cards/from-gan`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ gan }),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? data.gift_card?.id : undefined;
}

async function isRedeemed(gcId: string): Promise<{ redeemed: boolean; redeemedCents: number; state?: string; balance?: number }> {
  // List activities for this card; look for any REDEEM.
  let cursor: string | undefined;
  let redeemedCents = 0;
  let redeemed = false;
  do {
    const qs = new URLSearchParams({ gift_card_id: gcId, type: "REDEEM" });
    if (cursor) qs.set("cursor", cursor);
    const r = await sq(`/gift-cards/activities?${qs.toString()}`);
    if (!r.ok) break;
    const acts = (r.data.gift_card_activities ?? []) as any[];
    for (const a of acts) {
      if (a.type === "REDEEM") {
        redeemed = true;
        redeemedCents += a.redeem_activity_details?.amount_money?.amount ?? 0;
      }
    }
    cursor = r.data.cursor;
  } while (cursor);
  const g = await sq(`/gift-cards/${gcId}`);
  return {
    redeemed,
    redeemedCents,
    state: g.data.gift_card?.state,
    balance: g.data.gift_card?.balance_money?.amount,
  };
}

const D = (c: number) => `$${(c / 100).toFixed(2)}`;
let collectedCount = 0;
let redeemedCount = 0;
let collectedCents = 0;
let redeemedCents = 0;

console.log(`Unique deposit gift cards collected: ${cards.size}\n`);
for (const c of cards.values()) {
  let gcId = c.gcId;
  if (!gcId && c.gan) gcId = await gcIdFromGan(c.gan);
  if (!gcId) {
    console.log(`?  ${[...c.refs].join("; ")}  gan=${c.gan} — could not resolve gift card id`);
    collectedCount++;
    collectedCents += c.cents;
    continue;
  }
  const v = await isRedeemed(gcId);
  collectedCount++;
  collectedCents += c.cents;
  if (v.redeemed) {
    redeemedCount++;
    redeemedCents += v.redeemedCents;
  }
  console.log(
    `${v.redeemed ? "✓REDEEMED" : "·collected"}  ${[...c.sources].join(",")}  ${[...c.refs].join("; ")}\n` +
      `   gan=${c.gan ?? "?"} dep=${D(c.cents)} state=${v.state} balance=${D(v.balance ?? 0)}` +
      (v.redeemed ? ` redeemed=${D(v.redeemedCents)}` : ""),
  );
}

console.log(`\n──────── Sunday ${DAY} deposit summary ────────`);
console.log(`Collected: ${collectedCount} deposit gift cards  (${D(collectedCents)})`);
console.log(`Redeemed:  ${redeemedCount} of those  (${D(redeemedCents)} redeemed)`);
console.log(`Outstanding (collected, not yet redeemed): ${collectedCount - redeemedCount}`);
process.exit(0);
