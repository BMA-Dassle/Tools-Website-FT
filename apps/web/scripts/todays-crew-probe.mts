/**
 * Today's Crew — READ-ONLY probe against real Neon (owner rule: tests with
 * mocked DB calls have shipped empty features before; run the real rail on
 * real rows before believing it).
 *
 * Two modes:
 *
 *   npx tsx scripts/todays-crew-probe.mts --find [--days 3]
 *     Lists recent kiosk race bookings with two or more distinct racers, so you
 *     can pick a personId that actually has co-bookers. Prints the bill, the
 *     date, and each racer's id + first name.
 *
 *   npx tsx scripts/todays-crew-probe.mts --person <bmiPersonId> --center fort-myers|naples [--date YYYY-MM-DD]
 *     Runs the EXACT read the API route runs — coBookedPeopleOnDate, then
 *     readTodaysCrew (names upgraded from our check-in / waiver-join rows,
 *     waiver vouched from waiver_signatures) — and asserts the contract:
 *     every id is a digit string, the caller is excluded, nobody is offered
 *     twice, the cap holds. Exit 1 on any failed assertion.
 *
 * Reads only. Nothing here writes to any table.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

try {
  const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val && !process.env[key]) process.env[key] = val;
  }
} catch {
  /* no .env.local — rely on the ambient environment */
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

const { sql } = await import("@/lib/db");
const { coBookedPeopleOnDate } = await import("@/lib/bowling-db");
const { readTodaysCrew } = await import("~/features/kiosk/todays-crew/service.server");
const { CREW_CAP } = await import("~/features/kiosk/todays-crew/todays-crew");
const { CENTER_CODES_FOR_SLUG, isCenterSlug } = await import("~/features/kiosk/checkin/centers");

const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`);
  if (!ok) failures++;
};

if (has("find")) {
  const days = Number(flag("days") ?? "3");
  const q = sql();
  const rows = (await q`
    SELECT r.id, r.bmi_bill_id, r.center_code, r.booked_at, r.status,
           jsonb_agg(DISTINCT jsonb_build_object('id', t.e->>'bmiPersonId', 'name', t.e->>'racer', 'heat', t.e->>'heatId')) AS racers
    FROM bowling_reservations r
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.booking_metadata->'heats')='array'
           THEN r.booking_metadata->'heats' ELSE '[]'::jsonb END) AS t(e)
    WHERE r.booking_source = 'kiosk'
      AND r.product_kind = 'race'
      AND r.booked_at > now() - (${days} || ' days')::interval
      AND t.e->>'bmiPersonId' IS NOT NULL
    GROUP BY r.id
    HAVING count(DISTINCT t.e->>'bmiPersonId') >= 2
    ORDER BY r.booked_at DESC
    LIMIT 15
  `) as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    console.log(`No kiosk race bookings with 2+ racers in the last ${days} days.`);
  }
  for (const r of rows) {
    const racers = r.racers as Array<{ id: string; name: string; heat: string }>;
    console.log(
      `\nbill ${r.bmi_bill_id}  ${r.center_code}  ${r.status}  booked ${String(r.booked_at).slice(0, 19)}`,
    );
    for (const x of racers) console.log(`   ${x.id}  ${x.name ?? "(no name)"}  ${x.heat}`);
  }
  process.exit(0);
}

const personId = flag("person");
const center = flag("center") ?? "fort-myers";
const date = flag("date") ?? todayET();
if (!personId || !/^\d+$/.test(personId)) {
  console.error(
    "usage: --find [--days N]  |  --person <digits> --center fort-myers|naples [--date YYYY-MM-DD]",
  );
  process.exit(2);
}
if (!isCenterSlug(center)) {
  console.error(`bad --center ${center}`);
  process.exit(2);
}

console.log(`\ncoBookedPeopleOnDate(${personId}, ${date}, ${center})`);
const t0 = Date.now();
const rows = await coBookedPeopleOnDate({
  personId,
  date,
  centerCodes: CENTER_CODES_FOR_SLUG[center],
});
console.log(`  ${rows.length} raw rows in ${Date.now() - t0} ms`);
for (const r of rows) {
  console.log(
    `   ${r.bmiPersonId}  ${r.name.padEnd(22)} ${r.kind.padEnd(12)} ${r.slot}  cat=${r.category ?? "-"}  waiver=${r.waiverValid ?? "?"}  bill=${r.bmiBillId}`,
  );
}
check(
  rows.every((r) => typeof r.bmiPersonId === "string" && /^\d+$/.test(r.bmiPersonId)),
  "every raw id is a digit STRING",
);
check(
  rows.every((r) => r.bmiPersonId !== personId),
  "the caller is not in their own crew",
);
check(
  rows.every((r) => r.slot.slice(0, 10) === date),
  `every row is on ${date}`,
);

console.log(`\nreadTodaysCrew(${personId}, ${center}, ${date})`);
const t1 = Date.now();
const crew = await readTodaysCrew(personId, center, date);
console.log(`  ${crew.length} people in ${Date.now() - t1} ms`);
for (const c of crew) {
  console.log(
    `   ${c.id}  ${`${c.firstName} ${c.lastName}`.trim().padEnd(26)} ${c.kind.padEnd(12)} ${c.bookedAt}  cat=${c.category ?? "-"}  waiver=${c.waiverValid === true ? "on file" : "unknown"}`,
  );
}
check(
  crew.every((c) => /^\d+$/.test(c.id)),
  "every shaped id is a digit STRING",
);
check(new Set(crew.map((c) => c.id)).size === crew.length, "nobody is offered twice");
check(crew.length <= CREW_CAP, `cap of ${CREW_CAP} holds`);
check(
  crew.every((c) => c.firstName.length > 0),
  "everyone has a first name",
);
check(
  crew.every((c) => c.age === null),
  "no ages are invented",
);
check(
  crew.every((c) => c.waiverValid === true || c.waiverValid === null),
  "waiver is vouched (true) or unknown (null), never a guessed false",
);
const rawIds = new Set(rows.map((r) => r.bmiPersonId));
check(
  crew.every((c) => rawIds.has(c.id)),
  "every shaped person came from a raw row",
);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
