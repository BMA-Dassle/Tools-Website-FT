import { describe, expect, it, vi } from "vitest";
import { parseWithRawIds } from "@ft/db";
import { fixtureText } from "@/test/msw/handlers/fixture";
import { STATUS_SEED } from "../../core/seed";

/**
 * Office state names → map proposals, BY NAME, never inventing an id; and the
 * "unavailable" path when Office cannot be reached.
 *
 * `~/features/daily-events/data/bmi-office` is mocked at the module boundary
 * (it opens Redis and https at call time); the reader is also injectable.
 */

vi.mock("~/features/daily-events/data/bmi-office", () => ({
  getMetadataLookups: async () => {
    throw new Error("Office auth failed: 401");
  },
}));

const {
  STATUS_BMI_STATE_NAMES,
  UNPROPOSED_OFFICE_STATES,
  listOfficeStateNames,
  normalizeStateName,
  proposeStatusMap,
  stateNamesToList,
} = await import("./bmi-states");

/** The fixture's states as the transport would deliver them (`stateNames: Record<id, name>`). */
function fixtureStateNames(): Record<string, string> {
  const meta = parseWithRawIds<{ states: { id: string; name: string }[] }>(
    fixtureText("office-metadata.json.txt"),
    ["id"],
  );
  return Object.fromEntries(meta.states.map((s) => [s.id, s.name]));
}

describe("the prototype table", () => {
  it("covers every seeded status id and nothing else", () => {
    expect(Object.keys(STATUS_BMI_STATE_NAMES).sort()).toEqual(STATUS_SEED.map((s) => s.id).sort());
  });

  /**
   * The prototype's table said "Quote" for both `waiting` and `quote`, and
   * NEITHER TENANT HAS A STATE BY THAT NAME — the stock one is "Pending Quote".
   * The fixture agreed with the prototype rather than with Office, so this
   * suite proved a mapping that could never resolve in production: the Statuses
   * screen proposed nothing, a card dragged to "Quote sent" moved nothing in
   * Office, and the KPI (which buckets on Office's state name) never counted
   * it. Owner, 2026-09-14: "quoted should be sent quote as well."
   *
   * So the table follows OFFICE now, not the prototype, and the fixture carries
   * the tenant's real state list.
   */
  it("names states that exist at the tenant, and records the unmapped ones as null", () => {
    expect(STATUS_BMI_STATE_NAMES).toEqual({
      new: "New Lead",
      assigned: "New Lead",
      contacted: "Contacted",
      // "Waiting on guest" is ours alone — it sits before "Quote sent" and a
      // guest can be waited on without ever having been quoted.
      waiting: null,
      quote: "Pending Quote",
      contract: "Send Contract",
      deposit: "Confirmation",
      confirmed: "Confirmation + Waiver",
      lost: "Cancellation",
      noresp: "Cancellation",
    });
    expect(UNPROPOSED_OFFICE_STATES).toEqual(["Pending Signed Contract", "Deposit Requested"]);
  });

  it("every name it does give is a state the tenant actually has", () => {
    const real = new Set(
      stateNamesToList(fixtureStateNames()).map((s) => normalizeStateName(s.name)),
    );
    for (const [statusId, wanted] of Object.entries(STATUS_BMI_STATE_NAMES)) {
      if (wanted === null) continue;
      expect(real.has(normalizeStateName(wanted)), `${statusId} → "${wanted}"`).toBe(true);
    }
  });
});

describe("proposeStatusMap", () => {
  const states = stateNamesToList(fixtureStateNames());

  it("matches by normalised name and returns the tenant's own ids", () => {
    const proposals = proposeStatusMap(states);
    const byStatus = Object.fromEntries(proposals.map((p) => [p.statusId, p]));
    expect(byStatus.new).toEqual({
      statusId: "new",
      bmiStateId: "3891928",
      bmiStateName: "New Lead",
    });
    expect(byStatus.assigned.bmiStateId).toBe("3891928");
    expect(byStatus.contacted.bmiStateId).toBe("7845185");
    // "Pending Quote" is Office's stock quote state (-2) at both centres.
    expect(byStatus.quote).toEqual({
      statusId: "quote",
      bmiStateId: "-2",
      bmiStateName: "Pending Quote",
    });
    // Ours alone: no Office state, so no proposal to make.
    expect(byStatus.waiting).toBeUndefined();
    expect(byStatus.contract).toEqual({
      statusId: "contract",
      bmiStateId: "49130082",
      bmiStateName: "Send Contract",
    });
    expect(byStatus.deposit).toEqual({
      statusId: "deposit",
      bmiStateId: "-3",
      bmiStateName: "Confirmation",
    });
    expect(byStatus.confirmed.bmiStateId).toBe("3274635");
    expect(byStatus.lost.bmiStateId).toBe("-4");
    expect(byStatus.noresp.bmiStateId).toBe("-4");
    // Nine of the ten seeded statuses; `waiting` is deliberately ours alone.
    expect(proposals).toHaveLength(9);
  });

  it("never proposes Pending Signed Contract or Deposit Requested, and never invents an id", () => {
    const proposals = proposeStatusMap(states);
    expect(proposals.map((p) => p.bmiStateName)).not.toContain("Pending Signed Contract");
    expect(proposals.map((p) => p.bmiStateName)).not.toContain("Deposit Requested");
    const known = new Set(states.map((s) => s.id));
    for (const p of proposals) expect(known.has(p.bmiStateId), p.bmiStateId).toBe(true);
  });

  it("a name missing from the tenant yields NO proposal for that status", () => {
    const without = states.filter((s) => s.name !== "Send Contract" && s.name !== "Pending Quote");
    const proposals = proposeStatusMap(without);
    expect(proposals.find((p) => p.statusId === "contract")).toBeUndefined();
    expect(proposals.find((p) => p.statusId === "quote")).toBeUndefined();
    expect(proposals).toHaveLength(7);
  });

  it("normalises case, whitespace and a trailing '(…)' suffix; prefers the lowest custom id on a tie", () => {
    expect(normalizeStateName("  Confirmation  +  Waiver (kiosk) ")).toBe("confirmation + waiver");
    expect(normalizeStateName("NEW LEAD")).toBe("new lead");
    const dup = proposeStatusMap([
      { id: "77", name: "New Lead (old)" },
      { id: "12", name: "new lead" },
      { id: "-9", name: "New Lead" },
    ]);
    expect(dup.find((p) => p.statusId === "new")?.bmiStateId).toBe("12");
  });
});

describe("listOfficeStateNames", () => {
  it("source 'office' with the centre → clientKey resolved (FT shares Fort Myers' tenant)", async () => {
    const reader = vi.fn(async () => ({ stateNames: fixtureStateNames() }));
    const r = await listOfficeStateNames("FT", reader);
    expect(reader).toHaveBeenCalledWith("headpinzftmyers");
    expect(r).toMatchObject({ centre: "FT", clientKey: "headpinzftmyers", source: "office" });
    expect(r.states.length).toBe(14);
    expect(r.proposals.length).toBe(9);
    expect(r.error).toBeUndefined();
    const naples = await listOfficeStateNames("HPN", reader);
    expect(reader).toHaveBeenLastCalledWith("headpinznaples");
    expect(naples.clientKey).toBe("headpinznaples");
  });

  it("source 'unavailable' with the error text when Office refuses — never a throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await listOfficeStateNames("HPFM");
      expect(r).toEqual({
        centre: "HPFM",
        clientKey: "headpinzftmyers",
        source: "unavailable",
        error: "Office auth failed: 401",
        states: [],
        proposals: [],
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts a clientKey directly", async () => {
    const reader = vi.fn(async () => ({ stateNames: {} }));
    const r = await listOfficeStateNames("headpinznaples", reader);
    expect(r.centre).toBe("HPN");
    expect(r.source).toBe("office");
    expect(r.proposals).toEqual([]);
  });
});
