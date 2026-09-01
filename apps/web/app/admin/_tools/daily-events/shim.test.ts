import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE DAILY-EVENTS SHIM'S REDIRECT TARGET.
 *
 * Both `/admin/daily-events` and `/admin/{ADMIN_CAMERA_TOKEN}/daily-events`
 * render nothing and forward to the v2 board, so the ONLY behaviour either
 * route has is the string it puts in `Location`. Two properties of that string
 * are load-bearing and neither is visible from a type:
 *
 *   1. IT MUST NOT CARRY THE TOKEN. `redirect()` writes a browser-visible
 *      header, so a tokened target hands out the permanent admin secret.
 *   2. IT MUST BE SAME-ORIGIN. Auth.js writes HOST-ONLY session cookies, so an
 *      absolute `https://admin.fasttraxent.com/…` target throws away the
 *      session the visitor just signed in for on the brand host and charges
 *      them a SECOND Microsoft round-trip. `/admin/daily-events-v2` resolves on
 *      both hosts (a `pass` in `resolveAdminHostPath`, then the same SSO
 *      branch), so the person signs in once wherever they started.
 *
 * `redirect()` is mocked rather than stubbed out: the real one throws to unwind
 * the render, and the components are typed `Promise<never>` on the strength of
 * that, so the mock throws too and every call below is asserted as a rejection.
 */

const nav = vi.hoisted(() => ({ targets: [] as string[] }));

vi.mock("next/navigation", () => ({
  redirect: (url: string): never => {
    nav.targets.push(url);
    throw new Error("NEXT_REDIRECT");
  },
  notFound: (): never => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { default: AdminToolPage, dailyEventsV2Path } = await import("./AdminToolPage");
const { default: AdminEventDetailPage } = await import("./AdminEventDetailPage");

/** The one target both shims must produce, asserted as a literal on purpose. */
const V2 = "/admin/daily-events-v2";

beforeEach(() => {
  nav.targets.length = 0;
});

/** Run a shim and return the single URL it redirected to. */
async function target(run: () => Promise<never>): Promise<string> {
  await expect(run()).rejects.toThrow("NEXT_REDIRECT");
  expect(nav.targets).toHaveLength(1);
  return nav.targets[0];
}

describe("dailyEventsV2Path", () => {
  it("is a same-origin path, never an absolute admin-host URL", () => {
    const p = dailyEventsV2Path({ date: "2026-08-30" });
    expect(p.startsWith("/")).toBe(true);
    expect(p).not.toMatch(/^https?:\/\//);
    // The specific regression: an admin-host hop costs a second sign-in
    // because the session cookie on the brand host is host-only.
    expect(p).not.toContain("admin.fasttraxent.com");
  });

  it("drops empty values rather than emitting `?location=`", () => {
    expect(dailyEventsV2Path({})).toBe(V2);
    expect(dailyEventsV2Path({ location: "", date: "" })).toBe(V2);
    expect(dailyEventsV2Path({ location: "", date: "2026-08-30" })).toBe(`${V2}?date=2026-08-30`);
  });
});

describe("the daily-events board shim", () => {
  it("forwards every query param to the same-origin v2 path", async () => {
    const t = await target(() =>
      AdminToolPage({
        query: { date: "2026-08-30", location: "fm", tab: "roster", view: "list" },
      }),
    );
    const url = new URL(t, "https://fasttraxent.com");
    expect(url.origin).toBe("https://fasttraxent.com");
    expect(url.pathname).toBe(V2);
    expect(url.searchParams.get("date")).toBe("2026-08-30");
    expect(url.searchParams.get("location")).toBe("fm");
    expect(url.searchParams.get("tab")).toBe("roster");
    expect(url.searchParams.get("view")).toBe("list");
  });

  it("never names another host, so the sign-in it just cost is not thrown away", async () => {
    const t = await target(() => AdminToolPage({ query: { date: "2026-08-30" } }));
    expect(t.startsWith("/")).toBe(true);
    expect(t).not.toMatch(/^https?:\/\//);
  });

  it("carries no credential — the token never reaches a Location header", async () => {
    const t = await target(() => AdminToolPage({ query: { date: "2026-08-30" } }));
    expect(t).not.toContain("/admin/daily-events-v2/"); // no token segment appended
    expect(t.split("?")[0]).toBe(V2);
  });

  it("ignores array-valued params rather than stringifying them", async () => {
    // Next hands `?date=a&date=b` through as an array; the shim takes strings
    // only, so a repeated param is dropped, not forwarded as "a,b".
    const t = await target(() => AdminToolPage({ query: { date: ["a", "b"], location: "fm" } }));
    expect(t).toBe(`${V2}?location=fm`);
  });
});

describe("the daily-events deep-link shim", () => {
  it("redirects a project id to the v2 board's ?event= modal, same-origin", async () => {
    const t = await target(() =>
      AdminEventDetailPage({
        projectId: "1234567890123456789",
        query: { location: "fm", date: "2026-08-30" },
      }),
    );
    expect(t.startsWith("/")).toBe(true);
    const url = new URL(t, "https://fasttraxent.com");
    expect(url.pathname).toBe(V2);
    // BMI ids exceed Number.MAX_SAFE_INTEGER — forwarded as TEXT, digit for
    // digit (tasks/lessons.md § BMI ID Precision).
    expect(url.searchParams.get("event")).toBe("1234567890123456789");
    expect(url.searchParams.get("location")).toBe("fm");
    expect(url.searchParams.get("date")).toBe("2026-08-30");
  });

  it("omits absent location/date instead of sending empty strings", async () => {
    const t = await target(() => AdminEventDetailPage({ projectId: "42", query: {} }));
    expect(t).toBe(`${V2}?event=42`);
  });

  it("404s a project id that is not digits, before building any URL", async () => {
    for (const bad of ["abc", "1;2", "", "../sales"]) {
      await expect(AdminEventDetailPage({ projectId: bad, query: {} })).rejects.toThrow(
        "NEXT_NOT_FOUND",
      );
    }
    expect(nav.targets).toHaveLength(0);
  });
});
