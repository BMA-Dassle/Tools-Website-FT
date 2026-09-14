/**
 * Fetchers for the three measure screens. The KEYS live in
 * `~/features/crm/kpi/queries` (client-safe, no imports); these bind them to
 * `crmFetch`. Mutations invalidate `measureKeys.all`, which re-runs the KPI
 * read too — a saved goal changes the pacing line's goal rule.
 */

import type {
  AccountabilityResponse,
  GoalsPostBody,
  GoalsPostResponse,
  GoalsResponse,
  KpiResponse,
  MyWeekResponse,
  TargetsPostBody,
  TargetsResponse,
} from "~/features/crm/kpi/contracts";
import type { CrmFetch } from "../lib/crm-fetch";

export interface KpiParams {
  month?: string | null;
  quarter?: string | null;
  rep?: string | null;
  centre?: string | null;
}

function qs(params: Record<string, string | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const fetchKpi = (f: CrmFetch, params: KpiParams) =>
  f<KpiResponse>(`/kpi${qs({ ...params })}`);

export const fetchAccountability = (f: CrmFetch, params: { range?: string; rep?: string | null }) =>
  f<AccountabilityResponse>(`/accountability${qs({ ...params })}`);

export const fetchMyWeek = (f: CrmFetch) => f<MyWeekResponse>("/accountability?mine=1");

export const fetchGoals = (f: CrmFetch, year: number) =>
  f<GoalsResponse>(`/goals?year=${encodeURIComponent(String(year))}`);

export const postGoals = (f: CrmFetch, body: GoalsPostBody) =>
  f<GoalsPostResponse>("/goals", { body: { goals: body.goals } });

export const fetchTargets = (f: CrmFetch) => f<TargetsResponse>("/targets");

export const postTargets = (f: CrmFetch, body: TargetsPostBody) =>
  f<TargetsResponse>("/targets", { body: { ...body } });
