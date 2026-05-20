import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/features/marketing", () => ({
  issueReward: vi.fn(),
  normalizePhoneE164: vi.fn((s: string) => {
    if (!s) throw new Error("phone required");
    const digits = s.replace(/\D/g, "");
    return digits.length === 10 ? `+1${digits}` : `+${digits}`;
  }),
  resolveAudienceMember: vi.fn(),
}));

import { NextRequest } from "next/server";
import { issueReward, resolveAudienceMember } from "~/features/marketing";
import { POST } from "./route";

const mockedIssue = vi.mocked(issueReward);
const mockedResolve = vi.mocked(resolveAudienceMember);

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://x/api/admin/guest-survey/issue-reward-test", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedResolve.mockResolvedValue({
    squareCustomerId: "CUS_T",
    phoneE164: "+15551234567",
    givenName: "Eric",
    familyName: "Osborn",
    email: null,
    isNew: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/admin/guest-survey/issue-reward-test", () => {
  it("400 on missing fields", async () => {
    const res = await POST(makeReq({ phone: "5551234567" }));
    expect(res.status).toBe(400);
  });

  it("400 on invalid kind", async () => {
    const res = await POST(
      makeReq({
        phone: "5551234567",
        guestName: "Eric Osborn",
        centerCode: "TXBSQN0FEKQ11",
        kind: "free_game",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("502 when audience resolve fails", async () => {
    mockedResolve.mockRejectedValue(new Error("Square 500"));
    const res = await POST(
      makeReq({
        phone: "5551234567",
        guestName: "Eric Osborn",
        centerCode: "TXBSQN0FEKQ11",
        kind: "pinz",
      }),
    );
    expect(res.status).toBe(502);
    expect(mockedIssue).not.toHaveBeenCalled();
  });

  it("Pinz path: resolves customer, fires issueReward, returns the full result", async () => {
    mockedIssue.mockResolvedValue({
      kind: "pinz",
      ref: "evt_1",
      value: 500,
      displayText: "500 Pinz added (new balance: 1500)",
      meta: { accountId: "loy_1", newBalance: 1500 },
    });

    const res = await POST(
      makeReq({
        phone: "5551234567",
        guestName: "Eric Osborn",
        centerCode: "TXBSQN0FEKQ11",
        kind: "pinz",
      }),
    );
    expect(res.status).toBe(200);

    expect(mockedIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "CUS_T",
        phoneE164: "+15551234567",
        locationId: "TXBSQN0FEKQ11",
        kind: "pinz",
        reason: "Admin reward test",
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.customerId).toBe("CUS_T");
    expect(body.result.kind).toBe("pinz");
    expect(body.result.meta.accountId).toBe("loy_1"); // operator audit trail
  });

  it("Gift-card path: passes surveyId through to issueReward", async () => {
    mockedIssue.mockResolvedValue({
      kind: "gift_card",
      ref: "GS-7F2A",
      value: 500,
      displayText: "$5.00 e-gift card GS-7F2A",
      meta: { giftCardId: "gc_1", gan: "1234", promoCode: "GS-7F2A" },
    });

    const res = await POST(
      makeReq({
        phone: "5551234567",
        guestName: "Eric Osborn",
        centerCode: "TXBSQN0FEKQ11",
        kind: "gift_card",
        surveyId: "survey-uuid-1",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockedIssue.mock.calls[0][0].surveyId).toBe("survey-uuid-1");
    const body = await res.json();
    expect(body.result.meta.gan).toBe("1234");
    expect(body.result.meta.promoCode).toBe("GS-7F2A");
  });

  it("502 when issueReward throws (Square minting failed)", async () => {
    mockedIssue.mockRejectedValue(new Error("Square 500"));
    const res = await POST(
      makeReq({
        phone: "5551234567",
        guestName: "Eric Osborn",
        centerCode: "TXBSQN0FEKQ11",
        kind: "pinz",
      }),
    );
    expect(res.status).toBe(502);
  });
});
