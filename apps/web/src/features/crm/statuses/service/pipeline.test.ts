import { describe, expect, it, vi } from "vitest";
import { publicRep } from "../../core/projections";
import { ALL_REPS, PROTO_NOW, makeLead } from "../../leads/test-support";
import { STATUSES } from "../test-support";
import { PIPELINE_LEAD_LIMIT } from "../contracts";
import { loadPipeline, type PipelineDeps } from "./pipeline";

/**
 * `loadPipeline` is thin — `buildBoard` is where the projection is tested. What
 * is NOT thin, and is pinned here, is WHOSE leads the read asks for. A board
 * that widens its scope by accident shows one rep another rep's pipeline, and
 * a director's board is the only place that is ever meant to happen.
 */

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    listStatuses: vi.fn(async () => STATUSES),
    publicRoster: vi.fn(async () => ALL_REPS.map((r) => publicRep(r)!)),
    listLeads: vi.fn(async () => ({
      leads: [makeLead({ id: "7001", status: "quote", rep: "1", valueCents: 120_00 })],
      nextCursor: null,
    })),
    ...over,
  } as PipelineDeps;
}

describe("loadPipeline scope", () => {
  it('scope "mine" reads only that rep\'s leads', async () => {
    const d = deps();
    await loadPipeline({ scope: "mine", repId: "1", byRep: false, now: PROTO_NOW }, d);
    expect(d.listLeads).toHaveBeenCalledWith(
      expect.objectContaining({ repId: "1", limit: PIPELINE_LEAD_LIMIT }),
    );
  });

  it('scope "team" reads every rep\'s leads — repId is not sent', async () => {
    const d = deps();
    await loadPipeline({ scope: "team", repId: null, byRep: true, now: PROTO_NOW }, d);
    expect(d.listLeads).toHaveBeenCalledWith(expect.objectContaining({ repId: undefined }));
  });

  /**
   * The one that matters. A signed-in salesperson with no `crm_reps` row has
   * `repId === null`; passing that through as "no rep filter" would hand them
   * the whole team's pipeline. An empty board is the correct answer, and the
   * read is not made at all.
   */
  it('scope "mine" with no rep row shows NOTHING, and never everyone', async () => {
    const d = deps();
    const data = await loadPipeline(
      { scope: "mine", repId: null, byRep: false, now: PROTO_NOW },
      d,
    );
    expect(d.listLeads).not.toHaveBeenCalled();
    expect(data.leads).toEqual([]);
    expect(data.openCount).toBe(0);
    expect(data.openValueCents).toBe(0);
    // The columns are still there — an empty board, not a broken one.
    expect(data.columns.map((c) => c.id)).toContain("quote");
    expect(data.columns.every((c) => c.count === 0)).toBe(true);
  });

  it("passes the centre and search filters into the read, so narrowing narrows the QUERY", async () => {
    const d = deps();
    await loadPipeline(
      { scope: "team", repId: null, byRep: false, centre: "HPN", q: "smith", now: PROTO_NOW },
      d,
    );
    expect(d.listLeads).toHaveBeenCalledWith(
      expect.objectContaining({ centre: "HPN", q: "smith" }),
    );
  });

  it("reports truncated when the page has a next cursor — the board says so rather than lying", async () => {
    const short = await loadPipeline({ scope: "team", repId: null, byRep: false }, deps());
    expect(short.truncated).toBe(false);

    const long = await loadPipeline(
      { scope: "team", repId: null, byRep: false },
      deps({
        listLeads: vi.fn(async () => ({
          leads: [makeLead({ id: "7002", status: "quote" })],
          nextCursor: "2026-09-12T19:30:00.000Z|7002",
        })),
      }),
    );
    expect(long.truncated).toBe(true);
  });

  it("carries byRep through, so the columns arrive with lanes only when asked", async () => {
    const plain = await loadPipeline({ scope: "team", repId: null, byRep: false }, deps());
    expect(plain.byRep).toBe(false);
    expect(plain.columns.every((c) => c.lanes === null)).toBe(true);

    const grouped = await loadPipeline({ scope: "team", repId: null, byRep: true }, deps());
    expect(grouped.byRep).toBe(true);
    expect(grouped.columns.every((c) => c.lanes !== null)).toBe(true);
  });
});
