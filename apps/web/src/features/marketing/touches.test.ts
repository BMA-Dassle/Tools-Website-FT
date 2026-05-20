import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/marketing-db", () => ({
  recordMarketingTouch: vi.fn(),
  getLastSentTouch: vi.fn(),
}));

import { recordMarketingTouch, getLastSentTouch } from "@/lib/marketing-db";
import { recordTouch, lastSentAt } from "./touches";

const mockedRecord = vi.mocked(recordMarketingTouch);
const mockedGetLast = vi.mocked(getLastSentTouch);

describe("recordTouch", () => {
  beforeEach(() => {
    mockedRecord.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards input verbatim to the db layer", async () => {
    mockedRecord.mockResolvedValue({
      id: "uuid-1",
      customerId: "CUS_1",
      phoneE164: "+15551234567",
      campaign: "guest_survey",
      channel: "sms",
      event: "sent",
      refId: "tok-1",
      meta: { center: "FM" },
      occurredAt: "2026-05-20T20:00:00.000Z",
    });

    const result = await recordTouch({
      customerId: "CUS_1",
      phoneE164: "+15551234567",
      campaign: "guest_survey",
      event: "sent",
      refId: "tok-1",
      meta: { center: "FM" },
    });

    expect(mockedRecord).toHaveBeenCalledWith({
      customerId: "CUS_1",
      phoneE164: "+15551234567",
      campaign: "guest_survey",
      event: "sent",
      refId: "tok-1",
      meta: { center: "FM" },
    });
    expect(result.id).toBe("uuid-1");
  });
});

describe("lastSentAt", () => {
  beforeEach(() => {
    mockedGetLast.mockReset();
  });

  it("returns null when no prior send", async () => {
    mockedGetLast.mockResolvedValue(null);
    await expect(lastSentAt({ customerId: "CUS_1", campaign: "guest_survey" })).resolves.toBeNull();
  });

  it("returns a Date when a prior send exists", async () => {
    mockedGetLast.mockResolvedValue({
      id: "x",
      customerId: "CUS_1",
      phoneE164: "+15551234567",
      campaign: "guest_survey",
      channel: "sms",
      event: "sent",
      refId: null,
      meta: {},
      occurredAt: "2026-05-01T12:00:00.000Z",
    });
    const result = await lastSentAt({ customerId: "CUS_1", campaign: "guest_survey" });
    expect(result).toBeInstanceOf(Date);
    expect(result?.toISOString()).toBe("2026-05-01T12:00:00.000Z");
  });
});
