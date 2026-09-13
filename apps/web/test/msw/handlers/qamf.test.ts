import { describe, expect, it } from "vitest";
import { installMsw } from "../server";
import { QAMF_BASE, QAMF_TOKEN_URL, qamfHandlers } from "./qamf";

/** QAMF transport: string ids, the shapes the availability grid reads. */

installMsw(...qamfHandlers);

describe("msw: QAMF bowling reservations", () => {
  it("token + lanes + reservations/search serve the documented shapes", async () => {
    const tok = await fetch(QAMF_TOKEN_URL, {
      method: "POST",
      body: "grant_type=client_credentials",
    });
    expect((await tok.json()).scope).toBe("bowling_reservations");

    const lanes = (await (await fetch(`${QAMF_BASE}/centers/9172/lanes`)).json()) as {
      Lanes: { LaneNumber: number; Status: string }[];
    };
    expect(lanes.Lanes.map((l) => l.LaneNumber)).toEqual([1, 5, 13, 14]);

    const search = (await (
      await fetch(`${QAMF_BASE}/centers/9172/reservations/search`, {
        method: "POST",
        headers: { "api-version": "1.4" },
        body: JSON.stringify({
          Filter: { Lanes: [{ StartTimeRange: { StartAt: "x", EndAt: "y" } }] },
        }),
      })
    ).json()) as {
      Reservations: {
        Id: string;
        Source: string;
        Lanes: { LaneNumber: number; StartTime: string }[];
      }[];
    };
    expect(search.Reservations).toHaveLength(2);
    // Ids are strings on this API (X… web, C… Conqueror) — no 17-digit trap here.
    expect(search.Reservations.map((r) => r.Id)).toEqual(["X2609121901", "C0000000123"]);
    // A multi-lane booking is an adjacent PAIR starting on an ODD lane (13, 14).
    expect(search.Reservations[0].Lanes.map((l) => l.LaneNumber)).toEqual([13, 14]);
    // Times carry the centre's offset, never Z.
    expect(search.Reservations[0].Lanes[0].StartTime).toMatch(/-04:00$/);
  });
});
