/**
 * The pass template binds eleven fields, and an ABSENT metaData key renders as
 * a blank on a live pass — a failure that looks fine from every API and only
 * shows on the racer's phone. These tests pin the shape so a new issue route
 * cannot ship a partial meta again.
 */
import { describe, it, expect } from "vitest";
import {
  buildLicenceMeta,
  formatHeat,
  formatLicenceDate,
  ordinal,
  tierFrom,
  CHECKIN_IDLE,
} from "./licence-meta";

/** Every key the template resolves a `${meta.x}` against. */
const TEMPLATE_KEYS = [
  "code",
  "memberName",
  "memberQr",
  "licenceUrl",
  "tier",
  "races",
  "validUntil",
  "waiver",
  "lastVisit",
  "nextRace",
  "nextRaceLong",
  "raceLabel",
  "checkinStatus",
] as const;

describe("ordinal", () => {
  it("uses US ordinals, including the teens", () => {
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(4)).toBe("4th");
    // The trap every ordinal helper gets wrong.
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(12)).toBe("12th");
    expect(ordinal(13)).toBe("13th");
    expect(ordinal(21)).toBe("21st");
    expect(ordinal(31)).toBe("31st");
  });
});

describe("formatLicenceDate", () => {
  it("renders US order with an ordinal day", () => {
    expect(formatLicenceDate("2026-08-05T18:00:00.000Z")).toBe("Aug 5th, 2026");
    expect(formatLicenceDate("2026-10-31T18:00:00.000Z")).toBe("Oct 31st, 2026");
  });

  it("returns empty rather than 'Invalid Date' for junk", () => {
    expect(formatLicenceDate(null)).toBe("");
    expect(formatLicenceDate("")).toBe("");
    expect(formatLicenceDate("not-a-date")).toBe("");
  });
});

describe("formatHeat", () => {
  // 02:36Z on Aug 6 IS 10:36 PM ET on Aug 5. Reading it as wall-clock printed
  // "Aug 6 · 2:36 AM" onto a live pass — wrong by the ET offset AND the day.
  const heat = { scheduledStart: "2026-08-06T02:36:00.000Z", track: "Red", heatNumber: 55 };

  it("reads scheduledStart as genuine UTC and renders ET", () => {
    const out = formatHeat(heat);
    expect(out.nextRace).toBe("Aug 5 · 10:36 PM · Red");
    expect(out.nextRaceLong).toBe("Wednesday, Aug 5 · 10:36 PM · Red · Heat 55");
    expect(out.raceLabel).toBe("Heat 55");
  });

  it("keeps all three renderings on the SAME heat", () => {
    // The pass showed 10:12 PM beside "Heat 55" because only one of the three
    // was ever updated. Whatever they say, they must agree.
    const out = formatHeat({ ...heat, heatNumber: 60, scheduledStart: "2026-08-06T02:48:00.000Z" });
    expect(out.nextRace).toContain("10:48 PM");
    expect(out.nextRaceLong).toContain("10:48 PM");
    expect(out.nextRaceLong).toContain("Heat 60");
    expect(out.raceLabel).toBe("Heat 60");
  });

  it("degrades to empty strings when there is no heat", () => {
    expect(formatHeat(null)).toEqual({ nextRace: "", nextRaceLong: "", raceLabel: "" });
    expect(formatHeat({ scheduledStart: "junk", track: "Red" }).nextRace).toBe("");
  });
});

describe("tierFrom", () => {
  it("returns the HIGHEST qualification, not the first", () => {
    expect(tierFrom(["Qualified Intermediate", "Qualified Pro", "License Fee"])).toBe("Pro");
    expect(tierFrom(["Qualified Intermediate"])).toBe("Intermediate");
    expect(tierFrom(["License Fee"])).toBe("");
    expect(tierFrom(undefined)).toBe("");
  });
});

describe("buildLicenceMeta", () => {
  const base = {
    personId: "409523",
    code: "mgrm2g8o42wxc",
    fullName: "Eric Osborn",
    skipPersonFetch: true,
  };

  it("returns EVERY key the template binds", async () => {
    const meta = await buildLicenceMeta(base);
    for (const key of TEMPLATE_KEYS) {
      expect(meta, `missing template key: ${key}`).toHaveProperty(key);
      // Absent OR empty both render as a blank field on the pass.
      expect(String(meta[key]).length, `empty template key: ${key}`).toBeGreaterThan(0);
    }
  });

  it("builds the register-scannable barcode payload, not the app payload", async () => {
    const meta = await buildLicenceMeta(base);
    // The BMI register rejects the app's JSON-array payload; only the
    // authenticate URL scans at the register, the kiosk AND the desk.
    expect(meta.memberQr).toBe(
      "https://smstim.in/908/authenticate/?login_code=mgrm2g8o42wxc",
    );
  });

  it("uppercases the racer name", async () => {
    expect((await buildLicenceMeta(base)).memberName).toBe("ERIC OSBORN");
  });

  it("writes the idle check-in value EXPLICITLY", async () => {
    // Omitting the key blanks the field, and a blank counts as a change — which
    // fired a "not checking in yet" alert on every single push.
    expect((await buildLicenceMeta(base)).checkinStatus).toBe(CHECKIN_IDLE);
  });

  it("fills the heat when the caller has one", async () => {
    const meta = await buildLicenceMeta({
      ...base,
      heat: { scheduledStart: "2026-08-06T02:36:00.000Z", track: "Red", heatNumber: 55 },
    });
    expect(meta.nextRace).toBe("Aug 5 · 10:36 PM · Red");
    expect(meta.raceLabel).toBe("Heat 55");
  });

  it("says 'None in next 2 hrs' rather than going blank with no heat", async () => {
    const meta = await buildLicenceMeta(base);
    expect(meta.nextRace).toBe("None in next 2 hrs");
    expect(meta.raceLabel).toBe("—");
  });

  it("carries tier and races through from the Office match", async () => {
    const meta = await buildLicenceMeta({
      ...base,
      races: 31,
      memberships: ["Qualified Intermediate", "Qualified Pro"],
    });
    expect(meta.tier).toBe("Pro");
    expect(meta.races).toBe("31");
  });

  it("renders a zero race count rather than an empty field", async () => {
    expect((await buildLicenceMeta({ ...base, races: null })).races).toBe("0");
  });
});
