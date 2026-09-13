import { beforeEach, describe, expect, it } from "vitest";
import { installMsw } from "../server";
import { VOX_SEND_URL, voxFixtures, voxHandlers, voxSent } from "./vox";

/** Vox transport: the send body is captured; the response carries the id `voxSendOnce` stores. */

installMsw(...voxHandlers);

beforeEach(() => {
  voxSent.length = 0;
});

describe("msw: Voxtelesys", () => {
  it("POST /sms captures what was sent and answers with a message id", async () => {
    const body = {
      to: "+12395551234",
      from: "+12392058142",
      body: "Hi Dana, it's Kelsea at HP Fort Myers!",
      status_callback: { url: "https://headpinz.com/api/sms-webhook/vox", method: "POST" },
    };
    const res = await fetch(VOX_SEND_URL, { method: "POST", body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("vx_01J7Q9Z4C2D6E8F0G1H2J3K4M5");
    expect(voxSent).toEqual([body]);
  });

  it("the MO sample is the inbound shape the webhook parses", () => {
    const mo = JSON.parse(voxFixtures.mo()) as Record<string, unknown>;
    expect(Object.keys(mo).sort()).toEqual(["body", "from", "id", "received_at", "to", "type"]);
    expect(mo.type).toBe("mo");
  });
});
