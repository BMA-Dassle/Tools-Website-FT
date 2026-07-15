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

export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof GameCardHttpError) {
    return NextResponse.json(
      { error: err.message, code: err.code, ...(err.extra ?? {}) },
      { status: err.status, headers: { ...NO_STORE } },
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
