/**
 * Typed error the services throw; routes map it to a JSON response via
 * `toErrorResponse`. Mirrors the account feature's error helper.
 */
import { NextResponse } from "next/server";

export class GameCardHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "GameCardHttpError";
  }
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Duck-types any HTTP-ish error carrying a numeric `status` + string `code`
 *  — covers GameCardHttpError AND the account feature's AccountHttpError that
 *  requireSession/requireCsrf throw (401/403), so those map correctly. */
function asHttpError(
  err: unknown,
): { status: number; code: string; message: string; extra?: Record<string, unknown> } | null {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.status === "number" && typeof e.code === "string") {
      return {
        status: e.status,
        code: e.code,
        message: typeof e.message === "string" ? e.message : e.code,
        extra: (e.extra as Record<string, unknown>) ?? undefined,
      };
    }
  }
  return null;
}

export function toErrorResponse(err: unknown): NextResponse {
  const http = asHttpError(err);
  if (http) {
    return NextResponse.json(
      { error: http.message, code: http.code, ...(http.extra ?? {}) },
      { status: http.status, headers: { ...NO_STORE } },
    );
  }
  console.error("[game-cards] unhandled error:", err);
  return NextResponse.json(
    { error: "Something went wrong", code: "INTERNAL" },
    { status: 500, headers: { ...NO_STORE } },
  );
}

export function jsonOk(data: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { ...NO_STORE } });
}
