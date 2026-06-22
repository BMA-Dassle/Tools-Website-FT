import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/booking-confirmation-link", () => ({
  confirmationShortUrl: vi.fn(
    async (billId: string, v2?: boolean) => `https://x/s/CODE-${billId}-${v2 ? "v2" : "v1"}`,
  ),
}));

import { GET } from "./route";
import { confirmationShortUrl } from "@/lib/booking-confirmation-link";

const mocked = vi.mocked(confirmationShortUrl);
const BILL = "63000000003876026";

function makeReq(qs: string) {
  return new NextRequest(`https://x/api/booking/confirmation-link${qs}`);
}

beforeEach(() => mocked.mockClear());

describe("GET /api/booking/confirmation-link", () => {
  it("returns the short link for a valid billId (v2)", async () => {
    const res = await GET(makeReq(`?billId=${BILL}&v2=1`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ shortUrl: `https://x/s/CODE-${BILL}-v2` });
    expect(mocked).toHaveBeenCalledWith(BILL, true);
  });

  it("defaults to v1 when v2 is absent", async () => {
    await GET(makeReq(`?billId=${BILL}`));
    expect(mocked).toHaveBeenCalledWith(BILL, false);
  });

  it("400s on a missing billId", async () => {
    const res = await GET(makeReq(""));
    expect(res.status).toBe(400);
    expect(mocked).not.toHaveBeenCalled();
  });

  it("400s on a non-numeric billId (no Number() coercion of bigints)", async () => {
    const res = await GET(makeReq("?billId=abc"));
    expect(res.status).toBe(400);
    expect(mocked).not.toHaveBeenCalled();
  });
});
