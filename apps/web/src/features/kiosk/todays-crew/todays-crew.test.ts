import { describe, expect, it } from "vitest";
import {
  CREW_CAP,
  crewPillState,
  dedupeCoBooked,
  shouldAutoOpenCrew,
  slotTimeLabel,
  splitName,
  withoutRosterNames,
} from "./todays-crew";
import type { CoBookedRow } from "./types";

const row = (over: Partial<CoBookedRow> & Pick<CoBookedRow, "bmiPersonId">): CoBookedRow => ({
  name: "Racer",
  category: null,
  kind: "race",
  slot: "2026-09-06T20:00:00",
  bmiBillId: "63000000009561437",
  waiverValid: null,
  ...over,
});

describe("dedupeCoBooked", () => {
  it("collapses a person who rode two heats into ONE entry, keeping the earliest slot", () => {
    const out = dedupeCoBooked([
      row({ bmiPersonId: "1", name: "Marcus", slot: "2026-09-06T20:24:00" }),
      row({ bmiPersonId: "1", name: "Marcus", slot: "2026-09-06T20:00:00" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].slot).toBe("2026-09-06T20:00:00");
  });

  it("drops rows with no usable person id — nobody can be signed in on a name", () => {
    const out = dedupeCoBooked([
      row({ bmiPersonId: "", name: "Ghost" }),
      row({ bmiPersonId: "abc", name: "Typo" }),
      row({ bmiPersonId: "2", name: "Priya" }),
    ]);
    expect(out.map((p) => p.bmiPersonId)).toEqual(["2"]);
  });

  it("keeps a 17-digit id as a string, never a number", () => {
    const out = dedupeCoBooked([row({ bmiPersonId: "63000000009561437" })]);
    expect(out[0].bmiPersonId).toBe("63000000009561437");
    expect(typeof out[0].bmiPersonId).toBe("string");
  });

  it("prefers the attraction roster's FULL name over the heat's first name", () => {
    const out = dedupeCoBooked([
      row({ bmiPersonId: "3", name: "Jordan", kind: "race" }),
      row({
        bmiPersonId: "3",
        name: "Jordan Lee",
        kind: "gel-blaster",
        slot: "2026-09-06T21:00:00",
      }),
    ]);
    expect(out[0].name).toBe("Jordan Lee");
    // …while the EARLIEST slot still wins for the "booked together" line.
    expect(out[0].slot).toBe("2026-09-06T20:00:00");
    expect(out[0].kind).toBe("race");
  });

  it("a known class or waiver flag beats an unknown one", () => {
    const out = dedupeCoBooked([
      row({ bmiPersonId: "4", category: null, waiverValid: null }),
      row({ bmiPersonId: "4", category: "junior", waiverValid: true, slot: "2026-09-06T21:00:00" }),
    ]);
    expect(out[0].category).toBe("junior");
    expect(out[0].waiverValid).toBe(true);
  });

  it("sorts by slot, then name", () => {
    const out = dedupeCoBooked([
      row({ bmiPersonId: "5", name: "Zed", slot: "2026-09-06T20:00:00" }),
      row({ bmiPersonId: "6", name: "Amy", slot: "2026-09-06T20:00:00" }),
      row({ bmiPersonId: "7", name: "Bob", slot: "2026-09-06T19:00:00" }),
    ]);
    expect(out.map((p) => p.name)).toEqual(["Bob", "Amy", "Zed"]);
  });

  it("collapses the same FULL name under two ids, preferring the check-in-verified record", () => {
    // Probed 2026-09-06: "Ryan Jones" 63000000009529297 (waiver join) and
    // 63000000009528048 (check-in) on one web booking.
    const out = dedupeCoBooked([
      row({ bmiPersonId: "63000000009529297", name: "Ryan Jones", kind: "waiver" }),
      row({ bmiPersonId: "63000000009528048", name: "Ryan Jones", kind: "checkin" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].bmiPersonId).toBe("63000000009528048");
  });

  it("never collapses first-name-only entries — two Daniels are two people", () => {
    const out = dedupeCoBooked([
      row({ bmiPersonId: "8", name: "Daniel" }),
      row({ bmiPersonId: "9", name: "Daniel" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("name collapse is case-insensitive and keeps the earlier slot when neither checked in", () => {
    const out = dedupeCoBooked([
      row({ bmiPersonId: "10", name: "steven stauss", slot: "2026-09-06T12:00:00" }),
      row({ bmiPersonId: "11", name: "Steven Stauss", slot: "2026-09-06T11:24:00" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].bmiPersonId).toBe("11");
  });

  it(`caps at ${CREW_CAP} — a corporate booking is not a crew`, () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      row({ bmiPersonId: String(100 + i), name: `P${String(i).padStart(2, "0")}` }),
    );
    expect(dedupeCoBooked(rows)).toHaveLength(CREW_CAP);
  });
});

describe("withoutRosterNames", () => {
  const crew = [
    { id: "1", firstName: "Isabelle", lastName: "Sager" },
    { id: "2", firstName: "Donavan", lastName: "Solomon" },
    { id: "3", firstName: "Sam", lastName: "" },
  ];
  it("drops the signed-in guest's own duplicate record by full name", () => {
    // Probed 2026-09-06: Isabelle signed in as 63000000009575710 and her own
    // online-waiver record 63000000009573720 came back in her crew.
    const out = withoutRosterNames(crew, [{ firstName: "isabelle", lastName: "SAGER" }]);
    expect(out.map((c) => c.id)).toEqual(["2", "3"]);
  });
  it("a roster member with no last name excludes nobody", () => {
    expect(withoutRosterNames(crew, [{ firstName: "Sam" }])).toHaveLength(3);
  });
  it("an empty roster changes nothing", () => {
    expect(withoutRosterNames(crew, [])).toHaveLength(3);
  });
});

describe("splitName", () => {
  it("splits First Last, keeping compound last names together", () => {
    expect(splitName("Sofia De Souza")).toEqual({ first: "Sofia", last: "De Souza" });
  });
  it("a lone token is a first name", () => {
    expect(splitName("Marcus")).toEqual({ first: "Marcus", last: "" });
  });
  it("empty in, empty out", () => {
    expect(splitName("   ")).toEqual({ first: "", last: "" });
  });
});

describe("crewPillState", () => {
  it("draws the pending pill the moment the lookup is in flight", () => {
    expect(crewPillState("loading", 0)).toBe("pending");
  });
  it("goes live when there is someone un-added to offer", () => {
    expect(crewPillState("ready", 3)).toBe("live");
  });
  it("hides once everyone has been added", () => {
    expect(crewPillState("ready", 0)).toBe("hidden");
  });
  it("an error never leaves a spinner on the card", () => {
    expect(crewPillState("error", 0)).toBe("hidden");
  });
  it("never asked = nothing shown", () => {
    expect(crewPillState("idle", 0)).toBe("hidden");
  });
});

describe("shouldAutoOpenCrew", () => {
  const base = { count: 5, overlayOpen: false, alreadyOffered: false, enabled: true };
  it("pops once when co-bookers were found and the screen is clear", () => {
    expect(shouldAutoOpenCrew(base)).toBe(true);
  });
  it("never pops over another overlay — the pill stays for later", () => {
    expect(shouldAutoOpenCrew({ ...base, overlayOpen: true })).toBe(false);
  });
  it("pops ONCE per member — a second sign-in of the same person stays quiet", () => {
    expect(shouldAutoOpenCrew({ ...base, alreadyOffered: true })).toBe(false);
  });
  it("nobody found = nothing to pop", () => {
    expect(shouldAutoOpenCrew({ ...base, count: 0 })).toBe(false);
  });
  it("screens that opted out (check-in, waiver flow) get the pill only", () => {
    expect(shouldAutoOpenCrew({ ...base, enabled: false })).toBe(false);
  });
});

describe("slotTimeLabel", () => {
  it("reads the wall-clock digits, whatever the browser timezone", () => {
    expect(slotTimeLabel("2026-09-06T20:00:00", "en")).toBe("8:00 PM");
    expect(slotTimeLabel("2026-09-06T20:00:00.000Z", "en")).toBe("8:00 PM");
  });
  it("noon and midnight are 12, not 0", () => {
    expect(slotTimeLabel("2026-09-06T12:30:00", "en")).toBe("12:30 PM");
    expect(slotTimeLabel("2026-09-06T00:05:00", "en")).toBe("12:05 AM");
  });
  it("Spanish uses the RAE abbreviations", () => {
    expect(slotTimeLabel("2026-09-06T20:00:00", "es")).toBe("8:00 p. m.");
    expect(slotTimeLabel("2026-09-06T09:00:00", "es")).toBe("9:00 a. m.");
  });
  it("a slot with no time yields null rather than a wrong label", () => {
    expect(slotTimeLabel("2026-09-06", "en")).toBeNull();
    expect(slotTimeLabel("2026-09-06T99:00:00", "en")).toBeNull();
  });
});
