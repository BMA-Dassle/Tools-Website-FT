import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `crm_assignment_rules` and `crm_shifts` at the SQL boundary (brief §3.10):
 * the statements, their parameters and the row mapping — no live Neon.
 */

const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);
vi.mock("@ft/db", () => ({ sql: () => db.q, isDbConfigured: () => true }));

const rulesDb = await import("./rules-db");
const shiftsDb = await import("./shifts-db");

const RULE_ROW = {
  id: "3",
  position: 3,
  enabled: true,
  kind: "route",
  label: "School and youth groups to Guest Services when under 40",
  why: "Small youth groups are handled like parties",
  when_json: { type: "school", guestsMax: 39 },
  then_json: { route: "gs" },
};

beforeEach(() => db.reset());

describe("rules-db", () => {
  it("mapRuleRow: id as string, JSONB objects pass through, junk falls back safely", () => {
    expect(rulesDb.mapRuleRow(RULE_ROW)).toEqual({
      id: "3",
      position: 3,
      enabled: true,
      kind: "route",
      label: RULE_ROW.label,
      why: RULE_ROW.why,
      when: { type: "school", guestsMax: 39 },
      then: { route: "gs" },
    });
    expect(
      rulesDb.mapRuleRow({
        ...RULE_ROW,
        kind: "weird",
        when_json: null,
        then_json: [1],
        why: null,
      }),
    ).toMatchObject({
      kind: "fallback",
      when: {},
      then: {},
      why: null,
    });
  });

  it("listRules orders by position; insertRule appends after MAX(position); updateRule never touches position/enabled", async () => {
    db.respond = (s) =>
      /^SELECT .* FROM crm_assignment_rules ORDER BY position/.test(s.text)
        ? [RULE_ROW]
        : [RULE_ROW];
    const list = await rulesDb.listRules();
    expect(list[0].id).toBe("3");
    expect(db.matching(/ORDER BY position ASC, id ASC/)).toHaveLength(1);

    db.reset();
    db.respond = () => [RULE_ROW];
    await rulesDb.insertRule(
      { label: "x", kind: "route", when: { type: "school" }, then: { route: "gs" } },
      "eric@headpinz.com",
    );
    const ins = db.matching(/^INSERT INTO crm_assignment_rules/)[0];
    expect(ins.text).toContain("(SELECT COALESCE(MAX(position), 0) + 1 FROM crm_assignment_rules)");
    expect(ins.params).toEqual([
      null,
      "route",
      "x",
      null,
      '{"type":"school"}',
      '{"route":"gs"}',
      "eric@headpinz.com",
    ]);

    db.reset();
    db.respond = () => [RULE_ROW];
    await rulesDb.updateRule(
      "3",
      { label: "y", kind: "hold", why: "w", when: {}, then: { hold: "mkt" } },
      "eric@headpinz.com",
    );
    const upd = db.matching(/^UPDATE crm_assignment_rules/)[0];
    expect(upd.text).not.toContain("position =");
    expect(upd.text).not.toContain("enabled =");
    expect(upd.params).toEqual([
      "3",
      "hold",
      "y",
      "w",
      "{}",
      '{"hold":"mkt"}',
      "eric@headpinz.com",
    ]);
  });

  it("setRuleEnabled flips one row; reorderRules renumbers from the ordinal of the given ids", async () => {
    db.respond = () => [{ ...RULE_ROW, enabled: false }];
    const r = await rulesDb.setRuleEnabled("3", false, "eric@headpinz.com");
    expect(r?.enabled).toBe(false);
    expect(db.matching(/SET enabled = \$2/)[0].params).toEqual(["3", false, "eric@headpinz.com"]);

    db.reset();
    await rulesDb.reorderRules(["7", "1", "2"], "eric@headpinz.com");
    const re = db.matching(/^UPDATE crm_assignment_rules AS r/)[0];
    expect(re.text).toContain("unnest($1::bigint[]) WITH ORDINALITY AS o(id, pos)");
    expect(re.params).toEqual([["7", "1", "2"], "eric@headpinz.com"]);
    db.reset();
    await rulesDb.reorderRules([], "eric@headpinz.com");
    expect(db.statements).toHaveLength(0);
  });
});

describe("shifts-db", () => {
  const RAW = {
    id: "5",
    rep_id: "1",
    shift_date: "2026-09-12",
    starts_at: "2026-09-12 14:00:00+00",
    ends_at: "2026-09-12 22:00:00+00",
    source: "7shifts",
    seven_shifts_shift_id: "8801234501",
    location_id: 332160,
    off_today: false,
    off_reason: null,
    updated_by: null,
    synced_at: "2026-09-12 12:00:00+00",
  };

  it("ensureShiftsSchema adds the one-manual-row-per-day partial unique index", async () => {
    await shiftsDb.ensureShiftsSchema();
    const idx = db.matching(/CREATE UNIQUE INDEX IF NOT EXISTS crm_shifts_manual_one_per_day/);
    expect(idx).toHaveLength(1);
    expect(idx[0].text).toContain("ON crm_shifts (rep_id, shift_date) WHERE source = 'manual'");
  });

  it("mapShiftRow: ids as strings, date trimmed to YYYY-MM-DD, source normalised", () => {
    expect(shiftsDb.mapShiftRow(RAW)).toEqual({
      id: "5",
      repId: "1",
      shiftDate: "2026-09-12",
      startsAt: "2026-09-12 14:00:00+00",
      endsAt: "2026-09-12 22:00:00+00",
      source: "7shifts",
      sevenShiftsShiftId: "8801234501",
      locationId: 332160,
      offToday: false,
      offReason: null,
      updatedBy: null,
      syncedAt: "2026-09-12 12:00:00+00",
    });
  });

  it("listShiftsForDates queries by date array; an empty list issues nothing", async () => {
    db.respond = () => [RAW];
    const rows = await shiftsDb.listShiftsForDates(["2026-09-12", "2026-09-13"]);
    expect(rows).toHaveLength(1);
    const sel = db.matching(/FROM crm_shifts WHERE shift_date = ANY\(\$1::date\[\]\)/)[0];
    expect(sel.params).toEqual([["2026-09-12", "2026-09-13"]]);
    db.reset();
    expect(await shiftsDb.listShiftsForDates([])).toEqual([]);
    expect(db.statements).toHaveLength(0);
  });

  it("upsertSevenShifts conflicts on the 7shifts key and refreshes times; pruneSevenShifts deletes only source='7shifts'", async () => {
    db.respond = (s) => (/^INSERT INTO crm_shifts/.test(s.text) ? [{ id: "9" }] : []);
    const n = await shiftsDb.upsertSevenShifts([
      {
        repId: "1",
        shiftDate: "2026-09-12",
        startsAt: "2026-09-12T10:00:00-04:00",
        endsAt: "2026-09-12T18:00:00-04:00",
        sevenShiftsShiftId: "8801234501",
        locationId: 332160,
      },
    ]);
    expect(n).toBe(1);
    const ins = db.matching(/^INSERT INTO crm_shifts/)[0];
    expect(ins.text).toContain(
      "ON CONFLICT (rep_id, shift_date, source, seven_shifts_shift_id) DO UPDATE SET",
    );
    expect(ins.text).toContain("'7shifts'");
    expect(ins.params).toEqual([
      "1",
      "2026-09-12",
      "2026-09-12T10:00:00-04:00",
      "2026-09-12T18:00:00-04:00",
      "8801234501",
      332160,
    ]);

    db.reset();
    await shiftsDb.pruneSevenShifts({
      locationId: 332160,
      dates: ["2026-09-12", "2026-09-13"],
      keep: [
        { repId: "1", shiftDate: "2026-09-13", sevenShiftsShiftId: "8801234501" },
        { repId: "4", shiftDate: "2026-09-13", sevenShiftsShiftId: "8801234501" },
      ],
    });
    const del = db.matching(/^DELETE FROM crm_shifts/)[0];
    expect(del.text).toContain("WHERE s.source = '7shifts'");
    // The identity is the TRIPLE, not the shift id: a shift that moves from
    // today to tomorrow keeps its id, and pruning by id alone left the old
    // day's row behind — the rep then read as on shift on a day off.
    expect(del.text).toContain("unnest($3::bigint[], $4::date[], $5::text[])");
    expect(del.text).toContain("k.rep_id = s.rep_id");
    expect(del.text).toContain("k.shift_date = s.shift_date");
    expect(del.text).toContain("k.shift_id = s.seven_shifts_shift_id");
    expect(del.params).toEqual([
      332160,
      ["2026-09-12", "2026-09-13"],
      ["1", "4"],
      ["2026-09-13", "2026-09-13"],
      ["8801234501", "8801234501"],
    ]);
  });

  it("pruneSevenShifts with nothing left upstream sends empty keep arrays (delete every mirrored row in the window)", async () => {
    db.reset();
    await shiftsDb.pruneSevenShifts({
      locationId: 467486,
      dates: ["2026-09-12"],
      keep: [],
    });
    const del = db.matching(/^DELETE FROM crm_shifts/)[0];
    expect(del.params).toEqual([467486, ["2026-09-12"], [], [], []]);
  });

  it("setOffToday upserts the manual row through the partial index; reason defaults to 'manual' when off, NULL when back on", async () => {
    db.respond = (s) =>
      /^INSERT INTO crm_shifts/.test(s.text)
        ? [
            {
              ...RAW,
              source: "manual",
              seven_shifts_shift_id: null,
              off_today: true,
              off_reason: "manual",
              starts_at: null,
              ends_at: null,
            },
          ]
        : [];
    const row = await shiftsDb.setOffToday({
      repId: "1",
      date: "2026-09-12",
      off: true,
      actorEmail: "eric@headpinz.com",
    });
    expect(row?.offToday).toBe(true);
    expect(row?.source).toBe("manual");
    const ins = db.matching(/^INSERT INTO crm_shifts/)[0];
    expect(ins.text).toContain(
      "ON CONFLICT (rep_id, shift_date) WHERE source = 'manual' DO UPDATE SET",
    );
    expect(ins.params).toEqual(["1", "2026-09-12", true, "manual", "eric@headpinz.com"]);

    db.reset();
    db.respond = () => [];
    await shiftsDb.setOffToday({
      repId: "1",
      date: "2026-09-12",
      off: true,
      reason: " PTO ",
      actorEmail: "e",
    });
    expect(db.matching(/^INSERT INTO crm_shifts/)[0].params[3]).toBe("PTO");
    db.reset();
    await shiftsDb.setOffToday({
      repId: "1",
      date: "2026-09-12",
      off: false,
      reason: "PTO",
      actorEmail: "e",
    });
    expect(db.matching(/^INSERT INTO crm_shifts/)[0].params.slice(2, 4)).toEqual([false, null]);
  });
});
