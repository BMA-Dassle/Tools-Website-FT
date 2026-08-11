import { describe, expect, it } from "vitest";
import { BETA_DISCLAIMER } from "./config";
import { buildTimeChangeCard, timeChangeSummaryText } from "./time-change-card";

const params = {
  guestName: "Max Maurer",
  playerCount: 2,
  comboName: "VIP Experience",
  oldIso: "2026-07-11T01:45:00.000Z", // 9:45 PM ET
  newIso: "2026-07-11T02:15:00.000Z", // 10:15 PM ET
  lane: "5",
  centerLabel: "HeadPinz Fort Myers",
};

describe("buildTimeChangeCard", () => {
  it("carries the combo name, party, old/new times, lane, and disclaimer", () => {
    const json = JSON.stringify(buildTimeChangeCard(params));
    expect(json).toContain("VIP EXPERIENCE · BOWLING TIME CHANGED");
    expect(json).toContain("Max Maurer · party of 2");
    expect(json).toContain("9:45 PM");
    expect(json).toContain("10:15 PM");
    expect(json).toContain("Lane 5");
    expect(json).toContain("HeadPinz Fort Myers");
    expect(json).toContain(BETA_DISCLAIMER);
  });

  it("omits the lane cleanly when unknown", () => {
    const json = JSON.stringify(buildTimeChangeCard({ ...params, lane: undefined }));
    expect(json).not.toContain("Lane");
  });
});

describe("timeChangeSummaryText", () => {
  it("summarizes the move", () => {
    expect(timeChangeSummaryText(params)).toBe(
      "VIP Experience: Max Maurer bowling moved 9:45 PM to 10:15 PM (BETA)",
    );
  });
});
