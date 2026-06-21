import { NextResponse } from "next/server";

/**
 * Typed error services throw; route handlers map it to a JSON response via
 * `toErrorResponse`. `extra` carries safe, non-PII fields (e.g. retryAfterSec).
 */
export class AccountHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "AccountHttpError";
  }
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof AccountHttpError) {
    return NextResponse.json(
      { error: err.message, code: err.code, ...(err.extra ?? {}) },
      { status: err.status, headers: { ...NO_STORE } },
    );
  }
  console.error("[account] unhandled error:", err);
  return NextResponse.json(
    { error: "Something went wrong", code: "INTERNAL" },
    { status: 500, headers: { ...NO_STORE } },
  );
}

export function jsonOk(data: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { ...NO_STORE } });
}
