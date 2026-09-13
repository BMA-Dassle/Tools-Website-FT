/**
 * `withCrmRoute` — the ONE auth chain every `/api/admin/crm/**` handler runs
 * (brief §3.4). No route re-implements it.
 *
 *   1. read input   GET/HEAD/DELETE → query string; otherwise the JSON body
 *   2. zod          `schema.safeParse(input)` → 400 `{ok:false, error}`
 *   3. credential   `isAdminApiRequest` — TWO-BRANCH, and the branch is
 *                   load-bearing: `isAdminApiRequest(req, {token})` returns
 *                   `isAdminCredential(opts.token)` whenever the `token` KEY
 *                   is present (`lib/admin-request-auth.ts:78`) and never falls
 *                   through to the `x-admin-token` header, so passing
 *                   `{token: undefined}` would 404 every GET. A body/query
 *                   `token` therefore BEATS the header; no token in the input
 *                   → the header / `?token=` / proxy-key path.
 *                   Failure → 404 `{"error":"Not found"}` (application/json),
 *                   BYTE-IDENTICAL to what the middleware's `/api/admin/*`
 *                   branch answers (`middleware.ts` ~:498) so a caller cannot
 *                   tell which layer refused; the page gate's `text/plain`
 *                   shape is for pages, not APIs.
 *   4. session      `crmUserFromRequest()` → 401 / 403 JSON `{ok:false,
 *                   error:"session"}`; `opts.director` → 403 `director_only`
 *   5. service      the handler; a plain object is wrapped as `{ok:true, …}`,
 *                   a `Response` is returned as-is, a thrown `CrmHttpError`
 *                   becomes its status, anything else 500 — logged with
 *                   `actor_email`, never with the body.
 *
 * Every route file still declares `export const runtime = "nodejs"; export
 * const dynamic = "force-dynamic";` itself (Next reads those statically).
 */

import { NextResponse, type NextRequest } from "next/server";
import type { ZodType, output as ZodOutput } from "zod";
import { isAdminApiRequest } from "@/lib/admin-request-auth";
import type { ApiErr, OfficePrompt } from "./contracts";
import { crmUserFromRequest, isDirector } from "./identity";
import type { CrmUser } from "./types";

/** Throw from a handler to answer with a specific status and error code. */
export class CrmHttpError extends Error {
  readonly status: number;
  readonly officePrompt?: OfficePrompt;
  constructor(status: number, error: string, officePrompt?: OfficePrompt) {
    super(error);
    this.name = "CrmHttpError";
    this.status = status;
    this.officePrompt = officePrompt;
  }
}

const NO_STORE = { "cache-control": "no-store" } as const;

export function json<T>(body: T, init?: ResponseInit): NextResponse<T> {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return NextResponse.json(body, { ...init, headers });
}

export function apiError(
  status: number,
  error: string,
  officePrompt?: OfficePrompt,
): NextResponse<ApiErr> {
  const body: ApiErr = officePrompt ? { ok: false, error, officePrompt } : { ok: false, error };
  return json(body, { status });
}

/**
 * The middleware's `/api/admin/*` refusal, byte for byte: `{"error":"Not found"}`
 * as application/json. NOT our `{ok:false}` envelope on purpose — `crmFetch`
 * reads "not an envelope" on a known route as "the credential expired, reload".
 */
export function gateNotFound(): Response {
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "content-type": "application/json", ...NO_STORE },
  });
}

export type RouteParams = Record<string, string | string[]>;

export interface CrmRouteContext<TInput> {
  req: NextRequest;
  input: TInput;
  user: CrmUser;
  params: RouteParams;
}

export type CrmRouteHandler<TInput, TOut extends Record<string, unknown>> = (
  ctx: CrmRouteContext<TInput>,
) => Promise<TOut | Response>;

export interface CrmRouteOptions {
  /** 403 `director_only` unless the session carries `sales-director`. */
  director?: boolean;
}

/** Next 15+/16 hands route handlers `{ params: Promise<…> }` as the second argument. */
export type RouteArgs = { params?: Promise<RouteParams> | RouteParams } | undefined;

const BODYLESS = new Set(["GET", "HEAD", "DELETE", "OPTIONS"]);

async function readInput(req: NextRequest): Promise<Record<string, unknown>> {
  if (BODYLESS.has(req.method)) {
    return Object.fromEntries(req.nextUrl.searchParams.entries());
  }
  try {
    const parsed: unknown = await req.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function zodSummary(err: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return err.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`)
    .join("; ");
}

export function withCrmRoute<TSchema extends ZodType, TOut extends Record<string, unknown>>(
  schema: TSchema,
  handler: CrmRouteHandler<ZodOutput<TSchema>, TOut>,
  opts: CrmRouteOptions = {},
): (req: NextRequest, args?: RouteArgs) => Promise<Response> {
  return async function crmRoute(req: NextRequest, args?: RouteArgs): Promise<Response> {
    const raw = await readInput(req);
    const bodyToken = typeof raw.token === "string" && raw.token ? raw.token : undefined;

    const parsed = schema.safeParse(raw);
    if (!parsed.success) return apiError(400, `invalid_request: ${zodSummary(parsed.error)}`);

    const authed = bodyToken
      ? await isAdminApiRequest(req, { token: bodyToken })
      : await isAdminApiRequest(req);
    if (!authed) return gateNotFound();

    const who = await crmUserFromRequest();
    if (!who.ok) return apiError(who.status, "session");
    if (opts.director && !isDirector(who.user)) return apiError(403, "director_only");

    const params = (await args?.params) ?? {};
    try {
      const out = await handler({
        req,
        input: parsed.data as ZodOutput<TSchema>,
        user: who.user,
        params,
      });
      if (out instanceof Response) return out;
      return json({ ok: true, ...out });
    } catch (err) {
      if (err instanceof CrmHttpError) return apiError(err.status, err.message, err.officePrompt);
      console.error("[crm] route failed", {
        path: req.nextUrl.pathname,
        method: req.method,
        actor_email: who.user.email,
        error: err instanceof Error ? err.message : String(err),
      });
      // A FIXED code, never `err.message`. Neon, Redis, Office and Pandora
      // errors carry hostnames, SQL fragments and upstream body snippets
      // (`putProjectFields` throws with 300 chars of Office's reply); a rep's
      // toast is the wrong place for any of it. The detail stays in the log
      // line above, which already names the actor and the route. Anything a
      // caller is MEANT to read comes back as a `CrmHttpError` with its own
      // code, handled one branch up.
      return apiError(500, "unexpected");
    }
  };
}
