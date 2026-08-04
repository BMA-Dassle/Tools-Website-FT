/**
 * Board filter state ↔ query string.
 *
 * PURE, and separate from the component on purpose. vitest here runs node-only
 * with no jsdom, so anything living inside the board is untestable — and this is
 * the part worth testing: a filtered view has to be linkable, survive a reload
 * byte-identical, and never silently narrow itself.
 *
 * The URL is the single source of truth for filter state. Not component state
 * mirrored into the URL — the URL itself — so back/forward work, a filtered
 * board can be pasted into Teams, and a refresh lands on the same rows.
 */

import { SALE_SOURCE_IDS, isSaleSourceId, type SaleSourceId } from "~/features/web-sales";

export interface BoardFilters {
  from: string;
  to: string;
  sources: SaleSourceId[];
  statuses: string[];
  venues: string[];
  q: string;
  /** Only rows with a `problem`. The filter ops actually use. */
  problemsOnly: boolean;
}

export const EMPTY_FILTERS: Omit<BoardFilters, "from" | "to"> = {
  sources: [],
  statuses: [],
  venues: [],
  q: "",
  problemsOnly: false,
};

/** Date presets, in the order the chips render. */
export const DATE_PRESETS = ["today", "yesterday", "7d", "30d", "mtd"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export function isDatePreset(v: string): v is DatePreset {
  return (DATE_PRESETS as readonly string[]).includes(v);
}

/**
 * Resolve a preset against a reference ET day.
 *
 * Takes `todayYmd` rather than reading the clock so it is deterministic in a
 * test and cannot disagree with the server's idea of today mid-render.
 */
export function presetRange(
  preset: DatePreset,
  todayYmd: string,
  shift: (ymd: string, days: number) => string,
): { from: string; to: string } {
  switch (preset) {
    case "today":
      return { from: todayYmd, to: todayYmd };
    case "yesterday": {
      const y = shift(todayYmd, -1);
      return { from: y, to: y };
    }
    case "7d":
      return { from: shift(todayYmd, -6), to: todayYmd };
    case "30d":
      return { from: shift(todayYmd, -29), to: todayYmd };
    case "mtd":
      return { from: `${todayYmd.slice(0, 7)}-01`, to: todayYmd };
  }
}

/** Which preset (if any) a range corresponds to — so the right chip lights up. */
export function matchPreset(
  range: { from: string; to: string },
  todayYmd: string,
  shift: (ymd: string, days: number) => string,
): DatePreset | null {
  return (
    DATE_PRESETS.find((p) => {
      const r = presetRange(p, todayYmd, shift);
      return r.from === range.from && r.to === range.to;
    }) ?? null
  );
}

const csv = (v: string | null): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Read filters out of a query string.
 *
 * Unknown source ids are dropped rather than rejected — a stale link from before
 * a source was retired should still show the sources that remain, not error.
 * Status and venue values are NOT validated here: they are source-native and the
 * adapters own their vocabularies.
 */
export function parseFilters(
  search: URLSearchParams,
  fallback: { from: string; to: string },
): BoardFilters {
  return {
    from: search.get("from") || fallback.from,
    to: search.get("to") || fallback.to,
    sources: csv(search.get("source")).filter(isSaleSourceId),
    statuses: csv(search.get("status")),
    venues: csv(search.get("venue")),
    q: (search.get("q") || "").trim(),
    problemsOnly: search.get("problems") === "1",
  };
}

/**
 * Serialise filters back to a query string.
 *
 * Defaults are OMITTED, so a board at rest has a clean URL and two equivalent
 * filter states always produce the same string. Keys are written in a fixed
 * order for the same reason — a URL that reshuffles on every render is useless
 * as a browser history entry.
 */
export function serializeFilters(f: BoardFilters, fallback: { from: string; to: string }): string {
  const p = new URLSearchParams();
  if (f.from !== fallback.from) p.set("from", f.from);
  if (f.to !== fallback.to) p.set("to", f.to);
  if (f.sources.length > 0) p.set("source", f.sources.join(","));
  if (f.statuses.length > 0) p.set("status", f.statuses.join(","));
  if (f.venues.length > 0) p.set("venue", f.venues.join(","));
  if (f.q) p.set("q", f.q);
  if (f.problemsOnly) p.set("problems", "1");
  return p.toString();
}

/**
 * The query string for the API call.
 *
 * `problemsOnly` is deliberately NOT sent: "needs attention" is derived from the
 * projected row (`status.problem`), not from any source's native status
 * vocabulary, so it is filtered client-side after projection. Sending it would
 * require every adapter to reimplement the same judgement in SQL and they would
 * drift.
 */
export function toApiQuery(f: BoardFilters, token: string, extra?: Record<string, string>): string {
  const p = new URLSearchParams({ token, from: f.from, to: f.to });
  if (f.sources.length > 0) p.set("source", f.sources.join(","));
  if (f.statuses.length > 0) p.set("status", f.statuses.join(","));
  if (f.venues.length > 0) p.set("venue", f.venues.join(","));
  if (f.q) p.set("q", f.q);
  for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v);
  return p.toString();
}

/** Toggle a value in a multi-select filter list. */
export function toggle<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** Are any filters beyond the date range active? Drives the "Clear" affordance. */
export function hasActiveFilters(f: BoardFilters): boolean {
  return (
    f.sources.length > 0 || f.statuses.length > 0 || f.venues.length > 0 || !!f.q || f.problemsOnly
  );
}

/** Every source id, for a board that wants to render all chips. */
export const ALL_SOURCE_IDS: readonly SaleSourceId[] = SALE_SOURCE_IDS;
