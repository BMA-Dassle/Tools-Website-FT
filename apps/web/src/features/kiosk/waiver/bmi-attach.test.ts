/**
 * The two defects a live probe found in the BMI waiver attach (2026-07-30).
 *
 * Both were silent. Together they meant the kiosk/waiver join route could record a
 * guest as attached to a reservation they were never added to — the staff waiver %
 * stays wrong, and nothing retries because nothing looked broken.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/bmi-office-actions", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getPublicBookingToken: vi.fn(async () => "tok"),
}));

import { registerProjectPersonServer } from "./bmi-attach";
import { billIdFromOfficeProjectId, officeProjectIdFromBillId } from "@/lib/bmi-office-actions";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function reply(status: number, body: string) {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });
}

const ARGS = {
  clientKey: "headpinzftmyers",
  orderId: "63000000006754861",
  personId: "56906741",
  firstName: "Ross",
  lastName: "Geller",
};

describe("billIdFromOfficeProjectId", () => {
  it("is the exact inverse of officeProjectIdFromBillId", () => {
    for (const billId of ["63000000006754861", "63000000006026882", "51383607", "1000000000"]) {
      expect(billIdFromOfficeProjectId(officeProjectIdFromBillId(billId))).toBe(billId);
    }
  });

  it("keeps the 17-digit prefix as raw text (never through Number())", () => {
    // 63000000006754862 > Number.MAX_SAFE_INTEGER; only the last 10 digits are safe.
    expect(billIdFromOfficeProjectId("63000000006754862")).toBe("63000000006754861");
    expect(billIdFromOfficeProjectId("63000000006754862")).not.toContain("e");
  });

  it("refuses rather than borrowing past the 10-digit window", () => {
    // A wrong id here attaches a guest to somebody else's booking, so the only safe
    // answer when the decrement would carry into the raw-text prefix is "no".
    expect(billIdFromOfficeProjectId("63000000000000000")).toBeNull(); // last 10 are zeros
    expect(billIdFromOfficeProjectId("0")).toBeNull();
    expect(billIdFromOfficeProjectId("abc")).toBeNull();
    expect(billIdFromOfficeProjectId("")).toBeNull();
    // NB a short id is not invalid — "123" decrements cleanly to "122".
    expect(billIdFromOfficeProjectId("123")).toBe("122");
  });
});

describe("registerProjectPersonServer", () => {
  it("sends the caller's orderId through verbatim, raw-injected", async () => {
    // NO conversion happens in here any more. It briefly did, and that broke the
    // kiosk CHECK-IN flow, which correctly passes a billId already — one shared
    // function cannot both convert and not convert. Callers holding a projectId
    // convert at their own call site.
    reply(200, '{"success":true}');
    await registerProjectPersonServer(ARGS);
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).toContain('"orderId":63000000006754861');
    // Ids raw-injected, never quoted or rounded through Number().
    expect(body).toContain('"personId":56906741');
    expect(body).not.toContain('"orderId":"');
  });

  it("treats HTTP 200 with success:false as a FAILURE", async () => {
    // The exact live response. `res.ok` alone reported this as attached.
    reply(
      200,
      '{"success":false,"errorMessage":"Cannot find the reservation for bill 63000000006754862"}',
    );
    const r = await registerProjectPersonServer(ARGS);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(200);
  });

  it("accepts a 2xx that does not declare failure", async () => {
    reply(200, '{"success":true}');
    expect((await registerProjectPersonServer(ARGS)).ok).toBe(true);
  });

  it("accepts a 2xx with an empty or non-JSON body", async () => {
    // A 200 with no payload stays a pass — only an explicit success:false demotes it.
    reply(200, "");
    expect((await registerProjectPersonServer(ARGS)).ok).toBe(true);
    reply(200, "OK");
    expect((await registerProjectPersonServer(ARGS)).ok).toBe(true);
  });

  it("still fails on a non-2xx", async () => {
    reply(500, "boom");
    expect((await registerProjectPersonServer(ARGS)).ok).toBe(false);
  });

  it("refuses a non-numeric id without calling BMI", async () => {
    const r = await registerProjectPersonServer({ ...ARGS, orderId: "abc" });
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
