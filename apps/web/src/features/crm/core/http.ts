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
 *                   Failure → 404 `text/plain` "Not found", matching the gate.
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

/** The gate's opaque answer, byte for byte: text, not JSON. */
export function notFoundText(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE },
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
    if (!authed) return notFoundText();

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
      return apiError(500, err instanceof Error ? err.message : "unexpected");
    }
  };
}
