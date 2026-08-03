import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the tax-exempt / no-DR-14 compliance nag.
 *
 * Lives in its own file rather than group-function-alert.test.ts because these
 * need `../teams-bot` and `../redis` mocked at module scope, and that file's
 * credential-gated live smoke imports the REAL teams-bot.
 */

// vi.mock factories are hoisted above every top-level `const`, so the doubles
// must be created inside vi.hoisted() or the factory hits a TDZ ReferenceError.
const mocks = vi.hoisted(() => {
  const sendAdaptiveCardToChannel = vi.fn();
  /** Emulates Redis SET ... NX: first call for a key wins, later calls return null. */
  const seenKeys = new Set<string>();
  // Full ioredis arg list — the caller passes (key, "1", "EX", ttl, "NX"), and the
  // TTL assertion below reads index 3, so the rest params must be typed.
  const redisSet = vi.fn(async (key: string, ..._rest: unknown[]) => {
    if (seenKeys.has(key)) return null;
    seenKeys.add(key);
    return "OK";
  });
  return { sendAdaptiveCardToChannel, redisSet, seenKeys };
});
vi.mock("../teams-bot", () => ({
  sendAdaptiveCardToChannel: mocks.sendAdaptiveCardToChannel,
}));
vi.mock("../redis", () => ({ default: { set: mocks.redisSet } }));

const { sendAdaptiveCardToChannel, redisSet, seenKeys } = mocks;

import { notifyTaxExemptNoCertificate } from "../group-function-alert";
import { plannerChatIdForEmail, GUEST_SERVICES_CHAT_ID } from "../sales-lead-config";

const PLANNER = "stephanie@headpinz.com";

function params(overrides: Record<string, unknown> = {}) {
  return {
    centerName: "HeadPinz Fort Myers",
    reservationId: "56668368",
    eventNumber: "3447",
    eventName: "JW Group",
    eventDateDisplay: "Aug 9 11:00 AM",
    guestName: "Acy Olmo-Ortigoza",
    guestEmail: "acymichelle@yahoo.com",
    plannerEmail: PLANNER,
    totalCents: 127374,
    contractUrl: "https://headpinz.com/contract/6f72f73a",
    signed: false,
    ...overrides,
  } as Parameters<typeof notifyTaxExemptNoCertificate>[0];
}

/** Flatten every TextBlock string in the card body. */
function cardText(card: Record<string, unknown>): string {
  return JSON.stringify(card);
}

beforeEach(() => {
  seenKeys.clear();
  sendAdaptiveCardToChannel.mockReset();
  sendAdaptiveCardToChannel.mockResolvedValue({ id: "activity-1" });
  redisSet.mockClear();
});

describe("notifyTaxExemptNoCertificate", () => {
  it("posts to the assigned planner's chat", async () => {
    const posted = await notifyTaxExemptNoCertificate(params());
    expect(posted).toBe(true);
    expect(sendAdaptiveCardToChannel).toHaveBeenCalledTimes(1);
    expect(sendAdaptiveCardToChannel.mock.calls[0][0]).toBe(plannerChatIdForEmail(PLANNER));
  });

  it("falls back to Guest Services when no planner is assigned", async () => {
    await notifyTaxExemptNoCertificate(params({ plannerEmail: null }));
    expect(sendAdaptiveCardToChannel.mock.calls[0][0]).toBe(GUEST_SERVICES_CHAT_ID);
  });

  it("states that no tax was charged and no certificate is on file", async () => {
    await notifyTaxExemptNoCertificate(params());
    const text = cardText(sendAdaptiveCardToChannel.mock.calls[0][1]);
    expect(text).toContain("GF Tax Exempt");
    expect(text).toContain("No DR-14 exemption certificate has been uploaded");
    expect(text).toContain("$1273.74");
  });

  it("tells staff to chase the certificate directly once the contract is signed", async () => {
    await notifyTaxExemptNoCertificate(params({ signed: true }));
    const text = cardText(sendAdaptiveCardToChannel.mock.calls[0][1]);
    expect(text).toContain("already signed");
    expect(text).toContain("request the certificate directly");
  });

  it("says the guest will be asked at signing when still unsigned", async () => {
    await notifyTaxExemptNoCertificate(params({ signed: false }));
    const text = cardText(sendAdaptiveCardToChannel.mock.calls[0][1]);
    expect(text).toContain("will be asked to upload it when they sign");
  });

  it("de-dupes a repeat for the same reservation", async () => {
    expect(await notifyTaxExemptNoCertificate(params())).toBe(true);
    expect(await notifyTaxExemptNoCertificate(params())).toBe(false);
    expect(sendAdaptiveCardToChannel).toHaveBeenCalledTimes(1);
  });

  it("re-arms once the event becomes signed — that is a different, more urgent ask", async () => {
    expect(await notifyTaxExemptNoCertificate(params({ signed: false }))).toBe(true);
    expect(await notifyTaxExemptNoCertificate(params({ signed: true }))).toBe(true);
    expect(sendAdaptiveCardToChannel).toHaveBeenCalledTimes(2);
  });

  it("nags weekly, not on the 6h data-issue throttle", async () => {
    await notifyTaxExemptNoCertificate(params());
    const ttl = redisSet.mock.calls[0][3];
    expect(ttl).toBe(7 * 24 * 60 * 60);
  });

  it("reports false (and does not throw) when Teams rejects the card", async () => {
    sendAdaptiveCardToChannel.mockRejectedValueOnce(new Error("Teams 502"));
    expect(await notifyTaxExemptNoCertificate(params())).toBe(false);
  });

  it("carries the contract link so staff can hand over the upload page", async () => {
    await notifyTaxExemptNoCertificate(params());
    const card = sendAdaptiveCardToChannel.mock.calls[0][1] as {
      actions: Array<{ url: string }>;
    };
    expect(card.actions[0].url).toBe("https://headpinz.com/contract/6f72f73a");
  });
});
