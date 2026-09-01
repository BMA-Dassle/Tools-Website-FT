import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  ADMIN_TOOL_SLUGS,
  DEVICE_TOKEN_TOOLS,
  SSO_ADMIN_TOOLS,
  TOKEN_ONLY_TOOLS,
  isDeviceTokenTool,
  isSsoAdminTool,
} from "./admin-tools";

/**
 * THE REGISTRY IS PINNED TO THE FILESYSTEM.
 *
 * Three lists decide who can open which board, and every one of them is a
 * hand-maintained set of strings. A string list that describes directories is a
 * list that goes stale — silently, and in the direction of "the gate does not
 * fire" rather than "the build breaks". So every claim the lists make is
 * checked against the real route tree here:
 *
 *   - a tool directory that is in no list         → CI fails (ungated, unroutable)
 *   - a slug in a list with no `[token]` directory→ CI fails (dead entry)
 *   - a slug in two lists                          → CI fails (which gate wins?)
 *   - an SSO slug with no `/admin/<slug>/page.tsx` → CI fails (307s to a 404)
 *   - an SSO slug whose v2 page is not backed by a shared `_tools` module
 *                                                  → CI fails (v1 and v2 will drift)
 *   - a `_tools` module for a slug that is NOT SSO → CI fails (a one-caller
 *                                                    abstraction claiming two)
 *   - a v2 page left behind by a tool that went BACK to the token
 *                                                  → CI fails (ungated board)
 */

const APP_ADMIN = fileURLToPath(new URL("../../../app/admin/", import.meta.url));

function dirsIn(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Directories under app/admin/ that are not tool slugs: the v1 tree, the
 *  portal's HMAC iframe surface, and the shared implementations. */
const NON_TOOL_DIRS = new Set(["[token]", "embed", "_tools"]);

const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe("the three lists partition the real tool directories", () => {
  it("ADMIN_TOOL_SLUGS is exactly app/admin/[token]/*", () => {
    // Both directions matter. A tool added to the v1 tree and not registered
    // here never resolves on the admin host; a slug registered here with no
    // directory is a rewrite target that 404s.
    expect(sorted(ADMIN_TOOL_SLUGS)).toEqual(dirsIn(`${APP_ADMIN}[token]/`));
  });

  it("is the union of the three lists, with nothing counted twice", () => {
    const parts = [...SSO_ADMIN_TOOLS, ...DEVICE_TOKEN_TOOLS, ...TOKEN_ONLY_TOOLS];
    expect(parts.length).toBe(ADMIN_TOOL_SLUGS.size);
    expect([...parts].sort()).toEqual(sorted(ADMIN_TOOL_SLUGS));
  });

  it("SSO tools and device tools are DISJOINT", () => {
    // The whole owner decision is that these two sets never overlap: a surface
    // is either staffed (sign in) or unattended (keep the token). A slug in
    // both would mean the gate and the device contradict each other.
    for (const slug of SSO_ADMIN_TOOLS) {
      expect(DEVICE_TOKEN_TOOLS.has(slug), `${slug} is in both lists`).toBe(false);
    }
    for (const slug of DEVICE_TOKEN_TOOLS) {
      expect(SSO_ADMIN_TOOLS.has(slug), `${slug} is in both lists`).toBe(false);
    }
  });

  it("names the eighteen desk tools, the two wall displays and the one kiosk tool", () => {
    // Spelled out rather than derived: this is an owner decision (2026-08-28,
    // revised the same day after a shift on the shipped gate, and again on
    // 2026-08-30 with "move the rest"), so a change to it should have to change
    // these lines and be argued for in the diff, not slide in as a side effect
    // of an edit somewhere else.
    expect(sorted(SSO_ADMIN_TOOLS)).toEqual([
      "api-docs",
      "checkin",
      "christmas-in-july",
      "daily-events",
      "daily-events-v2",
      "deals",
      "deposit-failures",
      "discount-codes",
      "e-tickets",
      "group-approvals",
      "group-functions",
      "healthnet",
      "kbf",
      "reservations",
      "sales",
      "signage",
      "videos",
      "web-sales",
    ]);
    expect(sorted(DEVICE_TOKEN_TOOLS)).toEqual(["briefing", "pit"]);
    expect(sorted(TOKEN_ONLY_TOOLS)).toEqual(["camera-assign"]);
  });

  it("leaves exactly three surfaces reachable by a token URL alone", () => {
    // The shape of the estate after "move the rest": everything a person works
    // sitting down signs in, and the only things that do not are two wall
    // screens nobody types on and one trackside kiosk. Stated as a count so
    // that quietly parking a nineteenth tool on the token fails here.
    expect(DEVICE_TOKEN_TOOLS.size + TOKEN_ONLY_TOOLS.size).toBe(3);
    expect(SSO_ADMIN_TOOLS.size).toBe(ADMIN_TOOL_SLUGS.size - 3);
  });

  it("keeps camera-assign on the TOKEN, not behind sign-in", () => {
    // The revision this file exists to hold. camera-assign shipped SSO-gated
    // and came straight back off: it is worked TRACKSIDE on shared kiosks —
    // one per track, standing up between heats — so a per-person Microsoft
    // sign-in is a password typed on a shared device in front of guests, every
    // time the session lapses. It is not a device tool either (a human works
    // it), so it belongs on neither of the other two lists.
    expect(TOKEN_ONLY_TOOLS.has("camera-assign")).toBe(true);
    expect(SSO_ADMIN_TOOLS.has("camera-assign")).toBe(false);
    expect(DEVICE_TOKEN_TOOLS.has("camera-assign")).toBe(false);
    expect(isSsoAdminTool("camera-assign")).toBe(false);
  });

  it("puts e-tickets and videos behind sign-in", () => {
    // Both are front-desk tools that paint guest contact details and can mail
    // a ticket or a video link to any address typed into them. On the token,
    // the URL that opened them was a forwardable bearer credential for that.
    for (const slug of ["e-tickets", "videos"]) {
      expect(SSO_ADMIN_TOOLS.has(slug), slug).toBe(true);
      expect(isSsoAdminTool(slug), slug).toBe(true);
      expect(TOKEN_ONLY_TOOLS.has(slug), slug).toBe(false);
    }
  });

  it("puts the fourteen office tools behind sign-in (owner decision 2026-08-30)", () => {
    // "Move the rest." Every one of these is worked from a chair — an office
    // laptop or a back-room desktop — and several paint guest names, phone
    // numbers and card outcomes. Named individually rather than derived so the
    // decision has to be edited to be reversed.
    for (const slug of [
      "api-docs",
      "christmas-in-july",
      "daily-events",
      "daily-events-v2",
      "deals",
      "deposit-failures",
      "discount-codes",
      "group-approvals",
      "group-functions",
      "healthnet",
      "kbf",
      "sales",
      "signage",
      "web-sales",
    ]) {
      expect(isSsoAdminTool(slug), slug).toBe(true);
      expect(TOKEN_ONLY_TOOLS.has(slug), slug).toBe(false);
      expect(DEVICE_TOKEN_TOOLS.has(slug), slug).toBe(false);
    }
  });

  it("keeps the predicates in step with the sets", () => {
    expect(isSsoAdminTool("reservations")).toBe(true);
    expect(isSsoAdminTool("pit")).toBe(false);
    expect(isDeviceTokenTool("pit")).toBe(true);
    expect(isDeviceTokenTool("reservations")).toBe(false);
    expect(isSsoAdminTool("not-a-tool")).toBe(false);
    expect(isDeviceTokenTool("not-a-tool")).toBe(false);
  });
});

describe("every SSO tool has a v2 page; nothing else does", () => {
  it("app/admin/* holds exactly the SSO tools", () => {
    // A v2 page for a tool the gate does not recognise is worse than useless:
    // the SSO branch would not fire, the static-token check would 404 it, and
    // the page would look implemented while being unreachable.
    expect(dirsIn(APP_ADMIN).filter((d) => !NON_TOOL_DIRS.has(d))).toEqual(sorted(SSO_ADMIN_TOOLS));
  });

  it("renders a page at /admin/<slug> for each", () => {
    for (const slug of SSO_ADMIN_TOOLS) {
      expect(existsSync(`${APP_ADMIN}${slug}/page.tsx`), `no v2 page for ${slug}`).toBe(true);
    }
  });

  it("gives camera-assign NO v2 page — neither the board nor its nested track route", () => {
    // The directory comparison above catches `/admin/camera-assign`; the
    // nested `[track]` route is the one it cannot see, and it is the one most
    // likely to be left behind by a half-done revert. Both must be gone: a
    // stray `/admin/camera-assign/blue` would be an ungated board (the SSO
    // branch no longer claims the path, so nothing would gate it but the
    // static-token check it does not have).
    expect(existsSync(`${APP_ADMIN}camera-assign/page.tsx`)).toBe(false);
    expect(existsSync(`${APP_ADMIN}camera-assign/[track]/page.tsx`)).toBe(false);
    expect(existsSync(`${APP_ADMIN}camera-assign`)).toBe(false);
    // …and the v1 tree still carries both, because a token URL comes down only
    // on an explicit owner "pull it".
    expect(existsSync(`${APP_ADMIN}[token]/camera-assign/page.tsx`)).toBe(true);
    expect(existsSync(`${APP_ADMIN}[token]/camera-assign/[track]/page.tsx`)).toBe(true);
  });

  it("mirrors every v1 page of a migrated tool, and no others", () => {
    // Walk the v1 tree and demand the same relative path exists under
    // app/admin/ for migrated tools — and does NOT exist for the rest.
    const v1Pages: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(`${dir}${e.name}/`, `${rel}${e.name}/`);
        else if (e.name === "page.tsx") v1Pages.push(rel);
      }
    };
    walk(`${APP_ADMIN}[token]/`, "");

    expect(v1Pages.length).toBeGreaterThanOrEqual(ADMIN_TOOL_SLUGS.size);
    for (const rel of v1Pages) {
      const slug = rel.split("/")[0];
      const hasV2 = existsSync(`${APP_ADMIN}${rel}page.tsx`);
      expect(hasV2, `${rel} — v2 page presence should follow SSO_ADMIN_TOOLS`).toBe(
        SSO_ADMIN_TOOLS.has(slug),
      );
    }
  });

  it("backs every v2 page with a shared module under _tools", () => {
    // The point of the split is that ONE component answers both routes. A v2
    // page that grew its own body would drift from the v1 one silently, and the
    // drift would be invisible until the two boards disagreed in front of a
    // guest.
    for (const slug of SSO_ADMIN_TOOLS) {
      expect(
        existsSync(`${APP_ADMIN}_tools/${slug}/AdminToolPage.tsx`),
        `missing shared module for ${slug}`,
      ).toBe(true);
    }
  });

  it("_tools holds a directory for exactly the SSO tools and nothing else", () => {
    // The other half of the same rule, and the one that caught camera-assign's
    // leftovers. `_tools` exists ONLY because two routes render one component.
    // When a tool leaves SSO its module has a single caller, and a shared
    // module with one caller is indirection that lies: the next reader takes
    // `_tools/camera-assign` as evidence that `/admin/camera-assign` exists.
    // Fold it back into the `[token]` page instead.
    const modules = dirsIn(`${APP_ADMIN}_tools/`);
    expect(modules).toEqual(sorted(SSO_ADMIN_TOOLS));
  });

  /**
   * NEXT MUST PREFER `/admin/reservations` OVER `/admin/[token]`.
   *
   * The whole v2-alongside-v1 arrangement rests on it. If the dynamic segment
   * won, `/admin/reservations` would render the v1 page with `token ===
   * "reservations"`, which fails its own `token !== expected` check and 404s —
   * so the failure mode is "every migrated board is dead", not a build error.
   *
   * Next's own answer is structural rather than ordered: a route with no
   * dynamic segment is compiled into `staticRoutes` and matched before
   * `dynamicRoutes` is consulted at all. This asserts that classification from
   * the real build output. It needs `.next/routes-manifest.json`, so it skips
   * when the suite runs without a build (the E2E covers the same property end
   * to end, by actually rendering the board).
   *
   * Every v2 BOARD route is static, so the property reduces to the
   * `staticRoutes` membership below. One v2 route is legitimately dynamic —
   * `/admin/daily-events/[projectId]`, the portal deep-link shim — and it does
   * not compete with `/admin/[token]`: the collision only exists at depth 2,
   * where `daily-events` is a static segment either way.
   *
   * Verified 2026-08-30 on this branch: all eighteen `/admin/<slug>` routes in
   * `staticRoutes`; `dynamicRoutes` carries `/admin/[token]/…` plus
   * `/admin/daily-events/[projectId]` and no `/admin/camera-assign/[track]`.
   */
  const MANIFEST = fileURLToPath(new URL("../../../.next/routes-manifest.json", import.meta.url));
  it.skipIf(!existsSync(MANIFEST))(
    "compiles the v2 routes as STATIC, so they out-rank /admin/[token]",
    async () => {
      const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as {
        staticRoutes?: { page: string }[];
        dynamicRoutes?: { page: string }[];
      };
      const statics = new Set((manifest.staticRoutes ?? []).map((r) => r.page));
      const dynamics = (manifest.dynamicRoutes ?? []).map((r) => r.page);

      for (const slug of SSO_ADMIN_TOOLS) {
        expect(statics.has(`/admin/${slug}`), `/admin/${slug} should be a static route`).toBe(true);
      }
      // And nothing compiles a route for the tool that went back to the token:
      // no static /admin/camera-assign, no dynamic /admin/camera-assign/[track].
      expect(statics.has("/admin/camera-assign")).toBe(false);
      expect(dynamics).not.toContain("/admin/camera-assign/[track]");
      // The v1 tree is untouched — every token URL still compiles.
      expect(dynamics.some((p) => p.startsWith("/admin/[token]/"))).toBe(true);
    },
  );

  it("leaves the wall displays with a token route and NO SSO route", () => {
    // The regression this catches is somebody "finishing the migration" by
    // adding /admin/pit — which would put a Microsoft sign-in screen on a wall
    // nobody can type on. Owner decision 2026-08-28.
    for (const slug of DEVICE_TOKEN_TOOLS) {
      expect(existsSync(`${APP_ADMIN}[token]/${slug}/page.tsx`), `${slug} v1`).toBe(true);
      expect(existsSync(`${APP_ADMIN}${slug}/page.tsx`), `${slug} must have no v2 page`).toBe(
        false,
      );
    }
  });
});
