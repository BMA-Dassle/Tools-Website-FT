/**
 * Board-side reads of `deal_purchases` — filtered, searched, keyset-paged.
 *
 * A SEPARATE FILE from `deal-purchases-db.ts` on purpose. That module owns the
 * table's write path and its `ensureSchema()`, which is a single memoised promise
 * that several in-flight branches are editing. Adding read-only indexes and
 * query helpers there would put this work in the one place guaranteed to
 * conflict. Everything here is additive and idempotent, so the two files can land
 * in either order.
 *
 * ORDERING IS `(created_at DESC, id DESC)` AND THAT IS ALSO THE KEYSET KEY.
 * `created_at` is the sale instant for a deal pack — the row is written
 * immediately before the charge in the same request, so it is within seconds of
 * `charged_at` and, unlike `charged_at`, is NOT NULL on every row. Sorting on a
 * COALESCE would also forfeit the index. The board's `soldAt` must therefore be
 * `created_at`; `charged_at` is shown in the detail timeline instead.
 *
 * FILTERS ARE ONE STATEMENT with nullable parameters rather than branched SQL.
 * Four optional filters branched in JS is sixteen query bodies to keep in step;
 * `(${p}::type IS NULL OR col = ...)` keeps it to one, and the date range — the
 * only predicate that has to be index-driven — stays a plain comparison.
 */

import { sql, isDbConfigured } from "@ft/db";
import { decodeDealPurchaseRow, type DealPurchaseRow } from "./deal-purchases-db";

let indexesReady: Promise<void> | null = null;

/**
 * Read-path indexes. Idempotent and independent of the write path's
 * `ensureSchema()`, which has already run by the time anything queries this
 * table (nothing can be read before something was written).
 */
function ensureSearchIndexes(): Promise<void> {
  indexesReady ??= (async () => {
    const q = sql();
    // The board's default sort and its keyset comparison, exactly.
    await q`
      CREATE INDEX IF NOT EXISTS deal_purchases_board
      ON deal_purchases (created_at DESC, id DESC)
    `;
    // Voucher-code search. `jsonb_path_ops` is roughly half the size of the
    // default opclass and supports the only operator used here (@>), which is
    // what "find the purchase this code came from" needs.
    await q`
      CREATE INDEX IF NOT EXISTS deal_purchases_codes_gin
      ON deal_purchases USING GIN (codes jsonb_path_ops)
    `;
  })();
  return indexesReady;
}

export interface DealSearchArgs {
  /** Half-open UTC window `[startUtc, endUtc)`. */
  startUtc: string;
  endUtc: string;
  /** Native `deal_purchases.status` values. Empty/undefined = all. */
  status?: string[];
  /** `location_key` values. Empty/undefined = all. */
  venue?: string[];
  /** Free text: name, email, phone, voucher code, Square id. */
  q?: string;
  /** Keyset position — return rows strictly older than this. */
  before?: { soldAt: string; ref: string } | null;
  limit: number;
}

/** Normalise a possibly-empty filter list to `string[] | null` for the SQL. */
function listParam(v: string[] | undefined): string[] | null {
  return v && v.length > 0 ? v : null;
}

/**
 * A voucher code typed by a human may carry the display hyphens (`HPW-K8EJ-PXCR`)
 * or not. `codes` stores them unhyphenated, so strip before the containment
 * check — otherwise pasting a code straight out of the confirmation email
 * silently matches nothing, which reads as "that sale doesn't exist".
 */
function codeCandidate(q: string): string | null {
  const bare = q.replace(/[^0-9a-z]/gi, "").toUpperCase();
  return bare.length >= 6 ? bare : null;
}

/**
 * Keyset page, newest first.
 *
 * `before.ref` is the row id as a string. It is cast to BIGINT for the row-wise
 * comparison; a non-numeric ref (a tampered cursor, or one minted by a different
 * source) yields null and the keyset predicate drops out, which serves page one
 * rather than erroring.
 */
export async function searchDealPurchases(args: DealSearchArgs): Promise<DealPurchaseRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSearchIndexes();
  const q = sql();

  const beforeAt = args.before?.soldAt ?? null;
  const beforeIdRaw = args.before?.ref ?? "";
  const beforeId = /^\d+$/.test(beforeIdRaw) ? beforeIdRaw : null;
  const text = args.q?.trim() || null;
  const code = text ? codeCandidate(text) : null;
  const like = text ? `%${text}%` : null;

  const rows = (await q`
    SELECT * FROM deal_purchases
    WHERE created_at >= ${args.startUtc} AND created_at < ${args.endUtc}
      AND (${listParam(args.status)}::text[] IS NULL OR status = ANY(${listParam(args.status)}::text[]))
      AND (${listParam(args.venue)}::text[] IS NULL OR location_key = ANY(${listParam(args.venue)}::text[]))
      AND (
        ${like}::text IS NULL
        OR buyer_name ILIKE ${like}
        OR buyer_email ILIKE ${like}
        OR buyer_phone ILIKE ${like}
        OR recipient_name ILIKE ${like}
        OR recipient_email ILIKE ${like}
        OR recipient_phone ILIKE ${like}
        OR square_order_id ILIKE ${like}
        OR square_payment_id ILIKE ${like}
        OR voucher_batch_id ILIKE ${like}
        OR idempotency_key ILIKE ${like}
        OR (${code}::text IS NOT NULL AND codes @> to_jsonb(ARRAY[${code}::text]))
      )
      AND (
        ${beforeAt}::timestamptz IS NULL
        OR ${beforeId}::bigint IS NULL
        OR (created_at, id) < (${beforeAt}::timestamptz, ${beforeId}::bigint)
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${Math.min(500, Math.max(1, args.limit))}
  `) as Record<string, unknown>[];
  return rows.map(decodeDealPurchaseRow);
}

export interface DealSearchTotals {
  /** Packs on non-refunded paid rows. */
  packsSold: number;
  grossCents: number;
  /** Sales rows counted (paid only), for the "N sales" line. */
  saleCount: number;
  /** Paid rows whose vouchers have been voided. */
  refundedCount: number;
  /** Paid, un-voided rows still owing codes or an email. */
  unfulfilled: number;
  /** Rows a human should look at: declines plus stalled fulfilment. */
  problemCount: number;
  /** Per-deal breakdown for the single-source rollup cards. */
  byDeal: Array<{ dealSlug: string; packsSold: number; grossCents: number; unfulfilled: number }>;
}

/**
 * Aggregate over the WHOLE matching set, not the current page.
 *
 * Deliberately mirrors the filter predicate above, minus the keyset — a summary
 * computed over one page would silently mean something different from the label
 * printed above it.
 *
 * `pending` and `charge_failed` are excluded from money but `charge_failed`
 * still counts as a problem: an abandoned card form is noise, a decline is a
 * guest who tried to give us money and could not.
 */
export async function summarizeDealPurchases(
  args: Omit<DealSearchArgs, "before" | "limit">,
): Promise<DealSearchTotals> {
  const empty: DealSearchTotals = {
    packsSold: 0,
    grossCents: 0,
    saleCount: 0,
    refundedCount: 0,
    unfulfilled: 0,
    problemCount: 0,
    byDeal: [],
  };
  if (!isDbConfigured()) return empty;
  await ensureSearchIndexes();
  const q = sql();

  const text = args.q?.trim() || null;
  const code = text ? codeCandidate(text) : null;
  const like = text ? `%${text}%` : null;

  const rows = (await q`
    WITH matched AS (
      SELECT deal_slug, qty, total_cents, status, refunded_at
      FROM deal_purchases
      WHERE created_at >= ${args.startUtc} AND created_at < ${args.endUtc}
        AND (${listParam(args.status)}::text[] IS NULL OR status = ANY(${listParam(args.status)}::text[]))
        AND (${listParam(args.venue)}::text[] IS NULL OR location_key = ANY(${listParam(args.venue)}::text[]))
        AND (
          ${like}::text IS NULL
          OR buyer_name ILIKE ${like}
          OR buyer_email ILIKE ${like}
          OR buyer_phone ILIKE ${like}
          OR recipient_name ILIKE ${like}
          OR recipient_email ILIKE ${like}
          OR recipient_phone ILIKE ${like}
          OR square_order_id ILIKE ${like}
          OR square_payment_id ILIKE ${like}
          OR voucher_batch_id ILIKE ${like}
          OR idempotency_key ILIKE ${like}
          OR (${code}::text IS NOT NULL AND codes @> to_jsonb(ARRAY[${code}::text]))
        )
    )
    SELECT
      deal_slug,
      COALESCE(SUM(qty) FILTER (WHERE paid AND NOT voided), 0)::int          AS packs_sold,
      COALESCE(SUM(total_cents) FILTER (WHERE paid AND NOT voided), 0)::int  AS gross_cents,
      COUNT(*) FILTER (WHERE paid)::int                                      AS sale_count,
      COUNT(*) FILTER (WHERE paid AND voided)::int                           AS refunded_count,
      COUNT(*) FILTER (WHERE paid AND NOT voided AND status IN ('charged','minted'))::int AS unfulfilled,
      COUNT(*) FILTER (WHERE status = 'charge_failed'
                          OR (paid AND NOT voided AND status IN ('charged','minted')))::int AS problem_count
    FROM (
      SELECT *,
             status NOT IN ('pending','charge_failed') AS paid,
             refunded_at IS NOT NULL                   AS voided
      FROM matched
    ) t
    GROUP BY deal_slug
  `) as Record<string, unknown>[];

  const byDeal = rows.map((r) => ({
    dealSlug: String(r.deal_slug),
    packsSold: Number(r.packs_sold ?? 0),
    grossCents: Number(r.gross_cents ?? 0),
    unfulfilled: Number(r.unfulfilled ?? 0),
  }));

  return {
    packsSold: byDeal.reduce((n, d) => n + d.packsSold, 0),
    grossCents: byDeal.reduce((n, d) => n + d.grossCents, 0),
    saleCount: rows.reduce((n, r) => n + Number(r.sale_count ?? 0), 0),
    refundedCount: rows.reduce((n, r) => n + Number(r.refunded_count ?? 0), 0),
    unfulfilled: byDeal.reduce((n, d) => n + d.unfulfilled, 0),
    problemCount: rows.reduce((n, r) => n + Number(r.problem_count ?? 0), 0),
    byDeal,
  };
}

/** Test seam — lets a suite re-run `ensureSearchIndexes` against a fresh mock. */
export function _resetDealSearchIndexes(): void {
  indexesReady = null;
}
