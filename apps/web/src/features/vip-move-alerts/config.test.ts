import { afterEach, describe, expect, it } from "vitest";
import { vipBoardUrl, vipMoveAlertsChatId, vipMoveAlertsEnabled, DEFAULT_CHAT_ID } from "./config";
import { buildTimeChangeCard } from "./time-change-card";

const TOKEN = "c".repeat(32);

afterEach(() => {
  delete process.env.ADMIN_CAMERA_TOKEN;
  delete process.env.ADMIN_PUBLIC_URL;
  delete process.env.VIP_MOVE_ALERTS_CHAT_ID;
  delete process.env.VIP_MOVE_ALERTS_ENABLED;
});

describe("vipBoardUrl", () => {
  it("links at the SSO staff shell with the VIP filter", () => {
    expect(vipBoardUrl()).toBe("https://admin.fasttraxent.com/reservations?view=vip");
  });

  it("carries NO admin token — these cards are posted into a Teams chat", () => {
    process.env.ADMIN_CAMERA_TOKEN = TOKEN;
    const url = vipBoardUrl()!;
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain("/admin/");
  });

  it("is never null now, so the card always gets its button", () => {
    delete process.env.ADMIN_CAMERA_TOKEN;
    expect(vipBoardUrl()).toBeTypeOf("string");
  });

  it("keeps the token out of the RENDERED card, not just the helper", () => {
    process.env.ADMIN_CAMERA_TOKEN = TOKEN;
    const json = JSON.stringify(
      buildTimeChangeCard({
        guestName: "Max Maurer",
        playerCount: 2,
        comboName: "VIP Experience",
        oldIso: "2026-07-11T01:45:00.000Z",
        newIso: "2026-07-11T02:15:00.000Z",
        centerLabel: "HeadPinz Fort Myers",
        boardUrl: vipBoardUrl(),
      }),
    );
    expect(json).toContain("https://admin.fasttraxent.com/reservations?view=vip");
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain("/admin/");
  });
});

describe("config knobs are unchanged", () => {
  it("chat id defaults, env overrides", () => {
    expect(vipMoveAlertsChatId()).toBe(DEFAULT_CHAT_ID);
    process.env.VIP_MOVE_ALERTS_CHAT_ID = "19:test@thread.v2";
    expect(vipMoveAlertsChatId()).toBe("19:test@thread.v2");
  });

  it("the flag is a kill switch — ON unless explicitly 'false'", () => {
    expect(vipMoveAlertsEnabled()).toBe(true);
    process.env.VIP_MOVE_ALERTS_ENABLED = "true";
    expect(vipMoveAlertsEnabled()).toBe(true);
    process.env.VIP_MOVE_ALERTS_ENABLED = "false";
    expect(vipMoveAlertsEnabled()).toBe(false);
  });
});
