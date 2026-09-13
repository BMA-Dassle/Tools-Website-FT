import type {
  CallBadgesResponse,
  CallDialResponse,
  CallDispositionResponse,
  CallLinkResponse,
  CallsListResponse,
} from "~/features/crm/calls/contracts";
import type { CallDialBody, CallDispositionBody, CallLinkBody } from "~/features/crm/calls/schemas";
import type { CrmFetch } from "../lib/crm-fetch";

/**
 * Fetchers for the calls routes (keys live in `~/features/crm/calls/queries`).
 * Mutations invalidate `callsKeys.all`, and the dial / disposition ones also
 * invalidate `leadsKeys.all` because both can move a lead (first touch, and
 * `assigned → contacted`).
 */

export const fetchCalls = (f: CrmFetch, params: Record<string, string> = {}) => {
  const qs = new URLSearchParams(params).toString();
  return f<CallsListResponse>(`/calls${qs ? `?${qs}` : ""}`);
};

export const fetchCallBadges = (f: CrmFetch) => f<CallBadgesResponse>("/calls/badges");

export const postDial = (f: CrmFetch, body: CallDialBody) =>
  f<CallDialResponse>("/calls/dial", { body: { ...body } });

export const postDisposition = (f: CrmFetch, id: string, body: CallDispositionBody) =>
  f<CallDispositionResponse>(`/calls/${encodeURIComponent(id)}/disposition`, {
    body: { ...body },
  });

export const postLinkCall = (f: CrmFetch, id: string, body: CallLinkBody) =>
  f<CallLinkResponse>(`/calls/${encodeURIComponent(id)}/link`, { body: { ...body } });
