/**
 * Keyset cursor for a board that merges several independent sources.
 *
 * WHY KEYSET AND NOT OFFSET. Offset paging over a merged stream needs a separate
 * offset per source, and any row inserted while someone is scrolling shifts every
 * subsequent page — on a money board that shows up as a sale that appears twice
 * or never appears at all. Keyset positions are anchored to actual rows, so a new
 * sale landing mid-scroll simply appears at the top on the next refresh.
 *
 * WHY A POSITION PER SOURCE rather than one global `(soldAt, id)` pair. The
 * sources have no shared sequence: `deal_purchases.id` and
 * `intercard_transactions.txn_id` are unrelated, and a global tiebreak would have
 * to be compared against a value from a different table. Carrying one position
 * per source keeps each adapter's SQL comparing its own key to its own key, and
 * makes it structurally impossible for one source's cursor to leak into another's
 * query — see the test that asserts exactly that.
 *
 * A source ABSENT from `positions` means "start from the top" — which is also
 * what a brand-new adapter gets when someone pages with a cursor minted before it
 * was registered. That degrades to showing its newest rows, never to a crash.
 *
 * THE CODEC NEVER THROWS. A cursor is user-supplied (it rides on the query
 * string), so every malformation — truncated, tampered, valid base64 of the wrong
 * shape, an unknown source id — resolves to `null`, meaning "start from the top".
 * Failing a whole board render because someone edited a URL would be worse than
 * silently showing page one.
 */

import { isSaleSourceId, type SaleCursorPosition, type SaleSourceId, type WebSaleRow } from "../types";

export interface SaleCursor {
  /** Per-source keyset position. Absent source = start from the top. */
  positions: Partial<Record<SaleSourceId, SaleCursorPosition>>;
}

/** Guard against a hand-crafted cursor being used as an unbounded payload. */
const MAX_ENCODED_LENGTH = 2048;

function isPosition(v: unknown): v is SaleCursorPosition {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.soldAt === "string" &&
    p.soldAt.length > 0 &&
    p.soldAt.length <= 40 &&
    typeof p.ref === "string" &&
    p.ref.length > 0 &&
    p.ref.length <= 300
  );
}

export function encodeCursor(cursor: SaleCursor): string {
  // Sort the keys so the same logical position always encodes to the same
  // string — otherwise an identical page yields a different cursor depending on
  // object insertion order, which makes the value useless for cache keys and
  // miserable to assert in a test.
  const sorted: Record<string, SaleCursorPosition> = {};
  for (const key of Object.keys(cursor.positions).sort()) {
    const pos = cursor.positions[key as SaleSourceId];
    if (pos) sorted[key] = { soldAt: pos.soldAt, ref: pos.ref };
  }
  return Buffer.from(JSON.stringify({ p: sorted }), "utf8").toString("base64url");
}

/** `null` for anything unusable — see the file header. Never throws. */
export function decodeCursor(raw: string | null | undefined): SaleCursor | null {
  if (!raw || raw.length > MAX_ENCODED_LENGTH) return null;
  let parsed: unknown;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    if (!json) return null;
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const bag = (parsed as Record<string, unknown>).p;
  if (typeof bag !== "object" || bag === null) return null;

  const positions: Partial<Record<SaleSourceId, SaleCursorPosition>> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(bag as Record<string, unknown>)) {
    // An unknown source id is dropped rather than rejected: a cursor minted
    // before a source was retired should still page the sources that remain.
    if (!isSaleSourceId(key) || !isPosition(value)) continue;
    positions[key] = { soldAt: value.soldAt, ref: value.ref };
    kept += 1;
  }
  // Valid JSON that yielded no usable position is indistinguishable from junk.
  return kept > 0 ? { positions } : null;
}

/**
 * The cursor for the NEXT page, given the rows actually taken for this one.
 *
 * A source that contributed no rows keeps its previous position — its rows are
 * still pending behind the ones that won the merge, and resetting it would
 * re-serve them. A source that did contribute advances to the last row taken
 * FROM IT, which is not necessarily the last row on the page.
 */
export function advanceCursor(prev: SaleCursor | null, taken: WebSaleRow[]): SaleCursor {
  const positions: Partial<Record<SaleSourceId, SaleCursorPosition>> = {
    ...(prev?.positions ?? {}),
  };
  for (const row of taken) {
    // `taken` is in merge order, so the last write per source wins — which is
    // exactly the oldest row taken from that source.
    positions[row.source] = { soldAt: row.soldAt, ref: row.ref };
  }
  return { positions };
}

/** This source's position, or null to start from the top. */
export function positionFor(
  cursor: SaleCursor | null,
  source: SaleSourceId,
): SaleCursorPosition | null {
  return cursor?.positions[source] ?? null;
}
