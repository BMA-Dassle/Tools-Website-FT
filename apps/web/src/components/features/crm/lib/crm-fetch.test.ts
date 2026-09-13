import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CRM_API } from "~/features/crm/core/contracts";
import {
  CrmApiError,
  SIGNED_OUT_MESSAGE,
  createCrmFetch,
  errorMessage,
  isKnownRoute,
} from "./crm-fetch";

/**
 * Pure tests of the client transport (brief §3.4 "crm-fetch.test.ts"): the
 * credential rides as a header and inside JSON bodies, a lost session reloads
 * the page, a gate's opaque 404 on a known route (text, or the middleware's
 * `{"error":"Not found"}`) reloads too, and an `{ok:false}` error envelope
 * becomes a `CrmApiError` that keeps the status and Office's prompt. No
 * network: `fetchImpl` and `reload` are injected.
 */

const TOKEN = "1700000000000.deadbeef";

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function textResponse(status: number, body: string) {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function rig(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return responder(url, init ?? {});
  });
  const reload = vi.fn();
  const crmFetch = createCrmFetch(TOKEN, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    reload,
  });
  return { crmFetch, calls, reload };
}

describe("createCrmFetch — the request", () => {
  it("prefixes CRM_API, sends x-admin-token, no-store and same-origin credentials on a GET", async () => {
    const { crmFetch, calls } = rig(() => jsonResponse(200, { ok: true, user: { email: "e" } }));
    const out = await crmFetch<{ ok: true; user: { email: string } }>("/me");
    expect(out.user.email).toBe("e");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${CRM_API}/me`);
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.cache).toBe("no-store");
    expect(calls[0].init.credentials).toBe("same-origin");
    expect((calls[0].init.headers as Record<string, string>)["x-admin-token"]).toBe(TOKEN);
    expect(calls[0].init.body).toBeUndefined();
  });

  it("a body implies POST, is JSON, and carries the token alongside the caller's fields", async () => {
    const { crmFetch, calls } = rig(() => jsonResponse(200, { ok: true, settings: {} }));
    await crmFetch("/settings", { body: { key: "bmi_writes", value: { enabled: false } } });
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      key: "bmi_writes",
      value: { enabled: false },
      token: TOKEN,
    });
  });

  it("an explicit method is honoured", async () => {
    const { crmFetch, calls } = rig(() => jsonResponse(200, { ok: true }));
    await crmFetch("/statuses", { method: "PUT", body: { id: "x" } });
    expect(calls[0].init.method).toBe("PUT");
  });
});

describe("createCrmFetch — the session is gone", () => {
  it("401 → reload once and reject with a 401 CrmApiError carrying the signed-out copy", async () => {
    const { crmFetch, reload } = rig(() => jsonResponse(401, { ok: false, error: "session" }));
    const err = await crmFetch("/me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrmApiError);
    expect((err as CrmApiError).status).toBe(401);
    expect((err as CrmApiError).message).toBe(SIGNED_OUT_MESSAGE);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a text 'Not found' 404 on a KNOWN route is the gate refusing the credential → reload", async () => {
    const { crmFetch, reload } = rig(() => textResponse(404, "Not found"));
    const err = await crmFetch("/statuses/office-states?centre=HPFM").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrmApiError);
    expect((err as CrmApiError).status).toBe(404);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the middleware\'s JSON {"error":"Not found"} 404 on a KNOWN route is the same refusal → reload', async () => {
    // middleware.ts's /api/admin/* branch answers an expired x-admin-token with
    // this exact body (application/json); withCrmRoute mirrors it. Neither is
    // our {ok:false} envelope, so both mean "sign in again", not "no such row".
    const { crmFetch, reload } = rig(() => jsonResponse(404, { error: "Not found" }));
    const err = await crmFetch("/me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrmApiError);
    expect((err as CrmApiError).status).toBe(404);
    expect((err as CrmApiError).message).toBe(SIGNED_OUT_MESSAGE);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a JSON 404 on a known route is a real not-found: no reload, the server's error surfaces", async () => {
    const { crmFetch, reload } = rig(() =>
      jsonResponse(404, { ok: false, error: "no such status: zzz" }),
    );
    const err = await crmFetch("/statuses/zzz").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrmApiError);
    expect((err as CrmApiError).status).toBe(404);
    expect((err as CrmApiError).message).toBe("no such status: zzz");
    expect(reload).not.toHaveBeenCalled();
  });

  it("a text 404 on an UNKNOWN route does not reload", async () => {
    const { crmFetch, reload } = rig(() => textResponse(404, "Not found"));
    const err = await crmFetch("/nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrmApiError);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("createCrmFetch — error envelopes", () => {
  it("{ ok: false } → CrmApiError with the HTTP status, the error, and Office's prompt", async () => {
    const { crmFetch, reload } = rig(() =>
      jsonResponse(409, {
        ok: false,
        error: "Office asked to confirm",
        officePrompt: { message: "Overbooking?", operationId: "op-1" },
      }),
    );
    const err = await crmFetch("/statuses/map", { body: { statusId: "quote" } }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CrmApiError);
    const e = err as CrmApiError;
    expect(e.status).toBe(409);
    expect(e.message).toBe("Office asked to confirm");
    expect(e.officePrompt).toEqual({ message: "Overbooking?", operationId: "op-1" });
    expect(reload).not.toHaveBeenCalled();
  });

  it("403 JSON (a rep on a director route) is an error, not a reload", async () => {
    const { crmFetch, reload } = rig(() => jsonResponse(403, { ok: false, error: "director" }));
    const err = await crmFetch("/jobs/run", { body: { kind: "noop" } }).catch((e: unknown) => e);
    expect((err as CrmApiError).status).toBe(403);
    expect(reload).not.toHaveBeenCalled();
  });

  it("a non-JSON 500 becomes a CrmApiError with the body snippet", async () => {
    const { crmFetch } = rig(() => textResponse(500, "Internal Server Error"));
    const err = await crmFetch("/me").catch((e: unknown) => e);
    expect((err as CrmApiError).status).toBe(500);
    expect((err as CrmApiError).message).toBe("Internal Server Error");
  });

  it("errorMessage() reads any thrown value", () => {
    expect(errorMessage(new CrmApiError(400, "bad"))).toBe("bad");
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
  });
});

describe("isKnownRoute", () => {
  it("matches the PR1 route families and their sub-paths, with or without a query string", () => {
    expect(isKnownRoute("/me")).toBe(true);
    expect(isKnownRoute("/statuses/office-states?centre=HPN")).toBe(true);
    expect(isKnownRoute("/jobs/run")).toBe(true);
    expect(isKnownRoute("/settings")).toBe(true);
    expect(isKnownRoute("/rules/try?guests=42")).toBe(true);
    expect(isKnownRoute("/roster")).toBe(true);
    expect(isKnownRoute("/leads")).toBe(true);
    expect(isKnownRoute("/leads/queue")).toBe(true);
    expect(isKnownRoute("/contracts")).toBe(true);
    expect(isKnownRoute("/contracts/7Hx2Qk/approve")).toBe(true);
    expect(isKnownRoute("/leadsmith")).toBe(false);
    expect(isKnownRoute("/measurements")).toBe(false);
  });
});

describe("the module never names the static admin secret", () => {
  it("has no ADMIN_CAMERA_TOKEN / ADMIN_ETICKETS_TOKEN reference (check-admin-token-leak scans src/components/**)", () => {
    const src = readFileSync(path.join(__dirname, "crm-fetch.ts"), "utf8");
    expect(src).not.toMatch(/ADMIN_CAMERA_TOKEN|ADMIN_ETICKETS_TOKEN|process\.env/);
  });
});
