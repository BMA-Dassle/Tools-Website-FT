/**
 * THE V1 SURFACE STILL WORKS (brief R16, "v2 alongside v1").
 *
 * `POST /api/group-function/approve` is called today by the approval email's
 * buttons and by the portal. B5 moved what approving DOES into
 * `lib/group-function-approve.ts` so the CRM can call the same code with the
 * SIGNED-IN approver — this file proves the move changed nothing the outside
 * world can see: the same body, the same two-address allowlist, the same
 * status codes, the same response.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getGfQuoteByShortId: vi.fn(),
  approveQuote: vi.fn(),
  denyQuote: vi.fn(),
}));

vi.mock("@/lib/group-function-db", () => ({
  getGfQuoteByShortId: mocks.getGfQuoteByShortId,
}));

vi.mock("@/lib/group-function-approve", async () => {
  class QuoteNotPendingApprovalError extends Error {
    readonly status: string;
    constructor(status: string) {
      super(`Quote is in status: ${status}, not pending_approval`);
      this.name = "QuoteNotPendingApprovalError";
      this.status = status;
    }
  }
  return {
    QuoteNotPendingApprovalError,
    approveQuote: mocks.approveQuote,
    denyQuote: mocks.denyQuote,
  };
});

const { POST } = await import("./route");

const QUOTE = {
  id: 4821,
  contract_short_id: "7Hx2Qk",
  status: "pending_approval",
  center_code: "fort-myers",
  bmi_reservation_id: "58454077",
};

function post(body: unknown): Request {
  return new Request("https://headpinz.com/api/group-function/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getGfQuoteByShortId.mockResolvedValue(QUOTE);
  mocks.approveQuote.mockResolvedValue({ action: "approved" });
  mocks.denyQuote.mockResolvedValue({ action: "denied" });
});

describe("POST /api/group-function/approve — unchanged", () => {
  it("an allowlisted approver approves through the extracted approveQuote", async () => {
    const res = await POST(
      post({
        shortId: "7Hx2Qk",
        action: "approve",
        email: "Eric@HeadPinz.com",
        memo: "ok",
      }) as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: "approved" });
    expect(mocks.approveQuote).toHaveBeenCalledWith(QUOTE, {
      approverEmail: "eric@headpinz.com",
      memo: "ok",
    });
  });

  it("THE ALLOWLIST IS INTACT — anyone else is 403 and nothing runs", async () => {
    const res = await POST(
      post({ shortId: "7Hx2Qk", action: "approve", email: "kelsea@headpinz.com" }) as never,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Not authorized to approve/deny" });
    expect(mocks.approveQuote).not.toHaveBeenCalled();
  });

  it("no email at all is 403, not an approval by ''", async () => {
    const res = await POST(post({ shortId: "7Hx2Qk", action: "approve" }) as never);
    expect(res.status).toBe(403);
    expect(mocks.approveQuote).not.toHaveBeenCalled();
  });

  it("deny needs a reason, and passes it through", async () => {
    const bad = await POST(
      post({ shortId: "7Hx2Qk", action: "deny", email: "jacob@headpinz.com" }) as never,
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "reason required for denial" });

    const good = await POST(
      post({
        shortId: "7Hx2Qk",
        action: "deny",
        email: "jacob@headpinz.com",
        reason: "No youth products",
      }) as never,
    );
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ok: true, action: "denied" });
    expect(mocks.denyQuote).toHaveBeenCalledWith(QUOTE, {
      approverEmail: "jacob@headpinz.com",
      reason: "No youth products",
    });
  });

  it("keeps its own guards: missing fields, a bad action, an unknown quote, a moved-on quote", async () => {
    expect((await POST(post({ action: "approve" }) as never)).status).toBe(400);
    expect((await POST(post({ shortId: "x", action: "shrug" }) as never)).status).toBe(400);

    mocks.getGfQuoteByShortId.mockResolvedValueOnce(null);
    expect((await POST(post({ shortId: "x", action: "approve" }) as never)).status).toBe(404);

    mocks.getGfQuoteByShortId.mockResolvedValueOnce({ ...QUOTE, status: "contract_sent" });
    const moved = await POST(
      post({ shortId: "7Hx2Qk", action: "approve", email: "eric@headpinz.com" }) as never,
    );
    expect(moved.status).toBe(400);
    expect((await moved.json()).error).toContain("not pending_approval");
  });
});
