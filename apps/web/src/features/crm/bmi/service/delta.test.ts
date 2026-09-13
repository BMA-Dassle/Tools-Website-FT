import { describe, expect, it } from "vitest";
import { FIXTURE_ONLINE_PROJECT_ID, FIXTURE_PROJECT_ID, memoryDeps } from "../test-support";
import {
  enqueueDeltaTicks,
  makeDeltaHandler,
  parseDeltaPayload,
  runDelta,
  type DeltaCursor,
} from "./delta";

/**
 * The delta: the overlap window, the watermark, the full detail read per
 * changed project, the live-row fallback, the continuation and the
 * self-scheduled next bucket.
 */

const NOW = new Date("2026-09-12T23:32:10.000Z");

function cursor(over: Partial<DeltaCursor> = {}): DeltaCursor {
  return {
    clientKey: "headpinzftmyers",
    fromIso: null,
    untilIso: null,
    projectIds: null,
    offset: 0,
    chain: true,
    ...over,
  };
}

describe("window and watermark", () => {
  it("first run: 24 h look-back, Office asked in ET wall clock, every state id, under the crm-delta tag", async () => {
    const deps = memoryDeps(NOW);
    const r = await runDelta(cursor(), deps);
    expect(r.watermark).toBeNull();
    expect(r.window.from).toBe("2026-09-11T23:32:10.000Z");
    expect(r.window.fromLocal).toBe("2026-09-11T19:32:10");
    expect(r.window.untilLocal).toBe("2026-09-12T19:32:10");
    const live = deps.office.calls.find((c) => c.op === "liveReservations")!;
    expect(live.args[1]).toBe("2026-09-11T19:32:10");
    expect(live.args[3]).toEqual(expect.arrayContaining(["-3", "-4", "49130082"]));
    expect((live.args[3] as string[]).some((id) => id === "-1" || id === "-100")).toBe(false);
    expect(deps.office.calls.filter((c) => c.op === "project").map((c) => c.args[2])).toEqual([
      "crm-delta",
      "crm-delta",
    ]);
  });

  it("later runs start ten minutes before the last OK run's until", async () => {
    const deps = memoryDeps(NOW);
    deps.store.seedRun({
      clientKey: "headpinzftmyers",
      kind: "delta",
      windowUntil: "2026-09-12T23:20:00.000Z",
    });
    deps.store.seedRun({
      clientKey: "headpinzftmyers",
      kind: "delta",
      windowUntil: "2026-09-12T23:25:00.000Z",
      ok: false,
    });
    deps.store.seedRun({
      clientKey: "headpinznaples",
      kind: "delta",
      windowUntil: "2026-09-12T23:31:00.000Z",
    });
    const r = await runDelta(cursor(), deps);
    expect(r.watermark).toBe("2026-09-12T23:20:00.000Z"); // the failed and the other tenant's runs do not count
    expect(r.window.from).toBe("2026-09-12T23:10:00.000Z");
  });
});

describe("what a complete run does", () => {
  it("mirrors every changed project with source 'delta', records an ok run, and schedules the next bucket", async () => {
    const deps = memoryDeps(NOW);
    const r = await runDelta(cursor(), deps);
    expect(r).toMatchObject({
      ok: true,
      changed: 2,
      mirroredThisRun: 2,
      inserted: 2,
      partial: 0,
      failed: [],
      complete: true,
      next: "bmi-mirror-delta:headpinzftmyers:2026-09-12T23:35:00.000Z",
      nextCreated: true,
    });
    expect(deps.store.rows.get(FIXTURE_PROJECT_ID)!.row.source).toBe("delta");
    expect(deps.store.runs[0]).toMatchObject({
      kind: "delta",
      ok: true,
      rowsSeen: 2,
      rowsUpserted: 2,
    });
    expect(deps.enqueued[0]).toMatchObject({
      kind: "bmi-mirror-delta",
      idempotencyKey: "bmi-mirror-delta:headpinzftmyers:2026-09-12T23:35:00.000Z",
      payload: { clientKey: "headpinzftmyers", chain: true },
    });
    expect(deps.enqueued[0]?.runAt?.toISOString()).toBe("2026-09-12T23:35:00.000Z");
  });

  it("a changed project the mirror knows as an ONLINE booking is refreshed from the live row — no detail read", async () => {
    const deps = memoryDeps(NOW);
    // Seed the online booking as the backfill would have left it (a kind -10 stub).
    await deps.store.upsert(
      {
        projectId: FIXTURE_ONLINE_PROJECT_ID,
        clientKey: "headpinzftmyers",
        locationId: 467486,
        number: "W59922",
        name: null,
        stateId: "-3",
        stateName: "Confirmation",
        kindId: "-10",
        responsibleUserId: null,
        responsibleName: null,
        eventDate: "2025-09-21",
        eventStart: null,
        persons: 4,
        totalValueCents: null,
        balanceCents: null,
        personId: "63000000009561440",
        personName: "Ana Rodriguez",
        personPhone: null,
        personEmail: null,
        products: null,
        raw: null,
        source: "backfill",
        bmiCreatedAt: null,
        bmiUpdatedAt: null,
      },
      { accountId: null, contactId: null },
    );
    const r = await runDelta(cursor(), deps);
    expect(r).toMatchObject({
      ok: true,
      changed: 2,
      online: 1,
      inserted: 1,
      updated: 1,
      partial: 0,
    });
    expect(deps.office.calls.filter((c) => c.op === "project").map((c) => c.args[1])).toEqual([
      FIXTURE_PROJECT_ID,
    ]);
    expect(deps.store.rows.get(FIXTURE_ONLINE_PROJECT_ID)!.row).toMatchObject({
      totalValueCents: 11_996,
      balanceCents: 0,
      source: "delta",
    });
  });

  it("chain:false runs once and schedules nothing", async () => {
    const deps = memoryDeps(NOW);
    const r = await runDelta(cursor({ chain: false }), deps);
    expect(r.next).toBeNull();
    expect(deps.enqueued).toHaveLength(0);
  });

  it("a failed detail keeps the live row (partial), still advances, and says so in the run's error", async () => {
    const deps = memoryDeps(NOW);
    deps.office.failProjects.add(FIXTURE_ONLINE_PROJECT_ID);
    const r = await runDelta(cursor(), deps);
    expect(r).toMatchObject({ ok: true, partial: 1, failed: [], complete: true });
    const row = deps.store.rows.get(FIXTURE_ONLINE_PROJECT_ID)!.row;
    expect(row).toMatchObject({
      number: "W59922",
      stateName: "Confirmation",
      stateId: null,
      source: "delta",
    });
    expect(deps.store.runs[0]?.ok).toBe(true);
    expect(deps.store.runs[0]?.error).toContain(FIXTURE_ONLINE_PROJECT_ID);
  });

  it("nothing changed → an ok run with zero rows and the next bucket", async () => {
    const deps = memoryDeps(NOW);
    deps.office.liveRows = () => [];
    const r = await runDelta(cursor(), deps);
    expect(r).toMatchObject({ ok: true, changed: 0, mirroredThisRun: 0, complete: true });
    expect(deps.store.runs[0]).toMatchObject({ ok: true, rowsSeen: 0, rowsUpserted: 0 });
  });
});

describe("continuation", () => {
  it("over budget → the rest rides a continuation with the SAME explicit window; the run is not ok until it completes", async () => {
    const deps = memoryDeps(NOW, 31_000);
    const r = await runDelta(cursor(), deps, { concurrency: 1 });
    expect(r).toMatchObject({ ok: false, complete: false, mirroredThisRun: 1, changed: 2 });
    expect(r.next).toMatch(/^bmi-mirror-delta:headpinzftmyers:.*:o1$/);
    const payload = deps.enqueued[0]!.payload!;
    expect(payload).toMatchObject({
      offset: 1,
      projectIds: [FIXTURE_PROJECT_ID, FIXTURE_ONLINE_PROJECT_ID],
    });
    expect(deps.store.lastOkRun("headpinzftmyers", "delta")).resolves.toBeNull();

    // The continuation finishes the list without asking liveReservations again and then schedules the tick.
    const parsed = parseDeltaPayload(payload);
    if (!parsed.ok) throw new Error(parsed.error);
    const deps2 = memoryDeps(NOW);
    deps2.store.runs = deps.store.runs;
    const r2 = await runDelta(parsed.cursors[0]!, deps2);
    expect(deps2.office.calls.filter((c) => c.op === "liveReservations")).toHaveLength(0);
    expect(r2).toMatchObject({ ok: true, complete: true, mirroredThisRun: 1, offset: 1 });
    expect(r2.window.from).toBe(r.window.from);
    expect(r2.next).toMatch(/^bmi-mirror-delta:headpinzftmyers:2026-09-12T23:35:00\.000Z$/);
  });
});

describe("payload and handler", () => {
  it("no clientKey → both tenants; an unknown one is refused; explicit windows validated", () => {
    const both = parseDeltaPayload({});
    expect(both.ok && both.cursors.map((c) => c.clientKey)).toEqual([
      "headpinzftmyers",
      "headpinznaples",
    ]);
    expect(parseDeltaPayload({ clientKey: "nope" })).toMatchObject({ ok: false });
    expect(parseDeltaPayload({ clientKey: "headpinznaples", fromIso: "yesterday" })).toMatchObject({
      ok: false,
    });
  });

  it("the handler runs each tenant and returns one result or a bundle", async () => {
    const deps = memoryDeps(NOW);
    const handler = makeDeltaHandler(deps);
    const job = { id: "3" } as never;
    const one = await handler({
      job,
      payload: { clientKey: "headpinznaples" },
      actorEmail: null,
      now: NOW,
    });
    expect(one.ok && (one.result as { clientKey: string }).clientKey).toBe("headpinznaples");
    const all = await handler({ job, payload: {}, actorEmail: null, now: NOW });
    expect(all.ok && (all.result as { runs: unknown[] }).runs).toHaveLength(2);
  });

  it("enqueueDeltaTicks seeds one idempotent tick per tenant", async () => {
    const deps = memoryDeps(NOW);
    const ticks = await enqueueDeltaTicks(NOW, deps);
    expect(ticks.map((t) => t.key)).toEqual([
      "bmi-mirror-delta:headpinzftmyers:2026-09-12T23:35:00.000Z",
      "bmi-mirror-delta:headpinznaples:2026-09-12T23:35:00.000Z",
    ]);
    const again = await enqueueDeltaTicks(NOW, deps);
    expect(again.every((t) => t.created === false)).toBe(true);
  });
});
