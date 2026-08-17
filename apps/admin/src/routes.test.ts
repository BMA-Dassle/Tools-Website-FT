import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { ADMIN_TOOL_SLUGS, resolveAdminProxyPath } from "./routes";

const TOKEN = "a".repeat(32);

describe("ADMIN_TOOL_SLUGS", () => {
  it("is pinned to the real apps/web/app/admin/[token]/* directories", () => {
    // Cross-app drift pin: a new admin tool added in apps/web that isn't
    // added here would silently 404 on the admin domain.
    const tokenDir = fileURLToPath(new URL("../../web/app/admin/[token]/", import.meta.url));
    const dirs = readdirSync(tokenDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([...ADMIN_TOOL_SLUGS].sort());
  });
});

describe("resolveAdminProxyPath — forward (same path upstream)", () => {
  it("forwards ALL api traffic to the main deployment's own gates", () => {
    for (const p of ["/api", "/api/foo", "/api/admin/videos/list", "/api/pandora/races-current"]) {
      expect(resolveAdminProxyPath(p, TOKEN), p).toEqual({ kind: "forward", pathname: p });
    }
  });

  it("forwards framework and static assets the proxied pages reference", () => {
    for (const p of [
      "/favicon.ico",
      "/_next/static/chunks/main.js",
      "/_next/image",
      "/_vercel/insights/script.js",
      "/images/logo.png",
      "/brand/ft.svg",
      "/some-font.woff2",
    ]) {
      expect(resolveAdminProxyPath(p, TOKEN).kind, p).toBe("forward");
    }
  });

  it("forwards non-matching /admin paths to the unified gate (embed, wrong/legacy token)", () => {
    for (const p of [
      "/admin",
      "/admin/embed/videos",
      "/admin/wrong-token/pit",
      `/admin/${TOKEN}`, // bare token, no tool — same not-found dead end as the main site
    ]) {
      expect(resolveAdminProxyPath(p, TOKEN), p).toEqual({ kind: "forward", pathname: p });
    }
  });

  it("forwards the owner-approved staff previews", () => {
    for (const p of ["/contract", "/contract/abc123", "/v/CODE99"]) {
      expect(resolveAdminProxyPath(p, TOKEN), p).toEqual({ kind: "forward", pathname: p });
    }
    // A bare /v carries no code and has no route upstream — stays a 404.
    expect(resolveAdminProxyPath("/v", TOKEN)).toEqual({ kind: "not-found" });
  });
});

describe("resolveAdminProxyPath — redirect (normalize to clean urls)", () => {
  it("strips the real-token prefix, keeping deeper segments", () => {
    expect(resolveAdminProxyPath(`/admin/${TOKEN}/pit`, TOKEN)).toEqual({
      kind: "redirect",
      pathname: "/pit",
    });
    expect(resolveAdminProxyPath(`/admin/${TOKEN}/camera-assign/blue`, TOKEN)).toEqual({
      kind: "redirect",
      pathname: "/camera-assign/blue",
    });
    expect(resolveAdminProxyPath(`/admin/${TOKEN}/pit/`, TOKEN)).toEqual({
      kind: "redirect",
      pathname: "/pit",
    });
  });

  it("maps the daily-events shim clean→clean so its redirect() (token in the Location header) never runs", () => {
    expect(resolveAdminProxyPath("/daily-events", TOKEN)).toEqual({
      kind: "redirect",
      pathname: "/daily-events-v2",
    });
    expect(resolveAdminProxyPath("/daily-events/", TOKEN)).toEqual({
      kind: "redirect",
      pathname: "/daily-events-v2",
    });
  });
});

describe("resolveAdminProxyPath — forward-admin (the clean tool urls)", () => {
  it("injects the token for every allowlisted tool", () => {
    for (const slug of ADMIN_TOOL_SLUGS) {
      if (slug === "daily-events") continue; // exact match redirects instead (shim)
      expect(resolveAdminProxyPath(`/${slug}`, TOKEN), slug).toEqual({
        kind: "forward-admin",
        pathname: `/admin/${TOKEN}/${slug}`,
      });
    }
  });

  it("carries deeper segments and trailing slashes along", () => {
    expect(resolveAdminProxyPath("/camera-assign/blue", TOKEN)).toEqual({
      kind: "forward-admin",
      pathname: `/admin/${TOKEN}/camera-assign/blue`,
    });
    expect(resolveAdminProxyPath("/daily-events/1234567", TOKEN)).toEqual({
      kind: "forward-admin",
      pathname: `/admin/${TOKEN}/daily-events/1234567`,
    });
    expect(resolveAdminProxyPath("/videos/", TOKEN)).toEqual({
      kind: "forward-admin",
      pathname: `/admin/${TOKEN}/videos`,
    });
  });
});

describe("resolveAdminProxyPath — not-found (this domain serves nothing else)", () => {
  it("404s the root and every guest path", () => {
    for (const p of ["/", "/book", "/racing", "/fort-myers", "/kiosk/admin", "/tv", "/hp"]) {
      expect(resolveAdminProxyPath(p, TOKEN), p).toEqual({ kind: "not-found" });
    }
  });

  it("fails closed when ADMIN_CAMERA_TOKEN is unset", () => {
    expect(resolveAdminProxyPath("/pit", "")).toEqual({ kind: "not-found" });
    // …and the token-prefix redirect can never match an empty token.
    expect(resolveAdminProxyPath("/admin//pit", "")).toEqual({
      kind: "forward",
      pathname: "/admin//pit",
    });
  });

  it("does not let a tool slug swallow lookalike siblings", () => {
    expect(resolveAdminProxyPath("/pits", TOKEN)).toEqual({ kind: "not-found" });
    expect(resolveAdminProxyPath("/salesy", TOKEN)).toEqual({ kind: "not-found" });
  });
});
