import { describe, expect, it } from "vitest";
import {
  CANCELLATION_POLICY_VERSION,
  cancellationPolicyEmailHtml,
  getCancellationPolicy,
} from "./cancellation-policy";

const FT = {
  brandName: "FastTrax Entertainment",
  brandPhone: "(239) 481-9666",
  cancellationHours: 2,
};

describe("getCancellationPolicy", () => {
  it("renders the racing/attraction 2-hour window and brand phone", () => {
    const p = getCancellationPolicy(FT);
    const flat = p.sections.flatMap((s) => s.items).join(" ");
    expect(flat).toContain("more than 2 hours");
    expect(flat).toContain("within 2 hours");
    expect(flat).toContain("non-refundable, no exceptions");
    expect(flat).toContain("(239) 481-9666");
    expect(flat).toContain("FastTrax Entertainment");
    expect(p.intro).toContain("All sales are final");
  });

  it("renders the bowling 1-hour window (singular)", () => {
    const p = getCancellationPolicy({ ...FT, cancellationHours: 1, brandName: "HeadPinz" });
    const flat = p.sections.flatMap((s) => s.items).join(" ");
    expect(flat).toContain("more than 1 hour");
    expect(flat).not.toContain("1 hours");
    expect(flat).toContain("HeadPinz");
  });
});

describe("cancellationPolicyEmailHtml", () => {
  it("produces an email block with the policy text and escapes HTML", () => {
    const html = cancellationPolicyEmailHtml(FT);
    expect(html).toContain("Cancellation &amp; Payment Policy");
    expect(html).toContain("All sales are final");
    expect(html).toContain("non-refundable, no exceptions");
    expect(html).toContain("(239) 481-9666");
    // "&" in headings/text is escaped, never a raw "&" followed by a space
    expect(html).toContain("Cancellations &amp; Reschedules");
    expect(html).toContain("Disputes &amp; Chargebacks");
  });
});

describe("policy version is a single source", () => {
  it("clickwrap CURRENT_POLICY_VERSION equals CANCELLATION_POLICY_VERSION", async () => {
    const { CURRENT_POLICY_VERSION } = await import("./clickwrap");
    expect(CURRENT_POLICY_VERSION).toBe(CANCELLATION_POLICY_VERSION);
  });
});
