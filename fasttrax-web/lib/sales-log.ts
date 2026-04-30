import { sql, isDbConfigured } from "@/lib/db";

/**
 * Persistent sales log — one entry per confirmed web reservation.
 *
 * Captures the booking shape at confirmation time (the moment SMS +
 * email fire) so the /admin/{token}/sales dashboard can answer:
 *   - How many reservations on a given day / range?
 *   - What % of new-racer bookings took the Rookie Pack?
 *   - POV attach rate split by new vs returning?
 *   - Add-on attach rate (HeadPinz attractions on a racing booking)?
 *   - Which race products / attractions are selling?
 *
 * ── Storage policy ──────────────────────────────────────────────
 *
 * **Long-term data → Neon Postgres.** Sales analytics need
 * unbounded retention (year-over-year comparisons, season totals,
 * cohort tracking) and SQL-native aggregation, so this lives in
 * Postgres exclusively.
 *
 * **Short-term, time-bounded data → Redis.** The rest of the app
 * (sms-log, sms-quota, ticket records, camera-assign,
 * race-day session state, etc.) has natural TTLs measured in
 * hours-to-days and stays in Redis — fast, ephemeral, no retention
 * needed.
 *
 * If you're adding a new data store, ask: do we need this six
 * months from now? Yes → Postgres. No → Redis.
 *
 * ── Retention ──────────────────────────────────────────────────
 *
 * Postgres rows are kept indefinitely. There's no application-side
 * pruning — Neon's storage is cheap and analytics on full history
 * is the whole point. If table size becomes a real concern (>10M
 * rows), partition by year or archive older years to cold storage.
 *
 * ── Schema ─────────────────────────────────────────────────────
 *
 * Auto-bootstrapped via `ensureSchema()` on first write. The
 * `IF NOT EXISTS` clauses make repeat runs no-ops.
 *
 * Data starts accumulating from the deploy of this file. No
 * backfill — we don't have a full booking-records archive to mine.
 */

export type BookingType =
  | "racing"      // pure racing booking
  | "racing-pack" // race-pack purchase
  | "attractions" // attraction-only (bowling, gel blaster, etc.)
  | "mixed"       // racing + attractions in one bill
  | "other";

export interface SaleEntry {
  /** ISO timestamp of confirmation (when SMS/email fired). */
  ts: string;
  /** BMI bill / order id — the canonical reservation key. */
  billId?: string;
  /** Short reservation number used on the confirmation page (e.g. "ABC123"). */
  reservationNumber?: string;
  /** Brand the booking landed under. */
  brand?: "fasttrax" | "headpinz";
  /** Physical location. */
  location?: "fortmyers" | "naples";
  /** What kind of booking this was — drives the dashboard breakdowns. */
  bookingType: BookingType;
  /** Total number of racers / participants on the bill. */
  participantCount?: number;
  /** True when the booker was a brand-new racer (no Pandora personId
   *  on file before this booking). Drives the Rookie Pack + POV
   *  cohort breakdowns. */
  isNewRacer?: boolean;
  /** True when the racing booking opted into the Rookie Pack
   *  (license + POV + free appetizer bundle). */
  rookiePack?: boolean;
  /** True when the bill includes a POV race-video product. */
  povPurchased?: boolean;
  /** Quantity of POV products sold (= number of racers when bundled). */
  povQty?: number;
  /** True when the bill includes a FastTrax license sale. */
  licensePurchased?: boolean;
  /** True when this was an Express Lane (returning-racer) booking. */
  expressLane?: boolean;
  /** Verbatim race / pack product names from the bill. */
  raceProductNames?: string[];
  /** Add-on / attraction product names on the same bill. */
  addOnNames?: string[];
  /** Coarse cash total in dollars (best-effort — not always in scope
   *  at confirmation time so this stays optional). */
  totalUsd?: number;
  /** Contact data — used for unique-booker counts + dedup. NOT for
   *  marketing / outreach from this surface. */
  email?: string;
  phone?: string;
  /** Package ID if this booking used a named bundle (e.g. "rookie-pack",
   *  "ultimate-qualifier-mega"). Null for plain/itemized bookings.
   *  Drives the generic "Packages" section in the sales dashboard. */
  packageId?: string;
  /** True when the bill was sold via the Square-charge +
   *  Pandora-deposit workaround (race packs, while BMI's
   *  booking/sell flow for packs is broken). When true, the BMI
   *  bill is synthetic — no `booking/sell` row exists upstream. */
  viaDeposit?: boolean;
  /** Pandora T_DEPOSIT row id returned by addDeposit (only set
   *  for `viaDeposit: true` rows, AFTER credit succeeded). */
  depositId?: string;
  /** True when Square charged successfully but the addDeposit call
   *  failed — admin needs to retry from the sales board. Only ever
   *  true on `viaDeposit` rows. */
  depositCreditPending?: boolean;
  /** Person ID the deposit credit landed on (or should land on,
   *  if pending). Lets admin re-run addDeposit without
   *  re-collecting context. Only meaningful when `viaDeposit`. */
  depositPersonId?: string;
  /** Deposit kind id the credit was applied to — see DEPOSIT_KIND
   *  in lib/pandora-deposits.ts. */
  depositKindId?: string;
  /** Number of race credits added (the "amount" passed to
   *  addDeposit). Stored separately from raceCount on the
   *  product so admin can audit deposit math vs. pack purchased. */
  depositAmount?: number;
}

/**
 * Idempotent schema bootstrap — runs once per cold start. The
 * `IF NOT EXISTS` clauses make subsequent runs no-ops.
 */
let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS sales_log (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      bill_id TEXT,
      reservation_number TEXT,
      brand TEXT,
      location TEXT,
      booking_type TEXT NOT NULL,
      participant_count INTEGER,
      is_new_racer BOOLEAN,
      rookie_pack BOOLEAN,
      pov_purchased BOOLEAN,
      pov_qty INTEGER,
      license_purchased BOOLEAN,
      express_lane BOOLEAN,
      race_product_names TEXT[],
      add_on_names TEXT[],
      total_usd NUMERIC(10, 2),
      email TEXT,
      phone TEXT,
      inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS sales_log_ts_idx ON sales_log(ts DESC)`;
  await q`CREATE INDEX IF NOT EXISTS sales_log_bill_idx ON sales_log(bill_id) WHERE bill_id IS NOT NULL`;
  await q`CREATE INDEX IF NOT EXISTS sales_log_booking_type_idx ON sales_log(booking_type)`;
  // Forward-compatible additions for the race-pack Square+deposit
  // workaround. ALTER ADD COLUMN IF NOT EXISTS is idempotent —
  // safe to run on every cold start.
  await q`ALTER TABLE sales_log ADD COLUMN IF NOT EXISTS via_deposit BOOLEAN`;
  await q`ALTER TABLE sales_log ADD COLUMN IF NOT EXISTS deposit_id TEXT`;
  await q`ALTER TABLE sales_log ADD COLUMN IF NOT EXISTS deposit_credit_pending BOOLEAN`;
  await q`ALTER TABLE sales_log ADD COLUMN IF NOT EXISTS deposit_person_id TEXT`;
  await q`ALTER TABLE sales_log ADD COLUMN IF NOT EXISTS deposit_kind_id TEXT`;
  await q`ALTER TABLE sales_log ADD COLUMN IF NOT EXISTS deposit_amount INTEGER`;
  // Generic package tracking — stores the packageId string (e.g. "rookie-pack",
  // "ultimate-qualifier-mega") so the dashboard can group by package type
  // without hardcoding every bundle name in SQL.
  await q`ALTER TABLE sales_log ADD COLUMN IF NOT EXISTS package_id TEXT`;
  // Partial index: admin board's "needs reconcile" filter scans
  // only the small subset where Square charged but addDeposit
  // didn't land. Predicate keeps the index tiny.
  await q`CREATE INDEX IF NOT EXISTS sales_log_pending_credit_idx ON sales_log(ts DESC) WHERE deposit_credit_pending IS TRUE`;
  schemaReady = true;
}

/**
 * Persist one confirmed reservation to Postgres.
 *
 * Failures are logged + swallowed — sales-logging must never break
 * the confirmation flow. Caller (booking-confirmation/route.ts) is
 * already wrapped in try/catch as a defense in depth.
 */
export async function logSale(entry: SaleEntry): Promise<void> {
  if (!isDbConfigured()) {
    console.warn("[sales-log] DATABASE_URL not configured — skipping write");
    return;
  }
  try {
    await ensureSchema();
    const q = sql();
    await q`
      INSERT INTO sales_log (
        ts, bill_id, reservation_number, brand, location, booking_type,
        participant_count, is_new_racer, rookie_pack, pov_purchased, pov_qty,
        license_purchased, express_lane, race_product_names, add_on_names,
        total_usd, email, phone,
        via_deposit, deposit_id, deposit_credit_pending,
        deposit_person_id, deposit_kind_id, deposit_amount,
        package_id
      ) VALUES (
        ${entry.ts},
        ${entry.billId ?? null},
        ${entry.reservationNumber ?? null},
        ${entry.brand ?? null},
        ${entry.location ?? null},
        ${entry.bookingType},
        ${entry.participantCount ?? null},
        ${entry.isNewRacer ?? null},
        ${entry.rookiePack ?? null},
        ${entry.povPurchased ?? null},
        ${entry.povQty ?? null},
        ${entry.licensePurchased ?? null},
        ${entry.expressLane ?? null},
        ${entry.raceProductNames ?? null},
        ${entry.addOnNames ?? null},
        ${entry.totalUsd ?? null},
        ${entry.email ?? null},
        ${entry.phone ?? null},
        ${entry.viaDeposit ?? null},
        ${entry.depositId ?? null},
        ${entry.depositCreditPending ?? null},
        ${entry.depositPersonId ?? null},
        ${entry.depositKindId ?? null},
        ${entry.depositAmount ?? null},
        ${entry.packageId ?? null}
      )
    `;
  } catch (err) {
    console.error("[sales-log] write failed:", err);
  }
}

/** Row shape returned by the Postgres SELECT — matches SaleEntry
 *  but with snake_case columns the driver returns. */
interface SalesLogRow {
  ts: string;
  bill_id: string | null;
  reservation_number: string | null;
  brand: string | null;
  location: string | null;
  booking_type: string;
  participant_count: number | null;
  is_new_racer: boolean | null;
  rookie_pack: boolean | null;
  pov_purchased: boolean | null;
  pov_qty: number | null;
  license_purchased: boolean | null;
  express_lane: boolean | null;
  race_product_names: string[] | null;
  add_on_names: string[] | null;
  total_usd: string | null;
  email: string | null;
  phone: string | null;
  via_deposit: boolean | null;
  deposit_id: string | null;
  deposit_credit_pending: boolean | null;
  deposit_person_id: string | null;
  deposit_kind_id: string | null;
  deposit_amount: number | null;
  package_id: string | null;
}

function rowToEntry(r: SalesLogRow): SaleEntry {
  return {
    ts: typeof r.ts === "string" ? r.ts : new Date(r.ts).toISOString(),
    billId: r.bill_id ?? undefined,
    reservationNumber: r.reservation_number ?? undefined,
    brand: (r.brand as SaleEntry["brand"]) ?? undefined,
    location: (r.location as SaleEntry["location"]) ?? undefined,
    bookingType: r.booking_type as BookingType,
    participantCount: r.participant_count ?? undefined,
    isNewRacer: r.is_new_racer ?? undefined,
    rookiePack: r.rookie_pack ?? undefined,
    povPurchased: r.pov_purchased ?? undefined,
    povQty: r.pov_qty ?? undefined,
    licensePurchased: r.license_purchased ?? undefined,
    expressLane: r.express_lane ?? undefined,
    raceProductNames: r.race_product_names ?? undefined,
    addOnNames: r.add_on_names ?? undefined,
    totalUsd: r.total_usd != null ? parseFloat(r.total_usd) : undefined,
    email: r.email ?? undefined,
    phone: r.phone ?? undefined,
    viaDeposit: r.via_deposit ?? undefined,
    depositId: r.deposit_id ?? undefined,
    depositCreditPending: r.deposit_credit_pending ?? undefined,
    depositPersonId: r.deposit_person_id ?? undefined,
    depositKindId: r.deposit_kind_id ?? undefined,
    depositAmount: r.deposit_amount ?? undefined,
    // Synthesize packageId from legacy rookiePack bool for old rows
    // that were written before the package_id column existed.
    packageId: r.package_id ?? (r.rookie_pack ? "rookie-pack" : undefined),
  };
}

/**
 * Flip a sales_log row from "pending credit" → "credit landed" once
 * an admin retry succeeds. Idempotent — a no-op if the row already
 * has a depositId.
 *
 * Identified by `billId` (synthetic for via-deposit rows, but
 * unique per attempt).
 */
export async function markDepositCredited(billId: string, depositId: string): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    await q`
      UPDATE sales_log
      SET deposit_id = ${depositId},
          deposit_credit_pending = FALSE
      WHERE bill_id = ${billId}
        AND via_deposit IS TRUE
        AND (deposit_id IS NULL OR deposit_credit_pending IS TRUE)
    `;
  } catch (err) {
    console.error("[sales-log] markDepositCredited failed:", err);
  }
}

/**
 * Read entries across an inclusive ET-calendar date range.
 * Both endpoints are YYYY-MM-DD in America/New_York.
 *
 * Queries Postgres directly. Uses a per-day window with an ET-aware
 * timestamp cast so DST transitions don't shift the bucket boundaries.
 */
export async function readSalesRange(
  fromYmd: string,
  toYmd: string,
  { limit = 5000 }: { limit?: number } = {},
): Promise<SaleEntry[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  // Inclusive of `to` — add a day and use < (cleaner than BETWEEN
  // for ET-day boundaries).
  const startTs = `${fromYmd} 00:00:00 America/New_York`;
  const endTs = `${toYmd} 23:59:59.999 America/New_York`;
  const rows = (await q`
    SELECT
      ts, bill_id, reservation_number, brand, location, booking_type,
      participant_count, is_new_racer, rookie_pack, pov_purchased, pov_qty,
      license_purchased, express_lane, race_product_names, add_on_names,
      total_usd, email, phone,
      via_deposit, deposit_id, deposit_credit_pending,
      deposit_person_id, deposit_kind_id, deposit_amount,
      package_id
    FROM sales_log
    WHERE ts >= ${startTs}::timestamptz
      AND ts <= ${endTs}::timestamptz
    ORDER BY ts DESC
    LIMIT ${limit}
  `) as SalesLogRow[];
  return rows.map(rowToEntry);
}

/**
 * Per-day reservation counts in the same range. Used by the
 * dashboard's daily-volume bar chart. Bucketing is done in SQL
 * with an ET-aware date cast so the buckets line up with the
 * dashboard's date filters.
 */
export async function readDailyTotals(
  fromYmd: string,
  toYmd: string,
): Promise<{ ymd: string; reservations: number; racers: number }[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const startTs = `${fromYmd} 00:00:00 America/New_York`;
  const endTs = `${toYmd} 23:59:59.999 America/New_York`;
  const rows = (await q`
    SELECT
      to_char((ts AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS ymd,
      COUNT(*)::int AS reservations,
      COALESCE(SUM(participant_count), 0)::int AS racers
    FROM sales_log
    WHERE ts >= ${startTs}::timestamptz
      AND ts <= ${endTs}::timestamptz
    GROUP BY ymd
    ORDER BY ymd ASC
  `) as { ymd: string; reservations: number; racers: number }[];
  return rows;
}
