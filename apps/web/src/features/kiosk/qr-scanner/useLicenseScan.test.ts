/**
 * The scan-burst verdict. Extracted from the hook precisely so these cases can
 * be exercised without a serial port — before this, the only way to test a
 * licence scan was to stand at a kiosk holding a phone up to a scanner.
 *
 * Every case below is a way a real racing licence could silently fail to
 * register, which is what the owner hit on 2026-08-07.
 */
import { describe, it, expect } from "vitest";
import { classifyBurst } from "./useLicenseScan";

/** The exact payload on a live FastTrax racing licence (person 409523). */
const LICENCE_QR = "https://smstim.in/908/authenticate/?login_code=mgrm2g8o42wxc";
/** The SMS-Timing app's own QR — the other accepted racer handle. */
const APP_QR = 'https://smstim.in?["headpinzftmyers","3f59bc35-1234-4abc-8def-0123456789ab"]';

describe("classifyBurst — the racing licence", () => {
  it("reads a clean single-line licence scan", () => {
    const v = classifyBurst([LICENCE_QR]);
    expect(v.kind).toBe("member");
    if (v.kind === "member") expect(v.qr.code).toBe("mgrm2g8o42wxc");
  });

  it("still reads it with a TRAILING BLANK line — the regression this fixes", () => {
    // A scanner emitting an empty read after the payload made lines.length 2,
    // which skipped the member-QR branch entirely and dropped the scan with no
    // error of any kind.
    const v = classifyBurst([LICENCE_QR, ""]);
    expect(v.kind).toBe("member");
    if (v.kind === "member") expect(v.qr.code).toBe("mgrm2g8o42wxc");
  });

  it("still reads it with a LEADING blank and surrounding whitespace", () => {
    const v = classifyBurst(["", "   ", LICENCE_QR, "\r"]);
    expect(v.kind).toBe("member");
  });

  it("reads the SMS-Timing app QR too, and keeps its clientKey", () => {
    const v = classifyBurst([APP_QR]);
    expect(v.kind).toBe("member");
    if (v.kind === "member") expect(v.qr.clientKey).toBe("headpinzftmyers");
  });

  it("an all-blank burst is empty, not 'unrecognised' — nothing to report", () => {
    expect(classifyBurst(["", "  "]).kind).toBe("empty");
    expect(classifyBurst([]).kind).toBe("empty");
  });
});

describe("classifyBurst — no longer silent", () => {
  it("reports an unrecognised scan instead of dropping it without a trace", () => {
    const v = classifyBurst(["https://example.com/nope"]);
    expect(v.kind).toBe("unrecognised");
  });

  it("the diagnostic leaks NO scanned content — shapes only", () => {
    // A driver's licence burst is PII and a member QR is a credential, so the
    // log line must never carry the payload.
    const secret = "SUPERSECRETCREDENTIAL1234567890";
    const v = classifyBurst([`https://evil.example/${secret}`]);
    expect(v.kind).toBe("unrecognised");
    if (v.kind === "unrecognised") {
      expect(v.diagnostic).not.toContain(secret);
      expect(v.diagnostic).toContain("1 line(s)");
    }
  });

  it("a near-miss licence URL is refused, not guessed at", () => {
    // Right host, code that fails the shape guard → still not a member QR.
    const v = classifyBurst(["https://smstim.in/908/authenticate/?login_code=has spaces"]);
    expect(v.kind).not.toBe("member");
  });

  it("a foreign host carrying a valid-looking code is refused", () => {
    const v = classifyBurst(["https://evil.example/908/authenticate/?login_code=mgrm2g8o42wxc"]);
    expect(v.kind).not.toBe("member");
  });
});
