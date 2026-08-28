import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";
import { mintAdminApiToken } from "./lib/admin-api-token";

/**
 * GOLDEN MATRIX for the unified admin gate.
 *
 * The gate is the only thing standing between the open internet and every
 * front-desk tool, and PR "feat/admin-sso" adds a SIXTH credential to it
 * (a signed, short-lived API token). Adding a credential to an auth gate is
 * the classic way to widen it by accident, so this file pins every existing
 * path — embed HMAC, public spec, api-key allowlist, proxy key, legacy 308,
 * static token, and the fail-closed 404 — alongside the new one. Every
 * assertion here describes behaviour that predates the new credential except
 * the `api-token` block; if one of them changes, the change is a regression
 * until proven otherwise.
 *
 * `x-admin-via` is the tell for WHICH credential answered — the gate returns
 * NextResponse.next() for all of them, so the header is the only observable
 * difference between "authenticated as the shell" and "authenticated as a
 * cron".
 */

const TOKEN = "c".repeat(32);
const LEGACY = "l".repeat(32);
const PROXY_KEY = "p".repeat(40);
const API_KEY = "sk_test_key";
const EMBED_SECRET = "embed-secret";

function env(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const ADMIN_ENV_KEYS = [
  "ADMIN_CAMERA_TOKEN",
  "ADMIN_ETICKETS_TOKEN",
  "ADMIN_PROXY_KEY",
  "ADMIN_API_SIGNING_SECRET",
  "SALES_API_KEYS",
  "ADMIN_EMBED_SECRET",
];

beforeEach(() => {
  env({
    ADMIN_CAMERA_TOKEN: TOKEN,
    ADMIN_ETICKETS_TOKEN: LEGACY,
    ADMIN_PROXY_KEY: PROXY_KEY,
    ADMIN_API_SIGNING_SECRET: undefined, // exercises the ADMIN_CAMERA_TOKEN fallback
    SALES_API_KEYS: API_KEY,
    ADMIN_EMBED_SECRET: EMBED_SECRET,
  });
});

afterEach(() => env(Object.fromEntries(ADMIN_ENV_KEYS.map((k) => [k, undefined]))));

function req(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL(url, "https://fasttraxent.com"), { headers });
}

/** What the gate decided: the status, and the credential it credited. */
async function gate(url: string, headers: Record<string, string> = {}) {
  const res = await middleware(req(url, headers));
  return {
    status: res.status,
    via: res.headers.get("x-middleware-request-x-admin-via"),
    adminRoute: res.headers.get("x-middleware-request-x-admin-route"),
    location: res.headers.get("location"),
    csp: res.headers.get("Content-Security-Policy"),
  };
}

async function embedSig(ts: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(EMBED_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(ts)));
  return Array.from(sig)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("admin gate — NEW: signed api-token credential", () => {
  it("accepts a minted token on /api/admin/* via the x-admin-token header", async () => {
    const signed = await mintAdminApiToken();
    const r = await gate("/api/admin/videos/list", { "x-admin-token": signed });
    expect(r.status).toBe(200);
    expect(r.via).toBe("api-token");
    expect(r.adminRoute).toBe("1");
  });

  it("accepts it via ?token= too — client components send it where they always did", async () => {
    const signed = await mintAdminApiToken();
    const r = await gate(`/api/admin/camera-assign/state?token=${encodeURIComponent(signed)}`);
    expect(r.status).toBe(200);
    expect(r.via).toBe("api-token");
  });

  it("accepts it on /admin/* pages as well (harmless — same credential class)", async () => {
    const signed = await mintAdminApiToken();
    const r = await gate(`/admin/embed/nope?token=${encodeURIComponent(signed)}`);
    expect(r.status).toBe(200);
    expect(r.via).toBe("api-token");
  });

  it("404s an EXPIRED token — it falls through to the static check and fails", async () => {
    const expired = await mintAdminApiToken(-1000);
    expect(await gate("/api/admin/videos/list", { "x-admin-token": expired })).toMatchObject({
      status: 404,
    });
  });

  it("404s a forged token", async () => {
    const forged = `${Date.now() + 60_000}.${"a".repeat(64)}`;
    expect(await gate("/api/admin/videos/list", { "x-admin-token": forged })).toMatchObject({
      status: 404,
    });
  });

  it("404s a token signed with a retired secret (rotation actually rotates)", async () => {
    const signed = await mintAdminApiToken();
    env({ ADMIN_API_SIGNING_SECRET: "a-new-signing-secret" });
    expect(await gate("/api/admin/videos/list", { "x-admin-token": signed })).toMatchObject({
      status: 404,
    });
  });
});

describe("admin gate — UNCHANGED: static ADMIN_CAMERA_TOKEN", () => {
  it("still opens a page by path segment", async () => {
    const r = await gate(`/admin/${TOKEN}/pit`);
    expect(r.status).toBe(200);
    expect(r.adminRoute).toBe("1");
    expect(r.via).toBeNull(); // the static path has never stamped x-admin-via
  });

  it("still opens an API by header and by query", async () => {
    expect(await gate("/api/admin/videos/list", { "x-admin-token": TOKEN })).toMatchObject({
      status: 200,
      adminRoute: "1",
    });
    expect(await gate(`/api/admin/videos/list?token=${TOKEN}`)).toMatchObject({
      status: 200,
      adminRoute: "1",
    });
  });

  it("still 404s a wrong token (page: text, api: json)", async () => {
    expect(await gate("/admin/wrong/pit")).toMatchObject({ status: 404 });
    expect(await gate("/api/admin/videos/list?token=wrong")).toMatchObject({ status: 404 });
    const apiRes = await middleware(req("/api/admin/videos/list?token=wrong"));
    expect(apiRes.headers.get("content-type")).toBe("application/json");
    const pageRes = await middleware(req("/admin/wrong/pit"));
    expect(pageRes.headers.get("content-type")).toBe("text/plain");
  });

  it("still fails closed when ADMIN_CAMERA_TOKEN is unset", async () => {
    env({ ADMIN_CAMERA_TOKEN: undefined, ADMIN_PROXY_KEY: undefined });
    expect(await gate("/admin//pit")).toMatchObject({ status: 404 });
    expect(await gate("/api/admin/videos/list")).toMatchObject({ status: 404 });
  });

  it("still sets the portal frame-ancestors CSP on ?embedded=1", async () => {
    const r = await gate(`/admin/${TOKEN}/reservations?embedded=1`);
    expect(r.csp).toBe("frame-ancestors https://portal.headpinz.com");
  });
});

describe("admin gate — UNCHANGED: legacy ADMIN_ETICKETS_TOKEN 308", () => {
  it("308s a legacy page URL onto the canonical token", async () => {
    const r = await gate(`/admin/${LEGACY}/e-tickets`);
    expect(r.status).toBe(308);
    expect(r.location).toBe(`https://fasttraxent.com/admin/${TOKEN}/e-tickets`);
  });

  it("does not fire for API paths or when the legacy env is cleared", async () => {
    expect(await gate("/api/admin/e-tickets/list", { "x-admin-token": LEGACY })).toMatchObject({
      status: 404,
    });
    env({ ADMIN_ETICKETS_TOKEN: undefined });
    expect(await gate(`/admin/${LEGACY}/e-tickets`)).toMatchObject({ status: 404 });
  });
});

describe("admin gate — UNCHANGED: proxy key (the SSO shell)", () => {
  it("authenticates a forwarded request with no token at all", async () => {
    const r = await gate(`/admin/${TOKEN}/pit`, { "x-admin-proxy-key": PROXY_KEY });
    expect(r.via).toBe("proxy-key");
    expect(await gate("/api/admin/videos/list", { "x-admin-proxy-key": PROXY_KEY })).toMatchObject({
      status: 200,
      via: "proxy-key",
    });
  });

  it("stays inert when ADMIN_PROXY_KEY is unset, and rejects a wrong key", async () => {
    expect(await gate("/api/admin/videos/list", { "x-admin-proxy-key": "nope" })).toMatchObject({
      status: 404,
    });
    env({ ADMIN_PROXY_KEY: undefined });
    expect(await gate("/api/admin/videos/list", { "x-admin-proxy-key": PROXY_KEY })).toMatchObject({
      status: 404,
    });
  });
});

describe("admin gate — UNCHANGED: x-api-key allowlist (portal integrations)", () => {
  it("opens every allowlisted prefix", async () => {
    for (const p of [
      "/api/admin/sales/orders",
      "/api/admin/videos/list",
      "/api/admin/e-tickets/list",
      "/api/admin/pov-codes/list",
      "/api/admin/guest-survey/stats",
    ]) {
      expect(await gate(p, { "x-api-key": API_KEY }), p).toMatchObject({
        status: 200,
        via: "api-key",
        adminRoute: "1",
      });
    }
  });

  it("accepts ?apiKey= as well", async () => {
    expect(await gate(`/api/admin/sales/orders?apiKey=${API_KEY}`)).toMatchObject({
      via: "api-key",
    });
  });

  it("does NOT open operator-only surfaces, and a wrong key falls through to 404", async () => {
    expect(await gate("/api/admin/camera-assign/state", { "x-api-key": API_KEY })).toMatchObject({
      status: 404,
    });
    expect(await gate("/api/admin/sales/orders", { "x-api-key": "wrong" })).toMatchObject({
      status: 404,
    });
  });
});

describe("admin gate — UNCHANGED: embed HMAC + public spec", () => {
  it("passes a valid signature with the portal frame lock", async () => {
    const ts = String(Date.now());
    const r = await gate(`/admin/embed/videos?ts=${ts}&sig=${await embedSig(ts)}`);
    expect(r.status).toBe(200);
    expect(r.via).toBe("embed-hmac");
    expect(r.csp).toBe("frame-ancestors https://portal.headpinz.com");
  });

  it("403s a bad signature, a stale ts, and missing params", async () => {
    const ts = String(Date.now());
    expect(await gate(`/admin/embed/videos?ts=${ts}&sig=deadbeef`)).toMatchObject({ status: 403 });
    const old = String(Date.now() - 20 * 60 * 1000);
    expect(await gate(`/admin/embed/videos?ts=${old}&sig=${await embedSig(old)}`)).toMatchObject({
      status: 403,
    });
    expect(await gate("/admin/embed/videos")).toMatchObject({ status: 403 });
  });

  it("serves the public OpenAPI spec with no credential", async () => {
    expect(await gate("/api/admin/sales/openapi.json")).toMatchObject({
      status: 200,
      via: "public-spec",
    });
    // …and it is NOT flagged as an admin route (no chrome stripping needed).
    expect((await gate("/api/admin/sales/openapi.json")).adminRoute).toBeNull();
  });
});

describe("admin gate — credential precedence is unchanged", () => {
  it("embed HMAC wins over everything on an embed path", async () => {
    const ts = String(Date.now());
    const r = await gate(`/admin/embed/videos?ts=${ts}&sig=${await embedSig(ts)}`, {
      "x-admin-proxy-key": PROXY_KEY,
      "x-admin-token": TOKEN,
    });
    expect(r.via).toBe("embed-hmac");
  });

  it("api-key wins over the proxy key on an allowlisted path", async () => {
    expect(
      await gate("/api/admin/sales/orders", {
        "x-api-key": API_KEY,
        "x-admin-proxy-key": PROXY_KEY,
      }),
    ).toMatchObject({ via: "api-key" });
  });

  it("proxy key wins over the signed token", async () => {
    const signed = await mintAdminApiToken();
    expect(
      await gate("/api/admin/camera-assign/state", {
        "x-admin-proxy-key": PROXY_KEY,
        "x-admin-token": signed,
      }),
    ).toMatchObject({ via: "proxy-key" });
  });

  it("the signed token wins over the static token — but both still open the door", async () => {
    const signed = await mintAdminApiToken();
    expect(
      await gate(`/api/admin/videos/list?token=${TOKEN}`, { "x-admin-token": signed }),
    ).toMatchObject({ status: 200, via: "api-token" });
    expect(await gate(`/api/admin/videos/list?token=${TOKEN}`)).toMatchObject({ status: 200 });
  });
});

describe("admin gate — the gate does not leak into non-admin routing", () => {
  it("leaves guest paths alone even with a signed token attached", async () => {
    const signed = await mintAdminApiToken();
    const r = await middleware(req(`/racing?token=${encodeURIComponent(signed)}`));
    expect(r.headers.get("x-middleware-request-x-admin-route")).toBeNull();
    expect(r.headers.get("x-middleware-request-x-admin-via")).toBeNull();
  });

  it("does not treat /adminsomething as an admin path", async () => {
    const r = await middleware(req("/administration"));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-middleware-request-x-admin-route")).toBeNull();
  });
});
