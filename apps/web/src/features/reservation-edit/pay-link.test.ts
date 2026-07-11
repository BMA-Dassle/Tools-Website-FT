import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPayLinkUrl,
  payLinkExpired,
  payLinkExpiresAtMs,
  payLinkToken,
  verifyPayLinkToken,
} from "./pay-link";

const HOUR = 60 * 60_000;

describe("pay-link tokens", () => {
  beforeEach(() => {
    process.env.EDIT_PAY_LINK_SECRET = "test-secret";
  });
  afterEach(() => {
    delete process.env.EDIT_PAY_LINK_SECRET;
  });

  it("round-trips: a generated token verifies for its editId only", () => {
    const token = payLinkToken("edit-42-a1");
    expect(verifyPayLinkToken("edit-42-a1", token)).toBe(true);
    expect(verifyPayLinkToken("edit-42-a2", token)).toBe(false);
    const flipped = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    expect(verifyPayLinkToken("edit-42-a1", flipped)).toBe(false);
    expect(verifyPayLinkToken("edit-42-a1", "")).toBe(false);
  });

  it("refuses everything when no secret is configured", () => {
    delete process.env.EDIT_PAY_LINK_SECRET;
    delete process.env.ADMIN_CAMERA_TOKEN;
    expect(verifyPayLinkToken("edit-42-a1", "anything")).toBe(false);
  });

  it("builds the absolute link with the token", () => {
    const url = buildPayLinkUrl("https://headpinz.com", "edit-42-a1");
    expect(url).toBe(`https://headpinz.com/pay/edit/edit-42-a1?t=${payLinkToken("edit-42-a1")}`);
  });
});

describe("pay-link expiry", () => {
  const created = Date.parse("2026-07-11T12:00:00Z");

  it("expires 24h after creation when the event is far out", () => {
    const eventAt = created + 10 * 24 * HOUR;
    expect(payLinkExpiresAtMs(created, eventAt)).toBe(created + 24 * HOUR);
    expect(payLinkExpired(created, eventAt, created + 23 * HOUR)).toBe(false);
    expect(payLinkExpired(created, eventAt, created + 25 * HOUR)).toBe(true);
  });

  it("expires 1h before the event when that is sooner", () => {
    const eventAt = created + 6 * HOUR;
    expect(payLinkExpiresAtMs(created, eventAt)).toBe(eventAt - HOUR);
    expect(payLinkExpired(created, eventAt, eventAt - 2 * HOUR)).toBe(false);
    expect(payLinkExpired(created, eventAt, eventAt - HOUR)).toBe(true);
  });

  it("falls back to the 24h rule when the event time is unknown", () => {
    expect(payLinkExpiresAtMs(created, null)).toBe(created + 24 * HOUR);
  });
});
