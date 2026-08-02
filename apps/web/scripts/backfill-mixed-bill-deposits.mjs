/**
 * Backfill the unpaid BMI money deposit on MIXED (race + attraction) bills.
 *
 * Context (2026-08-01, W57040/W56953): BMI flipped the Nexus gel/laser products
 * to require a MONEY deposit (~2026-07-22). Mixed carts confirm through
 * unified-reserve, which — until the fix that ships with this script — confirmed
 * the whole bill as a $0 CREDIT (the race $0-model path), leaving the attraction
 * lines' money outstanding (`totalToDeposit > 0`). BMI then releases the unpaid
 * lines' SCHEDULES and the party silently drops off the arena dayplanner.
 *
 * This script settles the money side of the already-booked bills the fix can't
 * reach retroactively:
 *   1. Finds race-kind rows since 2026-07-22 whose metadata carries attractions.
 *   2. Reads each bill's live BMI overview (totalToDeposit, statusId).
 *   3. With --apply: for bills still owing money AND whose visit is in the
 *      future, posts payment/confirm for EXACTLY BMI's outstanding amount, then
 *      re-asserts the project state (a second payment/confirm reverts it —
 *      the confirm-idempotency lesson), then re-reads to verify.
 *
 * DRY RUN by default — prints the plan and touches nothing.
 *   node scripts/backfill-mixed-bill-deposits.mjs            # list/plan only
 *   node scripts/backfill-mixed-bill-deposits.mjs --apply    # settle future-visit bills
 *   node scripts/backfill-mixed-bill-deposits.mjs --apply --all  # also settle past-visit bills (books cleanup)
 *
 * Only touches bills currently in plain `-3 Confirmation` or the FM/Naples
 * kiosk-confirmation states; anything else is listed and skipped (manual call).
 */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const APPLY = process.argv.includes("--apply");
const ALL = process.argv.includes("--all");

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=["']?([^"']*)["']?\s*$/);
  if (m) env[m[1]] = m[2];
}
const BASE = env.BMI_API_URL || "https://api.bmileisure.com";
const PANDORA = "https://bma-pandora-api.azurewebsites.net/v2";
const RACING_LOCATION = "LAB52GY480CJF"; // race-anchored bills confirm at the FastTrax racing center
// Auto-settle only bills sitting in plain `-3 Confirmation` — the Pandora state
// endpoint is proven with "-3" only. Kiosk-confirmation-state bills
// (55397028 FM / 8489113 Naples) are listed for a manual call instead: their
// custom state would need the Office API to re-assert.
const KNOWN_STATES = new Set(["-3"]);

async function bmiToken() {
  const res = await fetch(`${BASE}/auth/headpinzftmyers/publicbooking`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "BMI-Subscription-Key": env.BMI_SUBSCRIPTION_KEY,
    },
    body: JSON.stringify({ Username: env.BMI_USERNAME, Password: env.BMI_PASSWORD }),
  });
  if (!res.ok) throw new Error(`BMI auth ${res.status}`);
  const d = await res.json();
  return d.AccessToken || d.accessToken;
}

function bmiHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "BMI-Subscription-Key": env.BMI_SUBSCRIPTION_KEY,
    "Content-Type": "application/json",
    "Accept-Language": "en",
  };
}

/** Overview via RAW TEXT + regex — 17-digit ids must never pass JSON.parse. */
async function overview(token, billId) {
  const res = await fetch(`${BASE}/public-booking/headpinzftmyers/order/${billId}/overview`, {
    headers: bmiHeaders(token),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status };
  const num = (re) => {
    const m = text.match(re);
    return m ? parseFloat(m[1]) : null;
  };
  return {
    ok: true,
    toDepositCents: Math.round((num(/"totalToDeposit"\s*:\s*(-?[0-9.]+)/) ?? 0) * 100),
    statusId: text.match(/"statusId"\s*:\s*(-?\d+)/)?.[1] ?? "?",
    resNum: text.match(/"reservationNumber"\s*:\s*"([^"]+)"/)?.[1] ?? "?",
  };
}

async function main() {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql`
    select bmi_bill_id::text as bill, bmi_reservation_number as resnum, guest_name,
           booking_source, inserted_at, booking_metadata->'attractions' as attractions
    from bowling_reservations
    where product_kind = 'race'
      and status = 'confirmed'
      and bmi_bill_id is not null
      and inserted_at > '2026-07-22'
      and jsonb_array_length(coalesce(booking_metadata->'attractions','[]'::jsonb)) > 0
    order by inserted_at asc`;

  const token = await bmiToken();
  let settled = 0;
  for (const r of rows) {
    const ov = await overview(token, r.bill);
    if (!ov.ok) {
      console.log(`${r.resnum} | overview HTTP ${ov.status} — skipped`);
      continue;
    }
    const slots = (r.attractions ?? [])
      .map((a) => a.slot)
      .filter(Boolean)
      .sort();
    const lastSlot = slots[slots.length - 1] ?? null;
    const futureVisit = lastSlot ? new Date(`${lastSlot}-04:00`) > new Date() : false;
    const line = `${r.resnum} | ${r.guest_name} | ${r.booking_source} | slot ${lastSlot ?? "?"} | due $${(ov.toDepositCents / 100).toFixed(2)} | state ${ov.statusId}`;

    if (ov.toDepositCents <= 0) {
      console.log(`${line} — OK (nothing due)`);
      continue;
    }
    const eligible = (futureVisit || ALL) && KNOWN_STATES.has(ov.statusId);
    if (!APPLY || !eligible) {
      const why = !KNOWN_STATES.has(ov.statusId)
        ? ` (state ${ov.statusId} needs a manual Office re-assert; not auto-settled)`
        : futureVisit || ALL
          ? ", would settle with --apply"
          : " (past visit; use --all to settle)";
      console.log(`${line} — UNPAID${why}`);
      if (!APPLY && eligible) settled++;
      continue;
    }

    // 1. payment/confirm for exactly BMI's outstanding money.
    const body = `{"id":"${crypto.randomUUID()}","paymentTime":"${new Date().toISOString()}","amount":${ov.toDepositCents / 100},"orderId":${r.bill},"depositKind":0}`;
    const pay = await fetch(`${BASE}/public-booking/headpinzftmyers/payment/confirm`, {
      method: "POST",
      headers: bmiHeaders(token),
      body,
      cache: "no-store",
    });
    const payText = await pay.text();
    if (!pay.ok || !/"reservationNumber"\s*:\s*"/.test(payText)) {
      console.log(`${line} — payment/confirm FAILED ${pay.status}: ${payText.slice(0, 160)}`);
      continue;
    }
    // 2. Re-assert the project state (the second confirm reverts it to pending).
    //    projectId = orderId + 1, last-10-digit math (id precision rule).
    const tail = (Number(r.bill.slice(-10)) + 1).toString();
    const projectId = r.bill.slice(0, -tail.length) + tail;
    await new Promise((res) => setTimeout(res, 2000));
    for (let attempt = 1; attempt <= 3; attempt++) {
      const st = await fetch(`${PANDORA}/bmi/reservation/state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.SWAGGER_ADMIN_KEY}`,
        },
        body: JSON.stringify({ locationID: RACING_LOCATION, projectId, stateID: ov.statusId }),
        signal: AbortSignal.timeout(10000),
      });
      if (st.ok) break;
      console.log(`  state re-assert attempt ${attempt} → ${st.status}`);
      await new Promise((res) => setTimeout(res, 1500));
    }
    // 3. Verify.
    await new Promise((res) => setTimeout(res, 2000));
    const after = await overview(token, r.bill);
    console.log(
      `${line} — SETTLED $${(ov.toDepositCents / 100).toFixed(2)} → now due $${(after.toDepositCents / 100).toFixed(2)}, state ${after.statusId}` +
        (after.toDepositCents === 0 && after.statusId === ov.statusId ? " ✓" : "  ⚠ VERIFY IN BMI"),
    );
    settled++;
  }
  console.log(
    `\n${APPLY ? "settled" : "dry-run; would settle"} ${settled} bill(s) of ${rows.length} mixed bills since 7/22`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
