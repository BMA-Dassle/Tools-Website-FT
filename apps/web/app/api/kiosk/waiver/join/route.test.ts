import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Contract test for the reservation-join payload.
 *
 * WHY THIS EXISTS (live failure 2026-08-07): this route has TWO callers that
 * disagree on one field. The kiosk group-waiver flow sends a real string
 * `kioskId`; the at-home /waiver flow has no kiosk and sends an explicit
 * `kioskId: null`. The schema said `.optional()`, which zod satisfies with
 * `undefined` but NOT with `null` — so every at-home join was rejected at body
 * validation, before the Neon persist. `kiosk_waiver_joins` had ZERO rows
 * table-wide while the UI told guests "we have them saved to your reservation",
 * and the only trace was a 400 in Vercel's log. The one caller that worked is
 * flag-OFF by default, so nothing exercised the good path.
 *
 * These tests pin the payload BOTH callers actually send.
 */

vi.mock("~/features/kiosk/data/kiosk-waiver-joins-db", () => ({
  upsertJoin: vi.fn(async () => ({ bmiAttachStatus: "pending" })),
  setJoinAttachStatus: vi.fn(async () => {}),
}));
vi.mock("~/features/kiosk/waiver/bmi-attach", () => ({
  registerProjectPersonServer: vi.fn(async () => ({ ok: true, status: 200 })),
}));
vi.mock("~/features/daily-events/service", () => ({
  clientKeyForLocation: () => "headpinzftmyers",
}));
vi.mock("@/lib/bmi-office-actions", () => ({
  billIdFromOfficeProjectId: () => "63000000007642343",
}));
vi.mock("~/features/kiosk/flags", () => ({ kioskWaiverBmiAttachEnabled: () => false }));
vi.mock("@/lib/redis", () => ({ default: { del: vi.fn(async () => {}) } }));

import { POST } from "./route";
import { upsertJoin } from "~/features/kiosk/data/kiosk-waiver-joins-db";

const mockUpsert = vi.mocked(upsertJoin);

/** The exact body useReservationJoinAttach sends. */
function joinBody(over: Record<string, unknown> = {}) {
  return {
    center: "fort-myers",
    locationId: 467486,
    projectId: "63000000007642344",
    personId: "58089323",
    firstName: "Test3",
    lastName: "Test3",
    ...over,
  };
}
function makeReq(body: unknown) {
  return new NextRequest("https://x/api/kiosk/waiver/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => mockUpsert.mockClear());

describe("POST /api/kiosk/waiver/join — payload contract", () => {
  it("ACCEPTS kioskId: null (the at-home /waiver flow) and persists to Neon", async () => {
    // The regression. Before the fix this returned 400 and wrote nothing.
    const res = await POST(makeReq(joinBody({ kioskId: null })));
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it("accepts a real kioskId string (the in-centre kiosk flow)", async () => {
    const res = await POST(makeReq(joinBody({ kioskId: "fort-myers:99" })));
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it("accepts an omitted kioskId", async () => {
    const res = await POST(makeReq(joinBody()));
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it("persists to Neon even when the BMI attach is disabled", async () => {
    // The house rule: Neon first, unconditional, never gated on the external API.
    await POST(makeReq(joinBody({ kioskId: null })));
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "63000000007642344", personId: "58089323" }),
    );
  });

  it("still rejects a genuinely malformed body without writing", async () => {
    const res = await POST(makeReq(joinBody({ personId: "not-digits" })));
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects a location that does not belong to the center", async () => {
    const res = await POST(makeReq(joinBody({ locationId: 332145, kioskId: null })));
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
