/**
 * MSW for the CRM's transport tests (brief §3.10) — the ONE transport-mock
 * idiom. Node-only (`msw/node`); vitest runs in the node environment.
 *
 * NO GLOBAL `setupFiles`: each test file installs its own server so
 * `vitest.config.ts` stays untouched and a suite that never talks HTTP pays
 * nothing. Two ways to do it:
 *
 *   const server = setupServer(...handlers);
 *   beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
 *   afterEach(() => server.resetHandlers());
 *   afterAll(() => server.close());
 *
 * or the same four lines as one call: `const server = installMsw(...handlers);`
 *
 * `onUnhandledRequest: "error"` is deliberate and non-negotiable: a test that
 * reaches a real Office / Pandora / Vox host is a test that can write to
 * production, and it must fail loudly instead.
 *
 * FIXTURES FOR OFFICE / PANDORA ARE RAW JSON TEXT, never `HttpResponse.json({
 * id: 63000000009561437 })` — a numeric literal is already rounded when the JS
 * object is evaluated and `parseWithRawIds` is never exercised. Use
 * `rawJson(text)` below and keep the text in `fixtures/*.json.txt`. The smoke
 * test in this folder carries the negative control that proves why.
 */

import { afterAll, afterEach, beforeAll } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer, type SetupServer } from "msw/node";
import type { RequestHandler } from "msw";

export { http, HttpResponse, setupServer };
export type { RequestHandler, SetupServer };

/** Start a server for this test file with the lifecycle wired to vitest. */
export function installMsw(...handlers: RequestHandler[]): SetupServer {
  const server = setupServer(...handlers);
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return server;
}

/**
 * A JSON response from RAW TEXT — the only correct way to serve a payload that
 * carries a 17-digit id. `status` defaults to 200.
 */
export function rawJson(text: string, init: { status?: number; headers?: HeadersInit } = {}) {
  return new HttpResponse(text, {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}
