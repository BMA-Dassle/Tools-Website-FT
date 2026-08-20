import { describe, it, expect } from "vitest";
import { SMS_OPT_OUT_FOOTER, segmentsFor, hasOptOutLanguage, withOptOutFooter } from "./footer";

describe("SMS_OPT_OUT_FOOTER", () => {
  it("is GSM-7 safe", () => {
    // A single curly apostrophe here would drop every message using it
    // from 160 chars per segment to 70.
    expect(/[^\x00-\x7F]/.test(SMS_OPT_OUT_FOOTER)).toBe(false);
  });

  it("names both required keywords", () => {
    // STOP for the opt-out expectation, HELP for TCR reject 30890.
    expect(SMS_OPT_OUT_FOOTER).toMatch(/STOP/);
    expect(SMS_OPT_OUT_FOOTER).toMatch(/HELP/);
  });

  it("leaves room for a real message in one segment", () => {
    // If the footer alone ate most of a segment this whole approach
    // would be untenable, so pin the budget it leaves behind.
    expect(SMS_OPT_OUT_FOOTER.length).toBeLessThan(45);
    expect(160 - SMS_OPT_OUT_FOOTER.length).toBeGreaterThan(115);
  });
});

describe("segmentsFor", () => {
  it("counts a short body as one segment", () => {
    expect(segmentsFor("FastTrax: your race is at 4pm.").segments).toBe(1);
  });

  it("treats exactly 160 GSM-7 chars as one segment", () => {
    const r = segmentsFor("a".repeat(160));
    expect(r.segments).toBe(1);
    expect(r.encoding).toBe("gsm7");
  });

  it("treats 161 chars as two segments", () => {
    expect(segmentsFor("a".repeat(161)).segments).toBe(2);
  });

  it("uses 153 chars per segment once concatenated, not 160", () => {
    // The 6-byte UDH costs 7 characters per part. 306 = 2 x 153.
    expect(segmentsFor("a".repeat(306)).segments).toBe(2);
    expect(segmentsFor("a".repeat(307)).segments).toBe(3);
  });

  it("collapses to a 70-char budget on ONE non-ASCII character", () => {
    // The emoji trap: a body that read as 1 segment becomes 2.
    const ascii = "a".repeat(80);
    expect(segmentsFor(ascii).segments).toBe(1);
    const withEmoji = ascii + "\u{1F3C6}";
    const r = segmentsFor(withEmoji);
    expect(r.encoding).toBe("ucs2");
    expect(r.segments).toBeGreaterThan(1);
  });

  it("reports zero segments for an empty body", () => {
    expect(segmentsFor("").segments).toBe(0);
  });
});

describe("hasOptOutLanguage — every wording already in the tree", () => {
  // Each of these is a real string from the repo. Appending our footer on
  // top would tell the guest to reply STOP twice.
  it("detects 'Reply STOP to opt out.'", () => {
    expect(hasOptOutLanguage("You're confirmed! Reply STOP to opt out.")).toBe(true);
  });

  it("detects the bare 'Reply STOP' promo form", () => {
    expect(hasOptOutLanguage("Free RSVP: headpinz.com/j - see you! Reply STOP")).toBe(true);
  });

  it("detects the 'Txt STOP' variant", () => {
    expect(hasOptOutLanguage("join us - see you! Txt STOP")).toBe(true);
  });

  it("detects the survey templates' 'STOP to opt out'", () => {
    expect(hasOptOutLanguage("headpinz.com/s/abc123\nSTOP to opt out")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(hasOptOutLanguage("reply stop to opt out")).toBe(true);
  });

  it("does not fire on an ordinary message mentioning stopping", () => {
    expect(hasOptOutLanguage("The track will stop for a caution period.")).toBe(false);
    expect(hasOptOutLanguage("Your race is at 4pm.")).toBe(false);
  });
});

describe("withOptOutFooter", () => {
  const body = "FastTrax: your e-ticket for the 4:00pm heat. fasttrax.com/t/ab12";

  it("appends to a transactional message", () => {
    const r = withOptOutFooter(body, "transactional");
    expect(r.appended).toBe(true);
    expect(r.body.endsWith(SMS_OPT_OUT_FOOTER)).toBe(true);
  });

  it("does NOT append to an OTP", () => {
    // A code the guest asked for seconds ago is the weakest case for
    // spending 38 characters, and OTP bypasses suppression anyway.
    const r = withOptOutFooter("Your FastTrax code is 481920", "otp");
    expect(r.appended).toBe(false);
    expect(r.skipReason).toBe("otp");
    expect(r.body).toBe("Your FastTrax code is 481920");
  });

  it("does not double up on a template that already has a footer", () => {
    const already = "HeadPinz: You're confirmed! Reply STOP to opt out.";
    const r = withOptOutFooter(already, "transactional");
    expect(r.appended).toBe(false);
    expect(r.skipReason).toBe("already_present");
    expect(r.body).toBe(already);
  });

  it("leaves an empty body alone", () => {
    const r = withOptOutFooter("   ", "transactional");
    expect(r.appended).toBe(false);
    expect(r.skipReason).toBe("empty_body");
  });

  it("keeps a short message in one segment", () => {
    const r = withOptOutFooter(body, "transactional");
    expect(r.segments).toBe(1);
    expect(r.crossedBoundary).toBe(false);
  });

  it("flags when appending crosses a segment boundary", () => {
    // 140 chars fits; 140 + 38 does not. This flag is the audit signal
    // that says WHICH template needs shortening.
    const tight = "a".repeat(140);
    expect(segmentsFor(tight).segments).toBe(1);
    const r = withOptOutFooter(tight, "transactional");
    expect(r.segments).toBe(2);
    expect(r.crossedBoundary).toBe(true);
  });

  it("does not flag a body that was already multi-segment", () => {
    // Already 2 segments and still 2 afterwards — the footer did not
    // cost anything, so it should not show up in the audit.
    const long = "a".repeat(200);
    const r = withOptOutFooter(long, "transactional");
    expect(r.segments).toBe(2);
    expect(r.crossedBoundary).toBe(false);
  });

  it("appends for safety and marketing categories too", () => {
    expect(withOptOutFooter(body, "safety").appended).toBe(true);
    expect(withOptOutFooter(body, "marketing").appended).toBe(true);
  });
});
