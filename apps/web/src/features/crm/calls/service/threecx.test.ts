import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installMsw } from "../../../../../test/msw/server";
import { threecxDialled, threecxHandlers } from "../../../../../test/msw/handlers/threecx";
import {
  callLogPath,
  fetchCallLog,
  getCallControlDn,
  getThreecxToken,
  listCallControl,
  listUsers,
  makeCall,
  odataInstant,
  redactNumbers,
  resetThreecxTokenCache,
  threecxConfigured,
} from "./threecx";

/**
 * The 3CX client against MSW handlers whose fixtures were captured from the
 * live PBX on 2026-09-13 (`docs/crm/3cx.md`). What this pins is the shape of
 * the REQUESTS — above all the bound-function path, which is the only form the
 * PBX answers; the bare entity set is a 404 and `CallHistoryView` is a 500.
 */

installMsw(...threecxHandlers);

const savedId = process.env.THREECX_CLIENT_ID;
const savedSecret = process.env.THREECX_CLIENT_SECRET;

beforeEach(() => {
  process.env.THREECX_CLIENT_ID = "vercel";
  process.env.THREECX_CLIENT_SECRET = "test-secret";
  resetThreecxTokenCache();
  threecxDialled.length = 0;
});

afterEach(() => {
  if (savedId === undefined) delete process.env.THREECX_CLIENT_ID;
  else process.env.THREECX_CLIENT_ID = savedId;
  if (savedSecret === undefined) delete process.env.THREECX_CLIENT_SECRET;
  else process.env.THREECX_CLIENT_SECRET = savedSecret;
  resetThreecxTokenCache();
});

describe("credential", () => {
  it("needs BOTH halves", () => {
    expect(threecxConfigured()).toBe(true);
    delete process.env.THREECX_CLIENT_SECRET;
    expect(threecxConfigured()).toBe(false);
  });

  it("refuses to reach out at all without one", async () => {
    delete process.env.THREECX_CLIENT_ID;
    resetThreecxTokenCache();
    await expect(getThreecxToken()).rejects.toThrow("3cx_not_configured");
  });

  it("caches the token", async () => {
    const a = await getThreecxToken();
    const b = await getThreecxToken();
    expect(a).toBe("msw-3cx-token");
    expect(b).toBe(a);
  });
});

describe("call control", () => {
  it("lists DNs and reads one", async () => {
    const all = await listCallControl();
    expect(all.map((d) => d.dn)).toEqual(["141", "142", "100"]);
    const one = await getCallControlDn("141");
    expect(one?.participants?.[0]?.status).toBe("Connected");
  });

  it("answers null for a DN the PBX does not have", async () => {
    expect(await getCallControlDn("999")).toBeNull();
  });

  it("makecall posts {destination, timeout} to the rep's extension", async () => {
    const res = await makeCall("9025", "+12395551234", 30);
    expect(res.finalstatus).toBe("Success");
    expect(threecxDialled).toEqual([
      { extension: "9025", body: { destination: "+12395551234", timeout: 30 } },
    ]);
  });
});

describe("users", () => {
  it("reads the extension ↔ person list", async () => {
    const users = await listUsers();
    expect(users.find((u) => u.Number === "9027")?.LastName).toBe("Tajkowski");
  });
});

describe("the call log", () => {
  it("uses the BOUND OData function with all twelve required parameters", () => {
    const path = callLogPath(new Date("2026-09-12T00:00:00Z"), new Date("2026-09-13T23:59:59Z"));
    expect(path).toContain("/xapi/v1/ReportCallLogData/Pbx.GetCallLogData(");
    // The bare entity set 404s and CallHistoryView 500s — neither may creep back.
    expect(path).not.toContain("CallHistoryView");
    expect(path).not.toMatch(/ReportCallLogData\?/);
    for (const p of [
      "periodFrom=2026-09-12T00:00:00Z",
      "periodTo=2026-09-13T23:59:59Z",
      "sourceType=0",
      "sourceFilter=''",
      "destinationType=0",
      "destinationFilter=''",
      "callsType=0",
      "callTimeFilterType=0",
      "callTimeFilterFrom='0:00:0'",
      "callTimeFilterTo='0:00:0'",
      "hidePcalls=true",
    ]) {
      expect(path).toContain(p);
    }
  });

  it("drops the milliseconds the PBX will not parse", () => {
    expect(odataInstant(new Date("2026-09-13T18:11:27.302Z"))).toBe("2026-09-13T18:11:27Z");
  });

  it("returns the CDR rows, with GUID ids left as strings", async () => {
    const rows = await fetchCallLog({
      from: new Date("2026-09-12T00:00:00Z"),
      to: new Date("2026-09-13T23:59:59Z"),
    });
    expect(rows).toHaveLength(5);
    expect(typeof rows[0].CallHistoryId).toBe("string");
    expect(rows[0].TalkingDuration).toBe("PT1M12.577027S");
  });

  it("clamps `top` to what the PBX will serve", async () => {
    const rows = await fetchCallLog({
      from: new Date("2026-09-12T00:00:00Z"),
      to: new Date("2026-09-13T23:59:59Z"),
      top: 99_999,
    });
    expect(rows).toHaveLength(5);
  });
});

describe("redactNumbers", () => {
  it("masks anything long enough to be a phone number, at any depth", () => {
    const out = redactNumbers({ a: "+12395551234", b: [{ c: "9027" }], d: 5 }) as {
      a: string;
      b: { c: string }[];
      d: number;
    };
    expect(out.a).not.toContain("5551234");
    expect(out.b[0].c).toBe("9027");
    expect(out.d).toBe(5);
  });

  it("keeps a Date instead of blanking it to {}", () => {
    // A Date has no own enumerable keys; the naive object branch turns it into
    // `{}` and a probe report loses its timestamps without saying so.
    const out = redactNumbers({ at: new Date("2026-09-13T18:11:27.302Z") }) as { at: string };
    expect(out.at).toBe("2026-09-13T18:11:27.302Z");
  });
});
