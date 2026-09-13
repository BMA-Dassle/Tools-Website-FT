import { describe, expect, it } from "vitest";
import { installMsw } from "../server";
import { THREECX_BASE, threecxHandlers } from "./threecx";

/** 3CX transport: token, the DN list, one DN with a live participant. */

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
});
