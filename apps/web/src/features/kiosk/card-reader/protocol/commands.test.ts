import { describe, expect, it } from "vitest";
import {
  binCounterSetCommand,
  entryCommand,
  initCommand,
  isTrailerBlock,
  magReadCommand,
  mifareReadCommand,
  mifareVerifyKeyCommand,
  mifareWriteCommand,
  moveCommand,
  moveMagPositionCommand,
  parseBinCounter,
  permitEntryCommand,
  prohibitEntryCommand,
  parseFirmware,
  parseKeyHex,
  parseMagRead,
  parseRfActivation,
  parseRfStatus,
  parseSerialNumber,
  parseSwResult,
} from "./commands";
import { CrtCardSwError } from "./errors";
import { parseSensors, parseStatus } from "./status";

const A = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

describe("builders", () => {
  it("init defaults to the non-destructive leaveCard variant", () => {
    expect(initCommand()).toMatchObject({ cm: 0x30, pm: 0x33, commandClass: "init" });
    expect(initCommand("capture").pm).toBe(0x31);
  });

  it("move targets map to spec PM bytes", () => {
    expect(moveCommand("holding").pm).toBe(0x30);
    expect(moveCommand("icPosition").pm).toBe(0x31);
    expect(moveCommand("rfPosition").pm).toBe(0x32);
    expect(moveCommand("errorBin").pm).toBe(0x33);
    expect(moveCommand("outOfGate").pm).toBe(0x39);
    expect(moveCommand("outOfGate").commandClass).toBe("move");
  });

  it("entry enable/disable", () => {
    expect(entryCommand(true).pm).toBe(0x30);
    expect(entryCommand(false).pm).toBe(0x31);
  });

  it("mag permit/prohibit entry use the vendor PM bytes (32h / 30h)", () => {
    expect(permitEntryCommand()).toMatchObject({ cm: 0x33, pm: 0x32 });
    expect(prohibitEntryCommand()).toMatchObject({ cm: 0x33, pm: 0x30 });
  });

  it("mifare verify key builds 00 20 ks sn 06 + key", () => {
    const req = mifareVerifyKeyCommand({ key: "B", sector: 5, keyHex: "FF FF FF FF FF FF" });
    expect(Array.from(req.data!)).toEqual([0x00, 0x20, 0x01, 5, 6, 255, 255, 255, 255, 255, 255]);
  });

  it("mifare read builds 00 B0 sn bn le", () => {
    const req = mifareReadCommand({ sector: 1, block: 0, blocks: 3 });
    expect(Array.from(req.data!)).toEqual([0x00, 0xb0, 1, 0, 3]);
  });

  it("mifare write builds 00 D1 sn bn lc + data and counts blocks", () => {
    const data = new Uint8Array(32).fill(0xaa);
    const req = mifareWriteCommand({ sector: 1, block: 0, data });
    expect(Array.from(req.data!.slice(0, 5))).toEqual([0x00, 0xd1, 1, 0, 2]);
    expect(req.data!).toHaveLength(5 + 32);
  });

  it("bin counter set encodes ASCII and validates range", () => {
    expect(Array.from(binCounterSetCommand(7).data!)).toEqual(Array.from(A("007")));
    expect(() => binCounterSetCommand(1000)).toThrow(RangeError);
    expect(() => binCounterSetCommand(-1)).toThrow(RangeError);
  });
});

describe("trailer-block guard", () => {
  it("knows the geometry (4-block sectors then S70 16-block sectors)", () => {
    expect(isTrailerBlock(0, 3)).toBe(true);
    expect(isTrailerBlock(0x1f, 3)).toBe(true);
    expect(isTrailerBlock(0x20, 3)).toBe(false);
    expect(isTrailerBlock(0x20, 15)).toBe(true);
  });

  it("refuses a write that touches the trailer directly or via range", () => {
    const one = new Uint8Array(16);
    expect(() => mifareWriteCommand({ sector: 2, block: 3, data: one })).toThrow(/trailer/);
    const three = new Uint8Array(48);
    expect(() => mifareWriteCommand({ sector: 2, block: 1, data: three })).toThrow(/trailer/);
    expect(() => mifareWriteCommand({ sector: 2, block: 0, data: three })).not.toThrow();
  });

  it("rejects partial-block writes", () => {
    expect(() => mifareWriteCommand({ sector: 2, block: 0, data: new Uint8Array(10) })).toThrow(
      /multiple/,
    );
  });
});

describe("parseKeyHex", () => {
  it("accepts separators and normalizes", () => {
    expect(Array.from(parseKeyHex("a0:a1:a2:a3:a4:a5"))).toEqual([
      0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5,
    ]);
  });
  it("rejects wrong lengths and non-hex", () => {
    expect(() => parseKeyHex("FFFF")).toThrow(RangeError);
    expect(() => parseKeyHex("GGGGGGGGGGGG")).toThrow(RangeError);
  });
});

describe("status parsing", () => {
  it("maps all documented st combinations", () => {
    expect(parseStatus({ st0: 0x30, st1: 0x30, st2: 0x30 })).toMatchObject({
      card: "none",
      stacker: "empty",
      errorBin: "ok",
    });
    expect(parseStatus({ st0: 0x31, st1: 0x31, st2: 0x31 })).toMatchObject({
      card: "atGate",
      stacker: "few",
      errorBin: "full",
    });
    expect(parseStatus({ st0: 0x32, st1: 0x32, st2: 0x30 })).toMatchObject({
      card: "atRfIcPosition",
      stacker: "enough",
    });
  });

  it("maps unexpected bytes to unknown but keeps raw", () => {
    const st = parseStatus({ st0: 0x39, st1: 0x41, st2: 0x42 });
    expect(st).toMatchObject({ card: "unknown", stacker: "unknown", errorBin: "unknown" });
    expect(st.raw.st0).toBe(0x39);
  });

  it("parses sensors from 8 bytes and tolerates short data", () => {
    const s = parseSensors(Uint8Array.from([0x31, 0x30, 0x31, 0x30, 0x30, 0x30, 0x31, 0x99]));
    expect(s.sensors).toEqual([true, false, true, false, false, false, true]);
    expect(s.s8Raw).toBe(0x99);
    expect(parseSensors(Uint8Array.from([0x31])).sensors[0]).toBe(true);
    expect(parseSensors(Uint8Array.from([0x31])).s8Raw).toBeNull();
  });
});

describe("RF activation parsing", () => {
  it("parses a Mifare S50 activation (4-byte UID)", () => {
    const data = Uint8Array.from([0x4d, 0x00, 0x04, 4, 0xde, 0xad, 0xbe, 0xef, 0x08]);
    const r = parseRfActivation(data);
    expect(r.type).toBe("mifare");
    expect(r.card).toBe("s50");
    expect(r.uidHex).toBe("DEADBEEF");
    expect(r.atqaHex).toBe("0004");
    expect(r.sakHex).toBe("08");
    expect(r.atsHex).toBeNull();
  });

  it("accepts swapped ATQA byte order (scan ambiguity)", () => {
    const r = parseRfActivation(Uint8Array.from([0x4d, 0x44, 0x00, 7, 1, 2, 3, 4, 5, 6, 7, 0x00]));
    expect(r.card).toBe("ultralight");
    expect(r.uidHex).toBe("01020304050607");
  });

  it("parses Type A with trailing ATS", () => {
    const r = parseRfActivation(
      Uint8Array.from([0x41, 0x03, 0x44, 4, 1, 2, 3, 4, 0x20, 0x75, 0x77, 0x81, 0x02]),
    );
    expect(r.type).toBe("typeA");
    expect(r.card).toBeNull();
    expect(r.atsHex).toBe("75778102");
  });

  it("parses Type B (ATQB blob) and tolerates empty data", () => {
    const atqb = [0x50, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    expect(parseRfActivation(Uint8Array.from([0x42, ...atqb])).atqbHex).toBe(
      "500102030405060708090A0B",
    );
    expect(parseRfActivation(new Uint8Array(0)).type).toBe("unknown");
  });

  it("parses RF status sti/stj", () => {
    expect(parseRfStatus(A("00"))).toEqual({ active: false, card: null });
    expect(parseRfStatus(A("10"))).toEqual({ active: true, card: "s50" });
    expect(parseRfStatus(A("12"))).toEqual({ active: true, card: "ultralight" });
    expect(parseRfStatus(A("20"))).toEqual({ active: true, card: "typeAcpu" });
  });
});

describe("SW-terminated results", () => {
  it("strips a trailing 9000", () => {
    const payload = parseSwResult(Uint8Array.from([1, 2, 3, 0x90, 0x00]));
    expect(Array.from(payload)).toEqual([1, 2, 3]);
  });

  it("throws CrtCardSwError with the SW code on failure", () => {
    try {
      parseSwResult(Uint8Array.from([0x6f, 0x00]));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CrtCardSwError);
      expect((e as CrtCardSwError).sw).toBe("6F00");
    }
    expect(() => parseSwResult(Uint8Array.from([0x6b, 0x00]))).toThrow(/address overflow/);
  });
});

describe("magnetic stripe", () => {
  it("builds the mag read + move-to-mag-position commands", () => {
    expect(magReadCommand()).toMatchObject({ cm: 0x36, pm: 0x37, commandClass: "cardIo" });
    expect(moveMagPositionCommand()).toMatchObject({ cm: 0x32, pm: 0x34, commandClass: "move" });
  });

  it("parses the real CRT-591-(R02)HB-HDN capture into tracks + candidates", () => {
    // From the operator's debug log (2026-07-17): a negative-head reply whose
    // payload is the ASCII track buffer. e1/e0 = '0''2', then the buffer.
    const dataAscii = "1P6283=7496003776810700729~P6283=0000000001037356~N24";
    const data = Uint8Array.from([...dataAscii].map((c) => c.charCodeAt(0)));
    const mag = parseMagRead({ kind: "negative", data, e1: 0x30, e0: 0x32 });

    expect(mag.ascii).toBe("021P6283=7496003776810700729~P6283=0000000001037356~N24");
    expect(mag.candidates).toEqual(["7496003776810700729", "0000000001037356"]);
    // Confirmed against a printed card: the account is track 2's 16-digit field.
    expect(mag.cardNumber).toBe("0000000001037356");
    expect(mag.tracks.length).toBeGreaterThanOrEqual(2);
  });

  it("parses a positive-head mag reply (data only, no e1/e0)", () => {
    const dataAscii = "P6283=0000000001037357~";
    const data = Uint8Array.from([...dataAscii].map((c) => c.charCodeAt(0)));
    const mag = parseMagRead({ kind: "positive", data });
    expect(mag.candidates).toContain("0000000001037357");
  });

  it("returns no card number for an empty read", () => {
    const mag = parseMagRead({ kind: "negative", data: new Uint8Array(0), e1: 0x30, e0: 0x30 });
    expect(mag.cardNumber).toBeNull();
    expect(mag.candidates).toEqual([]);
  });

  it("accepts a clean 16-digit track-2 account even when track 1 is missing", () => {
    const mag = parseMagRead({
      kind: "negative",
      data: A("P6283=0000000001038091~"),
      e1: 0x30,
      e0: 0x32,
    });
    expect(mag.cardNumber).toBe("0000000001038091");
  });

  it("REJECTS a track-1-only read (long 19-digit field, no 16-digit account) → null", () => {
    // Track 2 didn't read — only the longer track-1 number came back. The old
    // logic wrongly served this as the card number; now it must be null.
    const mag = parseMagRead({
      kind: "negative",
      data: A("1P6283=7496003776810700729~"),
      e1: 0x30,
      e0: 0x32,
    });
    expect(mag.cardNumber).toBeNull();
    expect(mag.candidates).toEqual(["7496003776810700729"]);
  });

  it("REJECTS short garbage (a partial/stale '2124' read) → null", () => {
    const mag = parseMagRead({ kind: "negative", data: A("P6283=2124~"), e1: 0x30, e0: 0x32 });
    expect(mag.cardNumber).toBeNull();
  });
});

describe("identity parsing", () => {
  it("parses INIT firmware string", () => {
    expect(parseFirmware(A("CRT-591-M001"))).toBe("CRT-591-M001");
    expect(parseFirmware(new Uint8Array(0))).toBe("");
  });

  it("parses serial number with length prefix", () => {
    const data = Uint8Array.from([4, ...A("AB12"), 0, 0]);
    expect(parseSerialNumber(data)).toBe("AB12");
    expect(parseSerialNumber(new Uint8Array(0))).toBe("");
  });

  it("parses bin counter digits and rejects junk", () => {
    expect(parseBinCounter(A("042"))).toBe(42);
    expect(parseBinCounter(A("999"))).toBe(999);
    expect(parseBinCounter(A("9A9"))).toBeNull();
    expect(parseBinCounter(new Uint8Array(0))).toBeNull();
  });
});
