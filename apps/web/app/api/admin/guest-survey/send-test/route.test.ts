import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/features/guest-survey", () => ({
  enqueueBowlingSurvey: vi.fn(),
}));

vi.mock("~/features/marketing", () => ({
  normalizePhoneE164: vi.fn((s: string) => {
    if (!s) throw new Error("phone required");
    const digits = s.replace(/\D/g, "");
    return digits.length === 10 ? `+1${digits}` : `+${digits}`;
  }),
  recordOptIn: vi.fn().mockResolvedValue(undefined),
}));

import { NextRequest } from "next/server";
import { enqueueBowlingSurvey } from "~/features/guest-survey";
import { recordOptIn } from "~/features/marketing";
import { POST } from "./route";

const mockedEnqueue = vi.mocked(enqueueBowlingSurvey);
const mockedRecordOptIn = vi.mocked(recordOptIn);

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://x/api/admin/guest-survey/send-test", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRecordOptIn.mockResolvedValue(undefined);
  mockedEnqueue.mockResolvedValue({
    status: "sent",
    surveyId: "survey-uuid-1",
    token: "tok-1",
    tags: ["baseline", "bowling", "fnb_service"],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/admin/guest-survey/send-test", () => {
  it("returns 400 on missing required fields", async () => {
    const res = await POST(makeReq({ phone: "5551234567" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await POST(makeReq("not json"));
    expect(res.status).toBe(400);
  });

  it("normalizes phone, seeds opt-in, and forwards to enqueueBowlingSurvey", async () => {
    const res = await POST(
      makeReq({
        phone: "5551234567",
        guestName: "Eric Osborn",
        centerCode: "TXBSQN0FEKQ11",
      }),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.outcome).toMatchObject({ status: "sent", surveyId: "survey-uuid-1" });

    expect(mockedRecordOptIn).toHaveBeenCalledWith({
      phoneE164: "+15551234567",
      source: "admin",
    });

    expect(mockedEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "+15551234567",
        guestName: "Eric Osborn",
        centerCode: "TXBSQN0FEKQ11",
      }),
    );
    // default reservationId is admin-test-<digits>-YYYY-MM-DD
    expect(mockedEnqueue.mock.calls[0][0].reservationId).toMatch(
      /^admin-test-15551234567-\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("skips the opt-in seed when ensureOptIn=false", async () => {
    mockedEnqueue.mockResolvedValue({
      status: "skipped",
      reason: "no_marketing_consent",
    });

    const res = await POST(
      makeReq({
        phone: "5551234567",
        guestName: "Eric Osborn",
        centerCode: "TXBSQN0FEKQ11",
        ensureOptIn: false,
      }),
    );
    expect(res.status).toBe(200);
    expect(mockedRecordOptIn).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.outcome.reason).toBe("no_marketing_consent");
  });

  it("honors an explicit reservationId override", async () => {
    await POST(
      makeReq({
        phone: "5551234567",
        guestName: "Eric Osborn",
        centerCode: "TXBSQN0FEKQ11",
        reservationId: "custom-ref-42",
      }),
    );
    expect(mockedEnqueue.mock.calls[0][0].reservationId).toBe("custom-ref-42");
  });

  it("forwards the skipped outcome (e.g. 30-day cap) verbatim", async () => {
    mockedEnqueue.mockResolvedValue({
      status: "skipped",
      reason: "within_frequency_window",
    });
    const res = await POST(
      makeReq({
        phone: "5551234567",
        guestName: "Eric Osborn",
        centerCode: "TXBSQN0FEKQ11",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome.reason).toBe("within_frequency_window");
  });
});
