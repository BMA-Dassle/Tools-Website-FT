/**
 * What was actually in Paul Chung's cart on the 2026-07-28 FastTrax kiosk
 * orphan (BMI bill 63000000006468566, $234.21 captured, reserve-all threw on
 * QAMF createReservation(11542))? Dumps the pre-payment Redis record written by
 * saveBookingDetails, plus the post-reserve bookingrecord if one exists.
 * READ-ONLY.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const BILL = process.argv[2] || "63000000006468566";
const { default: redis } = await import("@/lib/redis");

for (const key of [`booking:${BILL}`, `bookingrecord:${BILL}`]) {
  const raw = await redis.get(key);
  console.log(`\n════════ ${key} ════════`);
  if (!raw) {
    console.log("  (missing)");
    continue;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log(raw.slice(0, 4000));
    continue;
  }
  if (typeof parsed.overviews === "string") {
    const ovs = JSON.parse(parsed.overviews);
    console.log(`amount=${parsed.amount}  race="${parsed.race}"  qty=${parsed.qty}  name=${parsed.name}  phone=${parsed.phone}  loc=${parsed.location}`);
    for (const ov of ovs) {
      console.log(`  ── overview bill=${ov._billId} total=${JSON.stringify(ov.total)} tax=${JSON.stringify(ov.totalTax)}`);
      for (const l of ov.lines ?? []) {
        console.log(`     x${l.quantity}  $${l.amount ?? l.price ?? "?"}  "${l.name}"  ${JSON.stringify(Object.fromEntries(Object.entries(l).filter(([k]) => !["name", "quantity", "amount", "price"].includes(k))))}`);
      }
    }
    const rest = { ...parsed };
    delete rest.overviews;
    console.log(`  ── rest: ${JSON.stringify(rest).slice(0, 2000)}`);
  } else {
    console.log(JSON.stringify(parsed, null, 1).slice(0, 6000));
  }
}
process.exit(0);
