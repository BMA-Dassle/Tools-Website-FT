import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";

/**
 * The `/crm` typing convenience, pinned (brief §1.4 item 8).
 *
 * The CRM has NO page tree at `/crm` — the admin gate covers `/admin/crm` and
 * nothing else — so if these two entries went missing, `headpinz.com/crm`
 * would fall through to the storefront's 404 and every rep bookmark would die
 * silently. Both entries are temporary (307): an alias, never a cached 308.
 */
describe("next.config redirects /crm to the gated URL", () => {
  it("declares the bare and the deep redirect, both temporary", async () => {
    const redirects = await nextConfig.redirects!();
    expect(redirects).toContainEqual({
      source: "/crm",
      destination: "/admin/crm",
      permanent: false,
    });
    expect(redirects).toContainEqual({
      source: "/crm/:path*",
      destination: "/admin/crm/:path*",
      permanent: false,
    });
  });

  it("does not ALSO redirect /admin/crm anywhere — that would loop", async () => {
    const redirects = await nextConfig.redirects!();
    expect(redirects.some((r) => r.source.startsWith("/admin/crm"))).toBe(false);
  });

  it("keeps the redirects host-agnostic so both brand hosts and the admin host get them", async () => {
    const redirects = await nextConfig.redirects!();
    for (const r of redirects.filter((r) => r.source.startsWith("/crm"))) {
      expect(r.has, r.source).toBeUndefined();
    }
  });
});
