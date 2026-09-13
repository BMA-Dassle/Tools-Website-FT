"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Filters live in the URL (brief §3.1): a link is a saved view. Pattern from
 * `WebSalesBoard.tsx:102-113` — `history.replaceState`, never a router push, so
 * flipping a Seg does not stack history entries.
 *
 * `initial` is the query the page saw at mount (`CrmApp.initialSearch`);
 * `setQuery` patches it (null / "" removes a key) and mirrors it to the URL in
 * the same call, so nothing here sets state inside an effect.
 */
export type UrlQueryPatch = Record<string, string | null | undefined>;

export function mergeQuery(prev: Record<string, string>, patch: UrlQueryPatch) {
  const next: Record<string, string> = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") delete next[k];
    else next[k] = v;
  }
  return next;
}

export function queryToSearch(query: Record<string, string>): string {
  const qs = new URLSearchParams(query).toString();
  return qs ? `?${qs}` : "";
}

function replaceUrl(query: Record<string, string>): void {
  if (typeof window === "undefined") return;
  const next = `${window.location.pathname}${queryToSearch(query)}`;
  if (next !== window.location.pathname + window.location.search) {
    window.history.replaceState(null, "", next);
  }
}

export function useUrlQuery(initial: Record<string, string>) {
  const [query, setQueryState] = useState(initial);
  const current = useRef(initial);

  const setQuery = useCallback((patch: UrlQueryPatch) => {
    const next = mergeQuery(current.current, patch);
    current.current = next;
    replaceUrl(next);
    setQueryState(next);
  }, []);

  return [query, setQuery] as const;
}
