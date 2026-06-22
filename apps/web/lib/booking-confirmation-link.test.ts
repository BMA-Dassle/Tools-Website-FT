import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Redis-backed shortener so these are pure unit tests.
vi.mock("@/lib/short-url", () => ({
  shortenUrl: vi.fn(async (_url: string, code?: string) => code ?? "RANDOM"),
}));

import { shortenUrl } from "@/lib/short-url";
import {
  signedConfirmationUrl,
  verifyBillSignature,
  confirmationShortCode,
  confirmationShortUrl,
} from "@/lib/booking-confirmation-link";

const mockedShorten = vi.mocked(shortenUrl);

// 17-digit BMI bigint — exactly the kind of id that must never be Number()'d.
const BILL = "63000000003876026";
const OTHER = "63000000003876027";

beforeEach(() => {
  mockedShorten.mockClear();
});

describe("confirmationShortCode", () => {
  it("is deterministic for a given billId", () => {
    expect(confirmationShortCode(BILL)).toBe(confirmationShortCode(BILL));
  });

  it("differs across billIds (even adjacent 17-digit ids)", () => {
    expect(confirmationShortCode(BILL)).not.toBe(confirmationShortCode(OTHER));
  });

  it("is an 8-char base64url string", () => {
    expect(confirmationShortCode(BILL)).toMatch(/^[A-Za-z0-9_-]{8}$/);
  });
});

describe("signedConfirmationUrl + verifyBillSignature", () => {
  it("round-trips its own signature", () => {
    const url = signedConfirmationUrl(BILL, true);
    const sig = new URL(url).searchParams.get("sig")!;
    expect(verifyBillSignature(BILL, sig)).toBe(true);
  });

  it("rejects a tampered signature", () => {
    expect(verifyBillSignature(BILL, "deadbeefdeadbeef")).toBe(false);
  });

  it("rejects a valid sig paired with a different billId", () => {
    const url = signedConfirmationUrl(BILL, true);
    const sig = new URL(url).searchParams.get("sig")!;
    expect(verifyBillSignature(OTHER, sig)).toBe(false);
  });

  it("embeds the raw billId and routes v2 vs v1 to the right page", () => {
    const v2 = new URL(signedConfirmationUrl(BILL, true));
    expect(v2.pathname).toBe("/book/confirmation/v2");
    expect(v2.searchParams.get("billId")).toBe(BILL);

    const v1 = new URL(signedConfirmationUrl(BILL, false));
    expect(v1.pathname).toBe("/book/confirmation");
    expect(v1.searchParams.get("billId")).toBe(BILL);
  });
});

describe("confirmationShortUrl", () => {
  it("stores the signed URL under the deterministic code and returns /s/{code}", async () => {
    const code = confirmationShortCode(BILL);
    const result = await confirmationShortUrl(BILL, true);

    // Stored with the deterministic code (idempotent re-mint).
    expect(mockedShorten).toHaveBeenCalledTimes(1);
    const [storedUrl, passedCode] = mockedShorten.mock.calls[0];
    expect(passedCode).toBe(code);
    expect(storedUrl).toContain(`billId=${BILL}`);
    expect(storedUrl).toContain("/book/confirmation/v2");

    // Returns the canonical short link.
    expect(result.endsWith(`/s/${code}`)).toBe(true);
  });

  it("yields the same short link on repeated calls (one code per bill)", async () => {
    const a = await confirmationShortUrl(BILL, true);
    const b = await confirmationShortUrl(BILL, true);
    expect(a).toBe(b);
  });
});
