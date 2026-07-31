import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/booking-confirmation-link", () => ({ verifyBillSignature: vi.fn(() => false) }));
vi.mock("@/lib/waiver-link-send", () => ({
  waiverLinkForSuppliedUrl: vi.fn(async () => "https://fasttraxent.com/w/ORGcode123456789"),
}));
// officeProjectIdFromBillId stays REAL — the pid-binding under test IS its
// string math (billId + 1 on the last 10 digits, never Number()).

import { POST } from "./route";
import { verifyBillSignature } from "@/lib/booking-confirmation-link";
import { waiverLinkForSuppliedUrl } from "@/lib/waiver-link-send";

const mockVerify = vi.mocked(verifyBillSignature);
const mockMint = vi.mocked(waiverLinkForSuppliedUrl);

// A real-shaped 17-digit pair: pid = billId + 1.
const BILL_ID = "63000000006535250";
const PROJECT_ID = "63000000006535251";
const LONG_URL = `https://fasttraxent.com/waiver?c=fasttrax&loc=467486&pid=${PROJECT_ID}`;

function makeReq(body: unknown) {
  return new NextRequest("https://x/api/waiver/booking-link", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  mockVerify.mockReset().mockReturnValue(false);
  mockMint.mockReset().mockResolvedValue("https://fasttraxent.com/w/ORGcode123456789");
});

describe("POST /api/waiver/booking-link", () => {
  it("mints the ORGANIZER link when the bill signature and pid both check out", async () => {
    mockVerify.mockReturnValue(true);
    const res = await POST(makeReq({ billId: BILL_ID, sig: "goodsig", waiverUrl: LONG_URL }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, url: "https://fasttraxent.com/w/ORGcode123456789" });
    expect(mockVerify).toHaveBeenCalledWith(BILL_ID, "goodsig");
    expect(mockMint).toHaveBeenCalledWith(LONG_URL, "organizer");
    // The response carries a capability — it must never be cached or shared.
    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("accepts the relative form of the same link", async () => {
    mockVerify.mockReturnValue(true);
    const rel = `/waiver?c=fasttrax&loc=467486&pid=${PROJECT_ID}`;
    const res = await POST(makeReq({ billId: BILL_ID, sig: "goodsig", waiverUrl: rel }));
    expect(res.status).toBe(200);
    expect(mockMint).toHaveBeenCalledWith(rel, "organizer");
  });

  it("403s on a bad signature and never reaches the mint", async () => {
    const res = await POST(makeReq({ billId: BILL_ID, sig: "forged", waiverUrl: LONG_URL }));
    expect(res.status).toBe(403);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("403s when the pid is not the authorized bill's project (sig for A cannot mint for B)", async () => {
    mockVerify.mockReturnValue(true);
    const otherReservation = "https://fasttraxent.com/waiver?c=fasttrax&loc=467486&pid=51383608";
    const res = await POST(
      makeReq({ billId: BILL_ID, sig: "goodsig", waiverUrl: otherReservation }),
    );
    expect(res.status).toBe(403);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("403s when the supplied URL has no pid at all", async () => {
    mockVerify.mockReturnValue(true);
    const res = await POST(
      makeReq({ billId: BILL_ID, sig: "goodsig", waiverUrl: "/waiver?c=fasttrax" }),
    );
    expect(res.status).toBe(403);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("400s on a non-numeric billId (no bigint coercion) and on missing fields", async () => {
    mockVerify.mockReturnValue(true);
    for (const body of [
      { billId: "abc", sig: "s", waiverUrl: LONG_URL },
      { sig: "s", waiverUrl: LONG_URL },
      { billId: BILL_ID, waiverUrl: LONG_URL },
      { billId: BILL_ID, sig: "s" },
    ]) {
      const res = await POST(makeReq(body));
      expect(res.status).toBe(400);
    }
    expect(mockMint).not.toHaveBeenCalled();
  });
});
