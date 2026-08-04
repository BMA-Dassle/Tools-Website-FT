/**
 * UNLINKED REFUND RETEST — itemized, one soda, to the owner's card on file.
 *
 * Square told the owner (2026-07-28) that unlinked refunds are now enabled on
 * the account. The 7/27 probe (`gc-refund-probe-followup.mts`) sent a fully
 * valid request — `unlinked: true` + `destination_id` = card on file +
 * `customer_id` — and got REFUND_ERROR/REFUND_DECLINED, i.e. entitlement off.
 * Ground-truth finding G5 in tasks/future/post-dayof-refund-plan.md rests on
 * that result, so it needs a real retest before anything is redesigned.
 *
 * This probe answers FOUR questions, in one pass, cheapest-first:
 *
 *   U1a  Can a RETURN order reference an UNPAID source order's line item?
 *        (An unlinked refund has no payment; if returns[] still needs a paid
 *        source order, itemization and "unlinked" are incompatible.)
 *   U1b  Can a return order carry AD-HOC return_line_items with NO
 *        source_order_id at all? (The shape a truly-sourceless refund needs.)
 *   U2   Does POST /v2/refunds accept `unlinked: true` + `destination_id` +
 *        `customer_id` TOGETHER WITH `order_id` = that return order?
 *        This is the whole ask: an unlinked refund that is still ITEMIZED.
 *   U3   CONTROL, only if U2 fails: the same unlinked refund with no order_id.
 *        Separates "unlinked still not entitled" from "unlinked can't be
 *        itemized" — two very different answers, one identical symptom.
 *
 * Money: ONE soda (400¢ + real sales tax) lands on the owner's VISA …5214.
 * Owner-authorized. Non-accounting location only. Reason string is the exact
 * owner-mandated "Refund: Reservation Deposit" (the portal journal keys off
 * it; Square refund reasons are immutable, so an ad-hoc string means manual
 * accounting later).
 *
 * Run from apps/web:
 *   npx tsx scripts/unlinked-refund-soda-probe.mts          # dry run
 *   npx tsx scripts/unlinked-refund-soda-probe.mts --live   # moves money
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
// Owner rule (2026-07-27): probes ALWAYS use this location — no accounting.
const LOCATION = "6MZJFTGAYD7TC";
const CUSTOMER_ID = "ABRRYRM2HH2BNFBK2FQ16V2ZDG"; // eric@headpinz.com (recon 7/28)
// "Fountain Soda FM" → 20 oz, 400¢, present at LOCATION (recon 7/28).
const SODA_VARIATION_ID = "NTLI7WKX6QVXCOZNA4YC3GZ7";
const SODA_NAME = "Fountain Soda FM";
const SODA_CENTS = 400;
// Owner rule (2026-07-27): EVERY Square refund, probes included, uses this.
const REASON = "Refund: Reservation Deposit";
const KEY = `unlr-${randomUUID().slice(0, 8)}`;

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log(`Would, at ${LOCATION}, with idempotency prefix ${KEY}:`);
  console.log(`  setup  OPEN unpaid order: 1× ${SODA_NAME} (${SODA_CENTS}¢) + real sales tax`);
  console.log("  U1a    return order referencing that UNPAID order's line uid");
  console.log("  U1b    return order with ad-hoc return_line_items, no source_order_id");
  console.log("  U2     POST /refunds unlinked:true + destination_id + customer_id + order_id");
  console.log("  U3     (only if U2 fails) same refund without order_id — entitlement control");
  console.log(`  then   poll refund status, then cancel the probe orders`);
  console.log("Money at risk: one soda + tax to VISA …5214. Nothing else.");
  process.exit(0);
}

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
  `HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 400)}`;
const codes = (r: { json: any }) =>
  (r.json?.errors ?? []).map((e: any) => `${e.category}/${e.code}`).join(",") || "-";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const findings: string[] = [];
const record = (q: string, a: string) => {
  findings.push(`${q}: ${a}`);
  console.log(`\n>>> ${q}\n    ${a}`);
};

const madeOrders: string[] = [];

try {
  // ── card on file (resolve fresh — ids rotate) ─────────────────────────────
  const cards = await sq("GET", `/cards?customer_id=${CUSTOMER_ID}`);
  const card = (cards.json?.cards ?? []).find((c: any) => c.enabled);
  if (!card) throw new Error(`no enabled card on file: ${errStr(cards)}`);
  console.log(`destination: ${card.card_brand} …${card.last_4} (${card.id})`);

  // ── real sales tax for this location (don't invent a rate) ───────────────
  const taxList = await sq("POST", "/catalog/search", {
    object_types: ["TAX"],
    include_deleted_objects: false,
  });
  const tax = (taxList.json?.objects ?? []).find(
    (t: any) =>
      t.tax_data?.enabled &&
      (t.present_at_all_locations === true ||
        (t.present_at_location_ids ?? []).includes(LOCATION)),
  );
  console.log(
    tax
      ? `tax: "${tax.tax_data.name}" ${tax.tax_data.percentage}% (${tax.id})`
      : "tax: none found at this location — order will be untaxed",
  );

  // ── setup: an OPEN, UNPAID order holding one real soda ───────────────────
  const src = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-src`,
    order: {
      location_id: LOCATION,
      line_items: [
        { uid: "SODA", catalog_object_id: SODA_VARIATION_ID, quantity: "1" },
      ],
      ...(tax ? { taxes: [{ uid: "TX", catalog_object_id: tax.id, scope: "ORDER" }] } : {}),
    },
  });
  if (!src.ok) throw new Error(`source order: ${errStr(src)}`);
  const srcOrder = src.json.order;
  madeOrders.push(srcOrder.id);
  const sodaLine = (srcOrder.line_items ?? []).find((l: any) => l.uid === "SODA")
    ?? srcOrder.line_items?.[0];
  console.log(
    `source order ${srcOrder.id} state=${srcOrder.state} total=${srcOrder.total_money?.amount}¢ ` +
      `(unpaid, net_due=${srcOrder.net_amount_due_money?.amount ?? 0}¢); soda line uid=${sodaLine?.uid}`,
  );

  // ── U1a: return order against the UNPAID source order ────────────────────
  const retLinked = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-ret1`,
    order: {
      location_id: LOCATION,
      returns: [
        {
          source_order_id: srcOrder.id,
          return_line_items: [{ uid: "R1", source_line_item_uid: sodaLine.uid, quantity: "1" }],
        },
      ],
    },
  });
  const linkedTotal = retLinked.json?.order?.return_amounts?.total_money?.amount;
  record(
    "U1a  return order referencing an UNPAID source order's line item",
    retLinked.ok
      ? `ACCEPTED — return order ${retLinked.json.order.id}, ` +
          `return_amounts.total=${linkedTotal}¢ (Square's own tax-inclusive figure). ` +
          `Itemization does NOT require the source order to be paid.`
      : `REFUSED — ${codes(retLinked)} — ${errStr(retLinked)}`,
  );
  if (retLinked.ok) madeOrders.push(retLinked.json.order.id);

  // ── U1b: return order with NO source order at all ─────────────────────────
  const retAdhoc = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-ret2`,
    order: {
      location_id: LOCATION,
      returns: [
        {
          return_line_items: [
            {
              uid: "R2",
              name: SODA_NAME,
              quantity: "1",
              base_price_money: { amount: SODA_CENTS, currency: "USD" },
            },
          ],
        },
      ],
    },
  });
  const adhocTotal = retAdhoc.json?.order?.return_amounts?.total_money?.amount;
  record(
    "U1b  return order with ad-hoc return_line_items and NO source_order_id",
    retAdhoc.ok
      ? `ACCEPTED — return order ${retAdhoc.json.order.id}, return_amounts.total=${adhocTotal}¢. ` +
          `A sourceless refund CAN still be itemized.`
      : `REFUSED — ${codes(retAdhoc)} — ${errStr(retAdhoc)}`,
  );
  if (retAdhoc.ok) madeOrders.push(retAdhoc.json.order.id);

  // ── U2: the ask — unlinked AND itemized ──────────────────────────────────
  // Prefer the source-linked return (real item attribution); fall back to the
  // ad-hoc one. Amount is ALWAYS Square's return_amounts.total, never local
  // tax math (owner rule, 2026-07-27).
  const useOrderId = retLinked.ok
    ? retLinked.json.order.id
    : retAdhoc.ok
      ? retAdhoc.json.order.id
      : undefined;
  const useTotal = retLinked.ok ? linkedTotal : adhocTotal;
  let refundId: string | undefined;

  if (useOrderId && typeof useTotal === "number" && useTotal > 0) {
    const u2 = await sq("POST", "/refunds", {
      idempotency_key: `${KEY}-u2`,
      unlinked: true,
      destination_id: card.id,
      customer_id: CUSTOMER_ID,
      location_id: LOCATION,
      amount_money: { amount: useTotal, currency: "USD" },
      order_id: useOrderId,
      reason: REASON,
    });
    record(
      `U2  unlinked refund of ${useTotal}¢ ITEMIZED via order_id=${useOrderId}`,
      u2.ok
        ? `ACCEPTED — refund ${u2.json.refund?.id} status=${u2.json.refund?.status}, ` +
            `order_id on refund=${u2.json.refund?.order_id ?? "none"}. ` +
            `Unlinked refunds are ENABLED and can be itemized.`
        : `REFUSED — ${codes(u2)} — ${errStr(u2)}`,
    );
    if (u2.ok) refundId = u2.json.refund?.id;
  } else {
    record("U2  unlinked + itemized refund", "SKIPPED — no usable return order from U1a/U1b");
  }

  // ── U3: control — is it entitlement, or is it the itemization? ────────────
  if (!refundId) {
    const amount = typeof useTotal === "number" && useTotal > 0 ? useTotal : SODA_CENTS;
    const u3 = await sq("POST", "/refunds", {
      idempotency_key: `${KEY}-u3`,
      unlinked: true,
      destination_id: card.id,
      customer_id: CUSTOMER_ID,
      location_id: LOCATION,
      amount_money: { amount, currency: "USD" },
      reason: REASON,
    });
    record(
      `U3  CONTROL — unlinked refund of ${amount}¢ with NO order_id`,
      u3.ok
        ? `ACCEPTED — refund ${u3.json.refund?.id} status=${u3.json.refund?.status}. ` +
            `Entitlement IS on; the U2 failure is about ITEMIZATION, not permission.`
        : `REFUSED — ${codes(u3)} — ${errStr(u3)}. ` +
            `A REFUND_DECLINED/FORBIDDEN here means the entitlement is still OFF — ` +
            `G5 stands and Square has not actually flipped it.`,
    );
    if (u3.ok) refundId = u3.json.refund?.id;
  }

  // ── settle: an unlinked refund is a real card push — watch it land ───────
  if (refundId) {
    console.log("\n═══ settling ═══");
    let status = "";
    for (let i = 0; i < 12; i++) {
      const r = await sq("GET", `/refunds/${refundId}`);
      status = r.json?.refund?.status ?? "?";
      const dest = r.json?.refund?.destination_type ?? "?";
      console.log(
        `  +${i * 10}s status=${status} destination_type=${dest} ` +
          `amount=${r.json?.refund?.amount_money?.amount}¢ order_id=${r.json?.refund?.order_id ?? "none"}`,
      );
      if (status === "COMPLETED" || status === "FAILED" || status === "REJECTED") break;
      await sleep(10_000);
    }
    record(
      "final refund status",
      status === "COMPLETED"
        ? `COMPLETED — money is on the card. Refund ${refundId}.`
        : `${status} — refund ${refundId}; PENDING is normal for a card push, re-check later ` +
            `(GET /v2/refunds/${refundId}). Do NOT re-run the probe on a PENDING result.`,
    );
  }
} catch (e) {
  console.error(`\nFATAL: ${(e as Error).message}`);
} finally {
  // ── cleanup: cancel the unpaid probe orders (nothing was tendered) ────────
  console.log("\n═══ cleanup ═══");
  for (const id of madeOrders) {
    const cur = await sq("GET", `/orders/${id}`);
    const ver = cur.json?.order?.version;
    const st = cur.json?.order?.state;
    if (st !== "OPEN") {
      console.log(`  order ${id} state=${st} — nothing to cancel`);
      continue;
    }
    const cancel = await sq("PUT", `/orders/${id}`, {
      idempotency_key: `${KEY}-cx-${id.slice(0, 6)}`,
      order: { location_id: LOCATION, version: ver, state: "CANCELED" },
    });
    console.log(`  cancel ${id} → ${cancel.ok ? "CANCELED" : errStr(cancel)}`);
  }

  console.log("\n═══ FINDINGS ═══");
  for (const f of findings) console.log(`• ${f}`);
}
