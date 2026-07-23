import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/waiver-acceptance", () => ({ logWaiverAcceptance: vi.fn(async () => {}) }));

import { POST } from "./route";
import { logWaiverAcceptance } from "@/lib/waiver-acceptance";

const mockLog = vi.mocked(logWaiverAcceptance);

function makeReq(body: unknown, headers?: Record<string, string>) {
  return new NextRequest("https://x/api/waiver/record", {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers || {}) },
    body: JSON.stringify(body),
  });
}

beforeEach(() => mockLog.mockClear());

describe("POST /api/waiver/record", () => {
  it("logs a self-sign acceptance (method=signature) and returns ok", async () => {
    const res = await POST(
      makeReq(
        {
          personId: "555",
          firstName: "Zzz Test",
          center: "fort-myers",
          waiverId: "W1",
          termsVersion: "CID9",
        },
        { "x-forwarded-for": "9.9.9.9, 1.1.1.1", "user-agent": "vitest-ua" },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockLog).toHaveBeenCalledTimes(1);
    const arg = mockLog.mock.calls[0][0];
    expect(arg).toMatchObject({
      method: "signature",
      personId: "555",
      firstName: "Zzz Test",
      center: "fort-myers",
      waiverId: "W1",
      termsVersion: "CID9",
      ipAddress: "9.9.9.9", // first x-forwarded-for hop
      userAgent: "vitest-ua",
    });
    expect(typeof arg.ts).toBe("string");
  });

  it("records the guardian on a minor's waiver (signedByPersonId)", async () => {
    await POST(makeReq({ personId: "100", signedByPersonId: "200", center: "naples" }));
    expect(mockLog.mock.calls[0][0]).toMatchObject({ personId: "100", signedByPersonId: "200" });
  });

  it("defaults termsVersion when absent", async () => {
    await POST(makeReq({ personId: "7" }));
    expect(mockLog.mock.calls[0][0].termsVersion).toBe("pandora-signature");
  });

  it("400s and does not log on a missing personId", async () => {
    const res = await POST(makeReq({ firstName: "x" }));
    expect(res.status).toBe(400);
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("400s on a non-numeric personId (no bigint coercion)", async () => {
    const res = await POST(makeReq({ personId: "abc" }));
    expect(res.status).toBe(400);
    expect(mockLog).not.toHaveBeenCalled();
  });
});
