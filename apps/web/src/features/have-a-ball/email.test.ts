import { describe, it, expect } from "vitest";
import { renderHabStaffEmail } from "./email";
import { computeJoinPlan } from "./schedule";

const base = {
  firstName: "Dana",
  lastName: "Bowler",
  phone: "(239) 555-1212",
  email: "dana@example.com",
  dob: "1990-04-15",
  teamName: "Pin Crushers",
  subscriptionId: "sub_ABC123",
};

describe("renderHabStaffEmail — ops notification reflects back-pay + subscription", () => {
  it("mid-season: shows the back-pay charge, payment ID, and the subscription schedule", () => {
    const plan = computeJoinPlan("2026-06-09"); // 3 back-pay weeks, sub Jun 16 × 9
    const html = renderHabStaffEmail({ ...base, backPayPaymentId: "pay_XYZ789", plan });

    // Header makes the dual setup obvious
    expect(html).toContain("back-pay charged + subscription created");
    // Back-pay charge
    expect(html).toContain("$63.90");
    expect(html).toContain("3 weeks already played");
    expect(html).toContain("pay_XYZ789");
    // Subscription
    expect(html).toContain("$21.30/week × 9");
    expect(html).toContain("June 16, 2026"); // first weekly charge
    expect(html).toContain("August 11, 2026"); // final charge
    // Totals + IDs
    expect(html).toContain("$255.60");
    expect(html).toContain("sub_ABC123");
    // Bowler details
    expect(html).toContain("Pin Crushers");
    expect(html).toContain("dana@example.com");
  });

  it("flags a missing back-pay payment ID so staff can investigate", () => {
    const plan = computeJoinPlan("2026-06-09");
    const html = renderHabStaffEmail({ ...base, backPayPaymentId: null, plan });
    expect(html).toContain("not recorded (check Square)");
  });

  it("pre-season: no back-pay, just the subscription", () => {
    const plan = computeJoinPlan("2026-05-01");
    const html = renderHabStaffEmail({ ...base, backPayPaymentId: null, plan });
    expect(html).toContain("None — signed up before the season");
    expect(html).toContain("$21.30/week × 12");
    expect(html).not.toContain("already played");
  });
});
