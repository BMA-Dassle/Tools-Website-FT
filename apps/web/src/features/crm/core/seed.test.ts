import { beforeEach, describe, expect, it, vi } from "vitest";
import { USER_NAMES } from "~/features/daily-events/constants";
import { PLANNERS } from "@/lib/sales-lead-config";

/**
 * The seed's CONTENT (pinned against its committed sources) and its
 * IDEMPOTENCY (every insert is ON CONFLICT DO NOTHING / WHERE NOT EXISTS, so a
 * second run adds nothing).
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

const {
  LOGIN_SEED,
  OFF_BOARD_STATUS_IDS,
  REP_SEED,
  RULE_SEED,
  STATUS_SEED,
  TEMPLATE_SEED,
  runSeed,
} = await import("./seed");

describe("seed content", () => {
  it("SEVEN rep rows — the three planners, Guest Services, Marketing, Jacob and Eric's own director row", () => {
    expect(REP_SEED.map((r) => r.slug)).toEqual([
      "kelsea",
      "lori",
      "stephanie",
      "gs",
      "mkt",
      "jacob",
      "eric",
    ]);
    expect(REP_SEED.filter((r) => r.role === "director").map((r) => r.slug)).toEqual([
      "jacob",
      "eric",
    ]);
    expect(REP_SEED.find((r) => r.slug === "gs")?.role).toBe("bucket");
    expect(REP_SEED.find((r) => r.slug === "mkt")?.role).toBe("hold");
    expect(REP_SEED.find((r) => r.slug === "mkt")?.email).toBeNull();
  });

  it("Office user ids and display names come from USER_NAMES; phones and chat ids from PLANNERS", () => {
    for (const r of REP_SEED) {
      if (r.bmiUserId) expect(USER_NAMES[r.bmiUserId]).toBe(r.bmiUsername);
    }
    expect(REP_SEED.find((r) => r.slug === "kelsea")).toMatchObject({
      bmiUserId: "28267036",
      bmiUsername: "Kelsea Kosco",
      phoneE164: PLANNERS.kelsea.phone,
      teamsChatId: PLANNERS.kelsea.teamsChatId,
      centres: ["HPFM", "FT"],
    });
    expect(REP_SEED.find((r) => r.slug === "lori")?.bmiUserId).toBe("465247");
    expect(REP_SEED.find((r) => r.slug === "stephanie")?.bmiUserId).toBe("465242");
    expect(REP_SEED.find((r) => r.slug === "gs")?.bmiUserId).toBe("30080112");
    expect(REP_SEED.find((r) => r.slug === "eric")?.bmiUserId).toBe("75262");
    // Per brief §3.8: Jacob's Office id is NOT asserted by the seed.
    expect(REP_SEED.find((r) => r.slug === "jacob")?.bmiUserId).toBeNull();
  });

  it("emails are lowercase headpinz.com addresses; every login slug has a rep row", () => {
    for (const r of REP_SEED) {
      if (r.email) expect(r.email).toMatch(/^[a-z]+@headpinz\.com$/);
    }
    expect(LOGIN_SEED.map((l) => l.email)).toEqual([
      "kelsea@headpinz.com",
      "lori@headpinz.com",
      "stephanie@headpinz.com",
      "guestservices@headpinz.com",
      "jacob@headpinz.com",
      "eric@headpinz.com",
    ]);
    const slugs = new Set(REP_SEED.map((r) => r.slug));
    for (const l of LOGIN_SEED) expect(slugs.has(l.slug)).toBe(true);
    // The prototype's placeholder DIDs are NOT seeded.
    for (const r of REP_SEED) expect("voxDid" in r).toBe(false);
  });

  it("ten statuses in prototype order; on_board false for the five the board folds away", () => {
    expect(STATUS_SEED.map((s) => s.id)).toEqual([
      "new",
      "assigned",
      "contacted",
      "waiting",
      "quote",
      "contract",
      "deposit",
      "confirmed",
      "lost",
      "noresp",
    ]);
    expect(STATUS_SEED.filter((s) => s.onBoard === false).map((s) => s.id)).toEqual([
      ...OFF_BOARD_STATUS_IDS,
    ]);
    expect(OFF_BOARD_STATUS_IDS).toEqual(["new", "deposit", "confirmed", "lost", "noresp"]);
    expect(STATUS_SEED.map((s) => s.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(STATUS_SEED.find((s) => s.id === "contract")).toMatchObject({
      label: "Contract sent",
      kind: "open",
      slaLabel: "Auto 96 h reminder",
      slaHours: 96,
    });
    expect(STATUS_SEED.filter((s) => s.kind === "won").map((s) => s.id)).toEqual([
      "deposit",
      "confirmed",
    ]);
    expect(STATUS_SEED.filter((s) => s.kind === "lost").map((s) => s.id)).toEqual([
      "lost",
      "noresp",
    ]);
  });

  it("R1..R7 verbatim from crm-data.js:33-41", () => {
    expect(RULE_SEED.map((r) => r.kind)).toEqual([
      "hold",
      "route",
      "route",
      "avail",
      "avail",
      "standard",
      "fallback",
    ]);
    expect(RULE_SEED[0]).toMatchObject({ when: { guestsMin: 100 }, then: { hold: "mkt" } });
    expect(RULE_SEED[1]).toMatchObject({
      when: { type: "birthday", kids: true },
      then: { route: "gs" },
    });
    expect(RULE_SEED[2]).toMatchObject({
      when: { type: "school", guestsMax: 39 },
      then: { route: "gs" },
    });
    expect(RULE_SEED[3].then).toEqual({ skipOff: true });
    expect(RULE_SEED[4].then).toEqual({ onShift: true });
    expect(RULE_SEED[5].then).toEqual({ standard: true });
    expect(RULE_SEED[6].then).toEqual({ queue: true });
  });

  it("T-1..T-6 with their merge fields", () => {
    expect(TEMPLATE_SEED.map((t) => t.kind)).toEqual([
      "sms",
      "sms",
      "sms",
      "email",
      "email",
      "email",
    ]);
    expect(TEMPLATE_SEED[0].body).toContain("{{guest.first}}");
    expect(TEMPLATE_SEED[4].subject).toBe("Ready for round two at {{centre.short}}?");
  });
});

describe("runSeed idempotency (SQL boundary)", () => {
  beforeEach(() => db.reset());

  it("every insert is ON CONFLICT DO NOTHING or WHERE NOT EXISTS; counts are the RETURNING rows", async () => {
    db.respond = (stmt) => (/RETURNING/.test(stmt.text) ? [{ id: "1" }] : []);
    const counts = await runSeed();
    expect(counts).toEqual({
      reps: 7,
      logins: 6,
      statuses: 10,
      rules: 7,
      templates: 6,
      settings: 3,
    });

    const inserts = db.matching(/^INSERT INTO crm_/);
    expect(inserts.length).toBe(7 + 6 + 10 + 7 + 6 + 3);
    for (const s of inserts) {
      expect(s.text, s.text).toMatch(/ON CONFLICT \([a-z_]+\) DO NOTHING|WHERE NOT EXISTS/);
    }
    // Logins resolve the rep by slug in SQL — never a hard-coded id.
    const logins = db.matching(/INSERT INTO crm_rep_logins/);
    expect(logins).toHaveLength(6);
    for (const l of logins) expect(l.text).toContain("FROM crm_reps WHERE slug =");
  });

  it("a second run with everything present inserts nothing", async () => {
    db.respond = () => [];
    expect(await runSeed()).toEqual({
      reps: 0,
      logins: 0,
      statuses: 0,
      rules: 0,
      templates: 0,
      settings: 0,
    });
  });
});
