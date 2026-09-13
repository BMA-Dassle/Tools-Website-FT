import type {
  CollateralCreateBody,
  CollateralCreateResponse,
  CollateralItemPostBody,
  CollateralItemResponse,
  CollateralListResponse,
  CollateralUploadResponse,
  ShareCreateResponse,
  ShareListResponse,
  TemplatesListResponse,
  TemplatesPostBody,
  TemplatesPostResponse,
} from "~/features/crm/collateral/contracts";
import { CRM_API } from "~/features/crm/core/contracts";
import { CrmApiError, type CrmFetch } from "../lib/crm-fetch";

/**
 * Fetchers for the Collateral screen. Keys live in
 * `~/features/crm/collateral/queries` (client-safe, no imports) so a key can
 * be invalidated from anywhere without importing this module's types.
 */

export interface CollateralListParams {
  centre?: string | null;
  tag?: string | null;
  q?: string | null;
  archived?: boolean;
  cursor?: string | null;
}

function qs(params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) search.set(k, v);
  const out = search.toString();
  return out ? `?${out}` : "";
}

export const fetchCollateral = (f: CrmFetch, params: CollateralListParams = {}) =>
  f<CollateralListResponse>(
    "/collateral" +
      qs({
        centre: params.centre,
        tag: params.tag,
        q: params.q,
        archived: params.archived ? "1" : null,
        cursor: params.cursor,
      }),
  );

export const postCollateral = (f: CrmFetch, body: CollateralCreateBody) =>
  f<CollateralCreateResponse>("/collateral", { body: { ...body } });

export const postCollateralItem = (f: CrmFetch, id: string, body: CollateralItemPostBody) =>
  f<CollateralItemResponse>(`/collateral/${encodeURIComponent(id)}`, { body: { ...body } });

export const fetchTemplates = (f: CrmFetch, kind?: "sms" | "email" | null) =>
  f<TemplatesListResponse>("/collateral/templates" + qs({ kind }));

export const postTemplates = (f: CrmFetch, body: TemplatesPostBody) =>
  f<TemplatesPostResponse>("/collateral/templates", { body: { ...body } });

export const fetchShares = (f: CrmFetch, scope: { collateralId?: string; lead?: string }) =>
  f<ShareListResponse>("/share" + qs({ collateralId: scope.collateralId, lead: scope.lead }));

export const createShareLink = (
  f: CrmFetch,
  body: { collateralId: string; lead?: string | null; expiresInDays?: number },
) => f<ShareCreateResponse>("/share", { body: { action: "create", ...body } });

export const revokeShareLink = (f: CrmFetch, shareToken: string) =>
  f<ShareListResponse>("/share", { body: { action: "revoke", shareToken } });

/**
 * The ONE call that does not go through `crmFetch`: a multipart body cannot
 * carry the JSON `token` field, so the credential travels in the header alone
 * and the request is built here. Everything else about it matches — same
 * origin, `no-store`, same-origin credentials so the SSO cookie rides along,
 * and the same `{ok:false, error}` envelope turned into a `CrmApiError` so the
 * screen handles `blob_not_configured` exactly like any other refusal.
 */
export async function uploadCollateralFile(
  token: string,
  form: FormData,
  signal?: AbortSignal,
): Promise<CollateralUploadResponse> {
  const res = await fetch(CRM_API + "/collateral/upload", {
    method: "POST",
    headers: { accept: "application/json", "x-admin-token": token },
    body: form,
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    parsed = null;
  }
  const envelope = parsed as { ok?: boolean; error?: string } | null;
  if (envelope && envelope.ok === false && typeof envelope.error === "string") {
    throw new CrmApiError(res.status, envelope.error);
  }
  if (!res.ok) throw new CrmApiError(res.status, text.trim().slice(0, 200) || `HTTP ${res.status}`);
  return parsed as CollateralUploadResponse;
}
