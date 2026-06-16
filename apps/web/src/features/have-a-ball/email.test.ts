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

describe("renderHabStaffEmail — ops notification reflects subscription + retro to collect", () => {
  it("mid-season: subscription schedule + the retro amount staff must collect separately", () => {
    const plan = computeJoinPlan("2026-06-09"); // 3 missed weeks (retro), sub Jun 16 × 9
    const html = renderHabStaffEmail({ ...base, plan });

    // Header makes the setup obvious
    expect(html).toContain("subscription for the 9 remaining weeks created");
    expect(html).toContain("$63.90 retro to collect");
    // Subscription (auto-charged) — only the remaining weeks
    expect(html).toContain("$21.30/week × 9");
    expect(html).toContain("June 16, 2026"); // first weekly charge
    expect(html).toContain("August 11, 2026"); // final charge
    expect(html).toContain("$191.70"); // 9 × $21.30 subscription total
    // Retro — disclosed, NOT charged
    expect(html).toContain("$63.90");
    expect(html).toContain("3 weeks already played");
    expect(html).toContain("collect separately");
    // IDs + bowler details
    expect(html).toContain("sub_ABC123");
    expect(html).toContain("Pin Crushers");
    expect(html).toContain("dana@example.com");
  });

  it("pre-season: just the subscription, no retro to collect", () => {
    const plan = computeJoinPlan("2026-05-01");
    const html = renderHabStaffEmail({ ...base, plan });
    expect(html).toContain("$21.30/week × 12");
    expect(html).not.toContain("already played");
    expect(html).not.toContain("retro to collect");
  });
});
