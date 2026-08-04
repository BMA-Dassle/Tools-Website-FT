/**
 * "Square says we can refund to a gift card or credit card" — which shape?
 *
 * The 7/28 unlinked probes all failed on any DISBURSING destination. But Square's
 * own support doc describes the Dashboard/POS feature as a **cross-tender
 * refund**: a refund of an EXISTING payment (`payment_id` present, so NOT
 * unlinked) whose `destination_id` points somewhere other than the original
 * tender. That is a different API shape than anything probed so far, and it is
 * very likely what the rep means. The doc also notes two things that make the
 * earlier gift-card failure suspect:
 *   - only PENDING or ACTIVE gift cards are legal destinations (a refund to a
 *     PENDING card auto-activates it)
 *   - $2,000 load limit including existing balance
 * The card used on 7/28 was ACTIVE but had a CUSTOM gan (`gan_source: "OTHER"`,
 * a WEBPRB… internal-shape card). A Square-issued gift card may behave
 * differently as a destination — untested confounder.
 *
 * Arms:
 *   T0  read-only: what scopes does our access token actually hold?
 *   T1  CROSS-TENDER LINKED refund — payment_id = a GC-A-funded soda payment,
 *       destination_id = gift card B. The shape the Dashboard uses.
 *   T2  ITEMIZED cross-tender — same, plus order_id = a proper return order
 *       against the PAID soda order (paid source, so returns[] is legal here —
 *       unlike the unlinked case). If T1 and T2 both work we get money movement
 *       AND item attribution, which no unlinked shape can give us.
 *   T3  UNLINKED to a SQUARE-issued gift card — re-runs 7/28's failure with the
 *       custom-GAN confounder removed.
 *
 * All gift-card funded via comped orders at the non-accounting location. No real
 * card is charged and no real money leaves; landed value is drained at the end.
 *
 * Run from apps/web:
 *   npx tsx scripts/refund-to-giftcard-crosstender-probe.mts          # dry run
 *   npx tsx scripts/refund-to-giftcard-crosstender-probe.mts --live
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const LIVE = process.argv.includes("--live");
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2025-01-23",
  "Content-Type": "application/json",
};
const LOCATION = "6MZJFTGAYD7TC";
const SODA_VARIATION_ID = "NTLI7WKX6QVXCOZNA4YC3GZ7"; // Fountain Soda FM, 20 oz, 400¢
const TAX_ID = "UBPQTR3W6ZKVRYFC7DXN2SJN"; // Lee County Sales Tax 6.5%
const FUND = 2000; // funds GC-A for two soda orders (T1 + T2)
const REASON = "Refund: Reservation Deposit";
const KEY = `xtnd-${randomUUID().slice(0, 8)}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function sq(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { ok: res.ok && !(json?.errors?.length > 0), status: res.status, json };
}
const errStr = (r: { status: number; json: any }) =>
  `HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 350)}`;
const codes = (r: { json: any }) =>
  (r.json?.errors ?? []).map((e: any) => `${e.category}/${e.code}`).join(",") || "-";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const findings: string[] = [];
const record = (q: string, a: string) => {
  findings.push(`${q}: ${a}`);
  console.log(`\n>>> ${q}\n    ${a}`);
};

// ── T0: token scopes (read-only, safe in dry run too) ───────────────────────
console.log("═══ T0  access-token scopes ═══");
const ts = await sq("POST", "/oauth2/token/status");
if (ts.ok) {
  console.log(`  merchant=${ts.json.merchant_id} client=${ts.json.client_id ?? "n/a"}`);
  console.log(`  expires=${ts.json.expires_at ?? "never"}`);
  console.log(`  scopes: ${(ts.json.scopes ?? []).join(", ")}`);
} else {
  console.log(`  unavailable (normal for a personal access token): ${errStr(ts)}`);
}

if (!LIVE) {
  console.log("\n=== DRY RUN (pass --live to execute) ===");
  console.log(`Would, at ${LOCATION}, all gift-card funded (no real card charged):`);
  console.log(`  setup  GC-A comp-funded ${FUND}¢ (Square-issued gan); two paid soda orders`);
  console.log("  T1     linked refund, payment_id + destination_id = GC-B  (cross-tender)");
  console.log("  T2     same + order_id = a real return order              (itemized)");
  console.log("  T3     unlinked refund → GC-C, Square-issued gan          (confounder removed)");
  console.log("  then   watch each destination card for the credit, then drain");
  process.exit(0);
}

const toDrain: string[] = [];
let gcA: string | undefined;

/** Comp-fund a Square-issued gift card with `amount`. */
async function mintCard(tag: string, amount: number) {
  const c = await sq("POST", "/gift-cards", {
    idempotency_key: `${KEY}-c${tag}`,
    location_id: LOCATION,
    gift_card: { type: "DIGITAL" }, // Square generates the GAN — NOT gan_source OTHER
  });
  if (!c.ok) throw new Error(`mint ${tag}: ${errStr(c)}`);
  const id = c.json.gift_card.id as string;
  console.log(`  GC-${tag} ${id} state=${c.json.gift_card.state} gan=${c.json.gift_card.gan}`);
  if (amount <= 0) return id; // leave PENDING — a legal destination per Square's doc
  const co = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-o${tag}`,
    order: {
      location_id: LOCATION,
      line_items: [
        {
          name: "eGiftCard (probe funding)",
          quantity: "1",
          item_type: "GIFT_CARD",
          base_price_money: { amount, currency: "USD" },
        },
      ],
      discounts: [
        { name: "Probe comp", amount_money: { amount, currency: "USD" }, scope: "ORDER" },
      ],
    },
  });
  if (!co.ok) throw new Error(`comp ${tag}: ${errStr(co)}`);
  await sq("POST", `/orders/${co.json.order.id}/pay`, {
    idempotency_key: `${KEY}-p${tag}`,
    payment_ids: [],
  });
  const a = await sq("POST", "/gift-cards/activities", {
    idempotency_key: `${KEY}-a${tag}`,
    gift_card_activity: {
      type: "ACTIVATE",
      location_id: LOCATION,
      gift_card_id: id,
      activate_activity_details: {
        order_id: co.json.order.id,
        line_item_uid: co.json.order.line_items[0].uid,
      },
    },
  });
  if (!a.ok) throw new Error(`activate ${tag}: ${errStr(a)}`);
  return id;
}

/** A soda order, paid in full by GC-A. Returns ids + the soda line uid. */
async function paidSodaOrder(tag: string) {
  const o = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-so${tag}`,
    order: {
      location_id: LOCATION,
      line_items: [{ uid: "SODA", catalog_object_id: SODA_VARIATION_ID, quantity: "1" }],
      taxes: [{ uid: "TX", catalog_object_id: TAX_ID, scope: "ORDER" }],
    },
  });
  if (!o.ok) throw new Error(`soda order ${tag}: ${errStr(o)}`);
  const total = o.json.order.total_money.amount as number;
  const pay = await sq("POST", "/payments", {
    idempotency_key: `${KEY}-sp${tag}`,
    source_id: gcA,
    amount_money: { amount: total, currency: "USD" },
    order_id: o.json.order.id,
    location_id: LOCATION,
    autocomplete: true,
  });
  if (!pay.ok) throw new Error(`soda payment ${tag}: ${errStr(pay)}`);
  const line = o.json.order.line_items.find((l: any) => l.uid === "SODA") ?? o.json.order.line_items[0];
  return {
    orderId: o.json.order.id as string,
    paymentId: pay.json.payment.id as string,
    total,
    lineUid: line.uid as string,
  };
}

/**
 * Watch a gift card for landed value. Credit is ASYNC (finding G3).
 *
 * `priorRefundActs` MUST be the REFUND-activity count from before this arm.
 * The first version of this helper treated "a REFUND activity exists" as
 * success, so the second arm reported the FIRST arm's credit as its own — a
 * false positive that inverted the T2 result on the 2026-07-28 run. An arm's
 * evidence has to be a change it caused, never a state it inherited.
 */
async function watchCard(id: string, want: number, label: string, priorRefundActs = 0) {
  for (let i = 0; i < 9; i++) {
    const c = await sq("GET", `/gift-cards/${id}`);
    const bal = c.json?.gift_card?.balance_money?.amount ?? 0;
    const st = c.json?.gift_card?.state;
    const acts = await sq("GET", `/gift-cards/activities?gift_card_id=${id}&limit=50`);
    const kinds = (acts.json?.gift_card_activities ?? []).map((a: any) => a.type);
    const newRefunds = kinds.filter((k: string) => k === "REFUND").length - priorRefundActs;
    console.log(
      `    ${label} +${i * 10}s state=${st} balance=${bal}¢ acts=[${kinds.join(",")}] ` +
        `newREFUND=${newRefunds}`,
    );
    if (bal >= want && newRefunds > 0) return { landed: true, bal, st, kinds };
    if (i < 8) await sleep(10_000);
  }
  return { landed: false, bal: 0, st: "?", kinds: [] as string[] };
}

try {
  console.log("\n═══ setup ═══");
  gcA = await mintCard("A", FUND);
  toDrain.push(gcA);
  const gcB = await mintCard("B", 0); // PENDING — doc says a refund auto-activates it
  const gcC = await mintCard("C", 0); // PENDING, for the unlinked arm
  toDrain.push(gcB, gcC);

  const s1 = await paidSodaOrder("1");
  console.log(`  soda order 1 ${s1.orderId} ${s1.total}¢ paid by GC-A (payment ${s1.paymentId})`);

  // ── T1: cross-tender LINKED refund → gift card B ─────────────────────────
  // NOTE: a LINKED refund must NOT carry location_id — Square derives it from
  // the payment and rejects it with CONFLICTING_PARAMETERS ("Supplying
  // location_id is not allowed"). Only unlinked refunds take location_id.
  const t1 = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-t1`,
    payment_id: s1.paymentId,
    amount_money: { amount: s1.total, currency: "USD" },
    destination_id: gcB,
    reason: REASON,
  });
  record(
    `T1  CROSS-TENDER linked refund ${s1.total}¢ — payment_id + destination_id = GC-B`,
    t1.ok
      ? `ACCEPTED — refund ${t1.json.refund?.id} status=${t1.json.refund?.status} ` +
          `destination_type=${t1.json.refund?.destination_type ?? "?"}`
      : `REFUSED — ${codes(t1)} — ${errStr(t1)}`,
  );
  if (t1.ok) {
    const w = await watchCard(gcB, s1.total, "GC-B");
    record(
      "T1  did the money LAND on GC-B?",
      w.landed
        ? `YES — state=${w.st} balance=${w.bal}¢ acts=[${w.kinds.join(",")}]. Cross-tender refund ` +
            `to a gift card WORKS. This is the "refund to gift card" the rep means.`
        : `NO — nothing landed in ~90s. Accepted but not credited: the same limbo as the ` +
            `itemized-refund blocker. Not usable.`,
    );
  }

  // ── T2: cross-tender AND itemized ────────────────────────────────────────
  if (t1.ok) {
    const s2 = await paidSodaOrder("2");
    const ret = await sq("POST", "/orders", {
      idempotency_key: `${KEY}-ret`,
      order: {
        location_id: LOCATION,
        returns: [
          {
            source_order_id: s2.orderId,
            return_line_items: [{ uid: "R1", source_line_item_uid: s2.lineUid, quantity: "1" }],
          },
        ],
      },
    });
    if (!ret.ok) {
      record("T2  ITEMIZED cross-tender", `return order REFUSED — ${codes(ret)} — ${errStr(ret)}`);
    } else {
      const retTotal = ret.json.order.return_amounts.total_money.amount as number;
      const t2 = await sq("POST", "/refunds", {
        idempotency_key: `${KEY}-t2`,
        payment_id: s2.paymentId,
        amount_money: { amount: retTotal, currency: "USD" },
        order_id: ret.json.order.id,
        destination_id: gcB,
        reason: REASON,
      });
      record(
        `T2  ITEMIZED cross-tender ${retTotal}¢ — payment_id + order_id + destination_id`,
        t2.ok
          ? `ACCEPTED — refund ${t2.json.refund?.id} status=${t2.json.refund?.status}`
          : `REFUSED — ${codes(t2)} — ${errStr(t2)}`,
      );
      if (t2.ok) {
        const before = await sq("GET", `/gift-cards/${gcB}`);
        const base = before.json?.gift_card?.balance_money?.amount ?? 0;
        const w = await watchCard(gcB, base + retTotal, "GC-B");
        record(
          "T2  did the ITEMIZED cross-tender money LAND?",
          w.landed
            ? `YES — balance=${w.bal}¢. Item attribution AND money movement in one refund — this ` +
                `is the shape the post-day-of plan needs.`
            : `NO — balance stayed ${base}¢. Itemizing again killed the credit (the known blocker).`,
        );
      }
    }
  } else {
    record("T2  ITEMIZED cross-tender", "SKIPPED — T1 refused, no point itemizing");
  }

  // ── T3: unlinked → SQUARE-issued gift card (confounder removed) ──────────
  const t3 = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-t3`,
    unlinked: true,
    destination_id: gcC,
    location_id: LOCATION,
    amount_money: { amount: 400, currency: "USD" },
    reason: REASON,
  });
  record(
    "T3  UNLINKED 400¢ → GC-C (Square-issued gan, PENDING — 7/28 used a custom OTHER gan)",
    t3.ok
      ? `ACCEPTED — refund ${t3.json.refund?.id} status=${t3.json.refund?.status}. The 7/28 ` +
          `gift-card failure was the CUSTOM GAN, not the feature.`
      : `REFUSED — ${codes(t3)} — ${errStr(t3)}. Square-issued gan fails too ⇒ the custom gan was ` +
          `not the cause; unlinked disbursement really is blocked.`,
  );
  if (t3.ok) {
    const w = await watchCard(gcC, 400, "GC-C");
    record("T3  did the unlinked money LAND on GC-C?", w.landed ? `YES — balance=${w.bal}¢` : "NO");
  }
} catch (e) {
  console.error(`\nFATAL: ${(e as Error).message}`);
} finally {
  // ── cleanup: drain every card that holds value ───────────────────────────
  console.log("\n═══ cleanup ═══");
  for (const id of toDrain) {
    const c = await sq("GET", `/gift-cards/${id}`);
    const bal = c.json?.gift_card?.balance_money?.amount ?? 0;
    const st = c.json?.gift_card?.state;
    if (st !== "ACTIVE" || bal <= 0) {
      console.log(`  ${id} state=${st} balance=${bal}¢ — nothing to drain`);
      continue;
    }
    const d = await sq("POST", "/gift-cards/activities", {
      idempotency_key: `${KEY}-dr-${id.slice(-6)}`,
      gift_card_activity: {
        type: "ADJUST_DECREMENT",
        location_id: LOCATION,
        gift_card_id: id,
        adjust_decrement_activity_details: {
          amount_money: { amount: bal, currency: "USD" },
          reason: "PURCHASE_WAS_REFUNDED",
        },
      },
    });
    console.log(`  drain ${id} ${bal}¢ → ${d.ok ? "0¢" : errStr(d)}`);
  }
  console.log("\n═══ FINDINGS ═══");
  for (const f of findings) console.log(`• ${f}`);
}
