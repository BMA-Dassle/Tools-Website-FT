import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/redis", () => ({
  default: { del: vi.fn(async () => 1) },
}));
vi.mock("@/lib/bmi-office-actions", () => ({
  removeProjectPersonRow: vi.fn(async () => ({ removed: true, rowId: "row1" })),
}));
vi.mock("~/features/kiosk/data/kiosk-waiver-joins-db", () => ({
  removeJoin: vi.fn(async () => true),
}));
vi.mock("@/lib/waiver-short-link", () => ({
  WAIVER_LINK_COOKIE: "wv_cap",
  waiverLinkGrantsOrganizerFor: vi.fn(async () => false),
}));

import { POST } from "./route";
import redis from "@/lib/redis";
import { removeProjectPersonRow } from "@/lib/bmi-office-actions";
import { removeJoin } from "~/features/kiosk/data/kiosk-waiver-joins-db";
import { waiverLinkGrantsOrganizerFor } from "@/lib/waiver-short-link";

const mockRemove = vi.mocked(removeProjectPersonRow);
const mockJoin = vi.mocked(removeJoin);
const mockGrant = vi.mocked(waiverLinkGrantsOrganizerFor);
const mockDel = vi.mocked(redis.del);

const GOOD = { c: "fort-myers", loc: "467486", pid: "63000000006846994", personId: "57018085" };

function makeReq(body: unknown, cookie?: string) {
  const req = new NextRequest("https://x/api/waiver/roster-remove", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  if (cookie) req.cookies.set("wv_cap", cookie);
  return req;
}

beforeEach(() => {
  mockRemove.mockReset().mockResolvedValue({ removed: true, rowId: "row1" });
  mockJoin.mockReset().mockResolvedValue(true);
  mockGrant.mockReset().mockResolvedValue(false);
  mockDel.mockReset().mockResolvedValue(1 as never);
});

describe("POST /api/waiver/roster-remove", () => {
  it("removes for the ORGANIZER: BMI row + Neon join + both context caches busted", async () => {
    mockGrant.mockResolvedValue(true);
    const res = await POST(makeReq(GOOD, "ORGcode1234567890"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, bmiRemoved: true, joinDropped: true });
    expect(mockGrant).toHaveBeenCalledWith("ORGcode1234567890", GOOD.pid);
    expect(mockRemove).toHaveBeenCalledWith({
      clientKey: "headpinzftmyers",
      projectId: GOOD.pid,
      personId: GOOD.personId,
    });
    expect(mockJoin).toHaveBeenCalledWith(GOOD.pid, GOOD.personId);
    const busted = mockDel.mock.calls.map((c) => c[0]);
    expect(busted).toContain("waiver:ctx:467486:63000000006846994");
    expect(busted).toContain("waiver:ctx:state:v2:467486:63000000006846994");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("403s without the organizer grant and touches NOTHING", async () => {
    const res = await POST(makeReq(GOOD, "REGcode1234567890"));
    expect(res.status).toBe(403);
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockJoin).not.toHaveBeenCalled();
    expect(mockDel).not.toHaveBeenCalled();
  });

  it("treats not-on-project as success (the goal state is already true) but still drops the join", async () => {
    mockGrant.mockResolvedValue(true);
    mockRemove.mockResolvedValue({ removed: false, reason: "not-on-project" });
    const res = await POST(makeReq(GOOD, "ORGcode1234567890"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, bmiRemoved: false, joinDropped: true });
  });

  it("502s when BMI says removed but the verify re-read still finds the person", async () => {
    mockGrant.mockResolvedValue(true);
    mockRemove.mockResolvedValue({ removed: false, reason: "still-present" });
    const res = await POST(makeReq(GOOD, "ORGcode1234567890"));
    expect(res.status).toBe(502);
    expect(mockDel).not.toHaveBeenCalled(); // roster genuinely unchanged — keep the caches
  });

  it("400s on a bad center/loc pair or a non-digit id (no bigint coercion)", async () => {
    mockGrant.mockResolvedValue(true);
    for (const body of [
      { ...GOOD, c: "naples" }, // 467486 is not a Naples loc
      { ...GOOD, pid: "abc" },
      { ...GOOD, personId: "5.7e16" },
    ]) {
      const res = await POST(makeReq(body, "ORGcode1234567890"));
      expect(res.status).toBe(400);
    }
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
