import { describe, expect, it, vi } from "vitest";
import type { LeadView } from "../../leads/contracts";
import { PROTO_NOW, makeLead } from "../../leads/test-support";
import type { ActionDeps } from "./actions";
import { addNote, etWeekday, logCall, nextMondayYmd, snoozeDueIso, snoozeLead } from "./actions";

/**
 * Note · Snooze · a logged call — the three things a rep does by hand on a
 * deal (crm-shared.js:256, 276-279).
 *
 * What these tests protect:
 *   • a NOTE reaches `crm_activities` and nothing else (R6 — the CRM never
 *     writes its own notes into BMI);
 *   • a SNOOZE lands on a real 9 AM ET, and "Monday" means the next Monday
 *     rather than the prototype's hard-coded "+2 days" (its frozen clock is a
 *     Saturday, so +2 only ever looked right);
 *   • a CALL goes through `transition()` to advance Assigned → Contacted, so
 *     the mapped BMI state is written by the ONE status writer, never here.
 */

interface Rec {
  activities: Record<string, unknown>[];
  updates: { id: string; patch: Record<string, unknown> }[];
  transitions: { toStatusId: string }[];
  touched: number;
}

function harness(options: { lead?: LeadView; callsToday?: number } = {}): {
  deps: ActionDeps;
  rec: Rec;
  lead: LeadView;
} {
  const lead = options.lead ?? makeLead({ id: "1042", status: "contacted", rep: "1" });
  const rec: Rec = { activities: [], updates: [], transitions: [], touched: 0 };
  let current = lead;
  const deps: ActionDeps = {
    recordActivity: vi.fn(async (a: Record<string, unknown>) => {
      rec.activities.push(a);
      return String(rec.activities.length);
    }) as unknown as ActionDeps["recordActivity"],
    getActivity: vi.fn(async (id: string) => ({
      id,
      leadId: lead.id,
      contactId: null,
      repId: null,
      actorEmail: null,
      kind: "note" as const,
      direction: null,
      occurredAt: PROTO_NOW.toISOString(),
      durationSeconds: null,
      outcome: null,
      subject: null,
      body: null,
      externalKind: null,
      externalRef: null,
      meta: null,
    })) as unknown as ActionDeps["getActivity"],
    getLead: vi.fn(async () => current) as unknown as ActionDeps["getLead"],
    updateLeadFields: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      rec.updates.push({ id, patch });
      return current;
    }) as unknown as ActionDeps["updateLeadFields"],
    noteOutboundTouch: vi.fn(async () => {
      rec.touched += 1;
      return { recorded: true, firstTouchAt: PROTO_NOW.toISOString() };
    }) as unknown as ActionDeps["noteOutboundTouch"],
    countTouchesToday: vi.fn(async () => ({
      call: options.callsToday ?? 0,
      sms: 0,
      email: 0,
      reachout: 0,
    })) as unknown as ActionDeps["countTouchesToday"],
    transition: vi.fn(async ({ toStatusId }: { toStatusId: string }) => {
      rec.transitions.push({ toStatusId });
      current = { ...current, status: toStatusId };
      return {
        lead: current,
        status: {
          id: toStatusId,
          label: toStatusId,
          kind: "open" as const,
          position: 3,
          slaLabel: null,
          slaHours: null,
          onBoard: true,
          archivedAt: null,
        },
        from: lead.status,
        bmi: { status: "unmapped" as const, stateId: null, stateName: null },
      };
    }) as unknown as ActionDeps["transition"],
    now: () => PROTO_NOW,
  };
  return { deps, rec, lead };
}

describe("addNote", () => {
  it("writes ONE `note` activity and touches nothing else — never BMI", async () => {
    const { deps, rec, lead } = harness();
    const out = await addNote(
      { lead, body: "Wants karting + pizza", actor: "kelsea@headpinz.com" },
      deps,
    );
    expect(rec.activities).toHaveLength(1);
    expect(rec.activities[0]).toMatchObject({
      kind: "note",
      body: "Wants karting + pizza",
      actorEmail: "kelsea@headpinz.com",
      leadId: "1042",
    });
    // No lead-row write, no status change, and not counted as a touch.
    expect(rec.updates).toEqual([]);
    expect(rec.transitions).toEqual([]);
    expect(out.countedAsTouch).toBe(false);
  });
});

describe("snooze arithmetic", () => {
  // The prototype's own clock: Saturday 2026-09-12, 19:30 ET.
  it("knows the ET weekday of a calendar day", () => {
    expect(etWeekday("2026-09-12")).toBe(6); // Saturday
    expect(etWeekday("2026-09-14")).toBe(1); // Monday
  });

  it("'Monday' is the NEXT Monday, not the prototype's hard-coded +2 days", () => {
    expect(nextMondayYmd("2026-09-12")).toBe("2026-09-14"); // Sat → Mon (+2, as it happens)
    expect(nextMondayYmd("2026-09-15")).toBe("2026-09-21"); // Tue → Mon (+6), where +2 was a Thursday
    expect(nextMondayYmd("2026-09-14")).toBe("2026-09-21"); // Mon → NEXT Mon, never today
  });

  it("every preset lands at 9 AM Eastern on its day", () => {
    const et = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    });
    for (const preset of ["tomorrow", "monday", "three-days", "next-week"] as const) {
      const iso = snoozeDueIso(preset, PROTO_NOW);
      expect(Number(et.format(new Date(iso)))).toBe(9);
      expect(new Date(iso).getTime()).toBeGreaterThan(PROTO_NOW.getTime());
    }
  });

  it("lands on the right ET calendar days from the prototype's Saturday", () => {
    const day = (iso: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(iso));
    expect(day(snoozeDueIso("tomorrow", PROTO_NOW))).toBe("2026-09-13");
    expect(day(snoozeDueIso("monday", PROTO_NOW))).toBe("2026-09-14");
    expect(day(snoozeDueIso("three-days", PROTO_NOW))).toBe("2026-09-15");
    expect(day(snoozeDueIso("next-week", PROTO_NOW))).toBe("2026-09-19");
  });

  it("still lands at 9 AM ET across the autumn DST change", () => {
    const beforeFallBack = new Date("2026-10-30T18:00:00.000Z"); // EDT
    const iso = snoozeDueIso("next-week", beforeFallBack); // lands after the change
    const et = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    });
    expect(Number(et.format(new Date(iso)))).toBe(9);
  });
});

describe("snoozeLead", () => {
  it("moves the due time, keeps the label, and leaves a line saying so", async () => {
    const lead = makeLead({
      id: "1042",
      status: "contacted",
      rep: "1",
      nextAction: { kind: "call", due: PROTO_NOW.toISOString(), label: "Follow up on the quote" },
    });
    const { deps, rec } = harness({ lead });
    const out = await snoozeLead(
      { lead, preset: "tomorrow", label: "Tomorrow 9 AM", actor: "kelsea@headpinz.com" },
      deps,
    );
    expect(rec.updates).toHaveLength(1);
    expect(rec.updates[0]!.patch).toMatchObject({
      nextActionKind: "call",
      nextActionLabel: "Follow up on the quote",
    });
    expect(String(rec.updates[0]!.patch.nextActionDue)).toBe(snoozeDueIso("tomorrow", PROTO_NOW));
    expect(rec.activities[0]).toMatchObject({ kind: "system" });
    expect(String(rec.activities[0]!.body)).toContain("Tomorrow 9 AM");
    expect(out.countedAsTouch).toBe(false);
  });

  it("gives a lead with no next action one, rather than silently doing nothing", async () => {
    const { deps, rec, lead } = harness();
    await snoozeLead({ lead, preset: "monday", label: "Monday 9 AM", actor: "a@b.c" }, deps);
    expect(rec.updates[0]!.patch).toMatchObject({
      nextActionKind: "call",
      nextActionLabel: "Follow up",
    });
  });
});

describe("logCall", () => {
  it("records an outbound call, credits the first touch, and counts it once a day", async () => {
    const { deps, rec, lead } = harness();
    const out = await logCall({ lead, outcome: "Voicemail", actor: "kelsea@headpinz.com" }, deps);
    expect(rec.activities[0]).toMatchObject({
      kind: "call",
      direction: "out",
      outcome: "Voicemail",
      repId: "1",
    });
    // Manual, and it says so — C3's reconcile must never mistake it for a 3CX row.
    expect(rec.activities[0]!.externalKind ?? null).toBeNull();
    expect(rec.activities[0]!.meta).toMatchObject({ source: "manual" });
    expect(rec.touched).toBe(1);
    expect(out.countedAsTouch).toBe(true);
  });

  it("a SECOND call the same ET day is still logged, but no longer scores", async () => {
    const { deps, rec, lead } = harness({ callsToday: 1 });
    const out = await logCall({ lead, outcome: "No answer", actor: "a@b.c" }, deps);
    expect(rec.activities).toHaveLength(1);
    expect(out.countedAsTouch).toBe(false);
  });

  it("'Reached' clears the next action — the rep decides what happens next", async () => {
    const { deps, rec, lead } = harness();
    await logCall({ lead, outcome: "Reached", actor: "a@b.c" }, deps);
    expect(rec.updates[0]!.patch).toEqual({
      nextActionKind: null,
      nextActionDue: null,
      nextActionLabel: null,
    });
  });

  it("an ASSIGNED lead advances to Contacted THROUGH the status writer, never by hand", async () => {
    const { deps, rec, lead } = harness({
      lead: makeLead({ id: "1042", status: "assigned", rep: "1" }),
    });
    await logCall({ lead, outcome: "Reached", actor: "a@b.c" }, deps);
    expect(rec.transitions).toEqual([{ toStatusId: "contacted" }]);
    // The status is NOT patched directly: `transition()` owns `status_id` and
    // the BMI state that goes with it (R5).
    expect(rec.updates.some((u) => "statusId" in u.patch)).toBe(false);
  });

  it("does not re-advance a lead that is already past Contacted", async () => {
    const { deps, rec, lead } = harness({
      lead: makeLead({ id: "1042", status: "quote", rep: "1" }),
    });
    await logCall({ lead, outcome: "Voicemail", actor: "a@b.c" }, deps);
    expect(rec.transitions).toEqual([]);
  });
});
