"use client";

import { useQuery } from "@tanstack/react-query";
import type { CrmRole } from "~/features/crm/core/types";
import type { BadgeKey } from "~/features/crm/core/nav";
import type { LeadBadgesResponse } from "~/features/crm/leads/contracts";
import { BADGES_POLL_MS, leadsKeys } from "~/features/crm/leads/queries";
import type { CrmFetch } from "../lib/crm-fetch";
import type { BadgeCounts } from "./nav-links";

/**
 * THE BADGE PROVIDERS (brief §3.5 "badge providers keyed by screen id").
 * `core/nav.ts` names the badge each item carries (`overdue`, `unassigned`,
 * `pendingApproval`, `unread`); this table says where each count comes from.
 * A PR fills exactly ITS line: B3 → `/leads/badges` for `overdue` and
 * `unassigned`; B5 adds `pendingApproval`; C1 adds `unread`. A `null` line
 * renders no badge.
 */
export const BADGE_SOURCES: Record<
  BadgeKey,
  { path: string; field: string; soft?: boolean } | null
> = {
  overdue: { path: "/leads/badges", field: "overdue" },
  unassigned: { path: "/leads/badges", field: "unassigned" },
  pendingApproval: null,
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
    const raw = payloads[source.path]?.[source.field];
    const n = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    if (n > 0) out[key] = { n, ...(source.soft ? { soft: true } : {}) };
  }
  return out;
}

/** Polls `/leads/badges` while the tab is visible and folds it into the shell's counts. */
export function useBadgeCounts(crmFetch: CrmFetch, role: CrmRole): BadgeCounts {
  const q = useQuery({
    queryKey: leadsKeys.badges(),
    queryFn: () => crmFetch<LeadBadgesResponse>("/leads/badges"),
    refetchInterval: BADGES_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: 15_000,
  });
  return badgeCountsFrom({ "/leads/badges": q.data as Record<string, unknown> | undefined }, role);
}
