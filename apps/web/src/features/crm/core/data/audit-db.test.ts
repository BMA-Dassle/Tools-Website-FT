import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `crm_audit` is the CRM's answer to "who changed this" (brief §3.8, R9), and
 * the charter's acceptance item for PR1 says a director pressing Run job
 * leaves a row carrying the SIGNED-IN email. Two things have to be true for
 * that to mean anything, and neither was pinned before:
 *
 *   1. the INSERT binds `actor_email` from the entry — never a body field, and
 *      never dropped when `before` / `after` are absent;
 *   2. a failing audit write is SWALLOWED, loudly. The mutation it describes
 *      has already happened; throwing here would make a director retry a
 *      change that landed. The log line is the compensating control, so it has
 *      to carry enough to find the row by hand.
 */

const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);
const env = vi.hoisted(() => ({ configured: true }));
vi.mock("@ft/db", () => ({ sql: () => db.q, isDbConfigured: () => env.configured }));

const { writeAudit, listAudit } = await import("./audit-db");

beforeEach(() => {
  db.reset();
  env.configured = true;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const ENTRY = {
  entity: "job",
  entityId: "noop",
  action: "run",
  actorEmail: "jacob@headpinz.com",
};

describe("writeAudit", () => {
  it("binds the signed-in actor_email, with the table created first", async () => {
    await writeAudit({ ...ENTRY, after: { ok: true } });

    expect(db.matching(/CREATE TABLE IF NOT EXISTS crm_audit/)).toHaveLength(1);
    const inserts = db.matching(/INSERT INTO crm_audit/);
    expect(inserts).toHaveLength(1);
    const [insert] = inserts;
    expect(insert.text).toContain("actor_email");
    expect(insert.params).toContain("jacob@headpinz.com");
    // The four NOT NULL columns, in the order the statement binds them.
    expect(insert.params.slice(0, 4)).toEqual(["job", "noop", "run", "jacob@headpinz.com"]);
    // `after` is JSON; `before` was absent and binds NULL rather than "undefined".
    expect(insert.params[4]).toBeNull();
    expect(insert.params[5]).toBe(JSON.stringify({ ok: true }));
  });

  it("never throws when the insert fails — it logs the row it could not write", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    db.respond = (stmt) => {
      if (/INSERT INTO crm_audit/.test(stmt.text)) throw new Error("neon down");
      return [];
    };

    await expect(writeAudit(ENTRY)).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(error.mock.calls[0]);
    expect(logged).toContain("jacob@headpinz.com");
    expect(logged).toContain("noop");
    expect(logged).toContain("neon down");
  });

  it("is a no-op without a database, rather than a crash on a preview with no DATABASE_URL", async () => {
    env.configured = false;
    await expect(writeAudit(ENTRY)).resolves.toBeUndefined();
    expect(db.statements).toHaveLength(0);
    await expect(listAudit("job", "noop")).resolves.toEqual([]);
  });
});

describe("listAudit", () => {
  it("reads newest first and clamps the limit to a sane window", async () => {
    await listAudit("lead", "L-1042", 5000);
    const [select] = db.matching(/SELECT [\s\S]* FROM crm_audit/);
    expect(select.text).toContain("ORDER BY created_at DESC");
    expect(select.params).toEqual(["lead", "L-1042", 200]);

    db.reset();
    await listAudit("lead", "L-1042", 0);
    expect(db.matching(/SELECT [\s\S]* FROM crm_audit/)[0].params[2]).toBe(1);
  });
});
