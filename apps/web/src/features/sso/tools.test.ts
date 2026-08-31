import { describe, it, expect } from "vitest";
import {
  ADMIN_TOOL_SLUGS,
  DEVICE_TOKEN_TOOLS,
  SSO_ADMIN_TOOLS,
  TOKEN_ONLY_TOOLS,
} from "~/lib/constants/admin-tools";
import {
  DEFAULT_ADMIN_HOST,
  isAdminHost,
  isSsoSelfPath,
  isSsoToolPath,
  parseAdminHosts,
  resolveAdminHostPath,
} from "./tools";

/**
 * The routing table, in isolation from the middleware that executes it.
 *
 * These are the same rules `apps/admin/src/routes.ts` enforced for the proxy
 * shell, ported in-process — so the assertions are deliberately the shell's,
 * plus the ones the split into SSO and token tools adds. The registry itself
 * (which slug is on which list) is pinned in
 * `~/lib/constants/admin-tools.test.ts`; this file only proves the mapping.
 */

const TOKEN = "a".repeat(32);

describe("isSsoToolPath — only the migrated tools", () => {
  it("is true for a migrated tool page and its deeper segments", () => {
    expect(isSsoToolPath("/admin/reservations", TOKEN)).toBe(true);
    expect(isSsoToolPath("/admin/reservations/", TOKEN)).toBe(true);
    expect(isSsoToolPath("/admin/checkin", TOKEN)).toBe(true);
    expect(isSsoToolPath("/admin/e-tickets", TOKEN)).toBe(true);
    expect(isSsoToolPath("/admin/videos", TOKEN)).toBe(true);
    // Deeper segments ride along on the slug, whether or not a route renders
    // them — the gate decides on segment 2 and nothing else.
    expect(isSsoToolPath("/admin/checkin/anything", TOKEN)).toBe(true);
  });

  it("covers EVERY slug on the SSO list, so no v2 board is left ungated", () => {
    for (const slug of SSO_ADMIN_TOOLS) {
      expect(isSsoToolPath(`/admin/${slug}`, TOKEN), slug).toBe(true);
    }
  });

  it("is FALSE for camera-assign, board and track alike (owner decision 2026-08-28)", () => {
    // It shipped SSO-gated and came back off: trackside kiosks, shared between
    // staff, worked standing up between heats. The nested path matters as much
    // as the board — `/admin/camera-assign/blue` must not be claimed by the
    // SSO branch either, because there is no v2 route for it to redirect to.
    expect(isSsoToolPath("/admin/camera-assign", TOKEN)).toBe(false);
    expect(isSsoToolPath("/admin/camera-assign/blue", TOKEN)).toBe(false);
    expect(isSsoToolPath("/admin/camera-assign/", TOKEN)).toBe(false);
    // …and its token URLs are untouched by any of this.
    expect(isSsoToolPath(`/admin/${TOKEN}/camera-assign`, TOKEN)).toBe(false);
    expect(isSsoToolPath(`/admin/${TOKEN}/camera-assign/blue`, TOKEN)).toBe(false);
  });

  it("is FALSE for the unattended wall displays", () => {
    // The owner decision, expressed where the gate can act on it: pit and
    // briefing must never be handed to the SSO branch, because the SSO branch's
    // answer to "no session" is a redirect to Microsoft, and a wall board
    // cannot answer it.
    for (const slug of DEVICE_TOKEN_TOOLS) {
      expect(isSsoToolPath(`/admin/${slug}`, TOKEN), slug).toBe(false);
    }
  });

  it("is FALSE for every tool that has not migrated yet", () => {
    for (const slug of TOKEN_ONLY_TOOLS) {
      expect(isSsoToolPath(`/admin/${slug}`, TOKEN), slug).toBe(false);
    }
  });

  it("is false for everything the other credentials own", () => {
    // These three exclusions are what keep the golden matrix unchanged.
    expect(isSsoToolPath(`/admin/${TOKEN}/reservations`, TOKEN)).toBe(false);
    expect(isSsoToolPath("/admin/embed/videos", TOKEN)).toBe(false);
    expect(isSsoToolPath("/api/admin/videos/list", TOKEN)).toBe(false);
  });

  it("is false for a non-tool second segment and for the bare /admin", () => {
    expect(isSsoToolPath("/admin/wrong/reservations", TOKEN)).toBe(false);
    expect(isSsoToolPath("/admin//reservations", TOKEN)).toBe(false);
    expect(isSsoToolPath("/admin", TOKEN)).toBe(false);
    expect(isSsoToolPath("/admin/", TOKEN)).toBe(false);
    expect(isSsoToolPath("/administration", TOKEN)).toBe(false);
  });

  it("yields to the static token when the token happens to BE a slug", () => {
    expect(isSsoToolPath("/admin/checkin", "checkin")).toBe(false);
    // …and claims it again once that token is not configured.
    expect(isSsoToolPath("/admin/checkin", "")).toBe(true);
  });
});

describe("isSsoSelfPath — the routes that must work with no session", () => {
  it("covers Auth.js's endpoints and the SSO surfaces", () => {
    for (const p of [
      "/api/auth",
      "/api/auth/signin",
      "/api/auth/callback/headpinz",
      "/api/auth/session",
      "/sso",
      "/sso/signin",
      "/sso/error",
      "/sso/diag",
      "/sso/error/",
    ]) {
      expect(isSsoSelfPath(p), p).toBe(true);
    }
  });

  it("does not swallow lookalike siblings", () => {
    expect(isSsoSelfPath("/api/authorize")).toBe(false);
    expect(isSsoSelfPath("/ssot")).toBe(false);
  });
});

describe("isAdminHost", () => {
  it("matches the default staff domain, port and case insensitively", () => {
    expect(isAdminHost(DEFAULT_ADMIN_HOST)).toBe(true);
    expect(isAdminHost("ADMIN.FastTraxEnt.com:443")).toBe(true);
  });

  it("does not match the brand hosts, a lookalike, or localhost", () => {
    for (const h of [
      "fasttraxent.com",
      "headpinz.com",
      "admin-preview.fasttraxent.com",
      "notadmin.fasttraxent.com",
      "localhost:3111",
      "",
    ]) {
      expect(isAdminHost(h), h).toBe(false);
    }
  });

  it("matches an ADMIN_HOSTS entry — preview aliases come from env, not source", () => {
    const hosts = parseAdminHosts(" preview-a.vercel.app , preview-b.vercel.app ");
    expect(hosts).toEqual(["preview-a.vercel.app", "preview-b.vercel.app"]);
    expect(isAdminHost("preview-b.vercel.app", hosts)).toBe(true);
    expect(isAdminHost("preview-c.vercel.app", hosts)).toBe(false);
    expect(parseAdminHosts(undefined)).toEqual([]);
  });
});

describe("resolveAdminHostPath", () => {
  it("decides the self paths FIRST — /api/auth IS an /api path", () => {
    // Regression pin: if the self branch moves below the /api rule, the
    // sign-in callback is treated as ordinary API traffic and nobody gets in.
    expect(resolveAdminHostPath("/api/auth/callback/headpinz")).toEqual({ kind: "self" });
    expect(resolveAdminHostPath("/sso/signin")).toEqual({ kind: "self" });
  });

  it("maps a migrated tool onto its v2 route, deeper segments intact", () => {
    expect(resolveAdminHostPath("/reservations")).toEqual({
      kind: "tool",
      pathname: "/admin/reservations",
    });
    expect(resolveAdminHostPath("/reservations/")).toEqual({
      kind: "tool",
      pathname: "/admin/reservations",
    });
    expect(resolveAdminHostPath("/e-tickets")).toEqual({
      kind: "tool",
      pathname: "/admin/e-tickets",
    });
    expect(resolveAdminHostPath("/videos")).toEqual({
      kind: "tool",
      pathname: "/admin/videos",
    });
    expect(resolveAdminHostPath("/checkin/anything")).toEqual({
      kind: "tool",
      pathname: "/admin/checkin/anything",
    });
    for (const slug of SSO_ADMIN_TOOLS) {
      expect(resolveAdminHostPath(`/${slug}`), slug).toEqual({
        kind: "tool",
        pathname: `/admin/${slug}`,
      });
    }
  });

  it("maps a MIGRATED tool's deeper segments onto its v2 route too", () => {
    // `/daily-events/{projectId}` is a real portal deep link, and it is the
    // only nested route any SSO tool has. Since "move the rest" it resolves to
    // the credential-free `/admin/daily-events/{projectId}` rather than to the
    // tokened form — which is the whole point of moving a tool.
    expect(resolveAdminHostPath("/daily-events/12345")).toEqual({
      kind: "tool",
      pathname: "/admin/daily-events/12345",
    });
  });

  it("keeps EVERY un-migrated tool resolving, on the legacy tokened route", () => {
    // `admin.fasttraxent.com/camera-assign` works today and is in staff hands.
    // Moving the domain onto this deployment must not 404 it. Same gate,
    // different rewrite target — and the same for the two wall displays.
    for (const slug of [...DEVICE_TOKEN_TOOLS, ...TOKEN_ONLY_TOOLS]) {
      expect(resolveAdminHostPath(`/${slug}`), slug).toEqual({
        kind: "legacy-tool",
        slug,
        path: `/${slug}`,
      });
    }
    // camera-assign rejoined this group, nested route and all — the clean staff
    // URL keeps working, it just rewrites to the tokened board again.
    expect(resolveAdminHostPath("/camera-assign")).toEqual({
      kind: "legacy-tool",
      slug: "camera-assign",
      path: "/camera-assign",
    });
    expect(resolveAdminHostPath("/camera-assign/blue")).toEqual({
      kind: "legacy-tool",
      slug: "camera-assign",
      path: "/camera-assign/blue",
    });
  });

  it("classifies every registered slug as one kind of tool or the other", () => {
    for (const slug of ADMIN_TOOL_SLUGS) {
      const kind = resolveAdminHostPath(`/${slug}`).kind;
      expect(kind, slug).toBe(SSO_ADMIN_TOOLS.has(slug) ? "tool" : "legacy-tool");
    }
  });

  it("passes assets, API traffic, canonical /admin/* and the staff previews", () => {
    for (const p of [
      "/_next/static/x.js",
      "/_vercel/insights/script.js",
      "/favicon.ico",
      "/images/logo.png",
      "/api",
      "/api/admin/videos/list",
      "/admin",
      "/admin/reservations",
      "/admin/embed/videos",
      `/admin/${TOKEN}/pit`,
      "/contract",
      "/contract/abc",
      "/v/HPW4K7M9PQR",
    ]) {
      expect(resolveAdminHostPath(p), p).toEqual({ kind: "pass" });
    }
  });

  it("404s the root and every guest route", () => {
    for (const p of ["/", "/book", "/book/race/v2", "/racing", "/fort-myers", "/v", "/w/abc"]) {
      expect(resolveAdminHostPath(p), p).toEqual({ kind: "not-found" });
    }
  });
});
