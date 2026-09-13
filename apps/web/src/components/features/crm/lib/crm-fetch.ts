/**
 * `crmFetch` — the ONE way the CRM's client talks to `/api/admin/crm/**`
 * (brief §3.4).
 *
 * The token is the signed 8-hour credential the page minted and handed to
 * `CrmApp` as a prop; it reaches this module through React context
 * (`lib/use-crm-user.ts`), NEVER from an env var — this file sits under
 * `src/components/**`, which `scripts/check-admin-token-leak.mjs` scans.
 *
 * What every call does:
 *   - `x-admin-token` header (the middleware accepts it on `/api/admin/*`),
 *     `cache: "no-store"`, same-origin credentials so the SSO cookie rides along
 *     (that cookie is how a route handler learns WHO acted);
 *   - JSON bodies also carry `token` (a route may read it from the body when a
 *     header cannot be set);
 *   - 401 → the session is gone: reload the page, which the edge gate turns into
 *     `/sso/signin`. A 404 on a KNOWN route whose body is NOT our `{ok:false}`
 *     envelope is a gate refusing the credential (an expired token) → same
 *     reload. Two gates can answer, and their bodies differ: the middleware's
 *     `/api/admin/*` branch says `{"error":"Not found"}` (application/json,
 *     `middleware.ts` ~:498) and `withCrmRoute` mirrors that byte for byte; a
 *     `text/plain` "Not found" (the page gate's shape) is treated the same way;
 *   - any `{ ok: false }` envelope → a thrown `CrmApiError` carrying the HTTP
 *     status, the server's `error`, and Office's 403 prompt when present. A
 *     JSON 404 envelope is therefore a REAL not-found (a missing status id),
 *     never a reload.
 *
 * Accepted loss (brief §3.4): a mutation in flight when the 8 h session expires
 * is dropped by that reload; the toast copy for it is `SIGNED_OUT_MESSAGE`.
 *
 * Parsing: CRM responses carry every BMI id as a STRING by contract
 * (`core/contracts.ts`), so `JSON.parse` on them is safe. This client never
 * touches a raw Office or Pandora payload — those are parsed server-side with
 * `parseWithRawIds`.
 */

import { CRM_API, type ApiErr, type OfficePrompt } from "~/features/crm/core/contracts";

export class CrmApiError extends Error {
  readonly status: number;
  readonly officePrompt: OfficePrompt | undefined;

  constructor(status: number, message: string, officePrompt?: OfficePrompt) {
    super(message);
    this.name = "CrmApiError";
    this.status = status;
    this.officePrompt = officePrompt;
  }
}

export type CrmFetchMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CrmFetchInit {
  /** Defaults to POST when a body is given, GET otherwise. */
  method?: CrmFetchMethod;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
}

export type CrmFetch = <T>(path: string, init?: CrmFetchInit) => Promise<T>;

export interface CrmFetchDeps {
  fetchImpl: typeof fetch;
  /** What to do when the session is gone. Production: reload the page. */
  reload: () => void;
}

/** What the toast says when a reload is about to drop an in-flight change. */
export const SIGNED_OUT_MESSAGE = "Signed out — your last change was not saved";

/**
 * Route families that exist in PR1. A 404 on one of these that is not our own
 * `{ ok: false, error }` envelope cannot be "no such resource" — it is the
 * middleware or `isAdminApiRequest` refusing the credential the same opaque way
 * the page gate does — so the client treats it like a 401. A JSON 404 envelope
 * on any path is a real not-found.
 */
export const KNOWN_ROUTES = [
  "/me",
  "/settings",
  "/statuses",
  "/jobs",
  "/rules",
  "/roster",
  "/history",
  "/accounts",
  "/last-year",
  "/leads",
  "/sms",
  "/templates",
  "/email",
] as const;

export function isKnownRoute(path: string): boolean {
  const bare = path.split("?")[0] ?? "";
  return KNOWN_ROUTES.some((root) => bare === root || bare.startsWith(root + "/"));
}

function defaultReload(): void {
  if (typeof window !== "undefined") window.location.assign(window.location.href);
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

function looksLikeEnvelope(value: unknown): value is ApiErr {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

export function createCrmFetch(token: string, deps: Partial<CrmFetchDeps> = {}): CrmFetch {
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const reload = deps.reload ?? defaultReload;

  return async function crmFetch<T>(path: string, init: CrmFetchInit = {}): Promise<T> {
    const method: CrmFetchMethod = init.method ?? (init.body ? "POST" : "GET");
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-admin-token": token,
    };
    let body: string | undefined;
    if (method !== "GET" && init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify({ ...init.body, token });
    }

    const res = await fetchImpl(CRM_API + path, {
      method,
      headers,
      body,
      cache: "no-store",
      credentials: "same-origin",
      signal: init.signal,
    });

    if (res.status === 401) {
      reload();
      throw new CrmApiError(401, SIGNED_OUT_MESSAGE);
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
    }

    // A gate's refusal (middleware `{"error":"Not found"}`, a route's mirror of
    // it, or the page gate's plain text) on a route we KNOW exists → the
    // credential expired: reload. Our own `{ok:false}` 404 is a real not-found.
    if (res.status === 404 && isKnownRoute(path) && !looksLikeEnvelope(parsed)) {
      reload();
      throw new CrmApiError(404, SIGNED_OUT_MESSAGE);
    }

    if (looksLikeEnvelope(parsed)) {
      throw new CrmApiError(res.status, parsed.error, parsed.officePrompt);
    }
    if (!res.ok) {
      const snippet = text.trim().slice(0, 200);
      throw new CrmApiError(res.status, snippet || `HTTP ${res.status}`);
    }
    return parsed as T;
  };
}

/** Narrow an unknown thrown value to a message the UI can show. */
export function errorMessage(err: unknown): string {
  if (err instanceof CrmApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
