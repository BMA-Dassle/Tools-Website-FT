import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/guest-survey-db", () => ({
  getGuestSurveyByToken: vi.fn(),
  markGuestSurveyOpened: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/features/marketing", () => ({
  recordTouch: vi.fn().mockResolvedValue({
    id: "touch",
    customerId: "x",
    phoneE164: "+1",
    campaign: "guest_survey",
    channel: "sms",
    event: "opened",
    refId: null,
    meta: {},
    occurredAt: "2026-05-20T00:00:00.000Z",
  }),
}));

import { getGuestSurveyByToken, markGuestSurveyOpened } from "@/lib/guest-survey-db";
import { recordTouch } from "~/features/marketing";
import { aGuestSurvey } from "~/test/builders/survey";
import { NextRequest } from "next/server";
import { GET } from "./route";

const mockedGet = vi.mocked(getGuestSurveyByToken);
const mockedMarkOpened = vi.mocked(markGuestSurveyOpened);
const mockedRecordTouch = vi.mocked(recordTouch);

const TOKEN = "abcdef1234567890";

function makeCtx(token: string) {
  return { params: Promise.resolve({ token }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // vi.clearAllMocks resets call history but the afterEach restoreAllMocks
  // strips implementations — re-assert every test.
  mockedMarkOpened.mockResolvedValue(undefined);
  mockedRecordTouch.mockResolvedValue({
    id: "touch",
    customerId: "x",
    phoneE164: "+1",
    campaign: "guest_survey",
    channel: "sms",
    event: "opened",
    refId: null,
    meta: {},
    occurredAt: "2026-05-20T00:00:00.000Z",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/surveys/[token]", () => {
  it("returns 400 for an obviously bad token", async () => {
    const res = await GET(new NextRequest("http://x/api/surveys/abc"), makeCtx("abc"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the token isn't found", async () => {
    mockedGet.mockResolvedValue(null);
    const res = await GET(new NextRequest("http://x"), makeCtx(TOKEN));
    expect(res.status).toBe(404);
  });

  it("returns 410 when the survey is already completed", async () => {
    mockedGet.mockResolvedValue(
      aGuestSurvey({
        token: TOKEN,
        completedAt: "2026-05-19T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z",
      }),
    );
    const res = await GET(new NextRequest("http://x"), makeCtx(TOKEN));
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.completed).toBe(true);
  });

  it("returns 410 when the survey is past expiresAt", async () => {
    mockedGet.mockResolvedValue(
      aGuestSurvey({
        token: TOKEN,
        completedAt: null,
        expiresAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    const res = await GET(new NextRequest("http://x"), makeCtx(TOKEN));
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.expired).toBe(true);
  });

  it("returns 200 + survey payload (no PII) on first GET, stamps opened_at and records 'opened' touch", async () => {
    mockedGet.mockResolvedValue(
      aGuestSurvey({
        token: TOKEN,
        openedAt: null,
        completedAt: null,
        expiresAt: "2027-01-01T00:00:00.000Z",
      }),
    );

    const res = await GET(new NextRequest("http://x"), makeCtx(TOKEN));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.token).toBe(TOKEN);
    expect(body.questions).toBeInstanceOf(Array);
    // PII guard: response must NOT include phone, squareCustomerId, reward fields
    expect(body.phoneE164).toBeUndefined();
    expect(body.squareCustomerId).toBeUndefined();
    expect(body.rewardKind).toBeUndefined();
    expect(body.rewardRef).toBeUndefined();

    // Wait a microtask so the fire-and-forget side effects resolve before assertions
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedMarkOpened).toHaveBeenCalledWith(TOKEN);
    expect(mockedRecordTouch).toHaveBeenCalledWith(
      expect.objectContaining({ event: "opened", refId: TOKEN }),
    );
  });

  it("does NOT stamp opened_at or record a touch on subsequent GETs", async () => {
    mockedGet.mockResolvedValue(
      aGuestSurvey({
        token: TOKEN,
        openedAt: "2026-05-19T12:00:00.000Z",
        completedAt: null,
        expiresAt: "2027-01-01T00:00:00.000Z",
      }),
    );

    const res = await GET(new NextRequest("http://x"), makeCtx(TOKEN));
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 0));
    expect(mockedMarkOpened).not.toHaveBeenCalled();
    expect(mockedRecordTouch).not.toHaveBeenCalled();
  });
});
