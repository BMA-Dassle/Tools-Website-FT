import { describe, expect, it } from "vitest";
import {
  FIXTURE_COMPANY_PERSON_ID,
  FIXTURE_HOST_PERSON_ID,
  FIXTURE_ONLINE_PROJECT_ID,
  FIXTURE_PROJECT_ID,
  memoryDeps,
} from "../test-support";
import {
  cursorToPayload,
  makeBackfillHandler,
  mergeDayPlannerRefs,
  runBackfillStep,
} from "./mirror";
import { parseBackfillPayload, type BackfillCursor } from "./windows";

/**
 * The chunked, resumable backfill against an in-memory Office fed from the
 * raw-text fixtures: one window per run, online bookings kept as stubs, the
 * detail phase split by batch and by time budget, every continuation
 * re-enqueued under a cursor-derived key, idempotent upserts, and a failed
 * detail that does not stall the chain.
 *
 * The dayPlanner fixture lists ONE group event (58454076) and ONE online
 * booking (58454077, kindId -10); tests that need two group events flip
 * `office.allGroupEvents`.
 */

function cursor(over: Partial<BackfillCursor> = {}): BackfillCursor {
  const r = parseBackfillPayload(
    { clientKey: "headpinzftmyers", from: "2025-09-01", until: "2025-10-15" },
    "77",
  );
  if (!r.ok) throw new Error(r.error);
  return { ...r.cursor, ...over };
}

describe("one window, end to end", () => {
  it("phase 1 asks the dayPlanner once with the tenant's resources under the crm-backfill tag; online bookings become stubs; phase 2 mirrors the group event + host", async () => {
    const deps = memoryDeps();
    const result = await runBackfillStep(cursor(), deps);

    const dp = deps.office.calls.filter((c) => c.op === "dayPlanner");
    expect(dp).toHaveLength(1);
    expect(dp[0]?.args).toEqual([
      "headpinzftmyers",
      ["11208654", "11208660"],
      "2025-09-01",
      "2025-09-30",
    ]);

    // Only the GROUP event is detail-read (with the backfill tag); the online booking is a stub.
    const projectReads = deps.office.calls.filter((c) => c.op === "project");
    expect(projectReads.map((c) => c.args[1])).toEqual([FIXTURE_PROJECT_ID]);
    expect(projectReads[0]?.args[2]).toBe("crm-backfill");
    // The host AND the project's `companyId` record — Office keeps a business
    // as a second person row, and its `name` is the only company name on this
    // rail (probed live 2026-09-13).
    expect(deps.office.calls.filter((c) => c.op === "person").map((c) => c.args[1])).toEqual([
      FIXTURE_HOST_PERSON_ID,
      FIXTURE_COMPANY_PERSON_ID,
    ]);
    expect(deps.office.calls.filter((c) => c.op === "person").map((c) => c.args[2])).toEqual([
      "crm-backfill",
      "crm-backfill",
    ]);
    expect(deps.linker.linked[0]?.account).toEqual({
      kind: "business",
      name: "Acme Corp., Inc.",
      nameKey: "acme",
    });

    expect(result).toMatchObject({
      ok: true,
      projectsInWindow: 2,
      groupEvents: 1,
      detailsThisRun: 1,
      inserted: 1,
      updated: 0,
      failed: [],
      onlineBookings: 1,
      onlineInserted: 1,
      window: { from: "2025-09-01", until: "2025-09-30" },
      next: "bmi-mirror-backfill:headpinzftmyers:2025-10-01#77",
      nextCreated: true,
    });

    // Rows: ids intact, links applied, the online booking KEPT and flagged with the dayPlanner's own facts.
    const host = deps.store.rows.get(FIXTURE_PROJECT_ID)!;
    expect(host.row.personId).toBe(FIXTURE_HOST_PERSON_ID);
    expect(host.row.source).toBe("backfill");
    expect(host.link.accountId).toBeTruthy();
    expect(host.link.contactId).toBeTruthy();
    expect(host.row.locationId).toBe(332160);
    const stub = deps.store.rows.get(FIXTURE_ONLINE_PROJECT_ID)!;
    expect(stub.row).toMatchObject({
      kindId: "-10",
      number: "W59922",
      personId: "63000000009561440",
      personName: "Ana Rodriguez",
      stateId: "-3",
      stateName: "Confirmation",
      eventDate: "2025-09-21",
      locationId: 467486, // schedule on the Blue Track → FastTrax
      products: null,
      personPhone: null,
    });
    expect(stub.link).toEqual({ accountId: null, contactId: null });

    // The sync-run ledger: one row, ok, counts include the stubs.
    expect(deps.store.runs).toHaveLength(1);
    expect(deps.store.runs[0]).toMatchObject({
      clientKey: "headpinzftmyers",
      kind: "backfill",
      ok: true,
      rowsSeen: 2,
      rowsUpserted: 2,
      error: null,
    });
    expect(deps.store.runs[0]?.windowFrom).toBe("2025-09-01T04:00:00.000Z"); // ET midnight, EDT
    expect(deps.store.runs[0]?.windowUntil).toBe("2025-10-01T04:00:00.000Z"); // start of the day after

    // The lifetime roll-up ran for the one account touched.
    expect(deps.linker.refreshed).toEqual([[host.link.accountId]]);

    // The next window was enqueued with a fresh cursor (no ids, offset 0).
    expect(deps.enqueued).toHaveLength(1);
    expect(deps.enqueued[0]).toMatchObject({
      kind: "bmi-mirror-backfill",
      idempotencyKey: "bmi-mirror-backfill:headpinzftmyers:2025-10-01#77",
      payload: {
        clientKey: "headpinzftmyers",
        from: "2025-09-01",
        until: "2025-10-15",
        windowFrom: "2025-10-01",
        windowUntil: "2025-10-15",
        detailOffset: 0,
        projectIds: null,
        chain: "77",
      },
    });
  });

  it("a tenant with many resources is asked in batches of 40, ≤ 2 in flight, and the union is deduped", async () => {
    const deps = memoryDeps();
    deps.office.resourceIds = Array.from({ length: 90 }, (_, i) => String(100 + i));
    let inFlight = 0;
    let peak = 0;
    const real = deps.office.dayPlanner.bind(deps.office);
    deps.office.dayPlanner = async (...args) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      inFlight--;
      return real(...args);
    };
    const r = await runBackfillStep(cursor(), deps);
    const dp = deps.office.calls.filter((c) => c.op === "dayPlanner");
    expect(dp.map((c) => (c.args[1] as string[]).length)).toEqual([40, 40, 10]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(r.projectsInWindow).toBe(2); // the same fixture three times → still two projects
    expect(r.onlineBookings).toBe(1);
    expect(deps.store.rows.size).toBe(2);
  });

  it("a second pass over the same window inserts 0 rows (idempotent upsert), and the chain key is NOT re-created", async () => {
    const deps = memoryDeps();
    await runBackfillStep(cursor(), deps);
    const again = await runBackfillStep(cursor(), deps);
    expect(again).toMatchObject({
      inserted: 0,
      updated: 1,
      onlineBookings: 1,
      onlineInserted: 0,
      nextCreated: false,
    });
    expect(deps.store.rows.get(FIXTURE_PROJECT_ID)!.writes).toBe(2);
    expect(deps.store.rows.get(FIXTURE_ONLINE_PROJECT_ID)!.writes).toBe(2);
  });

  it("mergeDayPlannerRefs unions resource ids per project across batches", () => {
    expect(
      mergeDayPlannerRefs([
        { projectId: "1", kindId: null, scheduleResourceIds: ["a"] },
        { projectId: "1", kindId: "-1", scheduleResourceIds: ["b", "a"] },
        { projectId: "2", kindId: "-10", scheduleResourceIds: [] },
      ]),
    ).toEqual([
      { projectId: "1", kindId: "-1", scheduleResourceIds: ["a", "b"] },
      { projectId: "2", kindId: "-10", scheduleResourceIds: [] },
    ]);
  });
});

describe("chunking and resumption", () => {
  it("a small detail batch continues the SAME window under a :d<offset> key, then moves on", async () => {
    const deps = memoryDeps();
    deps.office.allGroupEvents = true;
    const first = await runBackfillStep(cursor(), deps, { detailBatch: 1 });
    expect(first).toMatchObject({
      groupEvents: 2,
      detailsThisRun: 1,
      detailOffset: 0,
      onlineBookings: 0,
      next: "bmi-mirror-backfill:headpinzftmyers:2025-09-01:d1#77",
    });
    // The continuation carries the window's ids, so the dayPlanner is not asked again.
    const payload = deps.enqueued[0]!.payload!;
    expect(payload.projectIds).toEqual([FIXTURE_PROJECT_ID, FIXTURE_ONLINE_PROJECT_ID]);
    expect(payload.detailOffset).toBe(1);
    // The SAME cursor is handed back to the caller, so a client that cannot
    // wait for the cron can drive the chain itself.
    expect(first.nextPayload).toEqual(payload);

    const parsed = parseBackfillPayload(payload, "ignored");
    if (!parsed.ok) throw new Error(parsed.error);
    const second = await runBackfillStep(parsed.cursor, deps, { detailBatch: 1 });
    expect(deps.office.calls.filter((c) => c.op === "dayPlanner")).toHaveLength(1);
    expect(second).toMatchObject({
      detailsThisRun: 1,
      detailOffset: 1,
      next: "bmi-mirror-backfill:headpinzftmyers:2025-10-01#77",
    });
    expect(deps.store.rows.size).toBe(2);
  });

  it("the time budget stops between chunks and hands the rest to a continuation", async () => {
    // Every now() call advances 31 s, concurrency 1 → the check before the second chunk sees the budget (30 s) spent.
    const deps = memoryDeps(new Date("2026-09-12T23:30:00.000Z"), 31_000);
    deps.office.allGroupEvents = true;
    const r = await runBackfillStep(cursor(), deps, { concurrency: 1 });
    expect(r.detailsThisRun).toBe(1);
    expect(r.next).toBe("bmi-mirror-backfill:headpinzftmyers:2025-09-01:d1#77");
  });

  it("the last window of the span finishes the chain (next = null)", async () => {
    const deps = memoryDeps();
    const r = await runBackfillStep(
      cursor({ windowFrom: "2025-10-01", windowUntil: "2025-10-15" }),
      deps,
    );
    expect(r.next).toBeNull();
    expect(r.nextCreated).toBeNull();
    expect(r.nextPayload).toBeNull();
    expect(deps.enqueued).toHaveLength(0);
  });

  it("a caller can walk a whole span on nextPayload alone, ending with null", async () => {
    const deps = memoryDeps();
    let payload: Record<string, unknown> | null = {
      clientKey: "headpinzftmyers",
      from: "2025-09-01",
      until: "2025-10-15",
    };
    const windows: string[] = [];
    for (let i = 0; payload && i < 10; i++) {
      const parsed = parseBackfillPayload(payload, "chain-77");
      if (!parsed.ok) throw new Error(parsed.error);
      const run = await runBackfillStep(parsed.cursor, deps);
      windows.push(run.window.from);
      payload = run.nextPayload;
    }
    expect(payload).toBeNull();
    expect(windows).toEqual(["2025-09-01", "2025-10-01"]);
  });

  it("cursorToPayload round-trips through parseBackfillPayload", () => {
    const c = cursor({
      detailOffset: 3,
      projectIds: ["1"],
      scheduleResources: { "1": ["305133"] },
    });
    const back = parseBackfillPayload(cursorToPayload(c), "x");
    expect(back).toEqual({ ok: true, cursor: c });
  });
});

describe("failures", () => {
  it("one failed detail is recorded, the run is NOT ok, and the chain still advances", async () => {
    const deps = memoryDeps();
    deps.office.allGroupEvents = true;
    deps.office.failProjects.add(FIXTURE_ONLINE_PROJECT_ID);
    const r = await runBackfillStep(cursor(), deps);
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual([
      { projectId: FIXTURE_ONLINE_PROJECT_ID, error: expect.stringContaining("404") },
    ]);
    expect(r.inserted).toBe(1);
    expect(r.next).toBe("bmi-mirror-backfill:headpinzftmyers:2025-10-01#77");
    expect(deps.store.runs[0]).toMatchObject({ ok: false, rowsSeen: 2, rowsUpserted: 1 });
    expect(deps.store.runs[0]?.error).toContain(FIXTURE_ONLINE_PROJECT_ID);
  });

  it("a metadata / dayPlanner failure closes the run as failed and THROWS so the runner retries the same job", async () => {
    const deps = memoryDeps();
    deps.office.failMetadata = new Error("Office auth failed: 401");
    await expect(runBackfillStep(cursor(), deps)).rejects.toThrow("Office auth failed: 401");
    expect(deps.store.runs[0]).toMatchObject({
      ok: false,
      error: "Office auth failed: 401",
      rowsSeen: 0,
    });
    expect(deps.enqueued).toHaveLength(0);
  });
});

describe("the registry handler", () => {
  it("parks a malformed payload and returns the step result for a good one", async () => {
    const deps = memoryDeps();
    const handler = makeBackfillHandler(deps);
    const job = { id: "9", createdBy: "eric@headpinz.com" } as never;
    const bad = await handler({
      job,
      payload: { clientKey: "headpinzftmyers" },
      actorEmail: "e",
      now: new Date(),
    });
    expect(bad).toEqual({ ok: false, error: expect.stringContaining("YYYY-MM-DD"), park: true });

    const good = await handler({
      job,
      payload: { clientKey: "headpinzftmyers", from: "2025-09-01", until: "2025-09-30" },
      actorEmail: "e",
      now: new Date(),
    });
    expect(good.ok).toBe(true);
    expect(good.ok && (good.result as { chain: string }).chain).toBe("9"); // the job id seeds the chain
  });
});
