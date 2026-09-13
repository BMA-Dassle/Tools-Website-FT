import { describe, expect, it } from "vitest";
import { WebSubmitSchema } from "./schemas";

/**
 * B7's field on the public body. The rule that matters: a planner value we do
 * not like must NEVER cost the guest their enquiry — it degrades to "First
 * available", it does not 400. (R2: the submission reaches Neon either way.)
 */

const BODY = {
  centerKey: "headpinz-ft-myers",
  kind: "all",
  firstName: "CRM",
  lastName: "Test",
  email: "crm-test@example.com",
  phone: "(239) 555-1234",
  eventType: "corporate",
  preferredDate: "2026-10-16",
  preferredTime: "",
  guestCount: 42,
  notes: "",
  activityInterest: [],
  preferredContactMethod: "phone",
  bestTimeToCall: "Afternoon",
  packagePrefill: "",
};

function parse(requestedPlanner: unknown) {
  const r = WebSubmitSchema.safeParse({ ...BODY, requestedPlanner });
  expect(r.success).toBe(true);
  return r.success ? r.data.requestedPlanner : undefined;
}

describe("WebSubmitSchema.requestedPlanner", () => {
  it("a slug survives, lower-cased and trimmed", () => {
    expect(parse("kelsea")).toBe("kelsea");
    expect(parse("  Kelsea  ")).toBe("kelsea");
  });

  it("'First available' — the empty value the form sends by default", () => {
    expect(parse("")).toBeUndefined();
    expect(parse(undefined)).toBeUndefined();
  });

  it("a value that is not a slug is ignored, never a 400", () => {
    for (const bad of [
      "Kelsea Kosco",
      "../../etc/passwd",
      "1' OR '1'='1",
      "x".repeat(200),
      42,
      null,
      { slug: "kelsea" },
      ["kelsea"],
    ]) {
      expect(parse(bad)).toBeUndefined();
    }
  });

  it("the body without the key at all still parses (the five pages before this PR)", () => {
    const r = WebSubmitSchema.safeParse(BODY);
    expect(r.success).toBe(true);
    expect(r.success && r.data.requestedPlanner).toBeUndefined();
  });
});
