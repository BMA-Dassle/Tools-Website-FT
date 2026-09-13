import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The lead lookup at the SQL boundary — the statement, its parameter and the
 * row mapping — with no live Neon (brief §3.10).
 *
 * It matters that this is READ ONLY and archive-aware: the availability screen
 * is reachable by URL, and an archived lead must not come back from the dead
 * just because someone kept the link.
 */

const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);
vi.mock("@ft/db", () => ({ sql: () => db.q, isDbConfigured: () => true }));
vi.mock("~/features/crm/leads", () => ({ ensureLeadsSchema: () => Promise.resolve() }));

const { findLeadForAvailability } = await import("./lead-lookup");

const ROW = {
  public_id: "L-1042",
  centre: "HPFM",
  event_date: "2026-10-17",
  event_time: "18:00:00",
  guests: 60,
  status_id: "quote",
  account_name: "Lee Health",
  first_name: "Dana",
  last_name: "Marsh",
};

beforeEach(() => db.reset());

describe("findLeadForAvailability", () => {
  it("reads one unarchived lead by public id and titles it by account", async () => {
    db.respond = () => [ROW];
    const lead = await findLeadForAvailability("L-1042");
    expect(lead).toEqual({
      publicId: "L-1042",
      title: "Lee Health",
      centre: "HPFM",
      eventDate: "2026-10-17",
      eventTime: "18:00:00",
      guests: 60,
      statusId: "quote",
    });
    const stmt = db.matching(/FROM crm_leads/)[0];
    expect(stmt.params).toEqual(["L-1042"]);
    expect(stmt.text).toMatch(/archived_at IS NULL/);
    // Read only — nothing in this sub writes to the leads sub's table.
    expect(db.matching(/INSERT|UPDATE|DELETE/)).toEqual([]);
  });

  it("falls back to the contact's name, then to the id itself", async () => {
    db.respond = () => [{ ...ROW, account_name: null }];
    expect((await findLeadForAvailability("L-1042"))?.title).toBe("Dana Marsh");

    db.respond = () => [{ ...ROW, account_name: "   ", first_name: null, last_name: null }];
    expect((await findLeadForAvailability("L-1042"))?.title).toBe("L-1042");
  });

  it("answers null for a lead that is not there — never an invented one", async () => {
    db.respond = () => [];
    expect(await findLeadForAvailability("L-9999")).toBeNull();
  });

  it("answers null rather than trusting a centre code it does not recognise", async () => {
    db.respond = () => [{ ...ROW, centre: "HPXX" }];
    expect(await findLeadForAvailability("L-1042")).toBeNull();
  });

  it("takes the calendar day off a DATE column whichever shape the driver returns", async () => {
    db.respond = () => [{ ...ROW, event_date: new Date("2026-10-17T04:00:00.000Z") }];
    expect((await findLeadForAvailability("L-1042"))?.eventDate).toBe("2026-10-17");
  });
});
