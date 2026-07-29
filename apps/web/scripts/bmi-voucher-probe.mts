// BMI voucher probe (PR0 of the kiosk coupons/vouchers plan — see
// tasks/future/kiosk-coupons-vouchers.md §3). Settles the open questions
// gating the applyCode redemption build:
//
//   Q1  Which products are vouchers (IsVoucher / VoucherMetaId) and — on the
//       SELL path — where does the voucher NUMBER surface after a sale?
//   Q3  Is a code consumed/locked at order/applyCode, or only at payment
//       confirm? (Decides how the kiosk's abandon sweep un-burns codes.)
//   Q4  Partial redemption: voucher worth more/less than the order — what do
//       the overview totals + AppliedPromoCodes look like?
//   Q5  Error shapes for invalid / expired / already-used codes (the kiosk
//       needs per-reason guest copy).
//
// READ-ONLY by default: lists voucher products only. Mutating steps are each
// behind their own explicit env:
//
//   npx tsx scripts/bmi-voucher-probe.mts
//       # products scan only (no writes)
//   SELL_PRODUCT_ID=500 npx tsx scripts/bmi-voucher-probe.mts
//       # + voucher/sell into a NEW order (never confirmed; cancelled after)
//   ORDER_PRODUCT_ID=123 CODE=X7A3M4D3G6Q5S4R6D5M7U7K8 npx tsx scripts/bmi-voucher-probe.mts
//       # + sell ORDER_PRODUCT_ID into a throwaway order, applyCode CODE,
//       #   print overview, consume-check on a 2nd order, removeCode,
//       #   re-apply, then CANCEL both orders.
//       #   ⚠ USE A COMP/TEST VOUCHER — if BMI locks codes at apply and
//       #   removeCode doesn't fully restore, the code is spent.
//   KEEP=1
//       # skip the final cancels (leave orders for Office inspection)
//
// Gotchas honored (tasks/lessons.md): 17-digit ids never ride through
// JSON.parse unquoted or Number(); request bodies raw-inject ids; a vendor
// 200 is not proof of effect — every mutation re-reads the order overview.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const BMI_USERNAME = process.env.BMI_USERNAME || "";
const BMI_PASSWORD = process.env.BMI_PASSWORD || "";
const CLIENT_KEY = process.env.CLIENT_KEY || "headpinzftmyers";

const SELL_PRODUCT_ID = process.env.SELL_PRODUCT_ID || "";
const ORDER_PRODUCT_ID = process.env.ORDER_PRODUCT_ID || "";
const PAGE_ID = process.env.PAGE_ID || ""; // booking/sell requires the product's PageId
const CODE = (process.env.CODE || "").trim().toUpperCase();
const KEEP = process.env.KEEP === "1";

if (!BMI_SUB_KEY || !BMI_USERNAME) {
  console.error("Missing BMI env (BMI_SUBSCRIPTION_KEY / BMI_USERNAME) — run from apps/web.");
  process.exit(1);
}

/** Quote long id values so JSON.parse never rounds them (script-local
 *  parseWithRawIds — no app import chain per script idiom). */
function parseRawIds(text: string): any {
  return JSON.parse(text.replace(/"(\w*[iI]d)"\s*:\s*(\d{15,})/g, '"$1":"$2"'));
}

/** Raw-inject digit-only id fields into a JSON body so they never ride
 *  through Number() (script-local stringifyWithRawIds). */
function jsonWithRawIds(obj: Record<string, unknown>, rawIds: Record<string, string>): string {
  let json = JSON.stringify({
    ...obj,
    ...Object.fromEntries(Object.keys(rawIds).map((k) => [k, `__RAW_${k}__`])),
  });
  for (const [k, v] of Object.entries(rawIds)) {
    if (!/^\d+$/.test(v)) throw new Error(`raw id ${k} is not digit-only: ${v}`);
    json = json.replace(`"__RAW_${k}__"`, v);
  }
  return json;
}

async function getToken(): Promise<string> {
  const res = await fetch(`${BMI_API_URL}/auth/${CLIENT_KEY}/publicbooking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "BMI-Subscription-Key": BMI_SUB_KEY },
    body: JSON.stringify({ Username: BMI_USERNAME, Password: BMI_PASSWORD }),
  });
  if (!res.ok) throw new Error(`BMI auth failed: ${res.status} ${await res.text()}`);
  const data = JSON.parse(await res.text());
  return data.AccessToken || data.accessToken;
}

let TOKEN = "";

async function call(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: string,
): Promise<{ status: number; data: any; raw: string }> {
  const res = await fetch(`${BMI_API_URL}/public-booking/${CLIENT_KEY}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "BMI-Subscription-Key": BMI_SUB_KEY,
      "Content-Type": "application/json",
    },
    ...(body ? { body } : {}),
  });
  const raw = await res.text();
  let data: any = null;
  try {
    data = parseRawIds(raw);
  } catch {
    data = raw;
  }
  return { status: res.status, data, raw };
}

function overviewSummary(o: any): void {
  if (!o || typeof o !== "object") {
    console.log("   (no overview body)");
    return;
  }
  console.log(`   Total: ${JSON.stringify(field(o, "Total"))}`);
  console.log(`   TotalToDeposit: ${field(o, "TotalToDeposit")}  TotalPaid: ${field(o, "TotalPaid")}`);
  console.log(`   AppliedPromoCodes: ${JSON.stringify(field(o, "AppliedPromoCodes"))}`);
  for (const line of field(o, "Lines") ?? []) {
    console.log(
      `   line ${field(line, "OrderItemId")}: ${field(line, "Name")} ×${field(line, "Quantity")} ` +
        `kind=${field(line, "Kind")} discount=${field(line, "Discount")} ` +
        `voucherCode=${field(line, "VoucherCode") ?? "-"}`,
    );
  }
}

const applyCode = (orderId: string, code: string) =>
  call("POST", "/order/applyCode", jsonWithRawIds({ Code: code }, { OrderId: orderId }));

const removeVoucher = (orderId: string, voucherOrderItemId: string) =>
  call(
    "POST",
    "/order/removeCode",
    jsonWithRawIds({ DiscountId: null }, { OrderId: orderId, VoucherOrderItemId: voucherOrderItemId }),
  );

// Proven sell body shape (app/api/test/product-probe): PageId is required.
const sellProduct = (productId: string, path: "/booking/sell" | "/voucher/sell") =>
  call(
    "POST",
    path,
    `{"ProductId":${productId}${PAGE_ID ? `,"PageId":${PAGE_ID}` : ""},"Quantity":1,"OrderId":null,"ParentOrderItemId":null,"DynamicLines":[]}`,
  );

/** BMI responses mix Pascal/camel case in practice — read both. */
const field = (o: any, name: string) =>
  o?.[name] ?? o?.[name[0].toLowerCase() + name.slice(1)];

async function main() {
  console.log(`── BMI voucher probe · ${CLIENT_KEY} · ${BMI_API_URL} ──`);
  TOKEN = await getToken();
  console.log("auth OK");

  // ── 1. Read-only: which products are vouchers? ──
  const prods = await call("GET", "/products");
  if (prods.status !== 200) {
    console.log(`products GET → ${prods.status}: ${prods.raw.slice(0, 300)}`);
  } else {
    const list: any[] = Array.isArray(prods.data) ? prods.data : (prods.data?.Products ?? []);
    const vouchers = list.filter((p) => p.IsVoucher || p.Kind === 4);
    console.log(`products: ${list.length} total, ${vouchers.length} voucher products`);
    for (const v of vouchers) {
      console.log(
        `   voucher product ${v.Id}: "${v.Name}" kind=${v.Kind} ` +
          `voucherMetaId=${v.VoucherMetaId} prices=${JSON.stringify(v.Prices)}`,
      );
    }
    if (vouchers.length === 0) {
      console.log("   (none exposed on public products — voucher products may be Office-only)");
    }
  }

  // ── 2. Optional: sell a voucher product → where's the code? (Q1) ──
  if (SELL_PRODUCT_ID) {
    console.log(`\nSELL voucher product ${SELL_PRODUCT_ID} (qty 1, new order)…`);
    const sell = await sellProduct(SELL_PRODUCT_ID, "/voucher/sell");
    console.log(`voucher/sell → ${sell.status}: ${JSON.stringify(sell.data).slice(0, 500)}`);
    const orderId = String(field(sell.data, "OrderId") ?? "");
    if (orderId) {
      const ov = await call("GET", `/bill/${orderId}/overview`);
      console.log(`order overview after sell → ${ov.status}`);
      overviewSummary(ov.data);
      if (KEEP) {
        console.log(`KEEP=1 — order ${orderId} left in place for Office inspection`);
      } else {
        const del = await call("DELETE", `/bill/${orderId}/cancel`);
        console.log(`order cancel → ${del.status}`);
      }
    }
  }

  // ── 3. Optional: applyCode / removeCode semantics (Q3/Q4/Q5) ──
  if (ORDER_PRODUCT_ID && CODE) {
    console.log(`\nBuilding throwaway order with product ${ORDER_PRODUCT_ID}…`);
    const sell = await sellProduct(ORDER_PRODUCT_ID, "/booking/sell");
    console.log(`booking/sell → ${sell.status}: ${JSON.stringify(sell.data).slice(0, 300)}`);
    const orderId = String(field(sell.data, "OrderId") ?? "");
    if (!orderId) {
      console.error("no OrderId — cannot continue");
      process.exit(1);
    }

    console.log(`\napplyCode ${CODE} → order ${orderId}`);
    const a1 = await applyCode(orderId, CODE);
    console.log(`applyCode → ${a1.status}`);
    overviewSummary(a1.data);

    // Q5: error shape for a well-formed but nonexistent code.
    const bad = await applyCode(orderId, "Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9");
    console.log(`\napplyCode (garbage code) → ${bad.status}: ${bad.raw.slice(0, 300)}`);

    // Q3 part 1: is the code locked at APPLY? Same code on a 2nd un-paid order.
    const sell2 = await sellProduct(ORDER_PRODUCT_ID, "/booking/sell");
    const orderId2 = String(field(sell2.data, "OrderId") ?? "");
    if (orderId2) {
      const a2 = await applyCode(orderId2, CODE);
      console.log(
        `\napplyCode same code on SECOND un-paid order → ${a2.status}` +
          (a2.status === 200
            ? " — ACCEPTED (code not locked at apply)"
            : `: ${a2.raw.slice(0, 300)}`),
      );
      if (a2.status === 200) {
        const vi2 = field((field(a2.data, "AppliedPromoCodes") ?? [])[0], "VoucherOrderItemId");
        if (vi2 != null) {
          const rm2 = await removeVoucher(orderId2, String(vi2));
          console.log(`removeCode on order 2 → ${rm2.status}`);
        }
      }
      const del2 = await call("DELETE", `/bill/${orderId2}/cancel`);
      console.log(`order 2 cancel → ${del2.status}`);
    }

    // removeCode on order 1, then re-apply: does remove RESTORE the code?
    const applied = (field(a1.data, "AppliedPromoCodes") ?? [])[0];
    const appliedVi = field(applied, "VoucherOrderItemId");
    if (appliedVi != null) {
      const rm = await removeVoucher(orderId, String(appliedVi));
      console.log(`\nremoveCode → ${rm.status}`);
      overviewSummary(rm.data);
      const re = await applyCode(orderId, CODE);
      console.log(
        `re-applyCode after remove → ${re.status} ` +
          `(${re.status === 200 ? "code restored" : "code NOT restored"})`,
      );
    }

    if (KEEP) {
      console.log(`KEEP=1 — order ${orderId} left in place`);
    } else {
      const del = await call("DELETE", `/bill/${orderId}/cancel`);
      console.log(`\norder 1 cancel → ${del.status}`);
      console.log(
        `Verify in BMI Office that ${CODE} shows as un-used after the cancel — ` +
          `a cancelled order must release its voucher (Q3 part 2).`,
      );
    }
  }

  // -- 4. Optional: voucher onto a bill with a REAL BOOKED HEAT --
  // Owner expectation (2026-07-27): the comp line should ZERO OUT the race
  // line at/by processing. Books the LAST proposal of DATE (least contested),
  // applies CODE, prints the overview, removes, cancels. env:
  //   RACE_PRODUCT_ID=24960859 RACE_PAGE_ID=24961568 CODE=... [DATE=YYYY-MM-DD]
  const RACE_PRODUCT_ID = process.env.RACE_PRODUCT_ID || "";
  const RACE_PAGE_ID = process.env.RACE_PAGE_ID || "";
  if (RACE_PRODUCT_ID && RACE_PAGE_ID && CODE) {
    const date =
      process.env.DATE ||
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(
        new Date(Date.now() + 24 * 3600 * 1000),
      );
    console.log(`\nAvailability for race product ${RACE_PRODUCT_ID} on ${date}...`);
    const avail = await fetch(
      `${BMI_API_URL}/public-booking/${CLIENT_KEY}/availability?date=${date}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "BMI-Subscription-Key": BMI_SUB_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ProductId: Number(RACE_PRODUCT_ID),
          PageId: Number(RACE_PAGE_ID),
          Quantity: 1,
          OrderId: null,
          PersonId: null,
          DynamicLines: [],
        }),
      },
    );
    const availText = await avail.text();
    let proposals: any[] = [];
    try {
      proposals = JSON.parse(availText)?.proposals ?? [];
    } catch {
      /* fallthrough */
    }
    console.log(`availability -> ${avail.status}, ${proposals.length} proposals`);
    if (proposals.length === 0) {
      console.log(`   no proposals - body head: ${availText.slice(0, 200)}`);
    } else {
      const proposal = proposals[proposals.length - 1];
      const start = proposal?.blocks?.[0]?.block?.start;
      console.log(`booking LAST heat: ${start}`);
      const bookBody = JSON.stringify({
        productId: RACE_PRODUCT_ID,
        quantity: 1,
        resourceId: Number(proposal.blocks[0]?.block?.resourceId) || -1,
        proposal: {
          blocks: proposal.blocks,
          productLineId: proposal.productLineId ?? null,
        },
      });
      const book = await call("POST", "/booking/book", bookBody);
      const raceOrderId = String(field(book.data, "OrderId") ?? "");
      console.log(
        `booking/book -> ${book.status} orderId=${raceOrderId || "NONE"} ` +
          `${raceOrderId ? "" : book.raw.slice(0, 200)}`,
      );
      if (raceOrderId) {
        const before = await call("GET", `/bill/${raceOrderId}/overview`);
        console.log(`\noverview BEFORE applyCode:`);
        overviewSummary(before.data);

        const ap = await applyCode(raceOrderId, CODE);
        console.log(`\napplyCode ${CODE} -> ${ap.status}`);
        overviewSummary(ap.data);

        const after = await call("GET", `/bill/${raceOrderId}/overview`);
        console.log(`\noverview AFTER applyCode (re-read):`);
        overviewSummary(after.data);

        const appliedRace = (field(ap.data, "AppliedPromoCodes") ?? [])[0];
        const raceVi = field(appliedRace, "VoucherOrderItemId");
        if (raceVi != null) {
          const rm = await removeVoucher(raceOrderId, String(raceVi));
          console.log(`\nremoveCode -> ${rm.status}`);
        }
        if (KEEP) {
          console.log(`KEEP=1 - race order ${raceOrderId} left in place`);
        } else {
          const del = await call("DELETE", `/bill/${raceOrderId}/cancel`);
          console.log(`race order cancel -> ${del.status}`);
        }
      }
    }
  }

  console.log("\nDone. Record findings in tasks/future/kiosk-coupons-vouchers.md §4.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
