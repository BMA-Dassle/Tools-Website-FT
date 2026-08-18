import { describe, expect, it } from "vitest";
import { isRetryable } from "./client.server";

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
});
