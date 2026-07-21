import { describe, it, expect } from "vitest";
import { classifyScan, shortCodeFromPath } from "./scan";

describe("classifyScan", () => {
  it("classifies a /s short link URL as a short code", () => {
    const c = classifyScan("https://fasttraxent.com/s/AbCd12_-");
    expect(c.kind).toBe("shortcode");
    expect(c.value).toBe("AbCd12_-");
  });

  it("classifies a bare /s path", () => {
    const c = classifyScan("/s/XyZ789ab");
    expect(c.kind).toBe("shortcode");
    expect(c.value).toBe("XyZ789ab");
  });

  it("classifies a full signed confirmation URL with billId + sig", () => {
    const c = classifyScan(
      "https://fasttraxent.com/book/confirmation/v2?billId=12345678901234567&sig=deadbeefdeadbeef&referrer=receipt",
    );
    expect(c.kind).toBe("signed-url");
    expect(c.value).toBe("12345678901234567");
    expect(c.sig).toBe("deadbeefdeadbeef");
  });

  it("classifies a W-number (case-insensitive, uppercased)", () => {
    expect(classifyScan("w52731")).toEqual({ kind: "wnumber", value: "W52731" });
    expect(classifyScan("W48833").kind).toBe("wnumber");
  });

  it("treats the r{billId} fallback as an OTP-gated code, not trusted possession", () => {
    const c = classifyScan("r12345678901234567");
    expect(c.kind).toBe("code");
    expect(c.value).toBe("r12345678901234567");
  });

  it("treats a bare 17-digit billId as an (unresolvable) code — never trusted possession", () => {
    const c = classifyScan("12345678901234567");
    expect(c.kind).toBe("code");
    expect(c.value).toBe("12345678901234567");
  });

  it("classifies an opaque short token as a short code (server tries both indexes)", () => {
    const c = classifyScan("h3n7q9");
    expect(c.kind).toBe("shortcode");
    expect(c.value).toBe("h3n7q9");
  });

  it("classifies a longer opaque native reservationCode as code", () => {
    const c = classifyScan("RES-2026-AB19-QT7788");
    expect(c.kind).toBe("code");
  });

  it("returns unknown for empty / whitespace", () => {
    expect(classifyScan("").kind).toBe("unknown");
    expect(classifyScan("   ").kind).toBe("unknown");
  });

  it("does NOT treat a scanned URL as a bare code (would mangle otherwise)", () => {
    // A URL must resolve as shortcode/signed-url, never as a raw 'code'.
    const c = classifyScan("https://headpinz.com/s/Zz00Yy11");
    expect(c.kind).toBe("shortcode");
    expect(c.value).toBe("Zz00Yy11");
  });
});

describe("shortCodeFromPath", () => {
  it("extracts the code from a full URL, dropping query/hash", () => {
    expect(shortCodeFromPath("https://x.com/s/AbCd1234?x=1#y")).toBe("AbCd1234");
  });
  it("returns null when there is no /s/ segment", () => {
    expect(shortCodeFromPath("https://x.com/book/confirmation")).toBeNull();
  });
});
