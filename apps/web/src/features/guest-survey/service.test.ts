import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aQuestion } from "~/test/builders/survey";

// ── Mocks ─────────────────────────────────────────────────────────
// `vi.mock` runs before imports. Each call replaces the module with the
// shape we hand back here.

vi.mock("@ft/db", () => ({
  isDbConfigured: vi.fn().mockReturnValue(true),
  sql: vi.fn(),
}));

vi.mock("@/lib/sms-retry", () => import("~/test/mocks/sms"));
vi.mock("@/lib/sms-log", () => import("~/test/mocks/sms"));

vi.mock("@/lib/short-url", () => ({
  shortenUrl: vi.fn(),
}));

vi.mock("@/lib/bowling-lane-ready-notify", () => ({
  CENTER_META: {
    TXBSQN0FEKQ11: { name: "HeadPinz Fort Myers", smsFrom: "+12393022155" },
    PPTR5G2N0QXF7: { name: "HeadPinz Naples", smsFrom: "+12394553755" },
  },
}));

vi.mock("@/lib/guest-survey-db", () => ({
  insertGuestSurvey: vi.fn(),
  getGuestSurveyByOriginRef: vi.fn(),
  deleteGuestSurveyByToken: vi.fn().mockResolvedValue(true),
  // pickQuestions() (via ./questions) calls getActiveQuestionsForTags
  getActiveQuestionsForTags: vi.fn().mockResolvedValue([]),
  // service.ts auto-seeds questions on first call (idempotent in prod)
  seedGuestSurveyQuestionsIfEmpty: vi.fn().mockResolvedValue(0),
}));

vi.mock("~/features/marketing", () => ({
  canSend: vi.fn(),
  getConsent: vi.fn(),
  recordTouch: vi.fn(),
  renderBowlingSurveyInvite: vi.fn(({ code }: { code: string }) => `MOCK SMS BODY /s/${code}`),
  resolveAudienceMember: vi.fn(),
  splitGuestName: vi.fn((name: string) => ({
    firstName: name.split(" ")[0] ?? "",
    lastName: name.split(" ").slice(1).join(" "),
  })),
}));

import { isDbConfigured } from "@ft/db";
import {
  deleteGuestSurveyByToken,
  getActiveQuestionsForTags,
  getGuestSurveyByOriginRef,
  insertGuestSurvey,
  seedGuestSurveyQuestionsIfEmpty,
} from "@/lib/guest-survey-db";
import { shortenUrl } from "@/lib/short-url";
import { canSend, getConsent, recordTouch, resolveAudienceMember } from "~/features/marketing";
import * as smsMock from "~/test/mocks/sms";
import { enqueueBowlingSurvey } from "./service";

const mockedIsDbConfigured = vi.mocked(isDbConfigured);
const mockedGetExisting = vi.mocked(getGuestSurveyByOriginRef);
const mockedInsert = vi.mocked(insertGuestSurvey);
const mockedDelete = vi.mocked(deleteGuestSurveyByToken);
const mockedSeed = vi.mocked(seedGuestSurveyQuestionsIfEmpty);
const mockedGetActive = vi.mocked(getActiveQuestionsForTags);
const mockedShorten = vi.mocked(shortenUrl);
const mockedResolve = vi.mocked(resolveAudienceMember);
const mockedConsent = vi.mocked(getConsent);
const mockedCanSend = vi.mocked(canSend);
const mockedRecordTouch = vi.mocked(recordTouch);

const RESERVATION_ID = "42";
const PHONE_INPUT = "5551234567";
const PHONE_E164 = "+15551234567";
const SQUARE_CUSTOMER_ID = "CUS_TEST_42";
const CENTER_CODE = "TXBSQN0FEKQ11";
const VISIT_DATE = "2026-05-20";

const baseInput = () => ({
  reservationId: RESERVATION_ID,
  phone: PHONE_INPUT,
  guestName: "Ada Lovelace",
  guestEmail: "ada@example.com",
  centerCode: CENTER_CODE,
  visitDate: VISIT_DATE,
});

function defaultsHappyPath(): void {
  mockedIsDbConfigured.mockReturnValue(true);
  mockedGetExisting.mockResolvedValue(null);
  // vi.clearAllMocks (+ afterEach restoreAllMocks) wipe implementations
  // assigned in vi.mock declarations on cleanup — re-assert every test.
  mockedDelete.mockResolvedValue(true);
  mockedSeed.mockResolvedValue(0);
  mockedGetActive.mockResolvedValue([]);
  mockedRecordTouch.mockResolvedValue({
    id: "touch-uuid",
    customerId: "x",
    phoneE164: "+1",
    campaign: "guest_survey",
    channel: "sms",
    event: "sent",
    refId: null,
    meta: {},
    occurredAt: "2026-05-20T00:00:00.000Z",
  });
  mockedResolve.mockResolvedValue({
    squareCustomerId: SQUARE_CUSTOMER_ID,
    phoneE164: PHONE_E164,
    givenName: "Ada",
    familyName: "Lovelace",
    email: "ada@example.com",
    isNew: false,
  });
  // Happy path: no row at all → treated as implicit opt-in for bowling
  // (the customer accepted transactional SMS at booking).
  mockedConsent.mockResolvedValue(null);
  mockedCanSend.mockResolvedValue({ allowed: true, lastSentAt: null });
  mockedShorten.mockResolvedValue("abc123");
  mockedInsert.mockResolvedValue({
    id: "survey-uuid-1",
    token: "tok-1",
    squareCustomerId: SQUARE_CUSTOMER_ID,
    phoneE164: PHONE_E164,
    origin: "bowling",
    originRef: RESERVATION_ID,
    centerCode: CENTER_CODE,
    visitDate: VISIT_DATE,
    context: {},
    questions: [aQuestion()],
    responses: null,
    rewardKind: null,
    rewardRef: null,
    rewardValue: null,
    sentAt: "2026-05-20T20:00:00.000Z",
    openedAt: null,
    completedAt: null,
    expiresAt: "2026-05-27T20:00:00.000Z",
    createdAt: "2026-05-20T20:00:00.000Z",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  smsMock.resetSmsCaptures();
  defaultsHappyPath();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("enqueueBowlingSurvey — happy path", () => {
  it("sends the SMS, inserts the row, and records a 'sent' touch", async () => {
    const result = await enqueueBowlingSurvey(baseInput());

    expect(result.status).toBe("sent");
    if (result.status !== "sent") return;

    expect(result.surveyId).toBe("survey-uuid-1");
    expect(result.tags).toEqual(["baseline", "bowling", "fnb_service", "closing"]);

    // Audience resolve was called with phone + split name
    expect(mockedResolve).toHaveBeenCalledWith({
      phone: PHONE_INPUT,
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
    });

    // Insert was called with the right shape
    expect(mockedInsert).toHaveBeenCalledTimes(1);
    const insertedArg = mockedInsert.mock.calls[0][0];
    expect(insertedArg.origin).toBe("bowling");
    expect(insertedArg.originRef).toBe(RESERVATION_ID);
    expect(insertedArg.squareCustomerId).toBe(SQUARE_CUSTOMER_ID);
    expect(insertedArg.phoneE164).toBe(PHONE_E164);
    expect((insertedArg.context as { tags: string[] }).tags).toEqual([
      "baseline",
      "bowling",
      "fnb_service",
      "closing",
    ]);

    // SMS sent via voxSend with the center's smsFrom
    const send = smsMock.lastSend();
    expect(send?.to).toBe(PHONE_E164);
    expect(send?.fromOverride).toBe("+12393022155");
    expect(send?.body).toContain("/s/abc123");

    // marketing_touches 'sent' recorded
    const touchCalls = mockedRecordTouch.mock.calls;
    const sentTouch = touchCalls.find((c) => c[0].event === "sent");
    expect(sentTouch).toBeDefined();
    expect(sentTouch?.[0]).toMatchObject({
      customerId: SQUARE_CUSTOMER_ID,
      campaign: "guest_survey",
      event: "sent",
    });
  });
});

describe("enqueueBowlingSurvey — guard skips (no touch recorded)", () => {
  it("returns 'no_phone' and does nothing when phone is empty", async () => {
    const result = await enqueueBowlingSurvey({ ...baseInput(), phone: "" });
    expect(result).toEqual({ status: "skipped", reason: "no_phone" });
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(mockedInsert).not.toHaveBeenCalled();
    expect(smsMock.allSends()).toHaveLength(0);
  });

  it("returns 'no_db' when DATABASE_URL not configured", async () => {
    mockedIsDbConfigured.mockReturnValue(false);
    const result = await enqueueBowlingSurvey(baseInput());
    expect(result).toEqual({ status: "skipped", reason: "no_db" });
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it("returns 'already_sent_for_origin_ref' when a survey already exists for this reservation", async () => {
    mockedGetExisting.mockResolvedValue({
      id: "existing-survey",
      token: "existing-tok",
      squareCustomerId: SQUARE_CUSTOMER_ID,
      phoneE164: PHONE_E164,
      origin: "bowling",
      originRef: RESERVATION_ID,
      centerCode: CENTER_CODE,
      visitDate: VISIT_DATE,
      context: {},
      questions: [],
      responses: null,
      rewardKind: null,
      rewardRef: null,
      rewardValue: null,
      sentAt: "2026-05-19T20:00:00.000Z",
      openedAt: null,
      completedAt: null,
      expiresAt: "2026-05-26T20:00:00.000Z",
      createdAt: "2026-05-19T20:00:00.000Z",
    });

    const result = await enqueueBowlingSurvey(baseInput());
    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") return;
    expect(result.reason).toBe("already_sent_for_origin_ref");
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(mockedInsert).not.toHaveBeenCalled();
  });

  it("returns 'audience_resolve_failed' when Square lookup throws", async () => {
    mockedResolve.mockRejectedValue(new Error("Square 500"));
    const result = await enqueueBowlingSurvey(baseInput());
    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") return;
    expect(result.reason).toBe("audience_resolve_failed");
    expect(result.detail).toContain("Square 500");
    expect(mockedInsert).not.toHaveBeenCalled();
  });
});

describe("enqueueBowlingSurvey — consent / frequency skips (touch recorded)", () => {
  it("skips 'no_marketing_consent' when the customer has an explicit STOP on file", async () => {
    // Only an explicit opted_in=false (STOP) blocks the bowling survey
    // now — a missing row is treated as implicit transactional consent.
    mockedConsent.mockResolvedValue({
      phoneE164: PHONE_E164,
      optedIn: false,
      source: "inbound_sms_stop",
      reason: "STOP",
      updatedAt: "2026-05-19T00:00:00.000Z",
    });

    const result = await enqueueBowlingSurvey(baseInput());

    expect(result).toEqual({ status: "skipped", reason: "no_marketing_consent" });
    expect(mockedInsert).not.toHaveBeenCalled();

    const skippedTouch = mockedRecordTouch.mock.calls.find((c) => c[0].event === "skipped");
    expect(skippedTouch).toBeDefined();
    expect(skippedTouch?.[0]).toMatchObject({
      customerId: SQUARE_CUSTOMER_ID,
      campaign: "guest_survey",
      event: "skipped",
    });
    expect(skippedTouch?.[0].meta).toMatchObject({ reason: "no_marketing_consent" });
  });

  it("skips 'within_frequency_window' and writes a skipped touch with lastSentAt", async () => {
    const lastSent = new Date("2026-05-15T20:00:00.000Z");
    mockedCanSend.mockResolvedValue({
      allowed: false,
      reason: "within_window",
      lastSentAt: lastSent,
    });

    const result = await enqueueBowlingSurvey(baseInput());

    expect(result).toEqual({ status: "skipped", reason: "within_frequency_window" });
    expect(mockedInsert).not.toHaveBeenCalled();

    const skippedTouch = mockedRecordTouch.mock.calls.find((c) => c[0].event === "skipped");
    expect(skippedTouch?.[0].meta).toMatchObject({
      reason: "within_frequency_window",
      lastSentAt: lastSent.toISOString(),
    });
  });
});

describe("enqueueBowlingSurvey — SMS failure rollback", () => {
  it("deletes the inserted row when SMS fails and records a skipped touch", async () => {
    smsMock.voxSend.mockImplementationOnce(async () => ({
      ok: false,
      status: 500,
      error: "voxtelesys 500",
      provider: "vox" as const,
    }));

    const result = await enqueueBowlingSurvey(baseInput());

    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") return;
    expect(result.detail).toContain("voxtelesys 500");

    // Row was inserted then deleted
    expect(mockedInsert).toHaveBeenCalledTimes(1);
    expect(mockedDelete).toHaveBeenCalledTimes(1);

    // No 'sent' touch on failure
    const sentTouch = mockedRecordTouch.mock.calls.find((c) => c[0].event === "sent");
    expect(sentTouch).toBeUndefined();

    // Skipped touch captures the error
    const skippedTouch = mockedRecordTouch.mock.calls.find((c) => c[0].event === "skipped");
    expect(skippedTouch?.[0].meta).toMatchObject({
      smsError: "voxtelesys 500",
      smsStatus: 500,
    });
  });

  it("deletes the row when voxSend throws (network error)", async () => {
    smsMock.voxSend.mockImplementationOnce(async () => {
      throw new Error("ECONNREFUSED");
    });

    const result = await enqueueBowlingSurvey(baseInput());

    expect(result.status).toBe("skipped");
    expect(mockedDelete).toHaveBeenCalledTimes(1);
  });
});
