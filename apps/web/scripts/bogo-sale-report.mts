/**
 * BOGO report — ALL-TIME totals, every BOGO sale to date.
 *
 * Both queries below filter by SLUG ONLY, with no date bound, so this has always
 * been an all-time aggregate. That was indistinguishable from a sale report while
 * BOGO existed for exactly two days (2026-08-12 → EOD 8/13); it stopped being
 * true on 2026-08-19, when the promo became a recurring EVERY-WEDNESDAY offer
 * (features/booking/data/packs.ts BOGO_SALE_RULE). The header used to print that
 * two-day window over these numbers, which would now read as "the sale sold N"
 * when N is in fact every Wednesday since. Hence the relabel.
 *
 * There is deliberately still NO date filter: adding one would mean choosing a
 * period on the owner's behalf. If you want Wednesday-over-Wednesday, group by
 * `created_at` week — the tables carry it.
 *
 * The promo ships in two halves that land in DIFFERENT tables, so neither one
 * alone answers "how did it do":
 *
 *   TRACK A — returning racers buy a 2-race CREDIT pack
 *             → `race_pack_purchases` (pack_slug bogo-races-*), one row per
 *               pack per person, with the real charged `price_cents`, the
 *               selling `surface`, and the grant `status`.
 *
 *   TRACK B — new racers book the BOGO PACKAGE (Starter + Intermediate)
 *             → `sales_log.package_id` (bogo-weekday*), one row per confirmed
 *               reservation, with `total_usd` for the WHOLE booking.
 *
 * READ-ONLY. No writes, no BMI/Square calls — safe to run against prod any
 * time, including mid-sale.
 *
 *   node --env-file=apps/web/.env.local apps/web/scripts/bogo-sale-report.mts
 *   ... --json     machine-readable output for piping
 *
 * ⚠ Track B's `total_usd` is the ENTIRE reservation total, not the package
 * line. A BOGO booking that also bought a license, POV or add-ons reports the
 * full basket. Package-only revenue is the `expectedPackageRevenue` line, which
 * is derived from the catalog price × bookings — trust that one for "what the
 * deal itself sold", and `total_usd` for "what those guests spent with us".
 * That distinction is the whole point of running a loss-leader, so both are
 * printed rather than picking one.
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
const JSON_OUT = process.argv.includes("--json");
const e = (s = "") => process.stdout.write(s + "\n");
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Catalog mirror — kept LOCAL rather than imported because these scripts run
 * under Node's type-stripping, which does not resolve the app's `@/` and `~/`
 * path aliases. The assertion below is what keeps the mirror honest: if a slug
 * is ever renamed or repriced in the catalog, the sale rows stop matching and
 * the report says so loudly instead of quietly reporting zero.
 *
 * SOURCE OF TRUTH:
 *   Track A → src/features/booking/data/packs.ts  (price / regularPrice)
 *   Track B → lib/packages.ts                     (price / retailPrice)
 */
const TRACK_A = {
  "bogo-races-adult": { priceCents: 2099, retailCents: 4198, label: "BOGO Races (Mon-Thu)" },
  "bogo-races-junior": {
    priceCents: 1599,
    retailCents: 3198,
    label: "BOGO Races Junior (Mon-Thu)",
  },
} as const;
const TRACK_B = {
  "bogo-weekday": { priceCents: 2099, retailCents: 4198, label: "BOGO Races (adult)" },
  "bogo-weekday-junior": { priceCents: 1599, retailCents: 3198, label: "BOGO Races (junior)" },
} as const;

const A_SLUGS = Object.keys(TRACK_A);
const B_IDS = Object.keys(TRACK_B);

/** Does a table exist? A sale with zero Track-A purchases never creates
 *  race_pack_purchases, and a bare "relation does not exist" would read as a
 *  broken script rather than "nobody bought one yet". */
async function tableExists(name: string): Promise<boolean> {
  const r = (await sql`SELECT to_regclass(${`public.${name}`}) AS t`) as Array<{
    t: string | null;
  }>;
  return r[0]?.t != null;
}

// ── Track A — credit packs ──────────────────────────────────────────────────
interface TrackARow {
  pack_slug: string;
  surface: string;
  status: string;
  n: number;
  cents: number;
  credits: number;
}
let trackA: TrackARow[] = [];
if (await tableExists("race_pack_purchases")) {
  trackA = (await sql`
    SELECT pack_slug, surface, status,
           COUNT(*)::int              AS n,
           SUM(price_cents)::int      AS cents,
           SUM(race_count)::int       AS credits
    FROM race_pack_purchases
    WHERE pack_slug = ANY(${A_SLUGS})
    GROUP BY pack_slug, surface, status
    ORDER BY pack_slug, surface, status
  `) as unknown as TrackARow[];
}

// ── Track B — packages ──────────────────────────────────────────────────────
interface TrackBRow {
  package_id: string;
  n: number;
  total_usd: string | null;
  participants: number | null;
}
let trackB: TrackBRow[] = [];
if (await tableExists("sales_log")) {
  trackB = (await sql`
    SELECT package_id,
           COUNT(*)::int                        AS n,
           SUM(total_usd)                       AS total_usd,
           SUM(COALESCE(participant_count, 0))::int AS participants
    FROM sales_log
    WHERE package_id = ANY(${B_IDS})
    GROUP BY package_id
    ORDER BY package_id
  `) as unknown as TrackBRow[];
}

// ── Report ──────────────────────────────────────────────────────────────────
// Only CHARGED-or-better Track-A rows count as sales. A 'pending' row is an
// intent written before the money moved (persist-first doctrine) and would
// overstate the sale if counted; it is surfaced separately instead.
const A_SOLD = new Set(["charged", "granted", "grant-failed"]);
const aSold = trackA.filter((r) => A_SOLD.has(r.status));
const aPending = trackA.filter((r) => r.status === "pending");
const aFailed = trackA.filter((r) => r.status === "grant-failed");

const aUnits = aSold.reduce((s, r) => s + r.n, 0);
const aCents = aSold.reduce((s, r) => s + r.cents, 0);
const aCredits = aSold.reduce((s, r) => s + r.credits, 0);
const aRetail = aSold.reduce(
  (s, r) => s + r.n * (TRACK_A[r.pack_slug as keyof typeof TRACK_A]?.retailCents ?? 0),
  0,
);

const bUnits = trackB.reduce((s, r) => s + r.n, 0);
const bBasket = Math.round(trackB.reduce((s, r) => s + Number(r.total_usd ?? 0), 0) * 100);
const bCents = trackB.reduce(
  (s, r) => s + r.n * (TRACK_B[r.package_id as keyof typeof TRACK_B]?.priceCents ?? 0),
  0,
);
const bRetail = trackB.reduce(
  (s, r) => s + r.n * (TRACK_B[r.package_id as keyof typeof TRACK_B]?.retailCents ?? 0),
  0,
);

if (JSON_OUT) {
  e(
    JSON.stringify(
      {
        trackA: { rows: trackA, units: aUnits, chargedCents: aCents, creditsGranted: aCredits },
        trackB: { rows: trackB, units: bUnits, expectedPackageCents: bCents, basketCents: bBasket },
        combined: {
          units: aUnits + bUnits,
          dealRevenueCents: aCents + bCents,
          retailValueCents: aRetail + bRetail,
          discountGivenCents: aRetail + bRetail - (aCents + bCents),
        },
      },
      null,
      2,
    ),
  );
} else {
  e("BOGO RACES — ALL-TIME TOTALS (every BOGO sale to date)");
  e("Ran 2026-08-12 → EOD 8/13 as a flash sale; EVERY WEDNESDAY since 8/19.");
  e("=".repeat(62));

  e("\nTRACK A — returning racers, 2-race credit pack");
  if (aSold.length === 0) e("  (no sales yet)");
  for (const r of aSold) {
    e(
      `  ${r.pack_slug.padEnd(20)} ${r.surface.padEnd(11)} ${r.status.padEnd(13)} ` +
        `${String(r.n).padStart(3)} × → ${usd(r.cents).padStart(10)}  (${r.credits} credits)`,
    );
  }
  e(`  ${"".padEnd(46)}${String(aUnits).padStart(3)} packs  ${usd(aCents).padStart(10)}`);
  e(`  credits granted: ${aCredits}`);

  e("\nTRACK B — new racers, BOGO package (Starter + Intermediate)");
  if (trackB.length === 0) e("  (no sales yet)");
  for (const r of trackB) {
    const meta = TRACK_B[r.package_id as keyof typeof TRACK_B];
    e(
      `  ${r.package_id.padEnd(24)} ${String(r.n).padStart(3)} × ${usd(meta?.priceCents ?? 0)}` +
        ` → ${usd(r.n * (meta?.priceCents ?? 0)).padStart(10)}` +
        `   (basket incl. extras: ${usd(Math.round(Number(r.total_usd ?? 0) * 100))})`,
    );
  }
  e(`  ${"".padEnd(24)}${String(bUnits).padStart(3)} bookings  ${usd(bCents).padStart(10)}`);
  e(`  heats booked: ${bUnits * 2} (2 per booking)`);

  e("\nCOMBINED");
  e(`  units sold ............ ${aUnits + bUnits}`);
  e(`  deal revenue .......... ${usd(aCents + bCents)}`);
  e(`  retail value .......... ${usd(aRetail + bRetail)}`);
  e(`  discount given ........ ${usd(aRetail + bRetail - (aCents + bCents))}`);
  e(`  full basket (track B) . ${usd(bBasket)}   <- what those guests actually spent`);

  // Operational tail. Both of these need a human, so they print even at zero
  // rather than being hidden behind a non-empty check.
  e("\nNEEDS ATTENTION");
  const pendingN = aPending.reduce((s, r) => s + r.n, 0);
  const failedN = aFailed.reduce((s, r) => s + r.n, 0);
  e(
    `  pending (intent, never charged) . ${pendingN}` +
      (pendingN ? "   <- stale prepares; fine unless they persist" : ""),
  );
  e(
    `  grant-failed credits ............ ${failedN}` +
      (failedN ? "   <- deposit retry sweep owns these; verify they landed" : ""),
  );
}
