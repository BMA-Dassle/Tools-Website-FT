import { describe, expect, it } from "vitest";
import {
  EMAIL_SEND_RETRY_KIND,
  ERROR_CLAUSE_MAX,
  GRAPH_FETCH_MESSAGE_KIND,
  emailSendRetryIdempotencyKey,
  graphFetchIdempotencyKey,
  shortErrorClause,
} from "./contracts";

/**
 * The sub's pure module: the job keys the public webhook route imports
 * DIRECTLY (so a route test cannot stub the key it asserts) and the clamp that
 * keeps an upstream body out of a browser.
 */

describe("idempotency keys", () => {
  it("lowercases the mailbox so two casings are one row", () => {
    expect(graphFetchIdempotencyKey("Kelsea@HeadPinz.com", "AAMk1")).toBe(
      `${GRAPH_FETCH_MESSAGE_KIND}:kelsea@headpinz.com:AAMk1`,
    );
    expect(graphFetchIdempotencyKey("kelsea@headpinz.com", "AAMk1")).toBe(
      graphFetchIdempotencyKey("KELSEA@HEADPINZ.COM", "AAMk1"),
    );
  });

  it("keeps the message id EXACTLY — Graph ids are case-sensitive", () => {
    expect(graphFetchIdempotencyKey("a@b.com", "AaBb1")).toMatch(/:AaBb1$/);
  });

  it("keys a send retry by the link row, so one row is retried once", () => {
    expect(emailSendRetryIdempotencyKey("500")).toBe(`${EMAIL_SEND_RETRY_KIND}:500`);
  });
});

describe("shortErrorClause", () => {
  it("keeps a short, already-safe complaint whole", () => {
    expect(shortErrorClause("SendGrid 401")).toBe("SendGrid 401");
  });

  it("stops at the first clause — an AADSTS dump does not reach the browser", () => {
    const upstream =
      "AADSTS7000215: Invalid client secret provided. Trace ID: 9f2a-...; Correlation ID: 7c1d-...; Timestamp: 2026-09-13";
    expect(shortErrorClause(upstream)).toBe("AADSTS7000215: Invalid client secret provided.");
  });

  it("takes the first line only, and clamps a single long one", () => {
    expect(shortErrorClause("first line\nsecond line")).toBe("first line");
    const long = "x".repeat(400);
    const out = shortErrorClause(long)!;
    expect(out).toHaveLength(ERROR_CLAUSE_MAX);
    expect(out.endsWith("…")).toBe(true);
  });

  it("has nothing to say about nothing", () => {
    expect(shortErrorClause(null)).toBeNull();
    expect(shortErrorClause("")).toBeNull();
    expect(shortErrorClause("   \n  ")).toBeNull();
  });
});
