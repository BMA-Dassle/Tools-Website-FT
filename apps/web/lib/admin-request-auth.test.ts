import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { mintAdminApiToken } from "./admin-api-token";
import {
  hasAdminProxyKey,
  isAdminApiRequest,
  isAdminCredential,
  isStaticAdminToken,
} from "./admin-request-auth";

const STATIC = "c".repeat(32);
const PROXY_KEY = "p".repeat(40);

beforeEach(() => {
  process.env.ADMIN_CAMERA_TOKEN = STATIC;
  process.env.ADMIN_PROXY_KEY = PROXY_KEY;
  delete process.env.ADMIN_API_SIGNING_SECRET;
});

afterEach(() => {
  delete process.env.ADMIN_CAMERA_TOKEN;
  delete process.env.ADMIN_PROXY_KEY;
  delete process.env.ADMIN_API_SIGNING_SECRET;
});

const req = (url: string, headers: Record<string, string> = {}) =>
  new NextRequest(new URL(url, "https://fasttraxent.com"), { headers });

describe("isStaticAdminToken", () => {
  it("accepts the configured token and nothing else", () => {
    expect(isStaticAdminToken(STATIC)).toBe(true);
    expect(isStaticAdminToken("x".repeat(32))).toBe(false);
    expect(isStaticAdminToken("")).toBe(false);
    expect(isStaticAdminToken(null)).toBe(false);
  });

  it("fails closed with no env", () => {
    delete process.env.ADMIN_CAMERA_TOKEN;
    expect(isStaticAdminToken(STATIC)).toBe(false);
    expect(isStaticAdminToken("")).toBe(false);
  });
});

describe("isAdminCredential — both token kinds, one answer", () => {
  it("keeps accepting the static token (crons, .bat scripts, old bookmarks)", async () => {
    await expect(isAdminCredential(STATIC)).resolves.toBe(true);
  });

  it("accepts a signed short-lived token (what a staff browser now holds)", async () => {
    await expect(isAdminCredential(await mintAdminApiToken())).resolves.toBe(true);
  });

  it("rejects an expired signed token, a forgery, and junk", async () => {
    await expect(isAdminCredential(await mintAdminApiToken(-1000))).resolves.toBe(false);
    await expect(isAdminCredential(`${Date.now() + 60_000}.${"a".repeat(64)}`)).resolves.toBe(
      false,
    );
    for (const bad of ["", null, undefined, "wrong", STATIC.slice(0, 31)]) {
      await expect(isAdminCredential(bad), String(bad)).resolves.toBe(false);
    }
  });
});

describe("hasAdminProxyKey", () => {
  it("accepts the shell's header and is inert without the env", () => {
    expect(hasAdminProxyKey(req("/x", { "x-admin-proxy-key": PROXY_KEY }))).toBe(true);
    expect(hasAdminProxyKey(req("/x", { "x-admin-proxy-key": "nope" }))).toBe(false);
    expect(hasAdminProxyKey(req("/x"))).toBe(false);
    delete process.env.ADMIN_PROXY_KEY;
    expect(hasAdminProxyKey(req("/x", { "x-admin-proxy-key": PROXY_KEY }))).toBe(false);
  });
});

describe("isAdminApiRequest — the shape a route handler calls", () => {
  it("reads the header, then the query", async () => {
    await expect(
      isAdminApiRequest(req("/api/admin/pit", { "x-admin-token": STATIC })),
    ).resolves.toBe(true);
    await expect(isAdminApiRequest(req(`/api/admin/pit?token=${STATIC}`))).resolves.toBe(true);
    const signed = await mintAdminApiToken();
    await expect(
      isAdminApiRequest(req("/api/admin/pit", { "x-admin-token": signed })),
    ).resolves.toBe(true);
    await expect(
      isAdminApiRequest(req(`/api/admin/pit?token=${encodeURIComponent(signed)}`)),
    ).resolves.toBe(true);
  });

  it("accepts the shell's proxy key with no token at all", async () => {
    await expect(
      isAdminApiRequest(req("/api/admin/pit", { "x-admin-proxy-key": PROXY_KEY })),
    ).resolves.toBe(true);
  });

  it("takes an explicit token for the body-carrying routes — and ONLY that one", async () => {
    await expect(isAdminApiRequest(req("/api/admin/deals"), { token: STATIC })).resolves.toBe(true);
    await expect(
      isAdminApiRequest(req("/api/admin/deals"), { token: await mintAdminApiToken() }),
    ).resolves.toBe(true);
    // An explicit-but-wrong body token is NOT rescued by a header or query.
    await expect(
      isAdminApiRequest(req(`/api/admin/deals?token=${STATIC}`, { "x-admin-token": STATIC }), {
        token: "wrong",
      }),
    ).resolves.toBe(false);
  });

  it("rejects a bare request, and a forged x-admin-route header proves nothing", async () => {
    await expect(isAdminApiRequest(req("/api/admin/pit"))).resolves.toBe(false);
    await expect(
      isAdminApiRequest(
        req("/api/admin/pit", { "x-admin-route": "1", "x-admin-via": "proxy-key" }),
      ),
    ).resolves.toBe(false);
  });

  it("fails closed when nothing is configured", async () => {
    delete process.env.ADMIN_CAMERA_TOKEN;
    delete process.env.ADMIN_PROXY_KEY;
    await expect(
      isAdminApiRequest(req("/api/admin/pit", { "x-admin-token": STATIC })),
    ).resolves.toBe(false);
  });
});
