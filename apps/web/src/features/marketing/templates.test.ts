import { describe, expect, it } from "vitest";
import {
  assertGsm7Safe,
  renderBowlingSurveyInvite,
  renderRacingSurveyInvite,
  TEMPLATE_KEYS,
} from "./templates";

describe("assertGsm7Safe", () => {
  it("accepts plain ASCII", () => {
    expect(() => assertGsm7Safe("Hello World 123 $5", "test")).not.toThrow();
  });

  it("accepts ASCII punctuation we actually use", () => {
    expect(() => assertGsm7Safe("$5 / 500 Pinz. (yes)", "test")).not.toThrow();
    expect(() => assertGsm7Safe("STOP to opt out", "test")).not.toThrow();
  });

  it("rejects em-dash (charges 2x per segment in extended GSM-7)", () => {
    expect(() => assertGsm7Safe("Tell us — here", "test")).toThrow(/non-GSM-7/);
  });

  it("rejects curly apostrophe", () => {
    expect(() => assertGsm7Safe("We’ll send you", "test")).toThrow(/non-GSM-7/);
  });

  it("rejects emoji", () => {
    expect(() => assertGsm7Safe("Thanks 🎳", "test")).toThrow(/non-GSM-7/);
  });

  it("includes the template key in the error message", () => {
    expect(() => assertGsm7Safe("—", "my_template")).toThrow(/my_template/);
  });
});

describe("renderBowlingSurveyInvite", () => {
  it("renders the approved template with substituted code", () => {
    const body = renderBowlingSurveyInvite({ code: "a1B2c3" });
    expect(body).toBe(
      "Thanks for visiting HeadPinz! How was your visit?\n" +
        "Take 60 sec to tell us. We'll send you a $5 gift card or 500 Pinz.\n" +
        "headpinz.com/s/a1B2c3\n" +
        "STOP to opt out",
    );
  });

  it("is GSM-7 safe (no em-dashes, no curly quotes, no emoji)", () => {
    const body = renderBowlingSurveyInvite({ code: "abc123" });
    expect(() => assertGsm7Safe(body, "bowling_survey_invite")).not.toThrow();
  });

  it("fits in 1 SMS segment (≤160 chars) for an 8-char code", () => {
    const body = renderBowlingSurveyInvite({ code: "12345678" });
    expect(body.length).toBeLessThanOrEqual(160);
  });

  it("includes the STOP footer (marketing compliance)", () => {
    const body = renderBowlingSurveyInvite({ code: "x" });
    expect(body).toContain("STOP");
  });

  it("includes the reward teaser ($5 gift card OR 500 Pinz)", () => {
    const body = renderBowlingSurveyInvite({ code: "x" });
    expect(body).toContain("$5 gift card");
    expect(body).toContain("500 Pinz");
  });

  it("uses the default headpinz.com domain when none is provided", () => {
    const body = renderBowlingSurveyInvite({ code: "x" });
    expect(body).toContain("headpinz.com/s/x");
  });

  it("honors a custom domain override (for FastTrax)", () => {
    const body = renderBowlingSurveyInvite({ code: "x", domain: "fasttrax.com" });
    expect(body).toContain("fasttrax.com/s/x");
    expect(body).not.toContain("headpinz.com");
  });
});

describe("renderRacingSurveyInvite", () => {
  it("renders the FastTrax template with substituted code on fasttraxent.com", () => {
    const body = renderRacingSurveyInvite({ code: "a1B2c3" });
    expect(body).toBe(
      "Thanks for racing at FastTrax! How was it?\n" +
        "Take 60 sec to tell us. We'll send you a $5 gift card or 500 Pinz.\n" +
        "fasttraxent.com/s/a1B2c3\n" +
        "STOP to opt out",
    );
  });

  it("is GSM-7 safe (no em-dashes, no curly quotes, no emoji)", () => {
    const body = renderRacingSurveyInvite({ code: "abc123" });
    expect(() => assertGsm7Safe(body, "racing_survey_invite")).not.toThrow();
  });

  it("fits in 1 SMS segment (≤160 chars) for an 8-char code", () => {
    const body = renderRacingSurveyInvite({ code: "12345678" });
    expect(body.length).toBeLessThanOrEqual(160);
  });

  it("includes the STOP footer + the reward teaser", () => {
    const body = renderRacingSurveyInvite({ code: "x" });
    expect(body).toContain("STOP");
    expect(body).toContain("$5 gift card");
    expect(body).toContain("500 Pinz");
  });

  it("defaults to fasttraxent.com (never headpinz.com)", () => {
    const body = renderRacingSurveyInvite({ code: "x" });
    expect(body).toContain("fasttraxent.com/s/x");
    expect(body).not.toContain("headpinz.com");
  });
});

describe("TEMPLATE_KEYS", () => {
  it("exposes the bowling survey invite key for telemetry", () => {
    expect(TEMPLATE_KEYS.bowlingSurveyInvite).toBe("bowling_survey_invite");
  });

  it("exposes the racing survey invite key for telemetry", () => {
    expect(TEMPLATE_KEYS.racingSurveyInvite).toBe("racing_survey_invite");
  });
});
