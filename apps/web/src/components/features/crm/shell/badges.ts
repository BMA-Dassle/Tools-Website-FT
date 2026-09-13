"use client";

import { useQueries } from "@tanstack/react-query";
import type { CrmRole } from "~/features/crm/core/types";
import type { BadgeKey } from "~/features/crm/core/nav";
import { BADGES_POLL_MS } from "~/features/crm/leads/queries";
import type { CrmFetch } from "../lib/crm-fetch";
import type { BadgeCounts } from "./nav-links";

/**
 * THE BADGE PROVIDERS (brief §3.5 "badge providers keyed by screen id").
 * `core/nav.ts` names the badge each item carries (`overdue`, `unassigned`,
 * `pendingApproval`, `unread`); this table says where each count comes from.
 * A PR fills exactly ITS line: B3 → `/leads/badges` for `overdue` and
 * `unassigned`; B5 → `/contracts?counts=1` for `pendingApproval`; C1 adds
 * `unread`. A `null` line renders no badge.
 *
 * `field` may name a nested value ("counts.pendingApproval"): the contracts
 * board answers one envelope for its tiles AND its badge, and a badge poll
 * must not cost a page of contracts a minute just to reshape the JSON.
 */
export const BADGE_SOURCES: Record<
  BadgeKey,
  { path: string; field: string; soft?: boolean } | null
> = {
  overdue: { path: "/leads/badges", field: "overdue" },
  unassigned: { path: "/leads/badges", field: "unassigned" },
  pendingApproval: { path: "/contracts?counts=1", field: "counts.pendingApproval" },
  unread: null,
};

/** Every distinct endpoint the table names — one query per path. */
export const BADGE_PATHS: readonly string[] = [
  ...new Set(
    Object.values(BADGE_SOURCES)
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .map((s) => s.path),
  ),
];

/** `"counts.pendingApproval"` → the nested number, or undefined. */
export function pickField(payload: Record<string, unknown> | undefined, field: string): unknown {
  if (!payload) return undefined;
  let cursor: unknown = payload;
  for (const part of field.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** Pure: fold `{path → payload}` into the shell's `BadgeCounts`. */
export function badgeCountsFrom(
  payloads: Record<string, Record<string, unknown> | undefined>,
  role: CrmRole,
): BadgeCounts {
  const out: BadgeCounts = {};
  for (const [key, source] of Object.entries(BADGE_SOURCES) as [
    BadgeKey,
    (typeof BADGE_SOURCES)[BadgeKey],
  ][]) {
    if (!source) continue;
    if (key === "unassigned" && role !== "director") continue;
    const raw = pickField(payloads[source.path], source.field);
    const n = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    if (n > 0) out[key] = { n, ...(source.soft ? { soft: true } : {}) };
  }
  return out;
}

/** Polls every badge endpoint while the tab is visible and folds them together. */
export function useBadgeCounts(crmFetch: CrmFetch, role: CrmRole): BadgeCounts {
  const results = useQueries({
    queries: BADGE_PATHS.map((path) => ({
      queryKey: ["crm", "badges", path] as const,
      queryFn: () => crmFetch<Record<string, unknown>>(path),
      refetchInterval: BADGES_POLL_MS,
      refetchIntervalInBackground: false,
      staleTime: 15_000,
    })),
  });
  const payloads: Record<string, Record<string, unknown> | undefined> = {};
  BADGE_PATHS.forEach((path, i) => {
    payloads[path] = results[i]?.data as Record<string, unknown> | undefined;
  });
  return badgeCountsFrom(payloads, role);
}
