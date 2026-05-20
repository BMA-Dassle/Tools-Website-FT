import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/marketing-db", () => ({
  getMarketingConsent: vi.fn(),
  upsertMarketingConsent: vi.fn(),
}));

import { getMarketingConsent, upsertMarketingConsent } from "@/lib/marketing-db";
import { hasMarketingOptIn, recordOptIn, recordOptOut } from "./consent";

const mockedGet = vi.mocked(getMarketingConsent);
const mockedUpsert = vi.mocked(upsertMarketingConsent);

describe("consent registry", () => {
  beforeEach(() => {
    mockedGet.mockReset();
    mockedUpsert.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("hasMarketingOptIn", () => {
    it("returns false for unknown phones (default-deny)", async () => {
      mockedGet.mockResolvedValue(null);
      await expect(hasMarketingOptIn("+15551234567")).resolves.toBe(false);
    });

    it("returns true when opted_in is true", async () => {
      mockedGet.mockResolvedValue({
        phoneE164: "+15551234567",
        optedIn: true,
        source: "booking_confirmation",
        reason: null,
        updatedAt: "2026-05-01T00:00:00.000Z",
      });
      await expect(hasMarketingOptIn("+15551234567")).resolves.toBe(true);
    });

    it("returns false when opted_in is false (opted out)", async () => {
      mockedGet.mockResolvedValue({
        phoneE164: "+15551234567",
        optedIn: false,
        source: "inbound_sms_stop",
        reason: "STOP reply",
        updatedAt: "2026-05-02T00:00:00.000Z",
      });
      await expect(hasMarketingOptIn("+15551234567")).resolves.toBe(false);
    });
  });

  describe("recordOptIn", () => {
    it("writes opted_in=true with the source", async () => {
      await recordOptIn({ phoneE164: "+15551234567", source: "booking_confirmation" });
      expect(mockedUpsert).toHaveBeenCalledWith({
        phoneE164: "+15551234567",
        optedIn: true,
        source: "booking_confirmation",
      });
    });
  });

  describe("recordOptOut", () => {
    it("writes opted_in=false with reason", async () => {
      await recordOptOut({
        phoneE164: "+15551234567",
        source: "inbound_sms_stop",
        reason: "STOP reply",
      });
      expect(mockedUpsert).toHaveBeenCalledWith({
        phoneE164: "+15551234567",
        optedIn: false,
        source: "inbound_sms_stop",
        reason: "STOP reply",
      });
    });

    it("accepts a missing reason", async () => {
      await recordOptOut({ phoneE164: "+15551234567", source: "admin" });
      expect(mockedUpsert).toHaveBeenCalledWith({
        phoneE164: "+15551234567",
        optedIn: false,
        source: "admin",
        reason: null,
      });
    });
  });

  it("supports the opt-in → opt-out → re-opt-in flow", async () => {
    await recordOptIn({ phoneE164: "+15551234567", source: "booking_confirmation" });
    await recordOptOut({
      phoneE164: "+15551234567",
      source: "inbound_sms_stop",
      reason: "STOP",
    });
    await recordOptIn({ phoneE164: "+15551234567", source: "inbound_sms_start" });

    expect(mockedUpsert).toHaveBeenCalledTimes(3);
    expect(mockedUpsert.mock.calls[0][0].optedIn).toBe(true);
    expect(mockedUpsert.mock.calls[1][0].optedIn).toBe(false);
    expect(mockedUpsert.mock.calls[2][0].optedIn).toBe(true);
  });
});
