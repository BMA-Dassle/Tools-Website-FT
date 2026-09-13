import { describe, expect, it, vi } from "vitest";
import type { CrmUser } from "../../core/types";
import { EMPTY_CALL_STATS, type CallListFilter } from "../data/calls-db";
import { connectivityFor, loadCallsBoard, scopeRepId, type BoardDeps } from "./board";

/** Who sees whose calls, and what the screen is told about 3CX. */

function user(role: "rep" | "director", repId: string | null): CrmUser {
  return {
    email: role === "director" ? "jacob@headpinz.com" : "kelsea@headpinz.com",
    name: "Test",
    sub: null,
    roles: role === "director" ? ["access", "sales-director"] : ["access", "sales"],
    role,
    rep: repId ? ({ id: repId, threecxExtension: "9025" } as unknown as CrmUser["rep"]) : null,
  };
}

describe("scopeRepId", () => {
  it("lets a director see everyone, or narrow to one rep", () => {
    expect(scopeRepId(user("director", null), null)).toBeNull();
    expect(scopeRepId(user("director", null), "7")).toBe("7");
  });

  it("pins a rep to their own calls, whatever they ask for", () => {
    expect(scopeRepId(user("rep", "7"), "99")).toBe("7");
  });

  it("shows a rep with no rep row NOTHING rather than everything", () => {
    // The important half: a missing rep row must not fall through to `null`,
    // which the SQL reads as "no filter" and would leak the whole team's calls.
    expect(scopeRepId(user("rep", null), null)).toBe("-1");
  });
});

describe("connectivityFor", () => {
  it("reports each half of 3CX separately", () => {
    const c = connectivityFor(user("rep", "7"), {
      apiConfigured: () => true,
      journalConfigured: () => false,
      callsEnabled: () => true,
    });
    expect(c).toEqual({
      apiConfigured: true,
      journalConfigured: false,
      clickToCallEnabled: true,
      myExtension: "9025",
    });
  });
});

describe("loadCallsBoard", () => {
  function deps(overrides: Partial<BoardDeps> = {}) {
    const filters: CallListFilter[] = [];
    const list = vi.fn(async (f: CallListFilter = {}) => {
      filters.push(f);
      return { calls: [], nextCursor: null };
    });
    const windows: { since: Date; until: Date }[] = [];
    const stats = vi.fn(async (o: { since: Date; until: Date; repId?: string | null }) => {
      windows.push({ since: o.since, until: o.until });
      return EMPTY_CALL_STATS;
    });
    const roster = vi.fn(async () => []);
    const base: BoardDeps = {
      list,
      stats,
      roster,
      apiConfigured: () => true,
      journalConfigured: () => false,
      callsEnabled: () => true,
      now: () => new Date("2026-09-13T22:00:00Z"),
    };
    return {
      deps: { ...base, ...overrides } satisfies BoardDeps,
      filters,
      windows,
      list,
      stats,
      roster,
    };
  }

  it("fetches the page and the tray, and never scopes the tray to a rep", async () => {
    const d = deps();
    await loadCallsBoard(user("rep", "7"), { direction: "in" }, d.deps);
    expect(d.filters[0]).toMatchObject({ repId: "7", direction: "in" });
    const tray = d.filters.find((f) => f.unlinked);
    expect(tray).toBeDefined();
    expect(tray?.repId).toBeUndefined();
  });

  it("counts 'today' over the ET calendar day, not the server's", async () => {
    const d = deps();
    // 22:00 UTC on the 13th is 18:00 ET on the 13th — the ET day must still be
    // the 13th, and the window must start at 04:00Z on the 13th (ET midnight).
    await loadCallsBoard(user("director", null), {}, d.deps);
    expect(d.windows[0]?.since.toISOString()).toBe("2026-09-13T04:00:00.000Z");
    expect(d.windows[0]?.until.toISOString()).toBe("2026-09-14T04:00:00.000Z");
  });

  it("renders the board even when the stats query fails", async () => {
    const d = deps({
      stats: async () => {
        throw new Error("neon down");
      },
    });
    const out = await loadCallsBoard(user("rep", "7"), {}, d.deps);
    expect(out.stats).toEqual(EMPTY_CALL_STATS);
    expect(out.connectivity.journalConfigured).toBe(false);
  });
});
