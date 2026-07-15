import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// MAC must be set before the config module is imported (it reads env at load).
vi.stubEnv("INTERCARD_MAC", "TESTMAC123");

describe("intercard SOAP client — creditTokens envelope", () => {
  let captured: { url: string; body: string; headers: Record<string, string> } | null = null;

  beforeEach(() => {
    captured = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        captured = {
          url: String(url),
          body: String(init.body),
          headers: init.headers as Record<string, string>,
        };
        return {
          ok: true,
          status: 200,
          text: async () =>
            `<?xml version="1.0"?><soap:Envelope><soap:Body>` +
            `<TPICreditAccountsResponse xmlns="http://tempuri.org/">` +
            `<TPICreditAccountsResult>0</TPICreditAccountsResult>` +
            `</TPICreditAccountsResponse></soap:Body></soap:Envelope>`,
        } as unknown as Response;
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("builds a valid envelope, splits tokens/bonus, keeps the account a string, and parses the result", async () => {
    const { creditTokens } = await import("./intercard");
    const res = await creditTokens({
      locationCode: 12,
      accountNumber: "1038010",
      tokens: 500,
      bonusTokens: 100,
      tpiTransactionID: "reload-abc",
    });

    expect(res.code).toBe(0);
    expect(captured).not.toBeNull();
    const body = captured!.body;

    // SOAPAction + operation
    expect(captured!.headers.SOAPAction).toBe('"http://tempuri.org/TPICreditAccounts"');
    expect(body).toContain("<TPICreditAccounts");

    // MAC as a <string> array item
    expect(body).toContain("<MAC_ID><string>TESTMAC123</string></MAC_ID>");
    expect(body).toContain("<LocationID>12</LocationID>");

    // Tokens vs BonusTokens land in separate buckets
    expect(body).toContain("&lt;Tokens&gt;500&lt;/Tokens&gt;");
    expect(body).toContain("&lt;BonusTokens&gt;100&lt;/BonusTokens&gt;");

    // Account number preserved verbatim as a string (no Number() rounding)
    expect(body).toContain("&lt;AccountNumber&gt;1038010&lt;/AccountNumber&gt;");

    // TimeDateMap struct fields present (not a single dateTime)
    expect(body).toMatch(/<LT_DateTime><Year>\d+<\/Year>/);
    expect(body).toContain("<Millisecond>");

    // Stable idempotency key echoed
    expect(body).toContain("<tpiTransactionID>reload-abc</tpiTransactionID>");
  });

  it("surfaces the raw result code (-2 = MAC not registered)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          `<TPICreditAccountsResponse><TPICreditAccountsResult>-2</TPICreditAccountsResult></TPICreditAccountsResponse>`,
      })) as unknown as typeof fetch,
    );
    const { creditTokens } = await import("./intercard");
    const res = await creditTokens({
      locationCode: 12,
      accountNumber: "1038010",
      tokens: 50,
      bonusTokens: 0,
      tpiTransactionID: "reload-xyz",
    });
    expect(res.code).toBe(-2);
  });
});
