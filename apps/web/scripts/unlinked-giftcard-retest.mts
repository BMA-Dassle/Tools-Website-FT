/**
 * RETEST (owner request, 2026-07-29): unlinked refund → gift card.
 *
 * Prior attempts, all `REFUND_ERROR/REFUND_DECLINED — "Unlinked refund could not
 * be created"`:
 *   7/28  custom-GAN card (`gan_source: "OTHER"`), ACTIVE, 0¢
 *   7/28  Square-issued card, PENDING, 0¢   (cross-tender probe's T3 arm)
 *
 * Both held a variable that could plausibly have caused the decline rather than
 * the entitlement, so this retest removes them and varies the request itself.
 * Destination is one Square-issued card, ACTIVE, **carrying a real balance** —
 * the combination never yet tried.
 *
 *   A  baseline: pinned Square-Version 2025-01-23, no customer_id
 *   B  + customer_id            (required for card-on-file destinations; never
 *                                tried for a gift-card destination)
 *   C  NO Square-Version header (the account's DEFAULT API version, in case the
 *                                behaviour is version-gated and our pin is 18
 *                                months stale)
 *
 * Any refund that IS accepted is watched to a terminal status and the card is
 * watched for the credit (async — finding G3), then drained. Nothing is
 * decremented while a refund to the card is still PENDING (7/27 lesson).
 *
 * Non-accounting location. Net money movement: zero.
 *
 * Run from apps/web:
 *   npx tsx scripts/unlinked-giftcard-retest.mts          # dry run
 *   npx tsx scripts/unlinked-giftcard-retest.mts --live
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const LIVE = process.argv.includes("--live");
const BASE = "https://connect.squareup.com/v2";
const TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const PINNED = "2025-01-23";
const LOCATION = "6MZJFTGAYD7TC";
const CUSTOMER_ID = "ABRRYRM2HH2BNFBK2FQ16V2ZDG";
const SEED = 500; // card is ACTIVE with real value before we aim a refund at it
const CENTS = 400; // one soda, matching every sibling probe
const REASON = "Refund: Reservation Deposit";
const KEY = `ugcr-${randomUUID().slice(0, 8)}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function sq(method: string, path: string, body?: unknown, version: string | null = PINNED) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };
  if (version) headers["Square-Version"] = version;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
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
  `HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 300)}`;
const codes = (r: { json: any }) =>
  (r.json?.errors ?? []).map((e: any) => `${e.category}/${e.code}`).join(",") || "-";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log(`Would, at ${LOCATION}:`);
  console.log(`  setup  Square-issued gift card, comp-funded ${SEED}¢ → ACTIVE with balance`);
  console.log(`  A      unlinked ${CENTS}¢ → that card, Square-Version ${PINNED}`);
  console.log("  B      same + customer_id");
  console.log("  C      same with NO Square-Version header (account default)");
  console.log("  then   watch/settle anything accepted, drain the card");
  console.log("Net money movement: zero.");
  process.exit(0);
}

const findings: string[] = [];
const record = (q: string, a: string) => {
  findings.push(`${q}: ${a}`);
  console.log(`\n>>> ${q}\n    ${a}`);
};

let cardId: string | undefined;
const accepted: string[] = [];

try {
  // ── setup: Square-issued, ACTIVE, with real value ────────────────────────
  const c = await sq("POST", "/gift-cards", {
    idempotency_key: `${KEY}-gc`,
    location_id: LOCATION,
    gift_card: { type: "DIGITAL" }, // Square generates the GAN
  });
  if (!c.ok) throw new Error(`create: ${errStr(c)}`);
  cardId = c.json.gift_card.id as string;
  const co = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-co`,
    order: {
      location_id: LOCATION,
      line_items: [
        {
          name: "eGiftCard (probe funding)",
          quantity: "1",
          item_type: "GIFT_CARD",
          base_price_money: { amount: SEED, currency: "USD" },
        },
      ],
      discounts: [
        { name: "Probe comp", amount_money: { amount: SEED, currency: "USD" }, scope: "ORDER" },
      ],
    },
  });
  if (!co.ok) throw new Error(`comp order: ${errStr(co)}`);
  await sq("POST", `/orders/${co.json.order.id}/pay`, {
    idempotency_key: `${KEY}-cp`,
    payment_ids: [],
  });
  const act = await sq("POST", "/gift-cards/activities", {
    idempotency_key: `${KEY}-act`,
    gift_card_activity: {
      type: "ACTIVATE",
      location_id: LOCATION,
      gift_card_id: cardId,
      activate_activity_details: {
        order_id: co.json.order.id,
        line_item_uid: co.json.order.line_items[0].uid,
      },
    },
  });
  if (!act.ok) throw new Error(`activate: ${errStr(act)}`);
  const st0 = await sq("GET", `/gift-cards/${cardId}`);
  console.log(
    `destination: ${cardId}\n  gan=${st0.json?.gift_card?.gan} ` +
      `state=${st0.json?.gift_card?.state} balance=${st0.json?.gift_card?.balance_money?.amount}¢`,
  );

  const body = (extra: Record<string, unknown>, k: string) => ({
    idempotency_key: `${KEY}-${k}`,
    unlinked: true,
    destination_id: cardId,
    location_id: LOCATION,
    amount_money: { amount: CENTS, currency: "USD" },
    reason: REASON,
    ...extra,
  });

  // ── A: baseline, pinned version ──────────────────────────────────────────
  const a = await sq("POST", "/refunds", body({}, "a"), PINNED);
  record(
    `A  unlinked ${CENTS}¢ → ACTIVE Square-issued card w/ balance (Square-Version ${PINNED})`,
    a.ok
      ? `ACCEPTED — refund ${a.json.refund?.id} status=${a.json.refund?.status}`
      : `REFUSED — ${codes(a)} — ${errStr(a)}`,
  );
  if (a.ok) accepted.push(a.json.refund.id);

  // ── B: + customer_id ─────────────────────────────────────────────────────
  const b = await sq("POST", "/refunds", body({ customer_id: CUSTOMER_ID }, "b"), PINNED);
  record(
    "B  same + customer_id",
    b.ok
      ? `ACCEPTED — refund ${b.json.refund?.id} status=${b.json.refund?.status}`
      : `REFUSED — ${codes(b)} — ${errStr(b)}`,
  );
  if (b.ok) accepted.push(b.json.refund.id);

  // ── C: account-default API version ───────────────────────────────────────
  const c2 = await sq("POST", "/refunds", body({}, "c"), null);
  record(
    "C  same with NO Square-Version header (account default, not our 2025-01-23 pin)",
    c2.ok
      ? `ACCEPTED — refund ${c2.json.refund?.id} status=${c2.json.refund?.status}`
      : `REFUSED — ${codes(c2)} — ${errStr(c2)}`,
  );
  if (c2.ok) accepted.push(c2.json.refund.id);

  // ── settle anything accepted, and check the card ─────────────────────────
  if (accepted.length) {
    console.log("\n═══ settling ═══");
    for (const id of accepted) {
      let s = "";
      for (let i = 0; i < 10; i++) {
        const g = await sq("GET", `/refunds/${id}`);
        s = g.json?.refund?.status ?? "?";
        console.log(`  ${id.slice(0, 18)}… +${i * 10}s status=${s}`);
        if (["COMPLETED", "FAILED", "REJECTED"].includes(s)) break;
        await sleep(10_000);
      }
      record(`refund ${id.slice(0, 18)}… terminal status`, s);
    }
    const after = await sq("GET", `/gift-cards/${cardId}`);
    const acts = await sq("GET", `/gift-cards/activities?gift_card_id=${cardId}&limit=50`);
    const kinds = (acts.json?.gift_card_activities ?? []).map((x: any) => x.type);
    record(
      "did any value LAND on the card?",
      `balance=${after.json?.gift_card?.balance_money?.amount}¢ (seeded ${SEED}¢) ` +
        `activities=[${kinds.join(",")}] — a REFUND activity here means it truly worked`,
    );
  } else {
    record(
      "VERDICT",
      "All three shapes refused. Unlinked refunds to a gift card are STILL blocked — the " +
        "destination's gan source, state and balance are now ruled out, as is customer_id and " +
        "our pinned API version. Use the CROSS-TENDER linked refund instead (G6): payment_id + " +
        "destination_id = gift card, no order_id.",
    );
  }
} catch (e) {
  console.error(`\nFATAL: ${(e as Error).message}`);
} finally {
  console.log("\n═══ cleanup ═══");
  if (cardId) {
    // Never decrement while a refund to this card is still in flight (7/27).
    let pending = false;
    for (const id of accepted) {
      const g = await sq("GET", `/refunds/${id}`);
      if (!["COMPLETED", "FAILED", "REJECTED"].includes(g.json?.refund?.status ?? "")) pending = true;
    }
    if (pending) {
      console.log(`  LEAVING ${cardId} alone — a refund to it is still PENDING. Re-check later.`);
    } else {
      const g = await sq("GET", `/gift-cards/${cardId}`);
      const bal = g.json?.gift_card?.balance_money?.amount ?? 0;
      if (bal > 0) {
        const d = await sq("POST", "/gift-cards/activities", {
          idempotency_key: `${KEY}-drain`,
          gift_card_activity: {
            type: "ADJUST_DECREMENT",
            location_id: LOCATION,
            gift_card_id: cardId,
            adjust_decrement_activity_details: {
              amount_money: { amount: bal, currency: "USD" },
              reason: "PURCHASE_WAS_REFUNDED",
            },
          },
        });
        console.log(`  drain ${bal}¢ → ${d.ok ? "0¢" : errStr(d)}`);
      } else {
        console.log("  card already 0¢");
      }
    }
  }
  console.log("\n═══ FINDINGS ═══");
  for (const f of findings) console.log(`• ${f}`);
}
