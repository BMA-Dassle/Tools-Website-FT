import { describe, it, expect } from "vitest";
import { checkinQrPayload, parseCheckinQr } from "../qr-checkin";

describe("checkinQrPayload", () => {
  it("builds FT:{pid}:{sid} from numbers", () => {
    expect(checkinQrPayload(12345, 67890)).toBe("FT:12345:67890");
  });

  it("preserves full bigint strings (no precision loss)", () => {
    expect(checkinQrPayload("63000000000021716", "99887766")).toBe("FT:63000000000021716:99887766");
  });

  it("accepts string ids", () => {
    expect(checkinQrPayload("111", "222")).toBe("FT:111:222");
  });

  it("appends participantId as a 4th segment when present", () => {
    expect(checkinQrPayload(12345, 67890, 49976218)).toBe("FT:12345:67890:49976218");
    expect(checkinQrPayload("111", "222", "333")).toBe("FT:111:222:333");
  });

  it("omits the 4th segment when participantId is absent", () => {
    expect(checkinQrPayload(12345, 67890)).toBe("FT:12345:67890");
    expect(checkinQrPayload(12345, 67890, null)).toBe("FT:12345:67890");
    expect(checkinQrPayload(12345, 67890, "")).toBe("FT:12345:67890");
  });

  it("throws on non-digit participantId", () => {
    expect(() => checkinQrPayload("123", "456", "abc")).toThrow("participantId");
  });

  it("throws on empty personId", () => {
    expect(() => checkinQrPayload("", "123")).toThrow("personId");
  });

  it("throws on non-digit personId", () => {
    expect(() => checkinQrPayload("abc", "123")).toThrow("personId");
  });

  it("throws on empty sessionId", () => {
    expect(() => checkinQrPayload("123", "")).toThrow("sessionId");
  });

  it("throws on non-digit sessionId", () => {
    expect(() => checkinQrPayload("123", "abc")).toThrow("sessionId");
  });

  it("emits the HP form when locationId is present", () => {
    expect(checkinQrPayload(12345, 67890, null, "TXBSQN0FEKQ11")).toBe(
      "HP:TXBSQN0FEKQ11:12345:67890",
    );
    expect(checkinQrPayload("12345", "67890", "49976218", "TXBSQN0FEKQ11")).toBe(
      "HP:TXBSQN0FEKQ11:12345:67890:49976218",
    );
  });

  it("emits the legacy FT form when locationId is absent/empty", () => {
    expect(checkinQrPayload(12345, 67890, 49976218, null)).toBe("FT:12345:67890:49976218");
    expect(checkinQrPayload(12345, 67890, 49976218, "")).toBe("FT:12345:67890:49976218");
  });

  it("throws on a malformed locationId", () => {
    expect(() => checkinQrPayload("123", "456", null, "txbs lowercase")).toThrow("locationId");
  });
});

describe("parseCheckinQr", () => {
  it("parses a valid payload", () => {
    expect(parseCheckinQr("FT:12345:67890")).toEqual({
      personId: "12345",
      sessionId: "67890",
    });
  });

  it("preserves bigint strings", () => {
    expect(parseCheckinQr("FT:63000000000021716:99887766")).toEqual({
      personId: "63000000000021716",
      sessionId: "99887766",
    });
  });

  it("parses a 4-part payload with participantId", () => {
    expect(parseCheckinQr("FT:12345:67890:49976218")).toEqual({
      personId: "12345",
      sessionId: "67890",
      participantId: "49976218",
    });
  });

  it("trims whitespace", () => {
    expect(parseCheckinQr("  FT:123:456  ")).toEqual({
      personId: "123",
      sessionId: "456",
    });
  });

  it("returns null for wrong prefix", () => {
    expect(parseCheckinQr("NOTFT:123:456")).toBeNull();
  });

  it("returns null for missing sessionId", () => {
    expect(parseCheckinQr("FT:123")).toBeNull();
  });

  it("returns null for non-digit personId", () => {
    expect(parseCheckinQr("FT:abc:456")).toBeNull();
  });

  it("returns null for non-digit sessionId", () => {
    expect(parseCheckinQr("FT:123:abc")).toBeNull();
  });

  it("returns null for a non-digit participantId", () => {
    expect(parseCheckinQr("FT:123:456:extra")).toBeNull();
  });

  it("returns null for too many segments (5-part)", () => {
    expect(parseCheckinQr("FT:123:456:789:000")).toBeNull();
  });

  it("parses a 4-part HP payload with locationId", () => {
    expect(parseCheckinQr("HP:TXBSQN0FEKQ11:12345:67890")).toEqual({
      personId: "12345",
      sessionId: "67890",
      locationId: "TXBSQN0FEKQ11",
    });
  });

  it("parses a 5-part HP payload with participantId", () => {
    expect(parseCheckinQr("HP:TXBSQN0FEKQ11:12345:67890:49976218")).toEqual({
      personId: "12345",
      sessionId: "67890",
      participantId: "49976218",
      locationId: "TXBSQN0FEKQ11",
    });
  });

  it("preserves bigint personIds in HP payloads", () => {
    expect(parseCheckinQr("HP:TXBSQN0FEKQ11:63000000000021716:99887766")).toEqual({
      personId: "63000000000021716",
      sessionId: "99887766",
      locationId: "TXBSQN0FEKQ11",
    });
  });

  it("returns null for HP payloads with bad shapes", () => {
    expect(parseCheckinQr("HP:12345:67890")).toBeNull(); // 3 segments — too short for HP form
    expect(parseCheckinQr("HP:12345:67890:11111")).toBeNull(); // digits-only "locationId"
    expect(parseCheckinQr("HP:txbs:12345:67890")).toBeNull(); // lowercase locationId
    expect(parseCheckinQr("HP:TXBSQN0FEKQ11:abc:67890")).toBeNull(); // non-digit personId
    expect(parseCheckinQr("HP:TXBSQN0FEKQ11:12345:67890:abc")).toBeNull(); // non-digit participantId
    expect(parseCheckinQr("HP:TXBSQN0FEKQ11:1:2:3:4")).toBeNull(); // 6 segments
  });

  it("returns null for empty string", () => {
    expect(parseCheckinQr("")).toBeNull();
  });

  it("returns null for a random product barcode", () => {
    expect(parseCheckinQr("0123456789012")).toBeNull();
  });
});
