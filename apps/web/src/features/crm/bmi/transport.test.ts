import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, installMsw, rawJson } from "@/test/msw/server";
import { OFFICE_BASE, officeFixtures, officeHandlers } from "@/test/msw/handlers/office";
import {
  OFFICE_HOST_PERSON_ID,
  OFFICE_ONLINE_PROJECT_ID,
  officeMirrorCalls,
  officeMirrorHandlers,
} from "@/test/msw/handlers/office-mirror";

/**
 * The CRM's Office reads through the REAL transport (`officeGet` with the new
 * `sessionTag`) against MSW: the tag becomes `x-session-id: crm-backfill-<ck>`
 * via `officeReadSessionId`, the default read still rides `events-<ck>`, and
 * the 17-digit ids in the raw-text fixtures survive the parse.
 *
 * Redis is stubbed (the token cache): no server in CI, and `officeGet` must
 * not depend on one to be testable.
 */

vi.mock("@/lib/redis", () => ({
  default: {
    get: async () => null,
    setex: async () => "OK",
    set: async () => "OK",
    on: () => undefined,
  },
}));

const server = installMsw(...officeMirrorHandlers, ...officeHandlers);

const {
  officeDayPlanner,
  officePerson,
  officeProject,
  mapWithConcurrency,
  tenantResourceIds,
  collectResourceIds,
  chunk,
} = await import("./transport");
const { officeGet } = await import("~/features/daily-events/data/bmi-office");

beforeEach(() => {
  officeMirrorCalls.length = 0;
});

describe("session tags", () => {
  it("officeDayPlanner sends the stable crm-backfill tag keyed by tenant, every resource, showAll", async () => {
    const dp = await officeDayPlanner<{
      reservations: { projects: { id: string; personId: string }[] };
    }>("headpinznaples", ["11208654", "-1"], "2025-09-01", "2025-09-30");
    const call = officeMirrorCalls.find((c) => c.path.endsWith("/dayPlanner"))!;
    expect(call.sessionId).toBe("crm-backfill-headpinznaples");
    expect(call.search.getAll("resourceIds")).toEqual(["11208654", "-1"]);
    expect(call.search.get("from")).toBe("2025-09-01");
    expect(call.search.get("till")).toBe("2025-09-30");
    expect(call.search.get("showAll")).toBe("true");
    expect(dp.reservations.projects[0]?.personId).toBe(OFFICE_HOST_PERSON_ID);
  });

  it("officeProject / officePerson carry the tag they are given; ids stay exact", async () => {
    const p = await officeProject<{ id: string; personId: string; bills: { id: string }[] }>(
      "headpinzftmyers",
      OFFICE_ONLINE_PROJECT_ID,
      "crm-delta",
    );
    expect(p.id).toBe(OFFICE_ONLINE_PROJECT_ID);
    expect(p.bills[0]?.id).toBe("63000000009561443");
    const person = await officePerson<{ id: string }>("headpinzftmyers", OFFICE_HOST_PERSON_ID);
    expect(person.id).toBe(OFFICE_HOST_PERSON_ID);
    expect(officeMirrorCalls.map((c) => c.sessionId)).toEqual([
      "crm-delta-headpinzftmyers",
      "crm-backfill-headpinzftmyers",
    ]);
  });

  it("officeGet WITHOUT a tag still rides the shared events session (guest reads unchanged)", async () => {
    await officeGet("headpinznaples", `person/${OFFICE_HOST_PERSON_ID}`);
    expect(officeMirrorCalls[0]?.sessionId).toBe("events-headpinznaples");
  });

  it("a tagged read never derives its session id from a clock (same id twice)", async () => {
    await officePerson("headpinznaples", OFFICE_HOST_PERSON_ID);
    await officePerson("headpinznaples", OFFICE_HOST_PERSON_ID);
    expect(officeMirrorCalls[0]?.sessionId).toBe(officeMirrorCalls[1]?.sessionId);
  });
});

describe("tenant resource ids", () => {
  it("come from the tenant's OWN metadata blob under the backfill tag — never the merged Fort Myers constants", async () => {
    let sessionId: string | null = null;
    server.use(
      http.get(`${OFFICE_BASE}/api/:clientKey/metadata`, ({ request }) => {
        sessionId = request.headers.get("x-session-id");
        return rawJson(officeFixtures.metadata());
      }),
    );
    const ids = await tenantResourceIds("headpinznaples");
    expect(ids).toEqual(["11208654", "11208660"]); // the metadata fixture's resources, nothing else
    expect(sessionId).toBe("crm-backfill-headpinznaples");
  });

  it("collectResourceIds walks resources, children, sub-resources, groups AND group members, deduped", () => {
    expect(
      collectResourceIds({
        resources: [{ id: 1, children: [{ id: 2 }], subResources: [{ resourceId: 3 }] }],
        // Naples' real shape (probed 2026-09-13): the lanes are `resources` INSIDE each group.
        resourceGroups: [{ id: 4, resources: [{ id: 41 }, { id: 42 }] }, { id: 1 }],
        allResources: [{ id: "5" }],
      }),
    ).toEqual(["1", "2", "3", "4", "41", "42", "5"]);
  });

  it("chunk splits into ≤ size pieces", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});

describe("mapWithConcurrency", () => {
  it("never exceeds the ceiling, keeps order, and turns a rejection into a failed slot", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 4, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (n === 3) throw new Error("boom");
      return n * 10;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(out).toEqual([
      { ok: true, value: 10 },
      { ok: true, value: 20 },
      { ok: false, error: "boom" },
      { ok: true, value: 40 },
      { ok: true, value: 50 },
      { ok: true, value: 60 },
    ]);
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});
