import type {
  BuilderCatalogResponse,
  BuilderPostBody,
  BuilderStateResponse,
  BuilderTemplatesPostBody,
  BuilderTemplatesResponse,
} from "~/features/crm/bmi/contracts";
import type { CrmFetch } from "../lib/crm-fetch";

/**
 * Fetchers for the builder screen. Keys live in `~/features/crm/bmi/queries`.
 *
 * Every MUTATION answers with the whole builder state, re-read after the write,
 * so the caller sets one query's data rather than invalidating and refetching —
 * which is what keeps a new line and the total it moved on screen together.
 *
 * These modules import `~/features/crm/bmi/contracts` BY PATH, never the `bmi`
 * barrel: the barrel pulls in `@ft/db`, `ioredis` and `node:https`, none of
 * which may reach a browser bundle (§5.7b).
 */

function search(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    p.set(k, typeof v === "boolean" ? "1" : String(v));
  }
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

export const fetchBuilderState = (f: CrmFetch, lead: string) =>
  f<BuilderStateResponse>(`/builder${search({ lead })}`);

export const postBuilder = (f: CrmFetch, body: BuilderPostBody) =>
  f<BuilderStateResponse>("/builder", { method: "POST", body });

export interface CatalogParams {
  centre: string;
  date: string;
  q?: string;
  productId?: string;
  quantity?: number;
  lead?: string;
}

export const fetchCatalog = (f: CrmFetch, params: CatalogParams) =>
  f<BuilderCatalogResponse>(`/builder/catalog${search({ ...params })}`);

export const fetchTemplates = (f: CrmFetch, centre?: string) =>
  f<BuilderTemplatesResponse>(`/builder/templates${search({ centre })}`);

export const postTemplates = (f: CrmFetch, body: BuilderTemplatesPostBody) =>
  f<BuilderTemplatesResponse>("/builder/templates", { method: "POST", body });
