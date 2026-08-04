/**
 * The adapter registry.
 *
 * Adding a sale source is ONE new file in `adapters/` and ONE line in `ALL`.
 * That is the acceptance test for the whole design — if a new source needs a
 * change anywhere else, the contract in `types.ts` is wrong and should be fixed
 * before the adapter ships.
 */

import { dealsAdapter } from "./adapters/deals";
import { disabledSaleSources } from "./flags";
import type { SaleSourceId, WebSaleAdapter } from "./types";

/**
 * Every registered adapter, in board order.
 *
 * `satisfies` rather than a plain annotation so the keys are checked against
 * `SaleSourceId` while the object keeps its literal type — a registry keyed by a
 * typo would otherwise compile and simply never match a request.
 */
const ALL = {
  deals: dealsAdapter,
} satisfies Partial<Record<SaleSourceId, WebSaleAdapter>>;

/** Registered adapters, ignoring kill switches. */
export function allAdapters(): WebSaleAdapter[] {
  return Object.values(ALL);
}

/** Registered adapters minus anything switched off via `WEB_SALES_SOURCES_OFF`. */
export function activeAdapters(): WebSaleAdapter[] {
  const off = disabledSaleSources();
  return allAdapters().filter((a) => !off.has(a.id));
}

/**
 * Resolve a source id from a request. Returns null for unknown AND for
 * switched-off sources — a killed source must be unreachable by direct id, not
 * merely hidden from the list.
 */
export function getAdapter(id: string): WebSaleAdapter | null {
  return activeAdapters().find((a) => a.id === id) ?? null;
}

/**
 * The adapters a request should read, honouring an explicit `source` filter.
 * An empty or absent filter means every active source.
 */
export function adaptersFor(sources: SaleSourceId[] | undefined): WebSaleAdapter[] {
  const active = activeAdapters();
  if (!sources || sources.length === 0) return active;
  const wanted = new Set<string>(sources);
  return active.filter((a) => wanted.has(a.id));
}
