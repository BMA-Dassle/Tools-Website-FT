/**
 * A verified delivery DELETES a guest's PassKit record. These tests are about
 * what must NOT verify.
 *
 * The original endpoint checked a bearer token WE chose — but PassKit mints the
 * secret itself, so that check could never have matched a real delivery. It also
 * rejected before logging, so a permanently-broken webhook and a silent one
 * looked identical. Both are pinned here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { verifyPassKitWebhook } from "./webhook-auth";

/** A real PassKit-shaped secret: base64, 64 bytes decoded. */
const SECRET = "cJKEcrAvG4SQgov5yYrgYZ5HMOesxZcfYIbotQs25WwKHut9kCEoMmqVCqx6o+tqd1UrooGSMn/JkeyG/2B9Gg==";
const BODY = '{"externalId":"409523","event":"Uninstalled"}';
const URL_ = "https://fasttraxent.com/api/webhooks/passkit";

const h = (o: Record<string, string>) => new Headers(o);

beforeEach(() => {
  process.env.PASSKIT_WEBHOOK_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.PASSKIT_WEBHOOK_SECRET;
});

describe("closed by default", () => {
  it("verifies NOTHING when the secret is unset", () => {
    // The endpoint can delete a guest's credential. Unconfigured must mean inert,
    // never open.
    delete process.env.PASSKIT_WEBHOOK_SECRET;
    const mac = createHmac("sha256", SECRET).update(BODY).digest("hex");
    const out = verifyPassKitWebhook(h({ "x-signature": mac }), URL_, BODY);
    expect(out.verified).toBe(false);
  });

  it("reports the header names even when it refuses", () => {
    // The whole reason a misconfigured webhook was undiagnosable: it rejected
    // before logging anything about what arrived.
    delete process.env.PASSKIT_WEBHOOK_SECRET;
    const out = verifyPassKitWebhook(h({ "x-passkit-signature": "abc", "user-agent": "pk" }), URL_, BODY);
    expect(out.headerNames).toContain("x-passkit-signature");
    expect(out.headerNames).toContain("user-agent");
  });
});

describe("HMAC over the RAW body", () => {
  it("accepts a hex signature keyed on the secret as ASCII", () => {
    const mac = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(verifyPassKitWebhook(h({ "x-signature": mac }), URL_, BODY).verified).toBe(true);
  });

  it("accepts base64, and an algorithm-prefixed value", () => {
    const mac = createHmac("sha256", SECRET).update(BODY).digest("base64");
    expect(verifyPassKitWebhook(h({ "x-hmac": mac }), URL_, BODY).verified).toBe(true);
    expect(
      verifyPassKitWebhook(h({ "x-signature": `sha256=${mac}` }), URL_, BODY).verified,
    ).toBe(true);
  });

  it("accepts the secret used as DECODED KEY BYTES, not just ASCII", () => {
    // PassKit's secret is base64. Vendors split on whether the key is the string
    // or the bytes it encodes, and picking one is the difference between working
    // and a webhook that looks broken forever.
    const mac = createHmac("sha256", Buffer.from(SECRET, "base64")).update(BODY).digest("hex");
    expect(verifyPassKitWebhook(h({ "x-signature": mac }), URL_, BODY).verified).toBe(true);
  });

  it("REFUSES a signature computed over a different body", () => {
    // Re-serialising parsed JSON changes bytes; this is why the route reads
    // req.text() and never req.json().
    const mac = createHmac("sha256", SECRET).update('{"externalId":"409523"}').digest("hex");
    expect(verifyPassKitWebhook(h({ "x-signature": mac }), URL_, BODY).verified).toBe(false);
  });

  it("REFUSES a signature keyed on the wrong secret", () => {
    const mac = createHmac("sha256", "not-the-secret").update(BODY).digest("hex");
    expect(verifyPassKitWebhook(h({ "x-signature": mac }), URL_, BODY).verified).toBe(false);
  });

  it("ignores a correct digest in a header that is not signature-ish", () => {
    const mac = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(verifyPassKitWebhook(h({ "x-request-id": mac }), URL_, BODY).verified).toBe(false);
  });
});

describe("the secret presented verbatim", () => {
  it("accepts it as a bearer token or bare, and via ?secret=", () => {
    expect(verifyPassKitWebhook(h({ authorization: `Bearer ${SECRET}` }), URL_, BODY).verified).toBe(true);
    expect(verifyPassKitWebhook(h({ "x-passkit-secret": SECRET }), URL_, BODY).verified).toBe(true);
    expect(
      verifyPassKitWebhook(h({}), `${URL_}?secret=${encodeURIComponent(SECRET)}`, BODY).verified,
    ).toBe(true);
  });

  it("REFUSES a near-miss secret", () => {
    expect(verifyPassKitWebhook(h({ authorization: `Bearer ${SECRET}x` }), URL_, BODY).verified).toBe(false);
    expect(verifyPassKitWebhook(h({ authorization: "Bearer " }), URL_, BODY).verified).toBe(false);
  });

  it("REFUSES an empty request outright", () => {
    expect(verifyPassKitWebhook(h({}), URL_, "").verified).toBe(false);
  });
});

describe("never throws", () => {
  it("survives junk headers and an unparseable url", () => {
    // A malformed signature must be a refusal, not a 500 — timingSafeEqual
    // throws outright on a length mismatch.
    for (const v of ["", "x", "!!!", "z".repeat(500)]) {
      expect(() => verifyPassKitWebhook(h({ "x-signature": v }), "not a url", BODY)).not.toThrow();
      expect(verifyPassKitWebhook(h({ "x-signature": v }), "not a url", BODY).verified).toBe(false);
    }
  });
});

describe("reports HOW it verified", () => {
  it("names the matching mechanism so one real delivery settles the scheme", () => {
    const mac = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(verifyPassKitWebhook(h({ "x-passkit-signature": mac }), URL_, BODY).via).toBe(
      "hmac:x-passkit-signature",
    );
    expect(verifyPassKitWebhook(h({ authorization: SECRET }), URL_, BODY).via).toBe(
      "header:authorization",
    );
  });
});
