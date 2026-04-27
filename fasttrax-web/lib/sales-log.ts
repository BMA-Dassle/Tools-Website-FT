import redis from "@/lib/redis";

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
 * Redis layout (mirrors lib/sms-log.ts):
 *   sales:log:{YYYY-MM-DD}  LIST, LPUSH newest-first, 90-day TTL.
 *
 * The ET calendar day is computed from the entry's `ts` so a booking
 * at 11:30 PM doesn't drift into "tomorrow" for staff working a
 * Florida-time clock. Capped at 10k entries/day (we won't approach
 * this — peak FastTrax day ~50 reservations).
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
  /** Verbatim race / pack product names from the bill (e.g.
   *  "Junior Starter Race Blue", "Race Pack — 3 Race"). One entry
   *  per line item — qty > 1 still produces one string. */
  raceProductNames?: string[];
  /** Add-on / attraction product names on the same bill (e.g.
   *  "Shuffly", "Duck Pin", "Gel Blaster"). Used for the
   *  attach-rate breakdowns. */
  addOnNames?: string[];
  /** Coarse cash total in dollars (best-effort — not always in scope
   *  at confirmation time so this stays optional). */
  totalUsd?: number;
  /** Contact data — used for unique-booker counts + dedup. NOT for
   *  marketing / outreach from this surface. */
  email?: string;
  phone?: string;
}

const LOG_TTL = 60 * 60 * 24 * 90; // 90 days
const MAX_PER_DAY = 10_000;

/** ET calendar day for an ISO timestamp — same scheme sms-log uses. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
  return `sales:log:${parts}`;
}

/** Persist one confirmed reservation. */
export async function logSale(entry: SaleEntry): Promise<void> {
  try {
    const key = dayKey(entry.ts);
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, MAX_PER_DAY - 1);
    await redis.expire(key, LOG_TTL);
  } catch (err) {
    // Logging failures must never interrupt the confirmation flow.
    console.error("[sales-log] write failed:", err);
  }
}

/**
 * Read entries for a single ET-calendar day. Use `readSalesRange`
 * for cross-day queries — easier than calling this in a loop and
 * stitching results.
 */
export async function readSalesDay(
  ymdEt: string,
  { limit = 500, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<SaleEntry[]> {
  const raw = await redis.lrange(`sales:log:${ymdEt}`, offset, offset + limit - 1);
  const out: SaleEntry[] = [];
  for (const s of raw) {
    try { out.push(JSON.parse(s) as SaleEntry); } catch { /* skip corrupt entry */ }
  }
  return out;
}

/**
 * Read entries across an inclusive ET-calendar date range.
 * `from` and `to` are YYYY-MM-DD in America/New_York.
 *
 * We iterate dates client-side and union the per-day lists. With a
 * 31-day max default this is at most 31 LRANGE calls — cheap.
 */
export async function readSalesRange(
  fromYmd: string,
  toYmd: string,
  { limitPerDay = 5000 }: { limitPerDay?: number } = {},
): Promise<SaleEntry[]> {
  const out: SaleEntry[] = [];
  const dates = enumerateDates(fromYmd, toYmd);
  for (const ymd of dates) {
    const day = await readSalesDay(ymd, { limit: limitPerDay });
    out.push(...day);
  }
  // Newest first across the whole range.
  out.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return out;
}

/** Inclusive YYYY-MM-DD enumeration. Both endpoints assumed valid ET dates. */
function enumerateDates(fromYmd: string, toYmd: string): string[] {
  const fromMs = parseYmd(fromYmd);
  const toMs = parseYmd(toYmd);
  if (isNaN(fromMs) || isNaN(toMs) || toMs < fromMs) return [];
  const dayMs = 24 * 60 * 60 * 1000;
  const out: string[] = [];
  // Cap at 95 days to keep the query bounded — dashboard's longest
  // preset is "last 90 days", anything wider is a user typo.
  const maxDays = 95;
  for (let t = fromMs, n = 0; t <= toMs && n < maxDays; t += dayMs, n++) {
    const d = new Date(t);
    const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    out.push(ymd);
  }
  return out;
}

function parseYmd(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return NaN;
  // Use UTC noon to dodge DST-edge weirdness when iterating days.
  return Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
}
