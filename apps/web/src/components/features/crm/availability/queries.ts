import type { AvailabilityResponse, HeatsResponse } from "~/features/crm/availability/contracts";
import type { CrmFetch } from "../lib/crm-fetch";

/**
 * Fetchers for the availability screen. Keys live in
 * `~/features/crm/availability/queries`; both reads are GETs, so every
 * parameter rides the query string — the same string the URL carries, which is
 * what makes a pasted link reproduce the exact grid the planner was looking at.
 */

export interface AvailabilityParams {
  centre?: string;
  date?: string;
  start?: number;
  dur?: number;
  guests?: number;
  lead?: string;
  refresh?: boolean;
}

function search(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    p.set(k, typeof v === "boolean" ? "1" : String(v));
  }
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

export const fetchAvailability = (f: CrmFetch, params: AvailabilityParams) =>
  f<AvailabilityResponse>(`/availability${search({ ...params })}`);

export interface HeatsParams {
  centre?: string;
  date?: string;
  guests?: number;
  resourceId?: string;
  lead?: string;
  refresh?: boolean;
}

export const fetchHeats = (f: CrmFetch, params: HeatsParams) =>
  f<HeatsResponse>(`/heats${search({ ...params })}`);
