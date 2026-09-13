"use client";

import { useQueries } from "@tanstack/react-query";
import type { CrmRole } from "~/features/crm/core/types";
import type { BadgeKey } from "~/features/crm/core/nav";
import { BADGES_POLL_MS, leadsKeys } from "~/features/crm/leads/queries";
import { smsKeys } from "~/features/crm/sms/queries";
import type { CrmFetch } from "../lib/crm-fetch";
import type { BadgeCounts } from "./nav-links";

/**
 * THE BADGE PROVIDERS (brief §3.5 "badge providers keyed by screen id").
 * `core/nav.ts` names the badge each item carries (`overdue`, `unassigned`,
 * `pendingApproval`, `unread`, `missedCalls`); this table says where each count
 * comes from. A PR fills exactly ITS line: B3 → `/leads/badges` for `overdue`
 * and `unassigned`; C3 → `/calls/badges` for `missedCalls`; B5 adds
 * `pendingApproval`; C1 adds `unread`. A `null` line renders no badge.
 *
 * The hook below polls EVERY distinct path in the table, so filling a line is
 * the whole change — no second `useQuery` to add, and no conflict between two
 * PRs doing it at once.
 */
export const BADGE_SOURCES: Record<
  BadgeKey,
  { path: string; field: string; soft?: boolean } | null
> = {
  overdue: { path: "/leads/badges", field: "overdue" },
  unassigned: { path: "/leads/badges", field: "unassigned" },
  pendingApproval: null,
  /** C1: the rep's own unread texts. `soft` — a message waiting is not an SLA breach. */
  unread: { path: "/sms/unread", field: "n", soft: true },
  /** C3: calls that rang and nobody answered. `soft` for the same reason. */
  missedCalls: { path: "/calls/badges", field: "missedCalls", soft: true },
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

/**
 * Polls every path `BADGE_SOURCES` names while the tab is visible and folds the
 * answers into the shell's counts.
 *
 * One query PER PATH (not per badge), so two badges fed by `/leads/badges`
 * cost one request; a PR that adds a badge on a new endpoint adds a query by
 * filling its line in the table above and nothing else.
 *
 * `useQueries` rather than a fixed list of `useQuery` calls, so the hook count
 * is stable (`BADGE_PATHS` is a module constant, R12 "hooks above every early
 * return") and a PR that fills a table line needs no change here. A path that
 * errors simply contributes nothing — a sidebar badge is never worth an error
 * state.
 */
export function useBadgeCounts(crmFetch: CrmFetch, role: CrmRole): BadgeCounts {
  const results = useQueries({
    queries: BADGE_PATHS.map((path) => ({
      queryKey: badgeKeyFor(path),
      queryFn: () => crmFetch<Record<string, unknown>>(path),
      refetchInterval: BADGES_POLL_MS,
      refetchIntervalInBackground: false,
      staleTime: 15_000,
      retry: 1,
    })),
  });
  const payloads: Record<string, Record<string, unknown> | undefined> = {};
  BADGE_PATHS.forEach((path, i) => {
    payloads[path] = results[i]?.data as Record<string, unknown> | undefined;
  });
  return badgeCountsFrom(payloads, role);
}

/**
 * The query key for a badge endpoint — the OWNING SUB'S key wherever there is
 * one, so that sub's own `invalidateQueries` reaches the badge.
 *
 *   `/leads/badges` → `leadsKeys.badges()`, under `["crm","leads"]`, so a lead
 *                     mutation refreshes it.
 *   `/sms/unread`   → `smsKeys.unread()`, under `["crm","sms"]`, so reading a
 *                     conversation (which invalidates `smsKeys.all`) clears the
 *                     Messages badge immediately instead of leaving a stale
 *                     count up for the rest of the 60 s poll.
 *
 * Anything else gets a stable key of its own.
 */
export function badgeKeyFor(path: string): readonly unknown[] {
  if (path === "/leads/badges") return leadsKeys.badges();
  if (path === "/sms/unread") return smsKeys.unread();
  return ["crm", "badges", path] as const;
}
