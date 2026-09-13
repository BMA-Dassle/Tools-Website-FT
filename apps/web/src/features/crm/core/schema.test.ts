import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `ensureCrmSchema()` creates every table in brief §3.8 EXACTLY ONCE per
 * process, however many times it (or a sub's own ensure) is called, and seeds
 * only when `crm_reps` is empty.
 *
 * Fresh module graph per test (`vi.resetModules`) because every ensure is a
 * module-level memo — which is the property under test.
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

const seed = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./seed", () => ({
  runSeed: async () => {
    seed.calls++;
    return { reps: 7, logins: 6, statuses: 10, rules: 7, templates: 6, settings: 3 };
  },
}));

/** The 30 tables the brief's DDL declares. */
const EXPECTED_TABLES = [
  "crm_reps",
  "crm_rep_logins",
  "crm_settings",
  "crm_audit",
  "crm_statuses",
  "crm_status_bmi_map",
  "crm_accounts",
  "crm_contacts",
  "crm_leads",
  "crm_assignments",
  "crm_activities",
  "crm_assignment_rules",
  "crm_shifts",
  "crm_bmi_projects",
  "crm_bmi_sync_runs",
  "crm_quote_lines",
  "crm_quote_templates",
  "crm_sms_threads",
  "crm_sms_messages",
  "crm_email_links",
  "crm_graph_subscriptions",
  "crm_calls",
  "crm_targets",
  "crm_goals",
  "crm_collateral",
  "crm_templates",
  "crm_share_links",
  "crm_cold_lists",
  "crm_cold_rows",
  "crm_jobs",
];

function createdTables(): string[] {
  return db
    .matching(/CREATE TABLE IF NOT EXISTS/)
    .map((s) => /CREATE TABLE IF NOT EXISTS (\w+)/.exec(s.text)?.[1] ?? "?");
}

beforeEach(() => {
  vi.resetModules();
  db.reset();
  seed.calls = 0;
  db.respond = (stmt) =>
    /SELECT count\(\*\)::int AS n FROM crm_reps/.test(stmt.text) ? [{ n: 7 }] : [];
});

describe("ensureCrmSchema", () => {
  it("creates all 30 tables exactly once across two calls", async () => {
    const { ensureCrmSchema, CRM_TABLES } = await import("./schema");
    await ensureCrmSchema();
    await ensureCrmSchema();

    const created = createdTables();
    expect(created.length).toBe(30);
    expect(new Set(created).size).toBe(30);
    expect([...created].sort()).toEqual([...EXPECTED_TABLES].sort());
    expect([...CRM_TABLES].sort()).toEqual([...EXPECTED_TABLES].sort());
  });

  it("a sub's own ensure before the aggregator does not double its CREATE", async () => {
    const { ensureJobsSchema } = await import("~/features/crm/jobs");
    await ensureJobsSchema();
    const { ensureCrmSchema } = await import("./schema");
    await ensureCrmSchema();
    expect(createdTables().filter((t) => t === "crm_jobs")).toHaveLength(1);
    expect(createdTables().length).toBe(30);
  });

  it("every table has created_at or is a keyed row (the conventions), and ids are TEXT where BMI ids live", async () => {
    const { ensureCrmSchema } = await import("./schema");
    await ensureCrmSchema();
    const ddl = db.matching(/CREATE TABLE IF NOT EXISTS/).map((s) => s.text);
    const leads = ddl.find((t) => t.includes("crm_leads ("))!;
    for (const col of [
      "bmi_project_id TEXT",
      "bmi_state_id TEXT",
      "bmi_person_id TEXT",
      "capture_payload JSONB NOT NULL",
    ]) {
      expect(leads).toContain(col);
    }
    const mirror = ddl.find((t) => t.includes("crm_bmi_projects ("))!;
    expect(mirror).toContain("project_id TEXT PRIMARY KEY");
    expect(mirror).toContain("responsible_user_id TEXT");
    const jobs = ddl.find((t) => t.includes("crm_jobs ("))!;
    expect(jobs).toContain("idempotency_key TEXT NOT NULL UNIQUE");
    expect(jobs).toContain("max_attempts INTEGER NOT NULL DEFAULT 20");
  });

  it("seeds lazily when crm_reps is empty, and not when it is not", async () => {
    db.respond = (stmt) =>
      /SELECT count\(\*\)::int AS n FROM crm_reps/.test(stmt.text) ? [{ n: 0 }] : [];
    const fresh = await import("./schema");
    await fresh.ensureCrmSchema();
    expect(seed.calls).toBe(1);

    vi.resetModules();
    db.reset();
    db.respond = (stmt) =>
      /SELECT count\(\*\)::int AS n FROM crm_reps/.test(stmt.text) ? [{ n: 7 }] : [];
    const again = await import("./schema");
    await again.ensureCrmSchema();
    expect(seed.calls).toBe(1);
  });
});
