import { describe, expect, it, vi } from "vitest";
import { parseWithRawIds } from "@ft/db";
import { HttpResponse, http, installMsw, rawJson } from "./server";

/**
 * Proves the idiom works under vitest's node environment before any transport
 * handler depends on it: interception of global `fetch`, the unhandled-request
 * error, and — the part that matters for BMI — that a raw-text body survives
 * the round trip so `parseWithRawIds` can do its job.
 */

const server = installMsw(
  http.get("https://example.invalid/ping", () => HttpResponse.json({ pong: true })),
  http.get("https://example.invalid/office/project", () =>
    rawJson('{"id":63000000009561437,"personId":63000000009561438,"name":"CRM TEST"}'),
  ),
);

describe("msw intercepts under vitest node", () => {
  it("answers a handled request without touching the network", async () => {
    const res = await fetch("https://example.invalid/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });

  it("refuses an unhandled request instead of letting it out (onUnhandledRequest: error)", async () => {
    // msw logs the refusal before throwing; keep the run's output clean.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(fetch("https://example.invalid/not-handled")).rejects.toThrow();
    } finally {
      error.mockRestore();
    }
  });

  it("a per-test override wins and resets afterwards", async () => {
    server.use(
      http.get("https://example.invalid/ping", () => HttpResponse.json({ pong: "override" })),
    );
    const res = await fetch("https://example.invalid/ping");
    expect(await res.json()).toEqual({ pong: "override" });
  });

  it("serves a raw-text Office fixture whose 17-digit ids survive parseWithRawIds — with the negative control", async () => {
    const res = await fetch("https://example.invalid/office/project");
    const text = await res.text();

    // NEGATIVE CONTROL: the ordinary parse ROUNDS the id, and this says so in
    // the one way that can fail — by naming the rounded value. (`not.toBe` of
    // the string form would pass against a Number no matter what, which is a
    // control that proves nothing.) The day the fixture stops being 17 digits,
    // this line goes red.
    expect(JSON.parse(text).id).toBe(63000000009561440);
    expect(String(JSON.parse(text).id)).not.toBe("63000000009561437");

    const parsed = parseWithRawIds<{ id: string; personId: string; name: string }>(text);
    expect(parsed.id).toBe("63000000009561437");
    expect(parsed.personId).toBe("63000000009561438");
    expect(parsed.name).toBe("CRM TEST");
  });
});
