import type { ActivityPostResponse, TimelineResponse } from "~/features/crm/activities/contracts";
import type { ActivityPostBody } from "~/features/crm/activities/schemas";
import type { LeadStatusResponse } from "~/features/crm/statuses/contracts";
import type { LeadStatusBody } from "~/features/crm/statuses/schemas";
import type { CrmFetch } from "../lib/crm-fetch";

/**
 * Lead-scoped fetchers the deal and the board share: the status writer and the
 * three hand-logged activities. Keys live in `~/features/crm/activities/queries`
 * and `~/features/crm/leads/queries`; every mutation here invalidates
 * `leadsKeys.all` at the call site, because the lead row itself moves.
 *
 * Type-only imports from the two subs' `schemas.ts` are safe in a client
 * module: zod types erase, and nothing here imports a sub's `index.ts`.
 */

export const postLeadStatus = (f: CrmFetch, publicId: string, body: LeadStatusBody) =>
  f<LeadStatusResponse>(`/leads/${encodeURIComponent(publicId)}/status`, { body: { ...body } });

export const fetchTimeline = (f: CrmFetch, publicId: string, cursor?: string | null) => {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return f<TimelineResponse>(`/leads/${encodeURIComponent(publicId)}/activities${qs}`);
};

export const postActivity = (f: CrmFetch, publicId: string, body: ActivityPostBody) =>
  f<ActivityPostResponse>(`/leads/${encodeURIComponent(publicId)}/activities`, {
    body: { ...body },
  });
