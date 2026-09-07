/**
 * Today's Crew — seed ONE synthetic same-day kiosk race booking so the
 * Playwright smoke (e2e/kiosk-todays-crew.spec.ts) has a group to find, and
 * clean it up afterwards.
 *
 *   npx tsx scripts/seed-todays-crew-smoke.mts --person <testAccountPersonId> \
 *       --co "<personId>:<First Last>" --co "<personId>:<First Last>" [--center fasttrax]
 *   npx tsx scripts/seed-todays-crew-smoke.mts --clean
 *
 * WHAT IT WRITES: one bowling_reservations row — product_kind 'race',
 * booking_source 'kiosk', status 'confirmed', bmi_bill_id
 * 'smoke-todays-crew-<stamp>' (deliberately NOT numeric, so nothing that
 * treats a bill id as a BMI id can mistake it), guest_name 'E2E SMOKE', and a
 * booking_metadata.heats[] roster carrying the test account plus the
 * co-racers, all on an 8:00 PM heat TODAY (ET). That is exactly the shape
 * unified-reserve persists at capture, which is what coBookedPeopleOnDate
 * reads.
 *
 * WHY THE CO-RACER IDS MUST BE REAL TEST PERSONS: the kiosk adds a picked
 * person as a party member and, when our own record cannot vouch for their
 * waiver, runs the ordinary one-person Pandora read. A made-up id makes that
 * read fail closed ("Waiver needed"), which is harmless for the smoke but
 * means the "Add N players" step ends on an amber card. Use known test ids.
 *
 * ALWAYS RUN --clean AFTER THE SMOKE. The row lives in the same table as real
 * bookings; day-of tooling filters kiosk rows and non-numeric bills out, but
 * a stale seed is still a row that lies about a booking that never happened.
 * --clean removes every 'smoke-todays-crew-%' row and is idempotent.
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
const flags = (name: string): string[] =>
  args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));

const { sql } = await import("@/lib/db");
const { ensureBowlingSchema } = await import("@/lib/bowling-db");
await ensureBowlingSchema();
const q = sql();

const BILL_PREFIX = "smoke-todays-crew-";

if (args.includes("--clean")) {
  const rows = (await q`
    DELETE FROM bowling_reservations
    WHERE bmi_bill_id LIKE ${BILL_PREFIX + "%"}
    RETURNING id, bmi_bill_id
  `) as Array<Record<string, unknown>>;
  console.log(
    `removed ${rows.length} smoke row(s)${rows.length ? ": " + rows.map((r) => r.bmi_bill_id).join(", ") : ""}`,
  );
  process.exit(0);
}

const personId = flag("person");
const cos = flags("co").map((s) => {
  const i = s.indexOf(":");
  return { id: s.slice(0, i).trim(), name: s.slice(i + 1).trim() };
});
const center = flag("center") ?? "fasttrax";
if (
  !personId ||
  !/^\d+$/.test(personId) ||
  cos.length === 0 ||
  cos.some((c) => !/^\d+$/.test(c.id) || !c.name)
) {
  console.error(
    'usage: --person <digits> --co "<digits>:<First Last>" [--co ...] [--center fasttrax|fort-myers|naples]   |   --clean',
  );
  process.exit(2);
}

const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const heatId = `${today}T20:00:00`;
const bill = `${BILL_PREFIX}${Date.now()}`;
const heat = (id: string, first: string) => ({
  productId: null,
  track: "Blue",
  heatId,
  assignedTo: null,
  tier: null,
  category: "adult",
  bmiPersonId: id,
  racer: first,
  bmiLineId: null,
});
const metadata = {
  heats: [heat(personId, "Test"), ...cos.map((c) => heat(c.id, c.name.split(/\s+/)[0]))],
  racerNames: ["Test", ...cos.map((c) => c.name.split(/\s+/)[0])],
  smoke: "seed-todays-crew-smoke.mts",
};

const inserted = (await q`
  INSERT INTO bowling_reservations
    (center_code, product_kind, bmi_bill_id, status, booked_at, player_count,
     guest_name, notes, booking_source, booking_metadata)
  VALUES
    (${center}, 'race', ${bill}, 'confirmed', now(), ${1 + cos.length},
     'E2E SMOKE — Today''s Crew', 'seed-todays-crew-smoke.mts — run --clean to remove',
     'kiosk', ${JSON.stringify(metadata)}::jsonb)
  RETURNING id
`) as Array<Record<string, unknown>>;

console.log(
  `seeded bowling_reservations #${inserted[0]?.id} bill ${bill} at ${center} — heat ${heatId}`,
);
console.log(`  test account ${personId} + ${cos.map((c) => `${c.name} (${c.id})`).join(", ")}`);
console.log(
  `\nverify:  npx tsx scripts/todays-crew-probe.mts --person ${personId} --center ${center === "naples" ? "naples" : "fort-myers"}`,
);
console.log(`clean:   npx tsx scripts/seed-todays-crew-smoke.mts --clean`);
