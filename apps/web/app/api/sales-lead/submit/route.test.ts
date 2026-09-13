import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { CreateLeadResult } from "~/features/crm/leads";
import { makeLead } from "~/features/crm/leads/test-support";

/**
 * CONTRACT TEST for the untouched form pages: `POST /api/sales-lead/submit`
 * answers the bodies `SalesLeadForm.tsx` reads, before and after B3's
 * cutover to `createLead`.
 */

const bag = vi.hoisted(() => ({
  calls: [] as unknown[][],
  result: null as unknown,
}));

vi.mock("~/features/crm/leads", async (importOriginal) => {
  const mod = await importOriginal<typeof import("~/features/crm/leads")>();
  return {
    ...mod,
    createLead: async (...args: unknown[]) => {
      bag.calls.push(args);
      return bag.result as CreateLeadResult;
    },
  };
});

const { POST } = await import("./route");

const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost:3000/api/sales-lead/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const BODY = {
  centerKey: "fasttrax-ft-myers",
  kind: "group",
  firstName: "CRM",
  lastName: "Test",
  email: "crm-test@example.com",
  phone: "(239) 555-1234",
  eventType: "birthday-kid",
  preferredDate: "2026-10-16",
  guestCount: 12,
  notes: "test",
  preferredContactMethod: "text",
};

function minted(): CreateLeadResult {
  return {
    lead: makeLead({ id: "5001" }),
    created: true,
    mint: {
      status: "minted",
      projectId: "63000000009561437",
      projectNumber: "DH3249",
      personId: "63000000009561438",
      assignedAgent: { name: "Kelsea Kosco" },
    },
    notify: {
      planner: { displayName: "Kelsea", isIndividual: true },
      queueCard: { ok: true, skipped: true, reason: "CRM_JACOB_TEAMS_CHAT_ID not set" },
      plannerCard: { ok: true, activityId: "a" },
      sms: { ok: true, status: 200 },
      email: { ok: true, status: null, skipped: true, reason: "skipped — customer prefers text" },
    },
    suggestion: { suggestion: null, trace: [] },
    assignment: null,
  };
}

beforeEach(() => {
  bag.calls = [];
  bag.result = minted();
});

describe("POST /api/sales-lead/submit", () => {
  it("invalid JSON → 400 {error:'Invalid JSON body'}", async () => {
    const res = await post("{nope");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
    expect(bag.calls).toHaveLength(0);
  });

  it("missing fields → 400 with the legacy wording, in the legacy order", async () => {
    const res = await post({
      centerKey: "fasttrax-ft-myers",
      lastName: "Test",
      phone: "2395551234",
      preferredDate: "2026-10-16",
      guestCount: 4,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing required fields: firstName, email" });
  });

  it("unknown centerKey → 400", async () => {
    const res = await post({ ...BODY, centerKey: "bowlero" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown centerKey: bowlero" });
  });

  it("success: the legacy body, and createLead was called with source web, FT, kids birthday, 12:00 default time", async () => {
    const res = await post(BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      projectID: "63000000009561437",
      projectNumber: "DH3249",
      planner: { displayName: "Kelsea", isIndividual: true },
      results: { sms: { ok: true, status: 200 }, teams: { ok: true, activityId: "a" } },
    });
    expect(typeof body.projectID).toBe("string");
    expect(bag.calls).toHaveLength(1);
    const [input, opts] = bag.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(opts).toEqual({ source: "web" });
    expect(input).toMatchObject({
      centre: "FT",
      type: "birthday",
      kids: true,
      eventTime: "12:00",
      guests: 12,
      email: "crm-test@example.com",
      preferredContactMethod: "text",
      createdBy: null,
    });
    expect(String(input.specialRequests)).toContain("Event subtype: Kids birthday");
  });

  it("Pandora down → 502 {error} (the legacy error shape) even though the lead row exists", async () => {
    bag.result = {
      ...minted(),
      mint: { status: "failed", error: "Pandora returned 502", httpStatus: 502 },
      notify: null,
    };
    const res = await post(BODY);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Pandora returned 502" });
  });
});
