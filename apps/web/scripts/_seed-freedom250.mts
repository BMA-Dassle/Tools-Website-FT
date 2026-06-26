/**
 * Seed the FREEDOM250 July-4th coupon (25% off online bookings whose VISIT date
 * is 2026-07-04 — racing, bowling, attractions, combos). Price-key reduction, NO
 * Square DISCOUNT object, so we seed DIRECTLY (bypassing the admin create route,
 * which would auto-provision a Square discount because bowling is in scope).
 *
 * Idempotent: ON CONFLICT (code) updates the promo fields. Seeds with
 * active=FALSE — flip to TRUE only after the preview/prod smoke passes.
 *
 *   DRY:     node --env-file=apps/web/.env.local apps/web/scripts/_seed-freedom250.mts
 *   EXECUTE: node --env-file=apps/web/.env.local apps/web/scripts/_seed-freedom250.mts --execute
 *   TEST:    add --test to ALSO seed FREEDOM250TEST (active, visit window = today→+14d)
 *            so the Vercel preview smoke can book a near-term slot.
 */
import { readFileSync } from "node:fs";
for (const path of ["apps/web/.env.local", ".env.local"]) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
    break;
  } catch {}
}
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL!);
const EXECUTE = process.argv.includes("--execute");
const SEED_TEST = process.argv.includes("--test");
const e = (s = "") => process.stdout.write(s + "\n");

const SCOPES = JSON.stringify({
  racing: { productSlugs: null },
  bowling: { experienceSlugs: null },
  attractions: { slugs: null },
});

/** ET YYYY-MM-DD for a Date (the test window is anchored in the venue's zone). */
function etYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

async function ensureColumns() {
  await sql`ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS booking_date_start DATE`;
  await sql`ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS booking_date_end DATE`;
}

async function upsert(row: {
  code: string;
  description: string;
  startsAt: string;
  expiresAt: string;
  bookingStart: string;
  bookingEnd: string;
  active: boolean;
}) {
  await sql`
    INSERT INTO discount_codes (
      code, description, mechanic, amount_pct,
      starts_at, expires_at, booking_date_start, booking_date_end,
      scopes, square_catalog_id, max_uses, active, created_by
    ) VALUES (
      ${row.code}, ${row.description}, 'percent', 25,
      ${row.startsAt}, ${row.expiresAt}, ${row.bookingStart}, ${row.bookingEnd},
      ${SCOPES}::jsonb, NULL, NULL, ${row.active}, 'seed-script'
    )
    ON CONFLICT (code) DO UPDATE SET
      description = EXCLUDED.description,
      mechanic = 'percent',
      amount_pct = 25,
      amount_cents = NULL,
      starts_at = EXCLUDED.starts_at,
      expires_at = EXCLUDED.expires_at,
      booking_date_start = EXCLUDED.booking_date_start,
      booking_date_end = EXCLUDED.booking_date_end,
      scopes = EXCLUDED.scopes,
      square_catalog_id = NULL,
      square_catalog_type = NULL,
      active = EXCLUDED.active
  `;
}

const REAL = {
  code: "FREEDOM250",
  description: "July 4th — 25% off online bookings",
  // Purchase window: open now → end of July 4 ET (00:00 EDT Jul 5 = 04:00Z).
  startsAt: "2026-06-26T00:00:00-04:00",
  expiresAt: "2026-07-05T04:00:00Z",
  bookingStart: "2026-07-04",
  bookingEnd: "2026-07-04",
  active: false, // flip to true only after smoke
};

e(`FREEDOM250 seed — ${EXECUTE ? "EXECUTE" : "DRY RUN"}${SEED_TEST ? " (+TEST code)" : ""}`);
e(`  ${REAL.code}: 25% off, visit ${REAL.bookingStart}, purchase ${REAL.startsAt}→${REAL.expiresAt}, active=${REAL.active}`);

let testRow: typeof REAL | null = null;
if (SEED_TEST) {
  const now = new Date();
  const plus14 = new Date(now.getTime() + 14 * 24 * 3600 * 1000);
  testRow = {
    code: "FREEDOM250TEST",
    description: "FREEDOM250 preview smoke (delete after testing)",
    startsAt: "2024-01-01T00:00:00Z",
    expiresAt: "2030-01-01T00:00:00Z",
    bookingStart: etYmd(now),
    bookingEnd: etYmd(plus14),
    active: true,
  };
  e(`  ${testRow.code}: 25% off, visit ${testRow.bookingStart}→${testRow.bookingEnd}, active=true`);
}

if (!EXECUTE) {
  e("\nDry run — no writes. Re-run with --execute to seed.");
} else {
  await ensureColumns();
  await upsert(REAL);
  if (testRow) await upsert(testRow);
  const rows = (await sql`
    SELECT code, amount_pct, booking_date_start, booking_date_end, active, square_catalog_id
    FROM discount_codes WHERE code IN ('FREEDOM250', 'FREEDOM250TEST') ORDER BY code
  `) as Array<Record<string, unknown>>;
  e("\nSeeded:");
  for (const r of rows) e(`  ${JSON.stringify(r)}`);
  e("\nDone. Remember: keep FREEDOM250 active=false until smoke passes; delete FREEDOM250TEST after.");
}
