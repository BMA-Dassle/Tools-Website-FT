import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { ADMIN_TOOL_SLUGS, isGuestHost, resolveAdminDeploymentPath } from "./admin-deployment";

const TOKEN = "a".repeat(32);

describe("ADMIN_TOOL_SLUGS", () => {
  it("is pinned to the real app/admin/[token]/* directories", () => {
    // The same drift protection the chrome registry uses: a new admin tool
    // that isn't added here would silently 404 on the admin deployment.
    const tokenDir = fileURLToPath(new URL("../../../app/admin/[token]/", import.meta.url));
    const dirs = readdirSync(tokenDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([...ADMIN_TOOL_SLUGS].sort());
  });
});

describe("isGuestHost", () => {
  it("matches the guest production domains and their subdomains", () => {
    for (const h of [
      "fasttraxent.com",
      "www.fasttraxent.com",
      "headpinz.com",
      "www.headpinz.com",
      "swflpassport.com",
      "cards.swflpassport.com",
    ]) {
      expect(isGuestHost(h), h).toBe(true);
    }
  });

  it("does not match dev hosts, vercel domains, or lookalikes", () => {
    for (const h of ["localhost", "127.0.0.1", "ft-admin.vercel.app", "notfasttraxent.com"]) {
      expect(isGuestHost(h), h).toBe(false);
    }
  });
});

describe("resolveAdminDeploymentPath — passthrough", () => {
  it("leaves ALL api traffic to the existing middleware logic", () => {
    for (const p of ["/api", "/api/foo", "/api/admin/videos/list", "/api/cron/video-match"]) {
      expect(resolveAdminDeploymentPath(p, TOKEN), p).toEqual({ kind: "passthrough" });
    }
  });

  it("leaves non-matching /admin paths to the unified gate (embed, wrong/legacy token)", () => {
    for (const p of [
      "/admin",
      "/admin/embed/videos",
      "/admin/wrong-token/pit",
      `/admin/${TOKEN}`, // bare token, no tool — same not-found dead end as main
    ]) {
      expect(resolveAdminDeploymentPath(p, TOKEN), p).toEqual({ kind: "passthrough" });
    }
  });

  it("passes the owner-approved staff previews through", () => {
    for (const p of ["/contract", "/contract/abc123", "/v/CODE99"]) {
      expect(resolveAdminDeploymentPath(p, TOKEN), p).toEqual({ kind: "passthrough" });
    }
    // A bare /v carries no code and has no route — stays a 404.
    expect(resolveAdminDeploymentPath("/v", TOKEN)).toEqual({ kind: "not-found" });
  });
});

describe("resolveAdminDeploymentPath — redirect (normalize to clean urls)", () => {
  it("strips the real-token prefix, keeping deeper segments", () => {
    expect(resolveAdminDeploymentPath(`/admin/${TOKEN}/pit`, TOKEN)).toEqual({
      kind: "redirect",
      pathname: "/pit",
    });
    expect(resolveAdminDeploymentPath(`/admin/${TOKEN}/camera-assign/blue`, TOKEN)).toEqual({
      kind: "redirect",
      pathname: "/camera-assign/blue",
    });
    expect(resolveAdminDeploymentPath(`/admin/${TOKEN}/pit/`, TOKEN)).toEqual({
      kind: "redirect",
      pathname: "/pit",
    });
  });

  it("maps the daily-events shim clean→clean so its redirect() (token in the Location header) never runs", () => {
    expect(resolveAdminDeploymentPath("/daily-events", TOKEN)).toEqual({
      kind: "redirect",
      pathname: "/daily-events-v2",
    });
    expect(resolveAdminDeploymentPath("/daily-events/", TOKEN)).toEqual({
      kind: "redirect",
      pathname: "/daily-events-v2",
    });
  });
});

describe("resolveAdminDeploymentPath — rewrite (the clean tool urls)", () => {
  it("injects the token for every allowlisted tool", () => {
    for (const slug of ADMIN_TOOL_SLUGS) {
      if (slug === "daily-events") continue; // exact match redirects instead (shim)
      expect(resolveAdminDeploymentPath(`/${slug}`, TOKEN), slug).toEqual({
        kind: "rewrite",
        pathname: `/admin/${TOKEN}/${slug}`,
      });
    }
  });

  it("carries deeper segments and trailing slashes along", () => {
    expect(resolveAdminDeploymentPath("/camera-assign/blue", TOKEN)).toEqual({
      kind: "rewrite",
      pathname: `/admin/${TOKEN}/camera-assign/blue`,
    });
    expect(resolveAdminDeploymentPath("/daily-events/1234567", TOKEN)).toEqual({
      kind: "rewrite",
      pathname: `/admin/${TOKEN}/daily-events/1234567`,
    });
    expect(resolveAdminDeploymentPath("/videos/", TOKEN)).toEqual({
      kind: "rewrite",
      pathname: `/admin/${TOKEN}/videos`,
    });
  });
});

describe("resolveAdminDeploymentPath — not-found (this project serves nothing else)", () => {
  it("404s the root and every guest path", () => {
    for (const p of ["/", "/book", "/racing", "/fort-myers", "/kiosk/admin", "/tv", "/hp"]) {
      expect(resolveAdminDeploymentPath(p, TOKEN), p).toEqual({ kind: "not-found" });
    }
  });

  it("fails closed when ADMIN_CAMERA_TOKEN is unset", () => {
    expect(resolveAdminDeploymentPath("/pit", "")).toEqual({ kind: "not-found" });
    // …and the token-prefix redirect can never match an empty token.
    expect(resolveAdminDeploymentPath("/admin//pit", "")).toEqual({ kind: "passthrough" });
  });

  it("does not let a tool slug swallow lookalike siblings", () => {
    expect(resolveAdminDeploymentPath("/pits", TOKEN)).toEqual({ kind: "not-found" });
    expect(resolveAdminDeploymentPath("/salesy", TOKEN)).toEqual({ kind: "not-found" });
  });
});
