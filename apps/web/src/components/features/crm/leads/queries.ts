import type { CrmStatus } from "~/features/crm/core/types";
import type {
  LeadArchiveResponse,
  LeadAssignResponse,
  LeadCreateResponse,
  LeadDetailResponse,
  LeadMintResponse,
  LeadPatchResponse,
  LeadsListResponse,
  MyDayResponse,
  QueueResponse,
} from "~/features/crm/leads/contracts";
import type { LeadAssignBody, LeadCreateBody, LeadPatchBody } from "~/features/crm/leads/schemas";
import type { CrmFetch } from "../lib/crm-fetch";

/**
 * Fetchers for the leads routes (keys live in `~/features/crm/leads/queries`).
 * Mutations invalidate `leadsKeys.all`; the badges query shares that root, so
 * a hand-off refreshes the sidebar count too.
 */

export const fetchQueue = (f: CrmFetch) => f<QueueResponse>("/leads/queue");

export const fetchMyDay = (f: CrmFetch) => f<MyDayResponse>("/leads/my-day");

export const fetchLead = (f: CrmFetch, id: string) =>
  f<LeadDetailResponse>(`/leads/${encodeURIComponent(id)}`);

export const fetchLeads = (f: CrmFetch, params: Record<string, string>) => {
  const qs = new URLSearchParams(params).toString();
  return f<LeadsListResponse>(`/leads${qs ? `?${qs}` : ""}`);
};

export const postCreateLead = (f: CrmFetch, body: LeadCreateBody) =>
  f<LeadCreateResponse>("/leads", { body: { ...body } });

export const patchLead = (f: CrmFetch, id: string, body: LeadPatchBody) =>
  f<LeadPatchResponse>(`/leads/${encodeURIComponent(id)}`, { method: "PATCH", body: { ...body } });

export const postAssign = (f: CrmFetch, id: string, body: LeadAssignBody) =>
  f<LeadAssignResponse>(`/leads/${encodeURIComponent(id)}/assign`, { body: { ...body } });

export const postMint = (f: CrmFetch, id: string) =>
  f<LeadMintResponse>(`/leads/${encodeURIComponent(id)}/mint`, { body: {} });

export const postArchive = (f: CrmFetch, id: string) =>
  f<LeadArchiveResponse>(`/leads/${encodeURIComponent(id)}/archive`, { body: {} });

/** `statuses` → a lookup the cards use for chips and "is this open?". */
export function statusIndex(statuses: readonly CrmStatus[] | undefined): Map<string, CrmStatus> {
  return new Map((statuses ?? []).map((s) => [s.id, s]));
}
