import { describe, expect, it } from "vitest";
import { installMsw } from "../server";
import {
  THREECX_ANSWERED_CALL_ID,
  THREECX_BASE,
  THREECX_MISSED_CALL_ID,
  threecxDialled,
  threecxHandlers,
} from "./threecx";

/**
 * 3CX transport: token, the DN list, one DN with a live participant, makecall,
 * the Users list and the bound call-log function — the surfaces probed live on
 * 2026-09-13 (`docs/crm/3cx.md`).
 */

installMsw(...threecxHandlers);

describe("msw: 3CX call control", () => {
  it("token, /callcontrol and /callcontrol/{dn}", async () => {
    const tok = await fetch(`${THREECX_BASE}/connect/token`, {
      method: "POST",
      body: "client_id=x&client_secret=y&grant_type=client_credentials",
    });
    expect((await tok.json()).access_token).toBe("msw-3cx-token");

    const all = (await (await fetch(`${THREECX_BASE}/callcontrol`)).json()) as {
      dn: string;
      type: string;
    }[];
    expect(all.map((d) => d.dn)).toEqual(["141", "142", "100"]);

    const one = (await (await fetch(`${THREECX_BASE}/callcontrol/141`)).json()) as {
      participants: { status: string; party_caller_id: string; callid: number }[];
    };
    expect(one.participants[0].status).toBe("Connected");
    expect(one.participants[0].party_caller_id).toBe("12395551234");

    expect((await fetch(`${THREECX_BASE}/callcontrol/999`)).status).toBe(404);
  });

  it("makecall records what was dialled instead of dialling", async () => {
    threecxDialled.length = 0;
    const res = await fetch(`${THREECX_BASE}/callcontrol/9025/makecall`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destination: "+12395551234", timeout: 30 }),
    });
    expect((await res.json()).finalstatus).toBe("Success");
    expect(threecxDialled[0]).toEqual({
      extension: "9025",
      body: { destination: "+12395551234", timeout: 30 },
    });
  });
});

describe("msw: 3CX reports", () => {
  it("serves the Users list", async () => {
    const users = (await (
      await fetch(`${THREECX_BASE}/xapi/v1/Users?$select=Id,Number`)
    ).json()) as { value: { Number: string }[] };
    expect(users.value.map((u) => u.Number)).toContain("9027");
  });

  it("serves the BOUND call-log function, with the ugly multi-leg call intact", async () => {
    const res = await fetch(
      `${THREECX_BASE}/xapi/v1/ReportCallLogData/Pbx.GetCallLogData(periodFrom=2026-09-12T00:00:00Z,periodTo=2026-09-13T23:59:59Z,sourceType=0,sourceFilter='',destinationType=0,destinationFilter='',callsType=0,callTimeFilterType=0,callTimeFilterFrom='0:00:0',callTimeFilterTo='0:00:0',hidePcalls=true)?$top=5`,
    );
    const body = (await res.json()) as {
      value: { CallHistoryId: string; TalkingDuration: string }[];
    };
    expect(body.value).toHaveLength(5);
    // Three fixture rows are ONE call; that is the case `groupCallLog` exists for.
    expect(body.value.filter((r) => r.CallHistoryId === THREECX_ANSWERED_CALL_ID)).toHaveLength(2);
    expect(body.value.some((r) => r.CallHistoryId === THREECX_MISSED_CALL_ID)).toBe(true);
    // ISO-8601 durations, not seconds — the thing that would silently read as 0.
    expect(body.value[0].TalkingDuration).toMatch(/^PT/);
  });
});
