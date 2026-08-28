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

describe("intercard clearAccount — TPI_ClearAccount envelope", () => {
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
            `<TPI_ClearAccountResponse xmlns="http://tempuri.org/">` +
            `<TPI_ClearAccountResult>0</TPI_ClearAccountResult></TPI_ClearAccountResponse>`,
        } as unknown as Response;
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("wraps account numbers in <long> (int64), NOT <string> — the silent-no-op trap", async () => {
    const { clearAccount } = await import("./intercard");
    const res = await clearAccount({ locationCode: 12, accountNumbers: ["1062056"] });

    expect(res.code).toBe(0);
    const body = captured!.body;
    expect(captured!.headers.SOAPAction).toBe('"http://tempuri.org/TPI_ClearAccount"');
    // The account array item MUST be <long> — a <string> item deserializes to an
    // empty long[] server-side and the clear no-ops while still returning 0.
    expect(body).toContain("<Account><long>1062056</long></Account>");
    expect(body).not.toContain("<Account><string>1062056</string></Account>");
    // MAC_ID items stay <string> (they genuinely are strings) — don't regress that.
    expect(body).toContain("<MAC_ID><string>TESTMAC123</string></MAC_ID>");
    expect(body).toContain("<LocID>12</LocID>");
  });

  it("wraps multiple accounts each in its own <long>", async () => {
    const { clearAccount } = await import("./intercard");
    await clearAccount({ locationCode: 13, accountNumbers: ["1062056", "1038010"] });
    expect(captured!.body).toContain("<long>1062056</long><long>1038010</long>");
  });
});

describe("intercard verifyAccount — balance + history parse", () => {
  afterEach(() => vi.unstubAllGlobals());

  const HISTORY_RESPONSE =
    `<AcountHistoryWithPhotoXMLResponse xmlns="http://tempuri.org/">` +
    `<AcountHistoryWithPhotoXMLResult>0</AcountHistoryWithPhotoXMLResult>` +
    `<AccountBalance><Account>1038010</Account><Name> , </Name><statusText>Active</statusText>` +
    `<TokenBalance>480</TokenBalance><TokenBonusBalance>20</TokenBonusBalance>` +
    `<PointBalance>90</PointBalance>` +
    `<TPLY_Duration>15</TPLY_Duration><CashBalance>0.0000</CashBalance>` +
    `<Trans>` +
    `<AccountTransactions><Device>Hot Wheels</Device><TransType>Game Play</TransType>` +
    `<Tokens>-20</Tokens><TokenBonus>0</TokenBonus><Points>0</Points><Cash>0.0000</Cash>` +
    `<TimeStamp>2026-07-15 22:26:08</TimeStamp><Location>FastTrax Fort Myers</Location></AccountTransactions>` +
    `<AccountTransactions><Device>Hot Wheels</Device><TransType>Ticket Credits</TransType>` +
    `<Tokens>0</Tokens><TokenBonus>0</TokenBonus><Points>10</Points><Cash>0.0000</Cash>` +
    `<TimeStamp>2026-07-15 22:26:34</TimeStamp><Location>FastTrax Fort Myers</Location></AccountTransactions>` +
    `<AccountTransactions><Device>Consolidation</Device><TransType>Credit</TransType>` +
    `<Tokens>50</Tokens><TokenBonus>0</TokenBonus><Points>0</Points><Cash>0.0000</Cash>` +
    `<TimeStamp>2026-07-15 22:25:00</TimeStamp><Location>FastTrax Fort Myers</Location></AccountTransactions>` +
    `</Trans></AccountBalance></AcountHistoryWithPhotoXMLResponse>`;

  it("maps TokenBalance/TokenBonusBalance/TPLY_Duration and parses each transaction", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => HISTORY_RESPONSE,
      })) as unknown as typeof fetch,
    );
    const { verifyAccount } = await import("./intercard");
    const r = await verifyAccount("1038010", 12);

    expect(r.exists).toBe(true);
    expect(r.balance).toEqual({ tokens: 480, bonusTokens: 20, eTickets: 90, timeMinutes: 15 });
    expect(r.transactions).toHaveLength(3);
    expect(r.transactions?.[0]).toMatchObject({
      device: "Hot Wheels",
      transType: "Game Play",
      tokens: -20,
      points: 0,
      location: "FastTrax Fort Myers",
    });
    expect(r.transactions?.[1]).toMatchObject({ transType: "Ticket Credits", points: 10 });
    // "Consolidation" (how a web reload posts to Intercard) shows as "Web".
    expect(r.transactions?.[2]).toMatchObject({ device: "Web", transType: "Credit", tokens: 50 });
  });

  it("treats a non-zero result as card-not-found (never charges downstream) — -1 is AMBIGUOUS", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          `<AcountHistoryWithPhotoXMLResponse><AcountHistoryWithPhotoXMLResult>-1</AcountHistoryWithPhotoXMLResult></AcountHistoryWithPhotoXMLResponse>`,
      })) as unknown as typeof fetch,
    );
    const { verifyAccount } = await import("./intercard");
    const r = await verifyAccount("999", 12);
    expect(r.exists).toBe(false);
    // A server exception is not proof the account is absent — the swipe-to-buy
    // rail must not sell this card as new.
    expect(r.notFound).toBe("ambiguous");
  });

  it("result 1 with an all-zero balance block is a CONFIRMED not-found (live shape, 2026-08-28 probe)", async () => {
    // Captured off the live service for an account Intercard has never seen —
    // exactly what a blank card looks like before its first credit.
    const UNKNOWN_RESPONSE =
      `<AcountHistoryWithPhotoXMLResponse xmlns="http://tempuri.org/">` +
      `<AcountHistoryWithPhotoXMLResult>1</AcountHistoryWithPhotoXMLResult>` +
      `<AccountBalance><Account>999999999999</Account><Status>0</Status>` +
      `<CashBalance>0</CashBalance><BonusCashBalance>0</BonusCashBalance><PointBalance>0</PointBalance>` +
      `<Firstused>0001-01-01T00:00:00</Firstused><Lastused>0001-01-01T00:00:00</Lastused>` +
      `<TodateCashIn>0</TodateCashIn><TodaysCashIn>0</TodaysCashIn><CardRegistered>false</CardRegistered>` +
      `<GroupID>0</GroupID><TokenBalance>0</TokenBalance><TokenBonusBalance>0</TokenBonusBalance>` +
      `<TPLY_Duration>0</TPLY_Duration></AccountBalance></AcountHistoryWithPhotoXMLResponse>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => UNKNOWN_RESPONSE,
      })) as unknown as typeof fetch,
    );
    const { verifyAccount } = await import("./intercard");
    const r = await verifyAccount("999999999999", 12);
    expect(r.exists).toBe(false);
    expect(r.notFound).toBe("confirmed");
    expect(r.balance).toBeUndefined();
  });

  it("surfaces a cash balance so a card holding cash never reads as empty stock", async () => {
    const CASH_RESPONSE =
      `<AcountHistoryWithPhotoXMLResponse xmlns="http://tempuri.org/">` +
      `<AcountHistoryWithPhotoXMLResult>0</AcountHistoryWithPhotoXMLResult>` +
      `<AccountBalance><Account>1</Account><statusText>Expired</statusText>` +
      `<CashBalance>20.0000</CashBalance><BonusCashBalance>50.0000</BonusCashBalance><PointBalance>0</PointBalance>` +
      `<TokenBalance>0</TokenBalance><TokenBonusBalance>0</TokenBonusBalance><TPLY_Duration>0</TPLY_Duration>` +
      `</AccountBalance></AcountHistoryWithPhotoXMLResponse>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => CASH_RESPONSE,
      })) as unknown as typeof fetch,
    );
    const { verifyAccount } = await import("./intercard");
    const r = await verifyAccount("1", 12);
    expect(r.exists).toBe(true);
    expect(r.balance).toEqual({ tokens: 0, bonusTokens: 0, eTickets: 0, timeMinutes: 0 });
    expect(r.cashBalance).toBe(70);
  });
});
