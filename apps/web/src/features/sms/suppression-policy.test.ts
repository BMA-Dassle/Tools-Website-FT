import { describe, it, expect } from "vitest";
import { decideSend, type SendCategory } from "./suppression-policy";

const clean = { suppressed: false, lookupFailed: false };
const revoked = { suppressed: true, lookupFailed: false };
const broken = { suppressed: false, lookupFailed: true };

describe("decideSend — default allow", () => {
  it("sends a transactional message when no revocation is on file", () => {
    const d = decideSend("transactional", clean);
    expect(d.allow).toBe(true);
    expect(d.outcome).toBe("allowed");
    expect(d.bypassUsed).toBe(false);
  });

  it("does not require an opt-in row to send an e-ticket", () => {
    // The inverse default from marketing_consent, and the reason the
    // e-ticket that admits a guest keeps working. Getting this backwards
    // is the W51654 failure: email arrived, text silently did not.
    expect(decideSend("transactional", clean).allow).toBe(true);
    expect(decideSend("otp", clean).allow).toBe(true);
    expect(decideSend("safety", clean).allow).toBe(true);
  });
});

describe("decideSend — honors revocation", () => {
  it("blocks a transactional message to a revoked number", () => {
    const d = decideSend("transactional", revoked);
    expect(d.allow).toBe(false);
    expect(d.outcome).toBe("blocked_suppressed");
  });

  it("still delivers an OTP to a revoked number", () => {
    // A guest who opted out of texts must still be able to sign in.
    const d = decideSend("otp", revoked);
    expect(d.allow).toBe(true);
    expect(d.outcome).toBe("bypassed_suppression");
  });

  it("still delivers a safety message to a revoked number", () => {
    expect(decideSend("safety", revoked).allow).toBe(true);
  });

  it("flags every bypass so it can be logged", () => {
    // An unlogged bypass is indistinguishable from ignoring the opt-out.
    expect(decideSend("otp", revoked).bypassUsed).toBe(true);
    expect(decideSend("safety", revoked).bypassUsed).toBe(true);
  });
});

describe("decideSend — lookup failure direction", () => {
  it("fails CLOSED for transactional", () => {
    // Texting someone who revoked is a per-message statutory violation.
    // Not texting them delays a message that also goes out by email.
    const d = decideSend("transactional", broken);
    expect(d.allow).toBe(false);
    expect(d.outcome).toBe("blocked_lookup_failed");
  });

  it("fails OPEN for OTP", () => {
    // Otherwise a database blip locks guests out of their own accounts.
    const d = decideSend("otp", broken);
    expect(d.allow).toBe(true);
    expect(d.bypassUsed).toBe(true);
  });

  it("fails OPEN for safety", () => {
    expect(decideSend("safety", broken).allow).toBe(true);
  });

  it("fails CLOSED for marketing", () => {
    expect(decideSend("marketing", broken).allow).toBe(false);
  });
});

describe("decideSend — marketing is never authorized here", () => {
  it("refuses marketing even on a completely clean number", () => {
    // "Not suppressed" is not "opted in". A future promo must not be
    // able to inherit transactional's default by picking a category.
    const d = decideSend("marketing", clean);
    expect(d.allow).toBe(false);
    expect(d.outcome).toBe("blocked_marketing_needs_opt_in");
  });

  it("refuses marketing to a revoked number", () => {
    expect(decideSend("marketing", revoked).allow).toBe(false);
  });
});

describe("decideSend — only two categories may override a revocation", () => {
  it("holds for every category", () => {
    const canBypass: SendCategory[] = ["otp", "safety"];
    const cannot: SendCategory[] = ["transactional", "marketing"];
    for (const c of canBypass) {
      expect(decideSend(c, revoked).allow, `${c} should bypass`).toBe(true);
    }
    for (const c of cannot) {
      expect(decideSend(c, revoked).allow, `${c} must not bypass`).toBe(false);
    }
  });

  it("always returns a reason string for the skip record", () => {
    const all: SendCategory[] = ["transactional", "otp", "safety", "marketing"];
    for (const c of all) {
      for (const s of [clean, revoked, broken]) {
        expect(decideSend(c, s).reason.length).toBeGreaterThan(0);
      }
    }
  });
});
