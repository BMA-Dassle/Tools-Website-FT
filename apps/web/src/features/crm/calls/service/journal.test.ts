import { describe, expect, it, vi } from "vitest";
import { fixtureText } from "../../../../../test/msw/handlers/fixture";
import type { CrmRep } from "../../core/types";
import type { CallRow } from "../contracts";
import type { CallUpsert } from "../data/calls-db";
import {
  foldLegs,
  groupCallLog,
  legDirection,
  legParties,
  parseIsoDuration,
  persistCall,
  reconcileCalls,
  reconcileIdempotencyKey,
  recordJournalCall,
  type NormalizedCall,
  type PersistDeps,
  type ReconcileDeps,
} from "./journal";
import type { CallLogRow } from "./threecx";

/**
 * The fold, against the REAL capture. `threecx-calllog.json.txt` is five rows
 * taken off the live PBX on 2026-09-13 with the guests' numbers swapped for the
 * test numbers, and it carries the case that made this hard: three rows share
 * ONE `CallHistoryId` (an IVR leg, a queue leg with `Status: "Waiting"`, and
 * the extension leg somebody answered).
 */

const LOG: CallLogRow[] = (
  JSON.parse(fixtureText("threecx-calllog.json.txt")) as { value: CallLogRow[] }
).value;

const ANSWERED = "00000000-01dd-43ab-25e4-c24300000ic5";
const MISSED = "00000000-01dd-43a1-4edb-b26800000ib1";
const OUTBOUND = "00000000-01dd-43a9-4b44-627e000002c2";
const INTERNAL = "00000000-01dd-43a9-4b44-627e000002c9";

function rep(partial: Partial<CrmRep>): CrmRep {
  return {
    id: "1",
    slug: "stephanie",
    displayName: "Stephanie Wegman",
    firstName: "Stephanie",
    initials: "SW",
    role: "rep",
    email: null,
    ssoSub: null,
    bmiUserId: null,
    bmiUsername: null,
    sevenShiftsUserId: null,
    voxDid: null,
    threecxExtension: null,
    teamsChatId: null,
    phoneE164: null,
    centres: [],
    active: true,
    sortOrder: 1,
    ...partial,
  };
}

describe("parseIsoDuration", () => {
  it("reads the shapes the PBX actually sends", () => {
    expect(parseIsoDuration("PT0S")).toBe(0);
    expect(parseIsoDuration("PT1M12.577027S")).toBe(73);
    expect(parseIsoDuration("PT17.754745S")).toBe(18);
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
  });

  it("is 0, never NaN, for anything else", () => {
    expect(parseIsoDuration(null)).toBe(0);
    expect(parseIsoDuration("")).toBe(0);
    expect(parseIsoDuration("12 seconds")).toBe(0);
    expect(Number.isNaN(parseIsoDuration("nonsense"))).toBe(false);
  });
});

describe("legParties", () => {
  it("puts the guest on the SOURCE side of an inbound leg and the DN on the destination", () => {
    const leg = LOG.find((r) => r.CdrId === "00000000-01dd-43ab-4b50-9fb600000b4e");
    expect(leg).toBeDefined();
    const p = legParties(leg as CallLogRow);
    expect(p.external).toBe("+12395551234");
    expect(p.extension).toBe("9027");
    expect(legDirection(leg as CallLogRow)).toBe("in");
  });

  it("reverses both for an outbound leg", () => {
    const leg = LOG.find((r) => r.CallHistoryId === OUTBOUND);
    const p = legParties(leg as CallLogRow);
    expect(p.external).toBe("+12395552277");
    expect(p.extension).toBe("9025");
    expect(legDirection(leg as CallLogRow)).toBe("out");
  });

  it("finds no guest on an internal leg", () => {
    const leg = LOG.find((r) => r.CallHistoryId === INTERNAL);
    expect(legParties(leg as CallLogRow).external).toBeNull();
  });
});

describe("foldLegs", () => {
  const legsOf = (id: string) => LOG.filter((r) => r.CallHistoryId === id);

  it("collapses an IVR + queue + extension call into ONE answered call on the extension", () => {
    const call = foldLegs(ANSWERED, legsOf(ANSWERED));
    expect(call).not.toBeNull();
    expect(call?.legs).toBe(2);
    expect(call?.status).toBe("Answered");
    expect(call?.extension).toBe("9027");
    expect(call?.external).toBe("+12395551234");
    expect(call?.durationSeconds).toBe(73);
    // The call began when the QUEUE leg started, not when a human answered.
    expect(call?.startedAt?.toISOString()).toBe("2026-09-13T18:10:36.104Z");
  });

  it("does NOT call a queue's `Answered: true, Status: Waiting` leg 'reached'", () => {
    const queueOnly = legsOf(ANSWERED).filter((r) => r.Direction === "Inbound Queue");
    expect(queueOnly[0]?.Answered).toBe(true);
    expect(foldLegs(ANSWERED, queueOnly)?.status).toBe("Unanswered");
  });

  it("keeps a missed call missed", () => {
    const call = foldLegs(MISSED, legsOf(MISSED));
    expect(call?.status).toBe("Unanswered");
    expect(call?.external).toBe("+12395550199");
    expect(call?.durationSeconds).toBe(0);
  });

  it("carries the recording path when there is one", () => {
    expect(foldLegs(ANSWERED, legsOf(ANSWERED))?.recordingUrl).toContain(".wav");
    expect(foldLegs(MISSED, legsOf(MISSED))?.recordingUrl).toBeNull();
  });

  it("is null for no legs at all", () => {
    expect(foldLegs("x", [])).toBeNull();
  });
});

describe("groupCallLog", () => {
  const calls = groupCallLog(LOG);

  it("gives one entry per CallHistoryId and drops internal chatter", () => {
    expect(calls.map((c) => c.threecxCallId).sort()).toEqual([ANSWERED, MISSED, OUTBOUND].sort());
    expect(calls.some((c) => c.threecxCallId === INTERNAL)).toBe(false);
  });

  it("is newest first", () => {
    const times = calls.map((c) => c.startedAt?.getTime() ?? 0);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("is idempotent — the same rows twice still give three calls", () => {
    expect(groupCallLog([...LOG, ...LOG]).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Persisting
// ---------------------------------------------------------------------------

function stubDeps(overrides: Partial<PersistDeps> = {}): PersistDeps & { saved: CallUpsert[] } {
  const saved: CallUpsert[] = [];
  return {
    saved,
    reps: async () => [rep({ id: "42", threecxExtension: "9027" })],
    match: async () => ({ contactId: "5", leadId: "9", repId: "8", matchedBy: "phone" as const }),
    save: async (row: CallUpsert) => {
      saved.push(row);
      return { id: String(saved.length) } as unknown as CallRow;
    },
    ...overrides,
  };
}

describe("persistCall", () => {
  it("puts an inbound guest in from_e164 and an outbound one in to_e164", async () => {
    const deps = stubDeps();
    const calls = groupCallLog(LOG);
    for (const c of calls) await persistCall(c, "reconcile", deps);
    const inbound = deps.saved.find((r) => r.threecxCallId === ANSWERED);
    const outbound = deps.saved.find((r) => r.threecxCallId === OUTBOUND);
    expect(inbound?.fromE164).toBe("+12395551234");
    expect(inbound?.toE164).toBeNull();
    expect(outbound?.toE164).toBe("+12395552277");
    expect(outbound?.fromE164).toBeNull();
  });

  it("attributes the call to the rep on that extension, ahead of the lead's assignee", async () => {
    const deps = stubDeps();
    await persistCall(
      groupCallLog(LOG).find((c) => c.threecxCallId === ANSWERED) as NormalizedCall,
      "reconcile",
      deps,
    );
    expect(deps.saved[0]?.repId).toBe("42");
  });

  it("falls back to the lead's assignee when no rep owns that extension", async () => {
    const deps = stubDeps({ reps: async () => [rep({ id: "42", threecxExtension: null })] });
    await persistCall(
      groupCallLog(LOG).find((c) => c.threecxCallId === ANSWERED) as NormalizedCall,
      "reconcile",
      deps,
    );
    expect(deps.saved[0]?.repId).toBe("8");
  });

  it("leaves a stranger's call unlinked, for the tray", async () => {
    const deps = stubDeps({
      match: async () => ({
        contactId: null,
        leadId: null,
        repId: null,
        matchedBy: "none" as const,
      }),
    });
    await persistCall(
      groupCallLog(LOG).find((c) => c.threecxCallId === MISSED) as NormalizedCall,
      "reconcile",
      deps,
    );
    expect(deps.saved[0]?.leadId).toBeNull();
    expect(deps.saved[0]?.contactId).toBeNull();
  });
});

describe("recordJournalCall", () => {
  it("writes the PBX's own end-of-call POST under the same dedupe key", async () => {
    const deps = stubDeps();
    await recordJournalCall(
      {
        callId: ANSWERED,
        direction: "in",
        number: "(239) 555-1234",
        extension: "9027",
        startedAt: "2026-09-13T18:10:36.104Z",
        duration: 73,
        status: "Answered",
      },
      deps,
    );
    expect(deps.saved[0]?.threecxCallId).toBe(ANSWERED);
    expect(deps.saved[0]?.fromE164).toBe("+12395551234");
    expect(deps.saved[0]?.status).toBe("Answered");
    expect(deps.saved[0]?.source).toBe("journal");
  });

  it("treats anything that is not 'Answered…' as unanswered", async () => {
    const deps = stubDeps();
    await recordJournalCall(
      { callId: "z", direction: "in", number: "2395550199", status: "Unanswered" },
      deps,
    );
    expect(deps.saved[0]?.status).toBe("Unanswered");
  });

  it("survives a template that sends no timestamps at all", async () => {
    const deps = stubDeps();
    await recordJournalCall({ callId: "z2", direction: "out", number: "2395552277" }, deps);
    expect(deps.saved[0]?.startedAt).toBeInstanceOf(Date);
    expect(deps.saved[0]?.durationSeconds).toBe(0);
  });
});

describe("reconcileCalls", () => {
  function reconcileDeps(overrides: Partial<ReconcileDeps> = {}) {
    const base = stubDeps();
    const deps = {
      ...base,
      fetch: vi.fn(async () => LOG),
      since: async () => null,
      ...overrides,
    } as unknown as ReconcileDeps & { fetch: ReturnType<typeof vi.fn> };
    return { deps, saved: base.saved };
  }

  it("writes one row per external call and reports the counts", async () => {
    const { deps, saved } = reconcileDeps();
    const result = await reconcileCalls({ now: new Date("2026-09-13T19:00:00Z") }, deps);
    expect(result.rowsSeen).toBe(5);
    expect(result.callsSeen).toBe(3);
    expect(result.callsWritten).toBe(3);
    expect(result.legsSkipped).toBe(1); // the internal desk-to-desk call
    expect(saved).toHaveLength(3);
  });

  it("cold-starts 24 h back when nothing is stored", async () => {
    const { deps } = reconcileDeps();
    await reconcileCalls({ now: new Date("2026-09-13T19:00:00Z") }, deps);
    const arg = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as { from: Date };
    expect(arg.from.toISOString()).toBe("2026-09-12T19:00:00.000Z");
  });

  it("resumes from the newest stored call, minus an overlap for late legs", async () => {
    const { deps } = reconcileDeps({ since: async () => new Date("2026-09-13T18:00:00Z") });
    await reconcileCalls({ now: new Date("2026-09-13T19:00:00Z") }, deps);
    const arg = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as { from: Date };
    expect(arg.from.toISOString()).toBe("2026-09-13T17:45:00.000Z");
  });

  it("running it twice writes the same three call ids — the dedupe key is the CallHistoryId", async () => {
    const { deps, saved } = reconcileDeps();
    await reconcileCalls({ now: new Date("2026-09-13T19:00:00Z") }, deps);
    await reconcileCalls({ now: new Date("2026-09-13T19:00:00Z") }, deps);
    expect(saved).toHaveLength(6);
    expect(new Set(saved.map((r) => r.threecxCallId)).size).toBe(3);
  });
});

describe("reconcileIdempotencyKey", () => {
  it("is one key per five-minute bucket, so a 2-minute cron cannot stack runs", () => {
    const a = reconcileIdempotencyKey(new Date("2026-09-13T18:11:00Z"));
    const b = reconcileIdempotencyKey(new Date("2026-09-13T18:14:59Z"));
    const c = reconcileIdempotencyKey(new Date("2026-09-13T18:15:01Z"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("threecx-reconcile:")).toBe(true);
  });
});
