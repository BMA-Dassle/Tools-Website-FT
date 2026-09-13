import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_REPS } from "~/features/crm/leads/test-support";

/**
 * The ONE public read B7 adds. What it must prove: it discloses first names
 * and centres and nothing else, it is cacheable (a marketing page's dropdown
 * must not mean a database round trip per form open), and a database that is
 * missing or down answers an empty list instead of failing the page.
 */

const bag = vi.hoisted(() => ({
  roster: [] as unknown[],
  error: null as Error | null,
  calls: 0,
}));

vi.mock("~/features/crm/reps", async (importOriginal) => {
  const mod = await importOriginal<typeof import("~/features/crm/reps")>();
  return {
    ...mod,
    listRoster: async () => {
      bag.calls += 1;
      if (bag.error) throw bag.error;
      return bag.roster;
    },
  };
});

const { GET } = await import("./route");

beforeEach(() => {
  bag.roster = [...ALL_REPS];
  bag.error = null;
  bag.calls = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/sales-lead/planners", () => {
  it("lists the planners a guest may pick, and only what a guest may see", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; planners: Record<string, unknown>[] };
    expect(body.ok).toBe(true);
    expect(body.planners.map((p) => p.slug)).toEqual(["kelsea", "lori", "stephanie"]);
    for (const p of body.planners) {
      expect(Object.keys(p).sort()).toEqual(["centres", "firstName", "slug"]);
    }
    expect(JSON.stringify(body)).not.toContain("@headpinz.com");
    expect(JSON.stringify(body)).not.toContain("28267036");
  });

  it("is cached at the edge, and served stale while it revalidates", async () => {
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
    );
  });

  it("answers from the memo rather than reading the roster again", async () => {
    vi.resetModules();
    const fresh = await import("./route");
    bag.calls = 0;
    await fresh.GET();
    await fresh.GET();
    await fresh.GET();
    expect(bag.calls).toBe(1);
  });

  it("a database that is down answers an empty list — the form still submits", async () => {
    bag.error = new Error("Neon unreachable");
    bag.calls = 0;
    // Reset the memo by loading the module fresh.
    vi.resetModules();
    const fresh = await import("./route");
    const res = await fresh.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, planners: [] });
  });
});
