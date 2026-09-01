import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Credentials must be set before the config module is imported (it reads env at load).
vi.stubEnv("INTERCARD_MAC", "00:15:5D:56:DE:02"); // deliberately colon form — must be normalised
vi.stubEnv("INTERCARD_CLIENT_TOKEN", "test.jwt.token");

interface Captured {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

// The client talks over node:https, NOT fetch — Api_External's read ops are
// GET-with-body, which WHATWG fetch refuses outright ("Request with GET/HEAD
// method cannot have body"). Mocking the transport it actually uses is the
// whole point: a stubbed `fetch` would happily pass while production failed on
// every read.
const httpsMock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({
  request: httpsMock.request,
  default: { request: httpsMock.request },
}));

/** Stub node:https with a fixed JSON response, capturing the outgoing request. */
function stubJson(status: number, payload: unknown, box: { req: Captured | null }) {
  httpsMock.request.mockImplementation((opts: any, cb: (res: any) => void) => {
    let body = "";
    const res = {
      statusCode: status,
      setEncoding() {},
      on(ev: string, fn: (chunk?: string) => void) {
        if (ev === "data") fn(JSON.stringify(payload));
        if (ev === "end") fn();
        return res;
      },
    };
    return {
      on(ev: string, fn: (e: Error) => void) {
        void ev;
        void fn;
      },
      write(chunk: string) {
        body += chunk;
      },
      end() {
        box.req = {
          url: `https://${opts.hostname}${opts.path}`,
          method: String(opts.method),
          body,
          headers: opts.headers as Record<string, string>,
        };
        cb(res);
      },
      destroy() {},
    };
  });
}

const OK_BALANCE = {
  responseCode: 0,
  responseDescription: "Success",
  accountBalance: {
    accountNumber: 1098379,
    locID: 12,
    blockedAccessID: 0,
    registered: false,
    firstName: "",
    lastName: "",
    cashBalance: 0.0,
    cashBonusBalance: 0.0,
    tokenBalance: 200,
    tokenBonusBalance: 0,
    pointBalance: 0,
    tpDuration: 0,
  },
};

describe("intercard onsite client — auth + envelope", () => {
  const box: { req: Captured | null } = { req: null };

  beforeEach(() => {
    box.req = null;
    stubJson(200, OK_BALANCE, box);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    httpsMock.request.mockReset();
  });

  it("sends the three licence headers and the MAC in the BODY (not a header)", async () => {
    const { verifyAccount } = await import("./intercard-onsite");
    await verifyAccount("1098379", 12);

    const req = box.req!;
    expect(req.url).toContain("/Api_External/api/v1/tpi/balanceinquiry");
    // All four licence values: three headers…
    expect(req.headers.LocID).toBe("12");
    expect(req.headers.ProductCode).toBe("API-0331");
    expect(req.headers.ClientToken).toBe("test.jwt.token");
    // …and the MAC travels in the body, NOT as a header (the licence check
    // reads it from transactionRequest.macAddress).
    expect(req.headers.MAC).toBeUndefined();
    expect(req.headers.macaddress).toBeUndefined();
    expect(JSON.parse(req.body).transactionRequest.macAddress).toBe("00155D56DE02");
  });

  it("normalises a colon-formatted MAC to the uppercase separator-free form the licence row stores", async () => {
    const { verifyAccount, normaliseMac } = await import("./intercard-onsite");
    await verifyAccount("1098379", 12);

    // The env secret is "00:15:5D:56:DE:02"; sending that verbatim 401s,
    // because the licence compare is a plain string equality.
    expect(JSON.parse(box.req!.body).transactionRequest.macAddress).toBe("00155D56DE02");
    expect(normaliseMac("00-15-5d-50-66-00")).toBe("00155D506600");
    expect(normaliseMac("00155D56DE02")).toBe("00155D56DE02");
  });

  it("always populates sessionID and employeeID (empty values 400 before the licence check)", async () => {
    const { verifyAccount } = await import("./intercard-onsite");
    await verifyAccount("1098379", 12);

    const tr = JSON.parse(box.req!.body).transactionRequest;
    expect(tr.sessionID).toBeTruthy();
    expect(tr.employeeID).toBeTruthy();
    expect(tr.employeeName.firstName).toBe("Web");
    expect(tr.employeeName.lastName).toBe("Reload");
    // Timestamps are sent without a trailing Z — server binds a local DateTime.
    expect(tr.lT_DateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(tr.utC_DateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it("reads balances with a GET that carries a body (the server's contract)", async () => {
    const { verifyAccount } = await import("./intercard-onsite");
    const res = await verifyAccount("1098379", 12);

    expect(box.req!.method).toBe("GET");
    expect(box.req!.body).toBeTruthy();
    expect(res.exists).toBe(true);
    expect(res.balance).toEqual({ tokens: 200, bonusTokens: 0, eTickets: 0, timeMinutes: 0 });
  });
});

describe("intercard onsite client — account number precision", () => {
  const box: { req: Captured | null } = { req: null };
  beforeEach(() => {
    box.req = null;
    stubJson(200, { responseCode: 0, responseDescription: "Success" }, box);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    httpsMock.request.mockReset();
  });

  it("keeps a 17-digit account number verbatim as a string (no Number() rounding)", async () => {
    const { creditTokens } = await import("./intercard-onsite");
    const big = "12345678901234567"; // > Number.MAX_SAFE_INTEGER
    await creditTokens({
      locationCode: 12,
      accountNumber: big,
      tokens: 500,
      bonusTokens: 100,
      tpiTransactionID: "reload-abc",
    });

    // Must appear as a JSON *string*, byte-identical — a numeric literal here
    // would silently round the last digits.
    expect(box.req!.body).toContain(`"accountNumber":"${big}"`);
    const acct = JSON.parse(box.req!.body).creditAccounts.creditAccountsList[0].accountNumber;
    expect(acct).toBe(big);
    expect(typeof acct).toBe("string");
  });

  it("splits tokens and bonus tokens into separate buckets", async () => {
    const { creditTokens } = await import("./intercard-onsite");
    await creditTokens({
      locationCode: 12,
      accountNumber: "1098379",
      tokens: 500,
      bonusTokens: 100,
      tpiTransactionID: "reload-abc",
    });

    const row = JSON.parse(box.req!.body).creditAccounts.creditAccountsList[0];
    expect(row.tokens).toBe(500);
    expect(row.tokenBonus).toBe(100);
    // A token reload must not move cash/points/time.
    expect(row.cash).toBe(0);
    expect(row.cashBonus).toBe(0);
    expect(row.points).toBe(0);
    expect(row.tP_Duration).toBe(0);
  });

  it("sends consolidate sources as an accountNumbers array of strings", async () => {
    const { consolidateAccounts } = await import("./intercard-onsite");
    await consolidateAccounts({
      locationCode: 12,
      targetAccount: "1098379",
      sourceAccounts: ["1038010", "1038011"],
      tpiTransactionID: "consol-1",
    });

    const body = JSON.parse(box.req!.body);
    expect(box.req!.url).toContain("/consolidatecards");
    expect(body.consolidateCards.targetAccount).toBe("1098379");
    expect(body.consolidateCards.consolidateSourceAccountList.accountNumbers).toEqual([
      "1038010",
      "1038011",
    ]);
  });

  it("refuses an empty consolidate/clear account list rather than calling out", async () => {
    const { consolidateAccounts, clearAccount } = await import("./intercard-onsite");
    await expect(
      consolidateAccounts({
        locationCode: 12,
        targetAccount: "1",
        sourceAccounts: [],
        tpiTransactionID: "x",
      }),
    ).rejects.toThrow(/source account/i);
    await expect(
      clearAccount({ locationCode: 12, accountNumbers: [], tpiTransactionID: "x" }),
    ).rejects.toThrow(/at least one account/i);
  });
});

describe("intercard onsite client — failure modes are distinguishable", () => {
  const box: { req: Captured | null } = { req: null };
  afterEach(() => {
    vi.unstubAllGlobals();
    httpsMock.request.mockReset();
  });

  it("maps 401 to NOT_LICENSED (a config bug, not a site outage)", async () => {
    stubJson(401, { error: "ETPI requires up to date Licensing." }, box);
    const { verifyAccount } = await import("./intercard-onsite");
    await expect(verifyAccount("1098379", 12)).rejects.toMatchObject({ code: "NOT_LICENSED" });
  });

  it("maps 404 to RELAY_OFFLINE (licensed, but the site's relay is down)", async () => {
    stubJson(404, { error: "No SignalR client connected for LocID 12." }, box);
    const { verifyAccount } = await import("./intercard-onsite");
    await expect(verifyAccount("1098379", 12)).rejects.toMatchObject({ code: "RELAY_OFFLINE" });
  });

  it("maps 504 to RELAY_TIMEOUT", async () => {
    stubJson(504, { error: "Transaction timed out waiting for client response." }, box);
    const { verifyAccount } = await import("./intercard-onsite");
    await expect(verifyAccount("1098379", 12)).rejects.toMatchObject({ code: "RELAY_TIMEOUT" });
  });

  it("treats a non-zero responseCode on HTTP 200 as AMBIGUOUS, never as a confirmed blank card", async () => {
    // The relay returns 200 even when the operation failed — responseCode is
    // authoritative. A blank-card sale must NOT be triggered by this.
    stubJson(
      200,
      { responseCode: -2, responseDescription: "Exception occurred", accountBalance: null },
      box,
    );
    const { verifyAccount } = await import("./intercard-onsite");
    const res = await verifyAccount("1098379", 12);
    expect(res.exists).toBe(false);
    expect(res.notFound).toBe("ambiguous");
  });

  it("treats success-with-no-balance as a CONFIRMED absent account", async () => {
    stubJson(200, { responseCode: 0, responseDescription: "Success", accountBalance: null }, box);
    const { verifyAccount } = await import("./intercard-onsite");
    const res = await verifyAccount("1098379", 12);
    expect(res.exists).toBe(false);
    expect(res.notFound).toBe("confirmed");
  });
});

describe("intercard onsite client — probeOnsite status for the kiosk badge", () => {
  const box: { req: Captured | null } = { req: null };
  afterEach(() => {
    vi.unstubAllGlobals();
    httpsMock.request.mockReset();
  });

  it("reports 'onsite' when the relay answers a gamelist", async () => {
    stubJson(200, { responseCode: 0, responseDescription: "Success", gameList: [] }, box);
    const { probeOnsite } = await import("./intercard-onsite");
    expect(await probeOnsite(12)).toMatchObject({ status: "onsite" });
    expect(box.req!.url).toContain("/gamelist");
  });

  it("reports 'offline' when no relay is connected", async () => {
    stubJson(404, { error: "No SignalR client connected for LocID 12." }, box);
    const { probeOnsite } = await import("./intercard-onsite");
    expect(await probeOnsite(12)).toMatchObject({ status: "offline" });
  });

  it("reports 'unlicensed' distinctly from 'offline' so a config bug isn't read as an outage", async () => {
    stubJson(401, { error: "ETPI requires up to date Licensing." }, box);
    const { probeOnsite } = await import("./intercard-onsite");
    expect(await probeOnsite(12)).toMatchObject({ status: "unlicensed" });
  });

  it("never throws — the badge must render something for every failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const { probeOnsite } = await import("./intercard-onsite");
    expect(await probeOnsite(12)).toMatchObject({ status: "error" });
  });
});

describe("intercard onsite client — history", () => {
  const box: { req: Captured | null } = { req: null };
  afterEach(() => {
    vi.unstubAllGlobals();
    httpsMock.request.mockReset();
  });

  it("maps history rows and relabels Consolidation as Web", async () => {
    stubJson(
      200,
      {
        responseCode: 0,
        responseDescription: "Success",
        accountHistory: {
          accountBalance: null,
          accountHistoryList: [
            {
              deviceName: "FTBMI 1",
              transType: "Consolidation",
              tokens: 500,
              tokenBonus: 0,
              points: 0,
              cash: 0,
              timeStamp: "2026-07-23T01:33:00",
              location: "FastTrax Fort Myers",
            },
          ],
        },
      },
      box,
    );
    const { accountHistory } = await import("./intercard-onsite");
    const rows = await accountHistory("1098379", 12);
    expect(rows).toHaveLength(1);
    expect(rows[0].transType).toBe("Web");
    expect(rows[0].tokens).toBe(500);
  });

  it("returns an empty list (not a throw) when the service errors", async () => {
    stubJson(
      200,
      { responseCode: -1, responseDescription: "Exception", accountHistory: null },
      box,
    );
    const { accountHistory } = await import("./intercard-onsite");
    expect(await accountHistory("1098379", 12)).toEqual([]);
  });
});
