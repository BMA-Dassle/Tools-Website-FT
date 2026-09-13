import { describe, expect, it, vi } from "vitest";
import type { CrmUser } from "../../core/types";
import type { LeadView } from "../../leads/contracts";
import type { CallRow } from "../contracts";
import {
  applyDisposition,
  leadPatchFor,
  STATUS_AFTER_CONTACT,
  type DispositionDeps,
} from "./dispositions";

/**
 * `act("dispo")` (crm-shared.js:259), made real: the outcome is stored, an
 * activity is written, an OUTBOUND call by the assignee sets `first_touch_at`,
 * an `assigned` lead becomes `contacted`, and "Reached" clears the follow-up.
 */

const USER: CrmUser = {
  email: "kelsea@headpinz.com",
  name: "Kelsea Kosco",
  sub: null,
  roles: ["access", "sales"],
  role: "rep",
  rep: null,
};

function call(partial: Partial<CallRow> = {}): CallRow {
  return {
    id: "101",
    threecxCallId: "guid-1",
    direction: "out",
    fromE164: null,
    toE164: "+12395551234",
    extension: "9025",
    repId: "7",
    repSlug: "kelsea",
    repInitials: "KK",
    repName: "Kelsea Kosco",
    leadId: "9",
    leadPublicId: "L-9",
    contactId: "5",
    contactLabel: "Lee Health",
    guestName: null,
    startedAt: "2026-09-13T18:00:00.000Z",
    answeredAt: "2026-09-13T18:00:00.000Z",
    endedAt: null,
    durationSeconds: 73,
    status: "Answered",
    callType: "Extension",
    disposition: null,
    dispositionNote: null,
    disposedAt: null,
    disposedBy: null,
    recordingUrl: null,
    source: "click",
    actorEmail: "kelsea@headpinz.com",
    createdAt: "2026-09-13T18:00:00.000Z",
    ...partial,
  };
}

function lead(partial: Partial<LeadView> = {}): LeadView {
  return {
    id: "9",
    publicId: "L-9",
    status: "assigned",
    rep: "7",
    nextAction: { kind: "call", due: "2026-09-13T19:00:00.000Z", label: "First touch" },
    ...partial,
  } as LeadView;
}

/**
 * `stored` is the ONE call both `read` and `write` answer with, so a test that
 * changes the call (an inbound one, one that belongs to nobody) changes what
 * the service sees on BOTH reads — the service works from `write`'s return
 * value, and a `write` that ignored the override made three tests pass that
 * should not have.
 */
function deps(stored: CallRow = call(), overrides: Partial<DispositionDeps> = {}) {
  const written: Record<string, unknown>[] = [];
  const activities: Record<string, unknown>[] = [];
  const touches: { leadId: string; repId: string }[] = [];
  const patches: Record<string, unknown>[] = [];
  const d = {
    written,
    activities,
    touches,
    patches,
    read: vi.fn(async () => stored),
    write: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      written.push(patch);
      return { ...stored, disposition: patch.disposition as CallRow["disposition"] };
    }),
    lead: vi.fn(async () => lead()),
    patchLead: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      patches.push(patch);
      return lead({ status: (patch.statusId as string) ?? "assigned" });
    }),
    firstTouch: vi.fn(async (input: { leadId: string; repId: string }) => {
      touches.push(input);
      return { recorded: true, firstTouchAt: "2026-09-13T18:00:00.000Z" };
    }),
    activity: vi.fn(async (a: Record<string, unknown>) => {
      activities.push(a);
      return "1";
    }),
    ...overrides,
  };
  return d as unknown as DispositionDeps & typeof d;
}

describe("leadPatchFor", () => {
  it("moves an assigned lead to contacted, whatever the outcome was", () => {
    expect(leadPatchFor("Voicemail", { status: "assigned", nextAction: null })).toEqual({
      statusId: STATUS_AFTER_CONTACT,
    });
  });

  it("clears the follow-up ONLY when the rep actually reached them", () => {
    const reached = leadPatchFor("Reached", { status: "contacted", nextAction: { due: "x" } });
    expect(reached).toEqual({ nextActionKind: null, nextActionDue: null, nextActionLabel: null });
    expect(leadPatchFor("No answer", { status: "contacted", nextAction: { due: "x" } })).toEqual(
      {},
    );
  });

  it("never drags a lead BACKWARDS from a later status", () => {
    expect(leadPatchFor("Voicemail", { status: "quote", nextAction: null })).toEqual({});
    expect(leadPatchFor("Voicemail", { status: "confirmed", nextAction: null })).toEqual({});
  });
});

describe("applyDisposition", () => {
  it("stores the outcome, writes the activity and records the first touch", async () => {
    const d = deps();
    const res = await applyDisposition(
      { callId: "101", disposition: "Reached", note: " good chat ", user: USER },
      d,
    );
    expect(d.written[0]).toMatchObject({
      disposition: "Reached",
      note: "good chat",
      actorEmail: "kelsea@headpinz.com",
    });
    expect(d.activities[0]).toMatchObject({ kind: "call", outcome: "Reached", leadId: "9" });
    expect(d.touches).toEqual([
      { leadId: "9", repId: "7", at: new Date("2026-09-13T18:00:00.000Z") },
    ]);
    expect(res.firstTouchRecorded).toBe(true);
    expect(res.leadStatus).toBe(STATUS_AFTER_CONTACT);
  });

  it("does NOT count an inbound call as the rep's response time", async () => {
    const d = deps(call({ direction: "in" }));
    const res = await applyDisposition({ callId: "101", disposition: "Reached", user: USER }, d);
    expect(d.touches).toHaveLength(0);
    expect(res.firstTouchRecorded).toBe(false);
  });

  it("does NOT count a call made by somebody other than the assignee", async () => {
    const d = deps(call({ repId: "99" }));
    await applyDisposition({ callId: "101", disposition: "Reached", user: USER }, d);
    expect(d.touches).toHaveLength(0);
  });

  it("still records the outcome for a call that belongs to no lead", async () => {
    const d = deps(call({ leadId: null, leadPublicId: null }));
    const res = await applyDisposition(
      { callId: "101", disposition: "Wrong number", user: USER },
      d,
    );
    expect(d.written).toHaveLength(1);
    expect(res.leadStatus).toBeNull();
    expect(d.patchLead).not.toHaveBeenCalled();
  });

  it("404s on a call that is not there", async () => {
    const d = deps(call(), { read: vi.fn(async () => null) });
    await expect(
      applyDisposition({ callId: "404", disposition: "Reached", user: USER }, d),
    ).rejects.toThrow("call_not_found");
  });

  it("turns an empty note into null rather than an empty string", async () => {
    const d = deps();
    await applyDisposition({ callId: "101", disposition: "Voicemail", note: "   ", user: USER }, d);
    expect(d.written[0]?.note).toBeNull();
  });
});
