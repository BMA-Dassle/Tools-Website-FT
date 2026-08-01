import { describe, expect, it } from "vitest";
import { AamvaBurst, parseAamvaLines } from "./aamva";

/**
 * Fabricated FL-shaped (AAMVA v09) burst — the exact LINE STRUCTURE seen from
 * a real license through LineAccumulator on 2026-07-23 ("@" line, stray RS
 * control char, first element inline on the ANSI header, ZF jurisdiction
 * subfile glued to its type), with entirely fake person data.
 */
const FL_BURST = [
  "@",
  "\x1e",
  "ANSI 636010090002DL00410269ZF03100075DLDAQD123456789012",
  "DCSDOE",
  "DDEN",
  "DACJANE",
  "DDFN",
  "DADMARIE",
  "DDGN",
  "DCAE",
  "DCBNONE",
  "DCDNONE",
  "DBD04182018",
  "DBB03151990",
  "DBA03152030",
  "DBC2",
  "DAU065 IN",
  "DAG123 MAIN ST",
  "DAIFORT MYERS",
  "DAJFL",
  "DAK339010000",
  "DCFX000000000000",
  "DCGUSA",
  "DCK0100000000000000",
  "DDAF",
  "DDB03012020",
  "DDK1",
  "ZFZFA20240721",
  "ZFB",
  "ZFCSAFE DRIVER",
  "ZFD",
  "ZFJ0123456789",
  "ZFK",
];

describe("parseAamvaLines", () => {
  it("parses the FL v09 burst shape (header inline element, RS char, ZF subfile)", () => {
    const lic = parseAamvaLines(FL_BURST);
    expect(lic).toEqual({
      firstName: "JANE",
      middleName: "MARIE",
      lastName: "DOE",
      dobIso: "1990-03-15",
    });
  });

  it("reads an element inlined on the ANSI header (not just DAQ)", () => {
    const lic = parseAamvaLines([
      "ANSI 636010090002DL00410269ZF03100075DLDCSSMITH",
      "DACJOHN",
      "DBB03142001",
      "DCGUSA",
    ]);
    expect(lic?.lastName).toBe("SMITH");
    expect(lic?.dobIso).toBe("2001-03-14");
  });

  it('treats middle name filler "NONE" as absent', () => {
    const lines = FL_BURST.map((l) => (l === "DADMARIE" ? "DADNONE" : l));
    const lic = parseAamvaLines(lines);
    expect(lic?.middleName).toBeUndefined();
    expect(lic?.firstName).toBe("JANE");
  });

  it("decodes Canadian CCYYMMDD dates via DCG", () => {
    const lic = parseAamvaLines([
      "ANSI 636028090002DL00410269ZF03100075DLDAQ12345",
      "DCSTREMBLAY",
      "DACLUC",
      "DBB19900315",
      "DCGCAN",
    ]);
    expect(lic?.dobIso).toBe("1990-03-15");
  });

  it("falls back to CCYYMMDD when the US MMDDCCYY read is impossible", () => {
    const lic = parseAamvaLines([
      "ANSI 636010010002DL00410269ZF03100075DLDAQ12345",
      "DCSDOE",
      "DACJANE",
      "DBB19900315", // month "19" is invalid as MMDDCCYY → must decode as 1990-03-15
      "DCGUSA",
    ]);
    expect(lic?.dobIso).toBe("1990-03-15");
  });

  it("rejects impossible calendar dates (rollover guarded)", () => {
    const lic = parseAamvaLines([
      "ANSI 636010090002DL00410269ZF03100075DLDAQ12345",
      "DCSDOE",
      "DACJANE",
      "DBB02302000", // Feb 30 — MMDDCCYY invalid, CCYYMMDD (year 0230) invalid too
    ]);
    expect(lic).toBeNull();
  });

  it("supports legacy DCT given-names (v02–03)", () => {
    const lic = parseAamvaLines([
      "ANSI 636010020002DL00410269ZF03100075DLDAQ12345",
      "DCSDOE",
      "DCTJANE MARIE",
      "DBB03151990",
    ]);
    expect(lic).toMatchObject({ firstName: "JANE", middleName: "MARIE", lastName: "DOE" });
  });

  it('supports legacy DAA full name ("LAST,FIRST,MIDDLE", v01)', () => {
    const lic = parseAamvaLines([
      "ANSI 6360100100DLDAADOE,JANE,MARIE",
      "DBB19900315", // v01 dates were CCYYMMDD — the fallback handles it
    ]);
    expect(lic).toMatchObject({ firstName: "JANE", middleName: "MARIE", lastName: "DOE" });
  });

  it("flags truncated names (DDE/DDF = T)", () => {
    const lines = FL_BURST.map((l) => (l === "DDEN" ? "DDET" : l));
    expect(parseAamvaLines(lines)?.truncatedName).toBe(true);
  });

  it("first write wins — a jurisdiction subfile can't overwrite DL fields", () => {
    const lic = parseAamvaLines([...FL_BURST, "DCSEVIL"]);
    expect(lic?.lastName).toBe("DOE");
  });

  it("returns null for a plain QR payload (single line)", () => {
    expect(parseAamvaLines(["https://fasttraxent.com/checkin/abc123"])).toBeNull();
  });

  it("returns null for multi-line non-license noise", () => {
    expect(parseAamvaLines(["hello", "WORLD123", "not a license"])).toBeNull();
  });

  it("parses a clipped burst missing the header when the fields are conclusive", () => {
    const lic = parseAamvaLines(["DCSDOE", "DACJANE", "DBB03151990", "DCGUSA"]);
    expect(lic).toMatchObject({ firstName: "JANE", lastName: "DOE", dobIso: "1990-03-15" });
  });

  it("returns null when the DOB is missing", () => {
    expect(
      parseAamvaLines(["ANSI 636010090002DL00410269ZF03100075DLDAQ1", "DCSDOE", "DACJANE"]),
    ).toBeNull();
  });
});

describe("AamvaBurst", () => {
  it("collects pushed lines and flush() parses + clears", () => {
    const burst = new AamvaBurst();
    for (const line of FL_BURST) burst.push(line);
    expect(burst.size).toBe(FL_BURST.length);
    const lic = burst.flush();
    expect(lic?.lastName).toBe("DOE");
    expect(burst.size).toBe(0);
    expect(burst.flush()).toBeNull(); // empty flush
  });

  it("reset() drops buffered lines", () => {
    const burst = new AamvaBurst();
    burst.push("DCSDOE");
    burst.reset();
    expect(burst.size).toBe(0);
    expect(burst.flush()).toBeNull();
  });
});
