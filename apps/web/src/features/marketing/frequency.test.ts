import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the underlying DB call before importing the unit under test.
vi.mock("@/lib/marketing-db", () => ({
  getLastSentTouch: vi.fn(),
}));

import { getLastSentTouch } from "@/lib/marketing-db";
import { canSend } from "./frequency";

const mockedGetLastSentTouch = vi.mocked(getLastSentTouch);

describe("canSend", () => {
  beforeEach(() => {
    mockedGetLastSentTouch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows send when there is no prior touch", async () => {
    mockedGetLastSentTouch.mockResolvedValue(null);
    const result = await canSend({
      customerId: "CUS_1",
      campaign: "guest_survey",
      windowDays: 30,
    });
    expect(result).toEqual({ allowed: true, lastSentAt: null });
  });

  it("blocks when last send was 29 days 23 hours ago (within 30-day window)", async () => {
    const now = new Date("2026-05-20T12:00:00Z");
    const lastSent = new Date(now.getTime() - (29 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000));
    mockedGetLastSentTouch.mockResolvedValue({
      id: "x",
      customerId: "CUS_1",
      phoneE164: "+15551234567",
      campaign: "guest_survey",
      channel: "sms",
      event: "sent",
      refId: null,
      meta: {},
      occurredAt: lastSent.toISOString(),
    });

    const result = await canSend({
      customerId: "CUS_1",
      campaign: "guest_survey",
      windowDays: 30,
      now,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("within_window");
    expect(result.lastSentAt?.toISOString()).toBe(lastSent.toISOString());
  });

  it("allows at exactly the window boundary (30 days)", async () => {
    const now = new Date("2026-05-20T12:00:00Z");
    const lastSent = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    mockedGetLastSentTouch.mockResolvedValue({
      id: "x",
      customerId: "CUS_1",
      phoneE164: "+15551234567",
      campaign: "guest_survey",
      channel: "sms",
      event: "sent",
      refId: null,
      meta: {},
      occurredAt: lastSent.toISOString(),
    });

    const result = await canSend({
      customerId: "CUS_1",
      campaign: "guest_survey",
      windowDays: 30,
      now,
    });

    expect(result.allowed).toBe(true);
  });

  it("allows when last send was 31 days ago", async () => {
    const now = new Date("2026-05-20T12:00:00Z");
    const lastSent = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    mockedGetLastSentTouch.mockResolvedValue({
      id: "x",
      customerId: "CUS_1",
      phoneE164: "+15551234567",
      campaign: "guest_survey",
      channel: "sms",
      event: "sent",
      refId: null,
      meta: {},
      occurredAt: lastSent.toISOString(),
    });

    const result = await canSend({
      customerId: "CUS_1",
      campaign: "guest_survey",
      windowDays: 30,
      now,
    });

    expect(result.allowed).toBe(true);
  });

  it("isolates campaigns — passing different campaign keys queries them independently", async () => {
    mockedGetLastSentTouch.mockResolvedValue(null);

    await canSend({ customerId: "CUS_1", campaign: "guest_survey", windowDays: 30 });
    await canSend({ customerId: "CUS_1", campaign: "birthday", windowDays: 365 });

    expect(mockedGetLastSentTouch).toHaveBeenCalledTimes(2);
    expect(mockedGetLastSentTouch).toHaveBeenNthCalledWith(1, {
      customerId: "CUS_1",
      campaign: "guest_survey",
    });
    expect(mockedGetLastSentTouch).toHaveBeenNthCalledWith(2, {
      customerId: "CUS_1",
      campaign: "birthday",
    });
  });
});
