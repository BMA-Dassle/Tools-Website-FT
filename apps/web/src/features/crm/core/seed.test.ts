import { beforeEach, describe, expect, it, vi } from "vitest";
import { USER_NAMES } from "~/features/daily-events/constants";
import { PLANNERS } from "@/lib/sales-lead-config";

/**
 * The seed's CONTENT (pinned against its committed sources) and its
 * IDEMPOTENCY (every insert is ON CONFLICT DO NOTHING / WHERE NOT EXISTS — bar
 * the reps row, whose conflict arm only HEALS a NULL Office id / 7shifts id —
 * so a second run writes nothing).
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
      // Owner, 2026-09-13: "they all do all". The FastTrax form offered one
      // name because Kelsea was the only planner who carried the centre.
      centres: ["HPFM", "FT", "HPN"],
    });
    expect(REP_SEED.find((r) => r.slug === "lori")?.bmiUserId).toBe("465247");
    expect(REP_SEED.find((r) => r.slug === "stephanie")?.bmiUserId).toBe("465242");
    expect(REP_SEED.find((r) => r.slug === "gs")?.bmiUserId).toBe("30080112");
    expect(REP_SEED.find((r) => r.slug === "eric")?.bmiUserId).toBe("75262");
    // Jacob's Office id arrived after production was seeded (owner-confirmed
    // 2026-09-13): the seed asserts it now and `seedReps` heals the live row.
    expect(REP_SEED.find((r) => r.slug === "jacob")).toMatchObject({
      bmiUserId: "7251049",
      bmiUsername: "Jacob Elliott",
    });
  });

  it("7shifts user ids: the three planners only, as INTEGERS (probed live 2026-09-13; Lori is 'Lori Coates-Lehman' there)", () => {
    const byId = Object.fromEntries(REP_SEED.map((r) => [r.slug, r.sevenShiftsUserId]));
    expect(byId).toEqual({
      kelsea: 10832991,
      lori: 6568770,
      stephanie: 8204948,
      gs: null, // Guest Services has no 7shifts user
      mkt: null,
      jacob: null,
      eric: null,
    });
    // The column is INTEGER — the seed carries numbers, never digit strings.
    for (const r of REP_SEED) {
      if (r.sevenShiftsUserId !== null) expect(Number.isInteger(r.sevenShiftsUserId)).toBe(true);
    }
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

  it("every insert is ON CONFLICT DO NOTHING or WHERE NOT EXISTS (reps: a heal-only DO UPDATE); counts are the RETURNING rows", async () => {
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
    const reps = db.matching(/^INSERT INTO crm_reps /);
    expect(reps).toHaveLength(7);
    for (const s of inserts) {
      if (reps.includes(s)) continue;
      expect(s.text, s.text).toMatch(/ON CONFLICT \([a-z_]+\) DO NOTHING|WHERE NOT EXISTS/);
    }
    // Logins resolve the rep by slug in SQL — never a hard-coded id.
    const logins = db.matching(/INSERT INTO crm_rep_logins/);
    expect(logins).toHaveLength(6);
    for (const l of logins) expect(l.text).toContain("FROM crm_reps WHERE slug =");
  });

  it("a second run with everything present (and nothing to heal) writes nothing", async () => {
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

  it("the reps upsert HEALS a NULL Office id from the seed and never overwrites a value an admin set", async () => {
    // Production before 2026-09-13: `jacob` exists with NULL bmi_user_id /
    // bmi_username. The recording stub cannot evaluate COALESCE, so the contract
    // is pinned at the SQL text: the conflict arm sets ONLY the healable
    // columns (two Office + the 7shifts id, + updated_at), each as
    // COALESCE(existing, seed) so a hand-set value wins, and fires only where
    // there is a NULL to fill — a run with nothing to heal RETURNS nothing and
    // counts zero.
    db.respond = (stmt) =>
      /^INSERT INTO crm_reps /.test(stmt.text) && stmt.params[0] === "jacob" ? [{ id: "6" }] : [];
    const counts = await runSeed();
    expect(counts.reps).toBe(1);

    const reps = db.matching(/^INSERT INTO crm_reps /);
    expect(reps).toHaveLength(7);
    for (const s of reps) {
      const at = s.text.indexOf("ON CONFLICT (slug) DO UPDATE SET");
      expect(at, s.text).toBeGreaterThan(0);
      const arm = s.text.slice(at);
      expect(arm).toContain("bmi_user_id = COALESCE(crm_reps.bmi_user_id, EXCLUDED.bmi_user_id)");
      expect(arm).toContain(
        "bmi_username = COALESCE(crm_reps.bmi_username, EXCLUDED.bmi_username)",
      );
      expect(arm).toContain(
        "seven_shifts_user_id = COALESCE(crm_reps.seven_shifts_user_id, EXCLUDED.seven_shifts_user_id)",
      );
      expect(arm).toContain(
        "WHERE (crm_reps.bmi_user_id IS NULL AND EXCLUDED.bmi_user_id IS NOT NULL) OR (crm_reps.bmi_username IS NULL AND EXCLUDED.bmi_username IS NOT NULL) OR (crm_reps.seven_shifts_user_id IS NULL AND EXCLUDED.seven_shifts_user_id IS NOT NULL) RETURNING id",
      );
      // The SET list names nothing else: display name, email, role, centres, phone… stay as set.
      const setList = arm.slice("ON CONFLICT (slug) DO UPDATE SET".length, arm.indexOf(" WHERE "));
      expect(setList.match(/\w+ =/g)).toEqual([
        "bmi_user_id =",
        "bmi_username =",
        "seven_shifts_user_id =",
        "updated_at =",
      ]);
    }

    const jacob = reps.find((s) => s.params[0] === "jacob");
    expect(jacob?.params).toEqual(expect.arrayContaining(["7251049", "Jacob Elliott"]));
    // The Office id is bound as TEXT — never a number.
    expect(jacob?.params.includes(7251049)).toBe(false);
  });

  it("the same arm HEALS a NULL 7shifts id for the three planners, bound as an INTEGER", async () => {
    // Production before 2026-09-13: every rep row had seven_shifts_user_id
    // NULL; the B2 rules PR then matched kelsea / lori / stephanie in 7shifts.
    // The first live run heals exactly those three rows; the second heals none.
    const healed = new Set(["kelsea", "lori", "stephanie"]);
    db.respond = (stmt) =>
      /^INSERT INTO crm_reps /.test(stmt.text) && healed.has(stmt.params[0] as string)
        ? [{ id: "1" }]
        : [];
    expect((await runSeed()).reps).toBe(3);

    const reps = db.matching(/^INSERT INTO crm_reps /);
    expect(reps).toHaveLength(7);
    // seven_shifts_user_id sits right after bmi_username in the column list…
    for (const s of reps) {
      expect(s.text).toContain("bmi_user_id, bmi_username, seven_shifts_user_id, teams_chat_id");
    }
    // …and is bound as a NUMBER (the column is INTEGER), never a digit string.
    const idOf = (slug: string) => reps.find((s) => s.params[0] === slug)?.params[8];
    expect(idOf("kelsea")).toBe(10832991);
    expect(idOf("lori")).toBe(6568770);
    expect(idOf("stephanie")).toBe(8204948);
    for (const slug of ["gs", "mkt", "jacob", "eric"]) expect(idOf(slug)).toBeNull();
    for (const s of reps) {
      expect(
        s.params.some((p) => typeof p === "string" && /^(10832991|6568770|8204948)$/.test(p)),
      ).toBe(false);
    }
  });
});
