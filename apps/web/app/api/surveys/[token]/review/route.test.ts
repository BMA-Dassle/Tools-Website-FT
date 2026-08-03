import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/guest-survey-db", () => ({
  getGuestSurveyByToken: vi.fn(),
  recordGuestSurveyReviewClick: vi.fn().mockResolvedValue(1),
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
    occurredAt: "2026-08-02T00:00:00.000Z",
  }),
}));

import { getGuestSurveyByToken, recordGuestSurveyReviewClick } from "@/lib/guest-survey-db";
import { recordTouch } from "~/features/marketing";
import { aGuestSurvey, aQuestion } from "~/test/builders/survey";
import { HEADPINZ_FM_CENTER_CODE, FASTTRAX_CENTER_CODE } from "@/lib/qamf-centers";
import { NextRequest } from "next/server";
import { GET } from "./route";

const mockedGet = vi.mocked(getGuestSurveyByToken);
const mockedClick = vi.mocked(recordGuestSurveyReviewClick);
const mockedRecordTouch = vi.mocked(recordTouch);

const TOKEN = "abcdef1234567890";

// Mirrors the real seed: baseline #1 = overall rating, baseline #2 = recommend.
const OVERALL = aQuestion({ id: 1, tag: "baseline", ordinal: 1, kind: "rating_1_5" });
const RECOMMEND = aQuestion({ id: 2, tag: "baseline", ordinal: 2, kind: "yes_no" });
const FOOD = aQuestion({ id: 3, tag: "food_drink", ordinal: 2, kind: "rating_1_5" });
const QUESTIONS = [OVERALL, RECOMMEND, FOOD];

const HAPPY = { "1": 5, "2": "Yes", "3": 5 };

function makeReq(): NextRequest {
  return new NextRequest(`https://headpinz.com/api/surveys/${TOKEN}/review`);
}

function makeCtx(token: string) {
  return { params: Promise.resolve({ token }) };
}

/** A completed survey with the given answers at the given center. */
function completedSurvey(responses: Record<string, unknown>, centerCode = HEADPINZ_FM_CENTER_CODE) {
  return aGuestSurvey({
    token: TOKEN,
    centerCode,
    questions: QUESTIONS,
    responses,
    completedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedClick.mockResolvedValue(1);
  // clearAllMocks wipes the factory's mockResolvedValue, so re-arm it —
  // the route calls .catch() on the returned promise.
  mockedRecordTouch.mockResolvedValue({
    id: "touch",
    customerId: "x",
    phoneE164: "+1",
    campaign: "guest_survey",
    channel: "sms",
    event: "converted",
    refId: null,
    meta: {},
    occurredAt: "2026-08-02T00:00:00.000Z",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/surveys/[token]/review", () => {
  it("returns 400 for a malformed token", async () => {
    const res = await GET(makeReq(), makeCtx("xx"));
    expect(res.status).toBe(400);
    expect(mockedClick).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown token", async () => {
    mockedGet.mockResolvedValue(null);
    const res = await GET(makeReq(), makeCtx(TOKEN));
    expect(res.status).toBe(404);
    expect(mockedClick).not.toHaveBeenCalled();
  });

  it("redirects a happy guest to the center's Google review form and counts the click", async () => {
    mockedGet.mockResolvedValue(completedSurvey(HAPPY));
    const res = await GET(makeReq(), makeCtx(TOKEN));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://search.google.com/local/writereview?placeid=ChIJw7rUvBSl3YgRZnV1tR0aK9s",
    );
    expect(mockedClick).toHaveBeenCalledWith(TOKEN);
  });

  it("records a review_click touch on the happy path", async () => {
    mockedGet.mockResolvedValue(completedSurvey(HAPPY));
    await GET(makeReq(), makeCtx(TOKEN));

    // fire-and-forget — let it settle
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedRecordTouch).toHaveBeenCalledWith(
      expect.objectContaining({ campaign: "guest_survey", event: "converted", refId: TOKEN }),
    );
    expect(mockedRecordTouch.mock.calls[0][0].meta).toMatchObject({ stage: "review_click" });
  });

  it("sends a racing guest to FastTrax's own star form, not the HeadPinz one", async () => {
    mockedGet.mockResolvedValue(completedSurvey(HAPPY, FASTTRAX_CENTER_CODE));
    const res = await GET(makeReq(), makeCtx(TOKEN));

    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toBe(
      "https://search.google.com/local/writereview?placeid=ChIJ3w3IFwAV24gRAVrB_FB6JE4",
    );
    // HeadPinz Fort Myers is across the same parking lot — a racer's review
    // must never land on its listing.
    expect(loc).not.toContain("ChIJw7rUvBSl3YgRZnV1tR0aK9s");
  });

  // ── The gate is enforced HERE, not just in the UI ──────────────────
  // Each of these is a hand-crafted-URL attempt: the guest never saw a CTA,
  // so nothing should reach Google and nothing should be counted.

  it("sends an unhappy guest home instead of to Google, and counts nothing", async () => {
    mockedGet.mockResolvedValue(completedSurvey({ "1": 2, "2": "No", "3": 1 }));
    const res = await GET(makeReq(), makeCtx(TOKEN));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://headpinz.com/");
    expect(mockedClick).not.toHaveBeenCalled();
    expect(mockedRecordTouch).not.toHaveBeenCalled();
  });

  it("sends a guest home when one area was rated low despite a 5 overall", async () => {
    mockedGet.mockResolvedValue(completedSurvey({ "1": 5, "2": "Yes", "3": 2 }));
    const res = await GET(makeReq(), makeCtx(TOKEN));

    expect(res.headers.get("location")).toBe("https://headpinz.com/");
    expect(mockedClick).not.toHaveBeenCalled();
  });

  it("sends a guest home when they said they would not recommend us", async () => {
    mockedGet.mockResolvedValue(completedSurvey({ "1": 5, "2": "No", "3": 5 }));
    const res = await GET(makeReq(), makeCtx(TOKEN));

    expect(res.headers.get("location")).toBe("https://headpinz.com/");
    expect(mockedClick).not.toHaveBeenCalled();
  });

  it("sends a guest home when the survey was never submitted", async () => {
    mockedGet.mockResolvedValue(
      aGuestSurvey({
        token: TOKEN,
        centerCode: HEADPINZ_FM_CENTER_CODE,
        questions: QUESTIONS,
        responses: HAPPY, // even with answers present, completed_at gates it
        completedAt: null,
        expiresAt: "2027-01-01T00:00:00.000Z",
      }),
    );
    const res = await GET(makeReq(), makeCtx(TOKEN));

    expect(res.headers.get("location")).toBe("https://headpinz.com/");
    expect(mockedClick).not.toHaveBeenCalled();
  });

  it("sends a guest home when the center has no mapped review destination", async () => {
    mockedGet.mockResolvedValue(completedSurvey(HAPPY, "SOME_NEW_CENTER"));
    const res = await GET(makeReq(), makeCtx(TOKEN));

    expect(res.headers.get("location")).toBe("https://headpinz.com/");
    expect(mockedClick).not.toHaveBeenCalled();
  });

  it("redirects relative to the request host, so FastTrax visitors land on FastTrax", async () => {
    mockedGet.mockResolvedValue(completedSurvey({ "1": 1 }));
    const req = new NextRequest(`https://fasttraxent.com/api/surveys/${TOKEN}/review`);
    const res = await GET(req, makeCtx(TOKEN));

    expect(res.headers.get("location")).toBe("https://fasttraxent.com/");
  });

  // ── Failure isolation ──────────────────────────────────────────────

  it("still redirects to Google when counting the click fails", async () => {
    // A lost count beats a broken link.
    mockedGet.mockResolvedValue(completedSurvey(HAPPY));
    mockedClick.mockRejectedValue(new Error("neon down"));

    const res = await GET(makeReq(), makeCtx(TOKEN));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("search.google.com");
  });
});
