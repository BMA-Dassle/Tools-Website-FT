import { describe, it, expect } from "vitest";
import * as copy from "../karting-checkin-copy";
import {
  KARTING_CHECKIN_LABEL,
  KARTING_CHECKIN_LABEL_SHORT,
  KARTING_CHECKIN_SMS_NOTE,
} from "../karting-checkin-copy";

// Any non-GSM-7 char (em-dash, arrow, middot, narrow/no-break space) forces
// UCS-2 encoding (70 chars/segment) and carrier rejection of longer bodies —
// see tasks/lessons.md. The SMS note must stay plain ASCII forever.
describe("KARTING_CHECKIN_SMS_NOTE", () => {
  it("is GSM-7 safe (ASCII only)", () => {
    expect(KARTING_CHECKIN_SMS_NOTE).toMatch(/^[\x00-\x7F]+$/);
  });

  it("stays short enough to not blow the SMS segment budget", () => {
    expect(KARTING_CHECKIN_SMS_NOTE.length).toBeLessThanOrEqual(60);
  });
});

// There are two check-ins half an hour apart on two different floors. A label
// that says only "check in by" is true of both, so a guest cannot tell which
// one he is reading — that ambiguity is the whole defect this module exists to
// remove. Every deadline label must name its desk.
describe("deadline labels name their desk", () => {
  it.each([
    ["KARTING_CHECKIN_LABEL", KARTING_CHECKIN_LABEL],
    ["KARTING_CHECKIN_LABEL_SHORT", KARTING_CHECKIN_LABEL_SHORT],
  ])("%s names Karting", (_name, value) => {
    expect(value.toLowerCase()).toContain("karting");
  });
});

// The old copy claimed "your race begins about 30 min after check-in".
// Measured slot -> green flag is p50 9.4 / p95 15.7 / min -2.5 (n=65), so that
// was wrong by ~3x AND unsafe in both directions. Until the pace is measured
// across weekends, no string here may assert how long anything takes.
describe("no unmeasured duration claims", () => {
  const strings: Array<[string, string]> = Object.entries(copy).flatMap(([name, value]) =>
    typeof value === "string" ? [[name, value] as [string, string]] : [],
  );

  // The sweep below only sees string exports. Anything else must be covered by
  // a test of its own, so assert the non-string exports are exactly the ones we
  // know about — a new helper then fails here until someone tests it.
  it("has no untested non-string exports", () => {
    const others = Object.entries(copy)
      .filter(([, v]) => typeof v !== "string")
      .map(([k]) => k);
    expect(others).toEqual(["thenKartingBy"]);
  });

  it.each(strings)("%s makes no duration claim", (_name, value) => {
    // "30 min", "about 20 minutes", "~45 mins", "30-45 min" ...
    expect(value).not.toMatch(/\d+\s*(?:-\s*\d+\s*)?(?:min|minute|hour|hr)/i);
  });

  it.each(strings)("%s makes no bare check-in reference", (_name, value) => {
    // "check in by" / "check-in time" with no desk named in the same string is
    // the ambiguous form — it is true of both check-ins, on two floors, half an
    // hour apart. Every such string must name which desk it means.
    if (/check[-\s]?in/i.test(value)) {
      expect(value.toLowerCase()).toMatch(/karting|guest services/);
    }
  });
});

describe("thenKartingBy", () => {
  it("names both desks so neither time can be read as the other", () => {
    const line = copy.thenKartingBy("7:45 PM");
    expect(line).toContain("Karting Desk");
    expect(line).toContain("7:45 PM");
    expect(line.toLowerCase()).toContain("not your race time");
  });

  it("makes no duration claim", () => {
    expect(copy.thenKartingBy("7:45 PM")).not.toMatch(/\d+\s*(?:min|minute|hour|hr)/i);
  });
});
