import { describe, expect, it } from "vitest";
import { buildContractWhere, decodeContractCursor, encodeContractCursor } from "./list";

/**
 * The window / filter / archive SQL and the keyset cursor. No Neon: the WHERE
 * builder is a pure function of the filter, today's ET date and the clock, and
 * that is exactly the part that decides which contracts a director sees.
 */
const NOW = new Date("2026-09-13T16:30:00.000Z"); // 12:30 ET
const TODAY = "2026-09-13";

const build = (
  filter: Parameters<typeof buildContractWhere>[0],
  plannerEmail: string | null = null,
) => buildContractWhere(filter, TODAY, plannerEmail, NOW);

describe("window filters (crm-events.js:215-217)", () => {
  it("attention drops in the SQL predicate and nothing date-bounded", () => {
    const { where } = build({ win: "attention" });
    expect(where[0]).toContain("status = 'pending_approval'");
    expect(where.join(" ")).not.toContain("event_date >=");
  });

  it("7 / 30 / 90 are today..today+N inclusive", () => {
    expect(build({ win: "7" }).where[0]).toBe(
      "q.event_date >= $1::date AND q.event_date <= ($1::date + 7)",
    );
    expect(build({ win: "30" }).where[0]).toContain("+ 30");
    expect(build({ win: "90" }).where[0]).toContain("+ 90");
  });

  it("past is strictly before today, and does NOT hide closed contracts", () => {
    const { where } = build({ win: "past" });
    expect(where[0]).toBe("q.event_date < $1::date");
    expect(where.join(" ")).not.toContain("q.status <> ALL");
  });

  it("all has no date bound at all", () => {
    const { where } = build({ win: "all", closed: true });
    expect(where).toEqual([]);
  });
});

describe("the archive toggle", () => {
  it("hides completed / cancelled / denied / expired by default", () => {
    const { where, params } = build({ win: "30" });
    expect(where.some((w) => w.includes("q.status <> ALL"))).toBe(true);
    expect(params).toContainEqual(["completed", "cancelled", "denied", "expired"]);
  });

  it("shows them when the toggle is on", () => {
    const { where } = build({ win: "30", closed: true });
    expect(where.some((w) => w.includes("q.status <> ALL"))).toBe(false);
  });
});

describe("centre, rep, status and search", () => {
  it("centre binds the center_code SLUG, never the clientKey (FT and HPFM share one)", () => {
    const { params } = build({ win: "all", centre: "FT", closed: true });
    expect(params).toContain("fasttrax");
    expect(params).not.toContain("headpinzftmyers");
  });

  it("the rep filter binds a planner EMAIL, resolved from the slug by the caller", () => {
    const { where, params } = build(
      { win: "all", rep: "kelsea", closed: true },
      "kelsea@headpinz.com",
    );
    expect(where.some((w) => w.includes("lower(q.planner_email)"))).toBe(true);
    expect(params).toContain("kelsea@headpinz.com");
  });

  it("status 'all' is not a filter", () => {
    expect(build({ win: "all", status: "all", closed: true }).where).toEqual([]);
    expect(build({ win: "all", status: "deposit_paid", closed: true }).params).toContain(
      "deposit_paid",
    );
  });

  it("search matches names, business, event number, short id and phone DIGITS", () => {
    const { where, params } = build({ win: "all", q: "(239) 555-1234", closed: true });
    const clause = where.join(" ");
    expect(clause).toContain("q.event_name ILIKE");
    expect(clause).toContain("q.contract_short_id ILIKE");
    expect(clause).toContain("regexp_replace(COALESCE(q.guest_phone, ''), '[^0-9]', '', 'g') LIKE");
    expect(params).toContain("%2395551234%");
  });

  it("a search with no digits cannot accidentally match every phone", () => {
    const { params } = build({ win: "all", q: "Acme", closed: true });
    expect(params).toContain("%Acme%");
    expect(params.some((p) => p === "%%")).toBe(false);
  });
});

describe("the keyset cursor", () => {
  it("round-trips (event_date, id)", () => {
    const c = encodeContractCursor("2026-10-17", "4821");
    expect(decodeContractCursor(c)).toEqual({ eventDate: "2026-10-17", id: "4821" });
  });

  it("refuses anything that is not a date and a numeric id", () => {
    expect(decodeContractCursor(null)).toBeNull();
    expect(decodeContractCursor("")).toBeNull();
    expect(decodeContractCursor("not-base64url!!")).toBeNull();
    expect(decodeContractCursor(encodeContractCursor("17 Oct 2026", "4821"))).toBeNull();
    expect(decodeContractCursor(encodeContractCursor("2026-10-17", "4821; DROP"))).toBeNull();
  });

  it("the first two parameters are always today and the unsigned cut-off, in that order", () => {
    const { params } = build({ win: "attention" });
    expect(params[0]).toBe(TODAY);
    // 2,880 minutes before the clock — the prototype's `ageMin(sentAt) > 2880`.
    expect(params[1]).toBe(new Date(NOW.getTime() - 2880 * 60_000).toISOString());
  });
});
