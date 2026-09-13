import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `recordActivity` at the SQL boundary: the unique (external_kind,
 * external_ref) guard is in the statement, a duplicate returns null, and a
 * failing write never throws. `listLeadTimeline` is keyset, never OFFSET.
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

const { recordActivity } = await import("./record");
const { decodeTimelineCursor, listLeadTimeline, mapActivityRow } = await import("./lead-timeline");

beforeEach(() => {
  db.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("recordActivity", () => {
  it("inserts with ON CONFLICT on the external key and returns the id", async () => {
    db.respond = (s) => (/INSERT INTO crm_activities/.test(s.text) ? [{ id: "42" }] : []);
    const id = await recordActivity({
      leadId: "1061",
      kind: "bmi",
      body: "x",
      externalKind: "pandora-party-lead",
      externalRef: "63000000009561437",
      actorEmail: "web",
    });
    expect(id).toBe("42");
    const ins = db.matching(/INSERT INTO crm_activities/)[0]!;
    expect(ins.text).toContain(
      "ON CONFLICT (external_kind, external_ref) WHERE external_ref IS NOT NULL DO NOTHING",
    );
    expect(ins.params[0]).toBe("1061");
    expect(ins.params[4]).toBe("bmi");
    expect(ins.params[12]).toBe("63000000009561437");
  });
  it("a duplicate external ref returns null; a failing write returns null and logs", async () => {
    db.respond = () => [];
    expect(
      await recordActivity({ leadId: "1", kind: "system", externalKind: "x", externalRef: "y" }),
    ).toBeNull();
    db.respond = () => {
      throw new Error("neon down");
    };
    expect(await recordActivity({ leadId: "1", kind: "system", body: "b" })).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("listLeadTimeline", () => {
  it("newest first, keyset on (occurred_at, id), limit ≤ 200, no OFFSET", async () => {
    db.respond = () => [];
    await listLeadTimeline("1061", { limit: 999, cursor: "2026-09-12T23:00:00.000Z|5" });
    const s = db.matching(/FROM crm_activities/)[0]!;
    expect(s.text).not.toMatch(/OFFSET/i);
    expect(s.text).toContain("(occurred_at, id) < ($3::timestamptz, $4::bigint)");
    expect(s.text).toContain("ORDER BY occurred_at DESC, id DESC");
    expect(s.params).toEqual(["1061", 201, "2026-09-12T23:00:00.000Z", "5"]);
    expect(decodeTimelineCursor("garbage")).toBeNull();
  });
  it("maps a row with string ids and a parsed meta", () => {
    const a = mapActivityRow({
      id: "1",
      lead_id: "1061",
      contact_id: null,
      rep_id: "1",
      actor_email: "x",
      kind: "assign",
      direction: null,
      occurred_at: "2026-09-12T23:30:00.000Z",
      duration_seconds: null,
      outcome: null,
      subject: null,
      body: "Assigned",
      external_kind: null,
      external_ref: null,
      meta: { reason: "manual" },
    });
    expect(a).toMatchObject({
      id: "1",
      leadId: "1061",
      repId: "1",
      kind: "assign",
      meta: { reason: "manual" },
    });
  });
});
