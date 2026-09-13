import type {
  ColdCommitResponse,
  ColdConvertResponse,
  ColdCreateResponse,
  ColdDispositionResponse,
  ColdListResponse,
  ColdListsResponse,
  ColdMapResponse,
  ColdRowsAppendResponse,
} from "~/features/crm/cold/contracts";
import type {
  ColdCreateBody,
  ColdListActionBody,
  ColdRowActionBody,
  ColdRowsAppendBody,
} from "~/features/crm/cold/schemas";
import type { CrmFetch } from "../lib/crm-fetch";

/**
 * Fetchers for the cold routes (keys live in `~/features/crm/cold/queries`).
 * Mutations invalidate `coldKeys.all`; the convert one also invalidates
 * `leadsKeys.all`, because it creates a lead.
 *
 * `postColdRows` is the staging call — one chunk of the uploaded file. The
 * browser sends them in order and stops at the first failure, so a half-sent
 * file leaves a STAGED list the operator can see and delete rather than a
 * silent partial import.
 */

export const fetchColdLists = (f: CrmFetch, params: Record<string, string> = {}) => {
  const qs = new URLSearchParams(params).toString();
  return f<ColdListsResponse>(`/cold${qs ? `?${qs}` : ""}`);
};

export const fetchColdList = (f: CrmFetch, id: string, params: Record<string, string> = {}) => {
  const qs = new URLSearchParams(params).toString();
  return f<ColdListResponse>(`/cold/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`);
};

export const postColdList = (f: CrmFetch, body: ColdCreateBody) =>
  f<ColdCreateResponse>("/cold", { body: { ...body } });

export const postColdRows = (f: CrmFetch, id: string, body: ColdRowsAppendBody) =>
  f<ColdRowsAppendResponse>(`/cold/${encodeURIComponent(id)}/rows`, { body: { ...body } });

export const postColdListAction = (f: CrmFetch, id: string, body: ColdListActionBody) =>
  f<ColdMapResponse & ColdCommitResponse>(`/cold/${encodeURIComponent(id)}`, {
    body: { ...body },
  });

export const postColdRowAction = (
  f: CrmFetch,
  listId: string,
  rowId: string,
  body: ColdRowActionBody,
) =>
  f<ColdDispositionResponse & ColdConvertResponse>(
    `/cold/${encodeURIComponent(listId)}/rows/${encodeURIComponent(rowId)}`,
    { body: { ...body } },
  );
