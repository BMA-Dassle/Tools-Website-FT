import { describe, expect, it } from "vitest";
import { WebSubmitSchema, type WebSubmitBody } from "../schemas";
import { makeLead } from "../test-support";
import type { CreateLeadResult } from "./create-lead";
import {
  FORM_EVENT_TO_CRM,
  WEB_DEFAULT_EVENT_TIME,
  WEB_REQUIRED_ORDER,
  buildPandoraNotes,
  centreForCenterKey,
  classifyWebSubmitIssues,
  friendlyEventLabel,
  isBlankWebValue,
  legacyWebResponse,
  missingFieldsMessage,
  webBodyToCreateInput,
  webEventType,
  webSubmitErrorMessage,
} from "./web-submit";

/**
 * The web form's contract, pinned: the same centerKey → centre mapping, the
 * same `specialRequests` blob, the same default time, and the legacy response
 * bodies the five `SalesLeadForm.tsx` pages read.
 */

const BODY: WebSubmitBody = {
  centerKey: "fasttrax-ft-myers",
  kind: "group",
  firstName: "CRM",
  lastName: "Test",
  email: "crm-test@example.com",
  phone: "(239) 555-1234",
  eventType: "team-building",
  preferredDate: "2026-10-16",
  preferredTime: undefined,
  guestCount: 42,
  notes: "Karting + pizza",
  activityInterest: ["Karting", "Pizza"],
  preferredContactMethod: "text",
  bestTimeToCall: "Evening",
  packagePrefill: "Blue Starter",
  requestedPlanner: undefined,
};

describe("centreForCenterKey", () => {
  it("the three form keys map to the three centres; anything else is null", () => {
    expect(centreForCenterKey("fasttrax-ft-myers")?.centre).toBe("FT");
    expect(centreForCenterKey("headpinz-ft-myers")?.centre).toBe("HPFM");
    expect(centreForCenterKey("headpinz-naples")?.centre).toBe("HPN");
    expect(centreForCenterKey("bowlero")).toBeNull();
  });
});

describe("event types", () => {
  it("birthday-kid is the only kids flag; other → corporate", () => {
    expect(FORM_EVENT_TO_CRM["birthday-kid"]).toEqual({ type: "birthday", kids: true });
    expect(FORM_EVENT_TO_CRM["birthday-adult"]).toEqual({ type: "birthday", kids: false });
    expect(webEventType("school-group", "group")).toEqual({ type: "school", kids: false });
    expect(webEventType(undefined, "birthday")).toEqual({ type: "birthday", kids: false });
    expect(webEventType("mystery", "group")).toEqual({ type: "corporate", kids: false });
    expect(friendlyEventLabel("birthday-kid", "birthday")).toBe("Kids birthday");
    expect(friendlyEventLabel(undefined, "team")).toBe("Team outing");
  });
});

describe("buildPandoraNotes (verbatim port)", () => {
  it("under-minimum disclosure first (12 for kids, 20 otherwise), then package, subtype, interests, notes", () => {
    expect(
      buildPandoraNotes({
        ...BODY,
        guestCount: 10,
        eventType: "birthday-kid",
        kind: "birthday",
      }).split("\n"),
    ).toEqual([
      "⚠️ UNDER MINIMUM — guest submitted 10 but acknowledged pricing will be billed at the 12-guest package minimum.",
      "Package interested in: Blue Starter",
      "Event subtype: Kids birthday",
      "Interests: Karting, Pizza",
      "Karting + pizza",
    ]);
    expect(buildPandoraNotes({ ...BODY, guestCount: 15 }).split("\n")[0]).toContain(
      "20-guest package minimum",
    );
    expect(
      buildPandoraNotes({
        ...BODY,
        guestCount: 42,
        packagePrefill: undefined,
        activityInterest: undefined,
        notes: undefined,
      }),
    ).toBe("Event subtype: Team building");
  });
});

describe("webBodyToCreateInput", () => {
  it("defaults the time to 12:00 (the route's old default), maps prefs and keeps the raw body", () => {
    const i = webBodyToCreateInput(BODY, "FT");
    expect(i).toMatchObject({
      centre: "FT",
      firstName: "CRM",
      eventDate: "2026-10-16",
      eventTime: WEB_DEFAULT_EVENT_TIME,
      guests: 42,
      type: "team",
      kids: false,
      prefers: "text",
      preferredContactMethod: "text",
      bestTimeToCall: "Evening",
      packageType: "Blue Starter",
      eventTypeLabel: "Team building",
      createdBy: null,
    });
    expect(i.specialRequests).toContain("Package interested in: Blue Starter");
    expect(i.capturePayload).toEqual(BODY);
    expect(webBodyToCreateInput({ ...BODY, preferredTime: "17:30:00" }, "FT").eventTime).toBe(
      "17:30",
    );
    expect(webBodyToCreateInput({ ...BODY, preferredContactMethod: "phone" }, "FT").prefers).toBe(
      "call",
    );
  });

  it("carries the planner the guest asked for as a SLUG, and null when they did not", () => {
    expect(webBodyToCreateInput(BODY, "FT").requestedPlannerSlug).toBeNull();
    expect(
      webBodyToCreateInput({ ...BODY, requestedPlanner: "kelsea" }, "FT").requestedPlannerSlug,
    ).toBe("kelsea");
  });
});

describe("legacyWebResponse", () => {
  const lead = makeLead({ id: "5001" });
  const base: CreateLeadResult = {
    lead,
    created: true,
    mint: {
      status: "minted",
      projectId: "63000000009561437",
      projectNumber: "DH3249",
      personId: null,
      assignedAgent: null,
    },
    notify: {
      planner: { displayName: "Kelsea", isIndividual: true },
      unassignedCard: { ok: true, skipped: true, reason: "x" },
      plannerCard: { ok: true, activityId: "a" },
      sms: { ok: true, status: 200 },
      email: { ok: false, status: 500, error: "boom" },
    },
    suggestion: { suggestion: null, trace: [], outcome: "none" as const },
    assignment: null,
  };

  it("200: exactly the keys the form reads, projectID as a string", () => {
    const r = legacyWebResponse(base);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      projectID: "63000000009561437",
      projectNumber: "DH3249",
      planner: { displayName: "Kelsea", isIndividual: true },
      results: {
        sms: { ok: true, status: 200 },
        email: { ok: false, status: 500, error: "boom" },
        teams: { ok: true, activityId: "a" },
      },
      leadId: "L-5001",
    });
  });

  it("502 with {error} when Pandora failed — the legacy error shape", () => {
    expect(
      legacyWebResponse({
        ...base,
        mint: { status: "failed", error: "Pandora returned 502", httpStatus: 502 },
      }),
    ).toEqual({
      status: 502,
      body: { error: "Pandora returned 502" },
    });
  });

  it("planner falls back to Guest Services when notifications did not run", () => {
    expect(legacyWebResponse({ ...base, notify: null }).body.planner).toEqual({
      displayName: "Guest Services",
      isIndividual: false,
    });
  });

  it("missingFieldsMessage matches the legacy wording", () => {
    expect(missingFieldsMessage(["firstName", "email"])).toBe(
      "Missing required fields: firstName, email",
    );
  });
});

describe("WebSubmitSchema", () => {
  it("accepts the form's body and lowercases the email", () => {
    const p = WebSubmitSchema.safeParse({ ...BODY, email: "CRM-Test@Example.com" });
    expect(p.success).toBe(true);
    if (p.success) expect(p.data.email).toBe("crm-test@example.com");
  });
  it("names the missing fields", () => {
    const p = WebSubmitSchema.safeParse({ centerKey: "x" });
    expect(p.success).toBe(false);
    if (!p.success) {
      const paths = new Set(p.error.issues.map((i) => String(i.path[0])));
      for (const k of ["firstName", "lastName", "email", "phone", "guestCount"])
        expect(paths.has(k)).toBe(true);
    }
  });

  /**
   * The form posts every optional control raw, so an untouched one is `""`
   * on the wire, not an absent key (`SalesLeadForm.tsx:347-363`). `""` is
   * "not filled in": it must fall through to the same defaults the legacy
   * route applied, never produce a 400 that loses the capture.
   */
  it("every optional control accepts the empty string the form sends", () => {
    const p = WebSubmitSchema.safeParse({
      centerKey: "fasttrax-ft-myers",
      kind: "",
      firstName: "CRM",
      lastName: "Test",
      email: "crm-test@example.com",
      phone: "2395551234",
      eventType: "",
      preferredDate: "",
      preferredTime: "",
      guestCount: 12,
      notes: "",
      activityInterest: [],
      preferredContactMethod: "",
      bestTimeToCall: "",
      packagePrefill: "",
    });
    expect(p.success).toBe(true);
    if (p.success) {
      for (const k of [
        "kind",
        "eventType",
        "preferredDate",
        "preferredTime",
        "notes",
        "preferredContactMethod",
        "bestTimeToCall",
        "packagePrefill",
      ] as const)
        expect([k, p.data[k]]).toEqual([k, undefined]);
      expect(webBodyToCreateInput(p.data, "FT").eventTime).toBe(WEB_DEFAULT_EVENT_TIME);
    }
  });

  it("kind 'all' is a real form value (three of the five pages)", () => {
    for (const kind of ["group", "birthday", "all"])
      expect(WebSubmitSchema.safeParse({ ...BODY, kind }).success).toBe(true);
    expect(WebSubmitSchema.safeParse({ ...BODY, kind: "nope" }).success).toBe(false);
  });

  it("each bound rejects only a value the guest actually typed", () => {
    const bad = (over: Record<string, unknown>) => {
      const p = WebSubmitSchema.safeParse({ ...BODY, ...over });
      expect(p.success).toBe(false);
      return p.success ? [] : p.error.issues.map((i) => String(i.path[0]));
    };
    expect(bad({ notes: "x".repeat(4001) })).toContain("notes");
    expect(bad({ phone: "12345" })).toContain("phone");
    expect(bad({ email: "not-an-email" })).toContain("email");
    expect(bad({ preferredTime: "half five" })).toContain("preferredTime");
    expect(bad({ preferredDate: "16/10/2026" })).toContain("preferredDate");
    expect(bad({ activityInterest: Array.from({ length: 21 }, () => "x") })).toContain(
      "activityInterest",
    );
    expect(bad({ activityInterest: ["x".repeat(61)] })).toContain("activityInterest");
    expect(bad({ bestTimeToCall: "Midnight" })).toContain("bestTimeToCall");
    expect(bad({ guestCount: 0 })).toContain("guestCount");
    // The textarea carries the matching maxLength, so 4000 is reachable.
    expect(WebSubmitSchema.safeParse({ ...BODY, notes: "x".repeat(4000) }).success).toBe(true);
  });
});

describe("missing vs invalid", () => {
  it("blank is missing; present-but-rejected is invalid", () => {
    expect(isBlankWebValue(undefined)).toBe(true);
    expect(isBlankWebValue(null)).toBe(true);
    expect(isBlankWebValue("   ")).toBe(true);
    expect(isBlankWebValue([])).toBe(true);
    expect(isBlankWebValue("x")).toBe(false);
    expect(isBlankWebValue(0)).toBe(false);
  });

  it("classifies against the RAW body, in the legacy order", () => {
    const raw = { email: "nope", phone: "", firstName: "", notes: "x".repeat(4001) };
    expect(classifyWebSubmitIssues(raw, ["email", "notes", "phone", "firstName"])).toEqual({
      missing: ["firstName", "phone"],
      invalid: ["email", "notes"],
    });
  });

  it("the message keeps the legacy wording for blanks and names invalid values honestly", () => {
    expect(webSubmitErrorMessage({ missing: ["firstName", "email"], invalid: [] })).toBe(
      "Missing required fields: firstName, email",
    );
    // A malformed email used to read "Missing required fields: email".
    expect(webSubmitErrorMessage({ missing: [], invalid: ["email"] })).toBe(
      "Invalid fields: email",
    );
    expect(webSubmitErrorMessage({ missing: [], invalid: [] })).toBe("Invalid fields: body");
  });

  it("WEB_REQUIRED_ORDER is the legacy list plus preferredDate", () => {
    expect([...WEB_REQUIRED_ORDER]).toEqual([
      "centerKey",
      "firstName",
      "lastName",
      "email",
      "phone",
      "preferredDate",
      "guestCount",
    ]);
  });
});
