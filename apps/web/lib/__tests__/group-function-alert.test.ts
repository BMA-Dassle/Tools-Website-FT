import { describe, it, expect, vi } from "vitest";

// Load .env.local into process.env BEFORE any imports evaluate — `@/lib/teams-bot`
// captures BOT_APP_ID/SECRET at module-load time, so this must be hoisted above
// the static imports below. Only runs for the credential-gated live smoke.
// NOTE: the live smoke needs REAL bot creds, which live in Vercel — local
// `.env.local` has placeholders, so run this where real creds exist (e.g. after
// `vercel env pull`) or it will 401.
vi.hoisted(async () => {
  if (process.env.GF_ALERT_SMOKE !== "1") return;
  try {
    const { readFileSync } = await import("node:fs");
    const envUrl = new URL("../../.env.local", import.meta.url);
    for (const line of readFileSync(envUrl, "utf8").split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* optional — test is skipped without the flag anyway */
  }
});

import { collectContractDataIssues, buildAlertCard } from "../group-function-alert";
import { plannerChatIdForEmail, GUEST_SERVICES_CHAT_ID } from "../sales-lead-config";
import type { HermesQueueItem } from "../hermes-client";

/** A fully-valid scanned item; override per-test to introduce a single defect. */
function makeItem(overrides: Partial<HermesQueueItem> = {}): HermesQueueItem {
  return {
    queueId: 0,
    logId: 0,
    center: "10.48.0.14",
    centerName: "HeadPinz Fort Myers",
    location: "HeadPinz Fort Myers",
    subject: "Smith Birthday",
    reservationId: "12345",
    event: { name: "Smith Birthday", date: "", dateRaw: "", notes: "", number: "1001" },
    customer: { email: "guest@example.com", first: "Sam", last: "Smith", phone: "+12395551234" },
    planner: {
      email: "stephanie@headpinz.com",
      first: "Stephanie",
      last: "",
      phone: "+12392148357",
    },
    products: [],
    payments: [],
    tax: 0,
    totalBill: 0,
    depositDue: 0,
    ...overrides,
  };
}

describe("collectContractDataIssues", () => {
  it("returns no issues for a complete item", () => {
    expect(collectContractDataIssues(makeItem(), "fort-myers")).toEqual([]);
  });

  it("flags a missing guest email", () => {
    const issues = collectContractDataIssues(
      makeItem({ customer: { email: "", first: "Sam", last: "Smith", phone: "+12395551234" } }),
      "fort-myers",
    );
    expect(issues).toContain("Guest email is missing");
  });

  it("flags a syntactically invalid guest email", () => {
    const issues = collectContractDataIssues(
      makeItem({
        customer: { email: "not-an-email", first: "Sam", last: "Smith", phone: "+12395551234" },
      }),
      "fort-myers",
    );
    expect(issues.some((i) => i.startsWith("Guest email looks invalid"))).toBe(true);
  });

  it("flags an incomplete guest name", () => {
    const issues = collectContractDataIssues(
      makeItem({
        customer: { email: "guest@example.com", first: "Sam", last: "", phone: "+12395551234" },
      }),
      "fort-myers",
    );
    expect(issues).toContain("Guest name is incomplete (first/last)");
  });

  it("flags a missing/short guest phone", () => {
    const issues = collectContractDataIssues(
      makeItem({
        customer: { email: "guest@example.com", first: "Sam", last: "Smith", phone: "123" },
      }),
      "fort-myers",
    );
    expect(issues.some((i) => i.startsWith("Guest phone is missing"))).toBe(true);
  });

  it("flags a missing planner email", () => {
    const issues = collectContractDataIssues(
      makeItem({ planner: { email: "", first: "", last: "", phone: "" } }),
      "fort-myers",
    );
    expect(issues.some((i) => i.startsWith("Planner email is not set"))).toBe(true);
  });

  it("flags a blank location selector at Fort Myers / FastTrax", () => {
    expect(collectContractDataIssues(makeItem({ location: undefined }), "fort-myers")).toContain(
      "Location selector not set in BMI — defaulted to HeadPinz Fort Myers",
    );
    expect(collectContractDataIssues(makeItem({ location: "" }), "fasttrax")).toContain(
      "Location selector not set in BMI — defaulted to HeadPinz Fort Myers",
    );
  });

  it("does NOT flag a blank location selector at Naples (no selector there)", () => {
    expect(collectContractDataIssues(makeItem({ location: undefined }), "naples")).toEqual([]);
  });
});

describe("alert routing (plannerChatIdForEmail)", () => {
  it("resolves a known planner email to their Teams chat id", () => {
    expect(plannerChatIdForEmail("stephanie@headpinz.com")).toMatch(/@thread\.v2$/);
    // case-insensitive
    expect(plannerChatIdForEmail("STEPHANIE@headpinz.com")).toBe(
      plannerChatIdForEmail("stephanie@headpinz.com"),
    );
  });

  it("returns null for an unknown / empty email (caller falls back to Guest Services)", () => {
    expect(plannerChatIdForEmail("nobody@example.com")).toBeNull();
    expect(plannerChatIdForEmail("")).toBeNull();
    expect(plannerChatIdForEmail(null)).toBeNull();
    expect(GUEST_SERVICES_CHAT_ID).toMatch(/@thread\.v2$/);
  });
});

/**
 * Live Teams round-trip — SKIPPED unless GF_ALERT_SMOKE=1. Posts the real
 * Adaptive Card to the Guest Services chat (the fallback target), asserts Teams
 * accepted it, then deletes it so no residue is left in the chat. Run with:
 *   GF_ALERT_SMOKE=1 npm run test -w fasttrax-web -- lib/__tests__/group-function-alert.test.ts
 */
describe.runIf(process.env.GF_ALERT_SMOKE === "1")("live Teams smoke", () => {
  it("posts the alert card to Guest Services and deletes it", async () => {
    const { sendAdaptiveCardToChannel, deleteActivity } = await import("../teams-bot");
    const card = buildAlertCard({
      eyebrow: "⚠ SMOKE TEST · BMI #SMOKE-TEST",
      title: "Smoke Test — please ignore",
      subtitle: "HeadPinz Fort Myers · Planner: (smoke test)",
      headerStyle: "warning",
      facts: [
        { title: "Guest", value: "Smoke Test" },
        { title: "Email", value: "— (missing)" },
        { title: "BMI #", value: "SMOKE-TEST" },
      ],
      issues: ["This is an automated smoke test and will be deleted immediately."],
      contractUrl: "https://fasttraxent.com",
    });

    const sent = await sendAdaptiveCardToChannel(GUEST_SERVICES_CHAT_ID, card, {
      summaryText: "⚠ smoke test (auto-deletes)",
    });
    expect(sent.id).toBeTruthy();

    const del = await deleteActivity(GUEST_SERVICES_CHAT_ID, sent.id);
    expect(del.ok).toBe(true);
  }, 20_000);
});
