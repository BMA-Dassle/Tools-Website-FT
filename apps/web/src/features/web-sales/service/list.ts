/**
 * Fan out to every active adapter, merge newest-first, page by keyset.
 *
 * The merge is a plain concat-and-sort rather than a heap. With at most three
 * sources and a hard limit of 200 rows each, the worst case is ~600 objects —
 * a heap would be more code to read and no faster in any real scenario.
 *
 * OVER-FETCH BY ONE. Each adapter is asked for `limit + 1` so the merge can tell
 * "this is the last page" from "there is exactly one more row" without a second
 * round trip. Only `limit` rows are ever returned.
 *
 * A FAILING SOURCE IS REPORTED, NOT SWALLOWED. If one adapter throws, the board
 * still renders the others — but the failure comes back in `errors` so the UI can
 * say "game-card reloads failed to load" instead of showing a shorter list that
 * looks complete. Silently dropping a source on a money board is how a sale goes
 * missing and nobody notices; the same reasoning as the no-silent-caps rule.
 */

import type { SaleListQuery, WebSaleAdapter, WebSaleRow } from "../types";
import { advanceCursor, encodeCursor, positionFor, type SaleCursor } from "./cursor";

export interface ListWebSalesResult {
  rows: WebSaleRow[];
  /** Opaque cursor for the next page, or null when this was the last one. */
  nextCursor: string | null;
  errors: Array<{ source: string; message: string }>;
}

/**
 * Newest first. Ties on `soldAt` break on `id` descending — `id` is
 * `${source}:${ref}`, globally unique, so the order is total and stable. Without
 * a total order the same row can straddle a page boundary and be served twice.
 */
export function compareRowsDesc(a: WebSaleRow, b: WebSaleRow): number {
  if (a.soldAt !== b.soldAt) return a.soldAt < b.soldAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** Merge pre-sorted per-source batches into one newest-first page. */
export function mergeRows(batches: WebSaleRow[][], limit: number): WebSaleRow[] {
  return batches
    .flat()
    .sort(compareRowsDesc)
    .slice(0, Math.max(0, limit));
}

export async function listWebSales(args: {
  adapters: WebSaleAdapter[];
  query: Omit<SaleListQuery, "before" | "limit">;
  cursor: SaleCursor | null;
  limit: number;
}): Promise<ListWebSalesResult> {
  const { adapters, query, cursor, limit } = args;
  const errors: Array<{ source: string; message: string }> = [];

  const batches = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        return await adapter.list({
          ...query,
          before: positionFor(cursor, adapter.id),
          limit: limit + 1,
        });
      } catch (err) {
        errors.push({
          source: adapter.id,
          message: err instanceof Error ? err.message : String(err),
        });
        return [] as WebSaleRow[];
      }
    }),
  );

  const available = batches.reduce((n, b) => n + b.length, 0);
  const rows = mergeRows(batches, limit);
  const hasMore = available > rows.length;

  return {
    rows,
    // No more rows means no more cursor. Handing back a cursor that yields an
    // empty page makes "Load more" look broken rather than finished.
    nextCursor: hasMore ? encodeCursor(advanceCursor(cursor, rows)) : null,
    errors,
  };
}
