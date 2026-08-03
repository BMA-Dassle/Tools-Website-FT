/**
 * READ-ONLY: is a group event's center wired up consistently end-to-end?
 *
 * FastTrax and HeadPinz Fort Myers share one BMI client (`headpinzftmyers`), so an
 * event can move between them without changing its project id, contract, deposit
 * or gift card. Four things have to agree afterwards, and each lives somewhere
 * different:
 *
 *   1. BMI/Pandora "Location" selector   — where the event actually IS
 *   2. group_function_quotes center stamp — what our emails/links/waivers use
 *   3. the day-of Square order's location — where the revenue rings up
 *   4. the deposit gift card's balance    — the money that carries over
 *
 * Run it before and after a move. Anything flagged MISMATCH means a dispatch pass
 * has not reconciled yet: flip the project to "Send Contract" in BMI to trigger
 * group-quote-dispatch, then re-run.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/gf-center-move-check.mts <bmiReservationId | H-number | name fragment>
 *   npx tsx scripts/gf-center-move-check.mts 56000667
 *   npx tsx scripts/gf-center-move-check.mts "anesthesia"
 */
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
import { neon } from "@neondatabase/serverless";

const needle = process.argv[2];
if (!needle) {
  console.error("usage: npx tsx scripts/gf-center-move-check.mts <reservationId|H-number|name>");
  process.exit(1);
}

const CENTER_BY_LOCATION: Record<string, string> = {
  LAB52GY480CJF: "FastTrax Fort Myers",
  TXBSQN0FEKQ11: "HeadPinz Fort Myers",
  PPTR5G2N0QXF7: "HeadPinz Naples",
};
const EXPECTED_LOCATION: Record<string, string> = {
  fasttrax: "LAB52GY480CJF",
  "fort-myers": "TXBSQN0FEKQ11",
  naples: "PPTR5G2N0QXF7",
};

const sql = neon(process.env.DATABASE_URL!);
const rows = (await sql`
  SELECT id, bmi_reservation_id, event_number, event_name, event_date, event_date_display, status,
         center_code, center_name, square_location_id, brand, base_url, gan_prefix, hermes_center,
         total_cents, collected_cents, balance_cents, deposit_due_cents,
         square_dayof_order_id, square_gift_card_id, square_gift_card_gan,
         square_deposit_payment_id, contract_short_id
  FROM group_function_quotes
  WHERE bmi_reservation_id = ${needle}
     OR event_number ILIKE ${needle}
     OR event_name ILIKE ${"%" + needle + "%"}
  ORDER BY event_date DESC NULLS LAST
  LIMIT 5
`) as Array<Record<string, string | number | null>>;

if (rows.length === 0) {
  console.error(`No group_function_quotes row matches "${needle}".`);
  process.exit(2);
}

const SQUARE_BASE = "https://connect.squareup.com/v2";
const sqHeaders = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN || ""}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};
const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const parseIds = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter(Boolean).map(String) : [String(raw)];
  } catch {
    return [String(raw)];
  }
};

let problems = 0;
const flag = (msg: string) => {
  problems++;
  console.log(`  ✗ MISMATCH  ${msg}`);
};
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

for (const r of rows) {
  const reservationId = String(r.bmi_reservation_id);
  const centerCode = String(r.center_code);
  const quoteLocation = String(r.square_location_id);

  console.log(
    `\n═══ #${r.id} ${r.event_number} "${r.event_name}" — ${r.event_date_display} [${r.status}]`,
  );
  console.log(
    `  quote center : ${centerCode} / ${r.center_name} / ${quoteLocation}` +
      ` (${CENTER_BY_LOCATION[quoteLocation] ?? "unknown location"})`,
  );
  console.log(`  brand/urls   : ${r.brand} · ${r.base_url} · GAN prefix ${r.gan_prefix}`);
  console.log(
    `  money        : total ${money(Number(r.total_cents))} · collected ${money(
      Number(r.collected_cents),
    )} · balance ${money(Number(r.balance_cents))}`,
  );

  // 1. Internal consistency of the center stamp.
  if (EXPECTED_LOCATION[centerCode] !== quoteLocation) {
    flag(
      `center_code ${centerCode} should carry Square location ` +
        `${EXPECTED_LOCATION[centerCode]}, row has ${quoteLocation}`,
    );
  } else {
    ok(`center stamp self-consistent (${centerCode} → ${quoteLocation})`);
  }

  // 2. What does BMI/Pandora say the location is right now?
  try {
    const { fetchReservationDetail } = await import("../lib/hermes-client.js");
    const detail = await fetchReservationDetail(centerCode, reservationId);
    const loc = (detail?.location || "").trim();
    if (!loc) {
      console.log("  ? BMI location selector is EMPTY (dispatch defaults it to HeadPinz Fort Myers)");
    } else {
      const bmiIsFt = loc.toLowerCase().includes("fasttrax");
      const rowIsFt = centerCode === "fasttrax";
      if (centerCode !== "naples" && bmiIsFt !== rowIsFt) {
        flag(
          `BMI location is "${loc}" but the row says ${centerCode} — ` +
            `flip the project to "Send Contract" so dispatch re-points it`,
        );
      } else {
        ok(`BMI location "${loc}" agrees with the row`);
      }
    }
  } catch (err) {
    console.log(`  ? BMI lookup failed (${err instanceof Error ? err.message : String(err)})`);
  }

  // 3. Day-of Square order — this is where the revenue rings up.
  if (!r.square_dayof_order_id) {
    console.log("  · no day-of order yet (created at deposit time)");
  } else {
    const res = await fetch(`${SQUARE_BASE}/orders/${r.square_dayof_order_id}`, {
      headers: sqHeaders,
    });
    const order = (await res.json()).order;
    if (!order) {
      flag(`day-of order ${r.square_dayof_order_id} not retrievable (${res.status})`);
    } else {
      const label = `${order.location_id} (${CENTER_BY_LOCATION[order.location_id] ?? "?"})`;
      console.log(
        `  day-of order : ${order.id} ${order.state} ${money(order.total_money?.amount ?? 0)} @ ${label}`,
      );
      if (order.state === "CANCELED") {
        flag("day-of order is CANCELED — the payout cron has nothing to pay");
      } else if (order.location_id !== quoteLocation) {
        flag(
          `day-of order books at ${label} but the event is at ` +
            `${CENTER_BY_LOCATION[quoteLocation] ?? quoteLocation} — it must be rebuilt`,
        );
      } else {
        ok("day-of order is at the event's center");
      }
      const orderTotal = order.total_money?.amount ?? 0;
      if (Math.abs(orderTotal - Number(r.total_cents)) > 50) {
        flag(
          `day-of order total ${money(orderTotal)} != contract total ${money(Number(r.total_cents))}`,
        );
      }
    }
  }

  // 4. Deposit gift card(s) — the money that carries across a move untouched.
  const gcIds = parseIds(r.square_gift_card_id as string | null);
  const gcGans = parseIds(r.square_gift_card_gan as string | null);
  if (gcIds.length === 0) {
    console.log("  · no deposit gift card yet");
  } else {
    let funded = 0;
    for (let i = 0; i < gcIds.length; i++) {
      const res = await fetch(`${SQUARE_BASE}/gift-cards/${gcIds[i]}`, { headers: sqHeaders });
      const gc = (await res.json()).gift_card;
      if (!gc) {
        flag(`gift card ${gcGans[i] || gcIds[i]} not retrievable (${res.status})`);
        continue;
      }
      funded += gc.balance_money?.amount ?? 0;
      console.log(
        `  gift card    : ${gc.gan} ${gc.state} ${money(gc.balance_money?.amount ?? 0)}` +
          ` (prefix is historical — GANs are immutable and valid at every location)`,
      );
    }
    if (funded < Number(r.collected_cents)) {
      console.log(
        `  ! gift cards hold ${money(funded)} vs ${money(Number(r.collected_cents))} collected` +
          " — expected before the balance charge, investigate if the event is fully funded",
      );
    }
  }
}

console.log(
  problems === 0
    ? "\nAll checks passed — center, day-of order and gift card agree."
    : `\n${problems} mismatch(es) found.`,
);
process.exit(problems === 0 ? 0 : 1);
