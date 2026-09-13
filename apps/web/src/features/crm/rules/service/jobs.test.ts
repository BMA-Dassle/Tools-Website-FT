import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two job handlers: the mirror PARKS without a token (never retries into a
 * void); the sweep honours the CRM_AUTO_ASSIGN kill switch and reports
 * `applied: 0` with "nothing to apply" — the ordinary state of a safety net
 * now that the rules assign at capture. Neon is stubbed at the `@ft/db`
 * boundary.
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

const { assignSweepHandler, sevenShiftsMirrorHandler } = await import("./jobs");
const { SEVEN_SHIFTS_TOKEN_MISSING } = await import("./sevenshifts");
const { SWEEP_NOT_APPLIED_REASON } = await import("./sweep");

const ctx = (payload: Record<string, unknown> = {}) => ({
  job: {
    id: "1",
    kind: "assign-sweep" as const,
    idempotencyKey: "k",
    payload,
    status: "running" as const,
    attempts: 1,
    maxAttempts: 20,
    nextAttemptAt: "",
    leasedUntil: null,
    lastError: null,
    result: null,
    createdBy: "eric@headpinz.com",
    createdAt: "",
    updatedAt: "",
    resolvedAt: null,
  },
  payload,
  actorEmail: "eric@headpinz.com",
  now: new Date("2026-09-12T19:30:00-04:00"),
});

const saved = {
  token: process.env.SEVEN_SHIFTS_API_TOKEN,
  access: process.env.SEVEN_SHIFTS_ACCESS_TOKEN,
  auto: process.env.CRM_AUTO_ASSIGN,
};

beforeEach(() => {
  db.reset();
  delete process.env.SEVEN_SHIFTS_API_TOKEN;
  delete process.env.SEVEN_SHIFTS_ACCESS_TOKEN;
  delete process.env.CRM_AUTO_ASSIGN;
});

afterEach(() => {
  if (saved.token === undefined) delete process.env.SEVEN_SHIFTS_API_TOKEN;
  else process.env.SEVEN_SHIFTS_API_TOKEN = saved.token;
  if (saved.access === undefined) delete process.env.SEVEN_SHIFTS_ACCESS_TOKEN;
  else process.env.SEVEN_SHIFTS_ACCESS_TOKEN = saved.access;
  if (saved.auto === undefined) delete process.env.CRM_AUTO_ASSIGN;
  else process.env.CRM_AUTO_ASSIGN = saved.auto;
});

describe("sevenshifts-mirror", () => {
  it("parks with the token message when SEVEN_SHIFTS_API_TOKEN is unset, touching nothing", async () => {
    const out = await sevenShiftsMirrorHandler(ctx());
    expect(out).toEqual({ ok: false, error: SEVEN_SHIFTS_TOKEN_MISSING, park: true });
    expect(db.statements).toHaveLength(0);
  });
});

describe("assign-sweep", () => {
  it('CRM_AUTO_ASSIGN="false" skips the sweep (kill switch, R4)', async () => {
    process.env.CRM_AUTO_ASSIGN = "false";
    const out = await assignSweepHandler(ctx());
    expect(out).toEqual({
      ok: true,
      result: { skipped: true, reason: 'CRM_AUTO_ASSIGN="false"', applied: 0 },
    });
    expect(db.statements).toHaveLength(0);
  });

  it("with nothing left unassigned returns applied 0; the retry delay comes from crm_settings (default 60)", async () => {
    db.respond = () => [];
    const out = await assignSweepHandler(ctx());
    expect(out.ok).toBe(true);
    const result = (out as { ok: true; result: Record<string, unknown> }).result;
    expect(result.applied).toBe(0);
    expect(result.reason).toBe(SWEEP_NOT_APPLIED_REASON);
    expect(result.delayMinutes).toBe(60);
    expect(result.candidates).toBe(0);
    const cand = db.matching(/FROM crm_leads l/)[0];
    expect(cand.text).toContain("l.assigned_rep_id IS NULL");
    expect(cand.text).toContain("l.held_for_rep_id IS NULL");
    expect(cand.params[0]).toBe("2026-09-12T22:30:00.000Z");
    expect(cand.params[1]).toBe(200);
  });
});
