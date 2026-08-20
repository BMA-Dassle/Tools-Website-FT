import { describe, expect, it } from "vitest";
import { isNotOurVoucher, isRetryable } from "./client.server";

describe("isRetryable", () => {
  // Staging really does this: one code returned 400 UNKNOWN_ERROR three times
  // in a row and then 200. Groupon's own docs tell partners to retry this code.
  it("retries the transient UNKNOWN_ERROR 400", () => {
    expect(isRetryable(400, ["UNKNOWN_ERROR"])).toBe(true);
  });

  it("retries 5xx and 429", () => {
    expect(isRetryable(500, [])).toBe(true);
    expect(isRetryable(503, [])).toBe(true);
    expect(isRetryable(429, [])).toBe(true);
  });

  // These are verdicts, not flakes. Retrying them wastes time and, on a redeem,
  // hammers a voucher whose answer will never change.
  it("never retries a terminal verdict", () => {
    expect(isRetryable(400, ["UNIT_NOT_FOUND"])).toBe(false);
    expect(isRetryable(400, ["MALFORMED_REQUEST"])).toBe(false);
    expect(isRetryable(400, ["INVALID_STATE_TRANSITION"])).toBe(false);
  });

  it("never retries a signature failure — retrying a bad base string is futile", () => {
    expect(isRetryable(401, ["INVALID_REQUEST_SIGNATURE"])).toBe(false);
  });

  it("does not retry a success", () => {
    expect(isRetryable(200, [])).toBe(false);
  });

  // Production's "no such voucher" is FORBIDDEN, not UNIT_NOT_FOUND. Retrying it
  // would hammer a verdict that will never change.
  it("never retries FORBIDDEN", () => {
    expect(isRetryable(400, ["FORBIDDEN"])).toBe(false);
  });
});

/**
 * The two environments disagree on how they say "we have never heard of this
 * voucher": staging answers UNIT_NOT_FOUND, production answers FORBIDDEN.
 * Verified 2026-08-20 — garbage codes and a real non-Groupon barcode all came
 * back FORBIDDEN while a known code returned 200 on the same credentials, so it
 * is a per-code verdict and not an auth failure. Code that checks for only one
 * of them reports a nonexistent voucher as an OUTAGE, and tells the guest to
 * try again forever.
 */
describe("isNotOurVoucher", () => {
  it("recognises both environments' not-found codes", () => {
    expect(isNotOurVoucher(["UNIT_NOT_FOUND"])).toBe(true);
    expect(isNotOurVoucher(["FORBIDDEN"])).toBe(true);
  });

  it("does not swallow a real outage or a signing bug", () => {
    expect(isNotOurVoucher([])).toBe(false);
    expect(isNotOurVoucher(["UNKNOWN_ERROR"])).toBe(false);
    expect(isNotOurVoucher(["INVALID_REQUEST_SIGNATURE"])).toBe(false);
  });
});
