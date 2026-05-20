import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/guest-survey-db", () => ({
  getGuestSurveyByToken: vi.fn(),
  saveGuestSurveyResponses: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/features/marketing", () => ({
  recordTouch: vi.fn().mockResolvedValue({
    id: "touch",
    customerId: "x",
    phoneE164: "+1",
    campaign: "guest_survey",
    channel: "sms",
    event: "converted",
    refId: null,
    meta: {},
    occurredAt: "2026-05-20T00:00:00.000Z",
  }),
}));

import { getGuestSurveyByToken, saveGuestSurveyResponses } from "@/lib/guest-survey-db";
import { recordTouch } from "~/features/marketing";
import { aGuestSurvey } from "~/test/builders/survey";
import { NextRequest } from "next/server";
import { POST } from "./route";

const mockedGet = vi.mocked(getGuestSurveyByToken);
const mockedSave = vi.mocked(saveGuestSurveyResponses);
const mockedRecordTouch = vi.mocked(recordTouch);

const TOKEN = "abcdef1234567890";

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://x/api/surveys/" + TOKEN + "/submit", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function makeCtx(token: string) {
  return { params: Promise.resolve({ token }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSave.mockResolvedValue(undefined);
  mockedRecordTouch.mockResolvedValue({
    id: "touch",
    customerId: "x",
    phoneE164: "+1",
    campaign: "guest_survey",
    channel: "sms",
    event: "converted",
    refId: null,
    meta: {},
    occurredAt: "2026-05-20T00:00:00.000Z",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/surveys/[token]/submit", () => {
  it("returns 400 for a malformed token", async () => {
    const res = await POST(makeReq({ responses: {} }), makeCtx("xx"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await POST(makeReq("not json"), makeCtx(TOKEN));
    expect(res.status).toBe(400);
  });

  it("returns 400 when responses is missing or not an object", async () => {
    const res1 = await POST(makeReq({}), makeCtx(TOKEN));
    expect(res1.status).toBe(400);

    const res2 = await POST(makeReq({ responses: [1, 2, 3] }), makeCtx(TOKEN));
    expect(res2.status).toBe(400);

    const res3 = await POST(makeReq({ responses: "string" }), makeCtx(TOKEN));
    expect(res3.status).toBe(400);
  });

  it("returns 404 when the token isn't found", async () => {
    mockedGet.mockResolvedValue(null);
    const res = await POST(makeReq({ responses: {} }), makeCtx(TOKEN));
    expect(res.status).toBe(404);
  });

  it("returns 409 when the survey was already submitted", async () => {
    mockedGet.mockResolvedValue(
      aGuestSurvey({
        token: TOKEN,
        completedAt: "2026-05-19T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z",
      }),
    );
    const res = await POST(makeReq({ responses: {} }), makeCtx(TOKEN));
    expect(res.status).toBe(409);
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("returns 410 when expired", async () => {
    mockedGet.mockResolvedValue(
      aGuestSurvey({
        token: TOKEN,
        completedAt: null,
        expiresAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    const res = await POST(makeReq({ responses: {} }), makeCtx(TOKEN));
    expect(res.status).toBe(410);
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("saves responses, returns 200, and records a 'converted' touch", async () => {
    mockedGet.mockResolvedValue(
      aGuestSurvey({
        token: TOKEN,
        completedAt: null,
        expiresAt: "2027-01-01T00:00:00.000Z",
      }),
    );
    const responses = { "1": 5, "2": "Yes", "3": "Spotless" };
    const res = await POST(makeReq({ responses }), makeCtx(TOKEN));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, token: TOKEN });

    expect(mockedSave).toHaveBeenCalledWith({ token: TOKEN, responses });

    // Wait for the fire-and-forget touch to settle
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedRecordTouch).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "converted",
        refId: TOKEN,
        campaign: "guest_survey",
      }),
    );
    expect(mockedRecordTouch.mock.calls[0][0].meta).toMatchObject({
      answerCount: 3,
    });
  });
});
