/**
 * READ-ONLY: which UPCOMING racing reservations have fewer people registered in
 * BMI than the booking expects? NO WRITES.
 *
 * The at-home /waiver join has been 400ing since it shipped, so nobody who
 * signed at home was ever attached to their reservation — and because
 * kiosk_waiver_joins never got a row and waiver_acceptances has no project
 * column, there is NO stored link to replay. This is the next best thing: a
 * worklist of reservations that are short, so the desk knows before the guests
 * arrive. It cannot say WHO is missing (that was never recorded), only how many.
 *
 * Run from apps/web:  npx tsx scripts/upcoming-roster-shortfall.mts [maxReservations]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import https from "node:https";
import { randomUUID } from "node:crypto";
import { parseWithRawIds } from "@ft/db";

const LIMIT = Number(process.argv[2] || 40);
const HOST = "office-api22.sms-timing.com";
const CK = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const VER = "6251006 202511051229";

const { sql } = await import("@/lib/db");
const q = sql();

// Upcoming confirmed race reservations, with the racer rows the booking carries.
const rows = (await q`
  SELECT r.bmi_bill_id AS bill,
         count(h.e)::int AS expected,
         min(h.e->>'heatId') AS first_heat
  FROM bowling_reservations r,
       LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(r.booking_metadata::jsonb->'heats')='array'
              THEN r.booking_metadata::jsonb->'heats' ELSE '[]'::jsonb END) AS h(e)
  WHERE r.product_kind = 'race' AND r.status = 'confirmed'
    AND r.bmi_bill_id IS NOT NULL
    AND (h.e->>'heatId') > to_char(now() at time zone 'America/New_York', 'YYYY-MM-DD"T"HH24:MI:SS')
  GROUP BY r.bmi_bill_id
  ORDER BY min(h.e->>'heatId')
  LIMIT ${LIMIT}
`) as Array<Record<string, any>>;

console.log(`Upcoming confirmed race reservations with heats ahead: ${rows.length}\n`);
if (rows.length === 0) process.exit(0);

const pw = Buffer.from(process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv", "base64").toString();
const token = JSON.parse(
  await (
    await fetch(`https://${HOST}/auth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        clientkey: CK,
        "x-fast-version": VER,
        origin: "https://office.bmileisure.com",
        referer: "https://office.bmileisure.com/",
      },
      body: `grant_type=password&username=${process.env.BMI_OFFICE_USERNAME || "API2"}&password=${encodeURIComponent(pw)}`,
    })
  ).text(),
).access_token;

function get(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const r = https.get(
      {
        hostname: HOST,
        path,
        headers: {
          Authorization: `Bearer ${token}`,
          "x-fast-version": VER,
          clientkey: CK,
          "x-session-id": randomUUID(),
        },
      },
      (x) => {
        let d = "";
        x.on("data", (c) => (d += c));
        x.on("end", () => res(d));
      },
    );
    r.on("error", rej);
    r.setTimeout(20_000, () => {
      r.destroy();
      rej(new Error("timeout"));
    });
  });
}
/** projectId = billId + 1, last-10-digit math (17-digit ids exceed MAX_SAFE_INTEGER). */
function projectIdFor(bill: string): string {
  const head = bill.slice(0, -10);
  const tail = bill.slice(-10);
  return head + String(Number(tail) + 1).padStart(10, "0");
}

let short = 0;
let ok = 0;
let failed = 0;
for (const r of rows) {
  const bill = String(r.bill);
  try {
    const body = await get(`/api/${CK}/project/${projectIdFor(bill)}`);
    const proj = parseWithRawIds<any>(body);
    const registered = (proj?.projectPersons ?? []).length;
    const expected = Number(r.expected);
    const flag = registered < expected ? "SHORT" : "ok   ";
    if (registered < expected) short++;
    else ok++;
    console.log(
      `  ${flag} bill=${bill} heat=${String(r.first_heat).slice(0, 16)} expected=${expected} registeredInBMI=${registered}`,
    );
  } catch (e) {
    failed++;
    console.log(`  ????  bill=${bill} lookup failed: ${e instanceof Error ? e.message : e}`);
  }
}
console.log(
  `\nSHORT (fewer people in BMI than the booking expects): ${short}   ok: ${ok}   lookup-failed: ${failed}`,
);
console.log(
  "NOTE: a shortfall is EXPECTED for count-based bookings (racers typed at booking are\n" +
    "never registered — that is PR5, unfixed). This does not distinguish that from an\n" +
    "at-home signer lost to the 400; nothing recorded enough to tell them apart.",
);
process.exit(0);
