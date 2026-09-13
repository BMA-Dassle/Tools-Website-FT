import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROTO_NOW, makeLead, minsAgo } from "../test-support";

/**
 * Response time: the pure badge (prototype `responseBadge`, crm-shared.js:199)
 * and the `first_touch_at` hook — set once, by the assignee's OUTBOUND touch
 * only, in a single guarded UPDATE.
 */

const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);
vi.mock("@ft/db", () => ({
  sql: () => db.q,
  isDbConfigured: () => true,
  parseWithRawIds: (t: string) => JSON.parse(t),
  BMI_ID_FIELDS: ["id"],
}));

const { firstTouchMinutes, isOutboundTouch, noteOutboundTouch, recordFirstTouch, responseBadge } =
  await import("./response-time");

beforeEach(() => db.reset());

describe("pure", () => {
  it("firstTouchMinutes rounds whole minutes and is null without both instants", () => {
    expect(firstTouchMinutes(minsAgo(70), minsAgo(46))).toBe(24);
    expect(firstTouchMinutes(null, minsAgo(46))).toBeNull();
    expect(firstTouchMinutes(minsAgo(70), null)).toBeNull();
    expect(firstTouchMinutes("nope", minsAgo(1))).toBeNull();
  });

  it("responseBadge: waiting → tone by the prototype's 30 / 60 minute thresholds", () => {
    expect(responseBadge({ assignedAt: null, firstTouchAt: null }, PROTO_NOW)).toEqual({
      kind: "none",
    });
    expect(responseBadge({ assignedAt: minsAgo(10), firstTouchAt: null }, PROTO_NOW)).toEqual({
      kind: "waiting",
      minutes: 10,
      tone: "",
    });
    expect(responseBadge({ assignedAt: minsAgo(45), firstTouchAt: null }, PROTO_NOW)).toEqual({
      kind: "waiting",
      minutes: 45,
      tone: "warn",
    });
    // L-1055: assigned 70 min ago, untouched → crit
    expect(responseBadge({ assignedAt: minsAgo(70), firstTouchAt: null }, PROTO_NOW)).toEqual({
      kind: "waiting",
      minutes: 70,
      tone: "crit",
    });
  });

  it("responseBadge: touched → the elapsed minutes, warn past 60", () => {
    expect(
      responseBadge({ assignedAt: minsAgo(70), firstTouchAt: minsAgo(46) }, PROTO_NOW),
    ).toEqual({
      kind: "touched",
      minutes: 24,
      tone: "",
    });
    expect(
      responseBadge({ assignedAt: minsAgo(200), firstTouchAt: minsAgo(100) }, PROTO_NOW),
    ).toEqual({
      kind: "touched",
      minutes: 100,
      tone: "warn",
    });
  });

  it("isOutboundTouch: call / sms / email going OUT; never a note, never inbound", () => {
    expect(isOutboundTouch({ kind: "call", direction: "out" })).toBe(true);
    expect(isOutboundTouch({ kind: "sms", direction: "out" })).toBe(true);
    expect(isOutboundTouch({ kind: "email", direction: "out" })).toBe(true);
    expect(isOutboundTouch({ kind: "sms", direction: "in" })).toBe(false);
    expect(isOutboundTouch({ kind: "note", direction: "out" })).toBe(false);
    expect(isOutboundTouch({ kind: "call", direction: null })).toBe(false);
  });
});

describe("recordFirstTouch", () => {
  it("the first touch wins: one guarded UPDATE, recorded:true", async () => {
    db.respond = (s) =>
      /UPDATE crm_leads/.test(s.text) ? [{ first_touch_at: "2026-09-12T23:30:00.000Z" }] : [];
    const r = await recordFirstTouch({
      leadId: "1055",
      repId: "1",
      at: new Date("2026-09-12T23:30:00Z"),
    });
    expect(r).toEqual({ recorded: true, firstTouchAt: "2026-09-12T23:30:00.000Z" });
    const upd = db.matching(/UPDATE crm_leads/)[0]!;
    expect(upd.text).toContain("first_touch_at IS NULL");
    expect(upd.text).toContain("assigned_rep_id = $3::bigint");
    expect(upd.params).toEqual(["2026-09-12T23:30:00.000Z", "1055", "1"]);
  });

  it("a later touch (or another rep's) is a no-op that reports the stored value", async () => {
    db.respond = (s) =>
      /UPDATE crm_leads/.test(s.text) ? [] : [{ first_touch_at: "2026-09-12T23:00:00.000Z" }];
    const r = await recordFirstTouch({ leadId: "1055", repId: "2" });
    expect(r).toEqual({ recorded: false, firstTouchAt: "2026-09-12T23:00:00.000Z" });
  });
});

describe("noteOutboundTouch (the hook C1/C2/C3 call)", () => {
  const lead = makeLead({ id: "1055", rep: "1", assignedAt: minsAgo(70) });
  const record = vi.fn(async () => ({ recorded: true, firstTouchAt: "x" }));

  beforeEach(() => record.mockClear());

  it("records for the assignee's outbound call", async () => {
    const r = await noteOutboundTouch({ kind: "call", direction: "out", repId: "1" }, lead, {
      record,
    });
    expect(r.recorded).toBe(true);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ leadId: "1055", repId: "1" }));
  });

  it("ignores inbound texts, notes and touches by someone who is not the assignee", async () => {
    expect(
      (await noteOutboundTouch({ kind: "sms", direction: "in", repId: "1" }, lead, { record }))
        .recorded,
    ).toBe(false);
    expect(
      (await noteOutboundTouch({ kind: "note", direction: null, repId: "1" }, lead, { record }))
        .recorded,
    ).toBe(false);
    expect(
      (await noteOutboundTouch({ kind: "email", direction: "out", repId: "2" }, lead, { record }))
        .recorded,
    ).toBe(false);
    expect(
      (
        await noteOutboundTouch(
          { kind: "email", direction: "out", repId: "1" },
          { ...lead, rep: null },
          { record },
        )
      ).recorded,
    ).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });
});
