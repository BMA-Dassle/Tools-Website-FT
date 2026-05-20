import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/guest-survey-db", () => ({
  getGuestSurveyByToken: vi.fn(),
  saveGuestSurveyReward: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/square-gift-card", () => ({
  appendCustomerNote: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/bowling-lane-ready-notify", () => ({
  CENTER_META: {
    TXBSQN0FEKQ11: { name: "HeadPinz Fort Myers", smsFrom: "+12393022155" },
  },
}));

vi.mock("@/lib/sms-retry", () => import("~/test/mocks/sms"));
vi.mock("@/lib/sms-log", () => import("~/test/mocks/sms"));

vi.mock("@/lib/short-url", () => ({
  shortenUrl: vi.fn().mockResolvedValue("abc123"),
}));

vi.mock("~/features/marketing", () => ({
  issueReward: vi.fn(),
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
  renderPinzAwardSms: vi.fn(
    ({ points, newBalance }: { points: number; newBalance: number }) =>
      `HeadPinz: ${points} Pinz added. Balance: ${newBalance}`,
  ),
}));

import { NextRequest } from "next/server";
import { getGuestSurveyByToken, saveGuestSurveyReward } from "@/lib/guest-survey-db";
import { appendCustomerNote } from "@/lib/square-gift-card";
import { shortenUrl } from "@/lib/short-url";
import { issueReward, recordTouch } from "~/features/marketing";
import * as smsMock from "~/test/mocks/sms";
import { aGuestSurvey } from "~/test/builders/survey";
import { POST } from "./route";

const mockedGet = vi.mocked(getGuestSurveyByToken);
const mockedSave = vi.mocked(saveGuestSurveyReward);
const mockedIssue = vi.mocked(issueReward);
const mockedNote = vi.mocked(appendCustomerNote);
const mockedTouch = vi.mocked(recordTouch);
const mockedShorten = vi.mocked(shortenUrl);

const TOKEN = "abcdef1234567890";

function makeReq(body: unknown): NextRequest {
  return new NextRequest(`http://x/api/surveys/${TOKEN}/reward`, {
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
  smsMock.resetSmsCaptures();
  mockedSave.mockResolvedValue(undefined);
  mockedNote.mockResolvedValue(undefined);
  mockedShorten.mockResolvedValue("abc123");
  mockedTouch.mockResolvedValue({
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

describe("POST /api/surveys/[token]/reward — validation", () => {
  it("400 on malformed token", async () => {
    const res = await POST(makeReq({ kind: "pinz" }), makeCtx("xx"));
    expect(res.status).toBe(400);
  });

  it("400 on invalid JSON", async () => {
    const res = await POST(makeReq("nope"), makeCtx(TOKEN));
    expect(res.status).toBe(400);
  });

  it("400 on missing or unknown kind", async () => {
    const r1 = await POST(makeReq({}), makeCtx(TOKEN));
    expect(r1.status).toBe(400);
    const r2 = await POST(makeReq({ kind: "free_game" }), makeCtx(TOKEN));
    expect(r2.status).toBe(400);
  });

  it("404 on unknown token", async () => {
    mockedGet.mockResolvedValue(null);
    const res = await POST(makeReq({ kind: "pinz" }), makeCtx(TOKEN));
    expect(res.status).toBe(404);
  });

  it("409 when the survey hasn't been submitted yet", async () => {
    mockedGet.mockResolvedValue(
      aGuestSurvey({ token: TOKEN, completedAt: null, rewardKind: null }),
    );
    const res = await POST(makeReq({ kind: "pinz" }), makeCtx(TOKEN));
    expect(res.status).toBe(409);
    expect(mockedIssue).not.toHaveBeenCalled();
  });

  it("409 when a reward has already been issued for this token", async () => {
    mockedGet.mockResolvedValue(
      aGuestSurvey({
        token: TOKEN,
        completedAt: "2026-05-20T20:00:00.000Z",
        rewardKind: "pinz",
        rewardRef: "evt_prior",
      }),
    );
    const res = await POST(makeReq({ kind: "gift_card" }), makeCtx(TOKEN));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.kind).toBe("pinz");
    expect(body.ref).toBe("evt_prior");
    expect(mockedIssue).not.toHaveBeenCalled();
  });
});

describe("POST /api/surveys/[token]/reward — Pinz path", () => {
  beforeEach(() => {
    mockedGet.mockResolvedValue(
      aGuestSurvey({
        token: TOKEN,
        squareCustomerId: "CUS_TEST",
        phoneE164: "+12397762044",
        centerCode: "TXBSQN0FEKQ11",
        completedAt: "2026-05-20T20:00:00.000Z",
        rewardKind: null,
      }),
    );
  });

  it("calls issueReward, saves the row, sends SMS, returns the reward shape", async () => {
    mockedIssue.mockResolvedValue({
      kind: "pinz",
      ref: "evt_1",
      value: 500,
      displayText: "500 Pinz added (new balance: 1500)",
      meta: { accountId: "loy_1", newBalance: 1500 },
    });

    const res = await POST(makeReq({ kind: "pinz" }), makeCtx(TOKEN));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.reward.kind).toBe("pinz");
    expect(body.reward.value).toBe(500);
    expect(body.reward.newBalance).toBe(1500);
    // PII guards: should NOT leak account id
    expect(body.reward.accountId).toBeUndefined();

    expect(mockedIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "CUS_TEST",
        phoneE164: "+12397762044",
        locationId: "TXBSQN0FEKQ11",
        kind: "pinz",
        surveyId: expect.any(String),
      }),
    );

    expect(mockedSave).toHaveBeenCalledWith({
      token: TOKEN,
      rewardKind: "pinz",
      rewardRef: "evt_1",
      rewardValue: 500,
    });

    // Wait for fire-and-forget side effects to settle
    await new Promise((r) => setTimeout(r, 0));

    const send = smsMock.lastSend();
    expect(send?.to).toBe("+12397762044");
    expect(send?.body).toContain("500 Pinz");
    expect(send?.body).toContain("1500");

    expect(mockedNote).toHaveBeenCalled();
    const convertedTouch = mockedTouch.mock.calls.find(
      (c) => c[0].event === "converted" && c[0].meta?.stage === "reward_issued",
    );
    expect(convertedTouch?.[0].meta).toMatchObject({
      rewardKind: "pinz",
      rewardValue: 500,
    });
  });
});

describe("POST /api/surveys/[token]/reward — gift card path", () => {
  beforeEach(() => {
    mockedGet.mockResolvedValue(
      aGuestSurvey({
        token: TOKEN,
        squareCustomerId: "CUS_TEST",
        phoneE164: "+12397762044",
        centerCode: "TXBSQN0FEKQ11",
        completedAt: "2026-05-20T20:00:00.000Z",
        rewardKind: null,
      }),
    );
  });

  it("mints + saves + returns rich payload (GAN, QR, wallet URLs) but does NOT auto-send SMS", async () => {
    mockedIssue.mockResolvedValue({
      kind: "gift_card",
      ref: "GS-7F2A",
      value: 500,
      displayText: "$5.00 e-gift card GS-7F2A",
      meta: {
        giftCardId: "gc_1",
        gan: "7777111122223333",
        promoCode: "GS-7F2A",
      },
    });

    const res = await POST(makeReq({ kind: "gift_card" }), makeCtx(TOKEN));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reward.kind).toBe("gift_card");
    expect(body.reward.promoCode).toBe("GS-7F2A");
    // GAN is now part of the response (the page renders it; SMS is opt-in)
    expect(body.reward.gan).toBe("7777-1111-2222-3333");
    expect(body.reward.balanceUrl).toContain("gc_1");
    expect(body.reward.walletUrl).toContain("gc_1");
    expect(body.reward.walletShortUrl).toMatch(/\/s\/abc123$/);
    expect(typeof body.reward.qrDataUrl).toBe("string");
    expect(body.reward.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    await new Promise((r) => setTimeout(r, 0));

    // CRITICAL change: no SMS sent on the issuance path — the user opts
    // in via the "Text it to my phone" button which hits the send-sms
    // endpoint.
    expect(smsMock.allSends()).toHaveLength(0);

    // converted touch still recorded
    const convertedTouch = mockedTouch.mock.calls.find(
      (c) => c[0].event === "converted" && c[0].meta?.stage === "reward_issued",
    );
    expect(convertedTouch?.[0].meta).toMatchObject({
      rewardKind: "gift_card",
      promoCode: "GS-7F2A",
    });
  });

  it("502 when issueReward throws (e.g. Square minting failed)", async () => {
    mockedIssue.mockRejectedValue(new Error("Square 500: gift_card_create_failed"));
    const res = await POST(makeReq({ kind: "gift_card" }), makeCtx(TOKEN));
    expect(res.status).toBe(502);
    // Did NOT save the survey row, did NOT send SMS, did NOT touch.
    expect(mockedSave).not.toHaveBeenCalled();
    expect(smsMock.allSends()).toHaveLength(0);
  });
});
