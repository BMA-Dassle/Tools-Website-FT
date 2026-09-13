import { beforeEach, describe, expect, it, vi } from "vitest";
import { COLD_DISPOSITIONS, COLD_INTERESTED, type ColdRowView } from "../contracts";
import { CALL_DISPOSITIONS } from "../../calls/contracts";
import {
  ColdRowNotFoundError,
  applyColdDisposition,
  callbackFor,
  coldActivityRef,
  convertColdRow,
  type ColdDispositionDeps,
} from "./dispositions";
import type { CrmUser } from "../../core/types";

/**
 * The service imports the leads barrel for `createLead`, which reaches the
 * Office transports; they only need `@ft/db`'s shape, never a connection.
 * Every dependency this test actually exercises is injected below.
 */
vi.mock("@ft/db", () => ({
  sql: () => ({}),
  isDbConfigured: () => false,
  BMI_ID_FIELDS: ["id", "personId", "projectId"],
  parseWithRawIds: (t: string) => JSON.parse(t) as unknown,
  serializeWithRawIds: (o: unknown) => JSON.stringify(o),
  stringifyWithRawIds: (o: unknown) => JSON.stringify(o),
  withIdempotency: async (_r: unknown, _k: string, fn: () => unknown) => fn(),
}));

const NOW = new Date("2026-09-13T18:20:00.000Z");

const USER: CrmUser = {
  email: "kelsea@headpinz.com",
  name: "Kelsea Kosco",
  sub: null,
  roles: ["access", "sales"],
  role: "rep",
  rep: {
    id: "3",
    slug: "kelsea",
    displayName: "Kelsea Kosco",
    firstName: "Kelsea",
    initials: "KK",
    role: "rep",
    email: "kelsea@headpinz.com",
    ssoSub: null,
    bmiUserId: "28267036",
    bmiUsername: "Kelsea",
    sevenShiftsUserId: 10832991,
    voxDid: null,
    threecxExtension: "141",
    teamsChatId: null,
    phoneE164: null,
    centres: ["HPFM", "FT"],
    active: true,
    sortOrder: 10,
  },
};

function row(over: Partial<ColdRowView> = {}): ColdRowView {
  return {
    id: "501",
    listId: "7",
    rowIndex: 3,
    company: "BrightPath Dental",
    contactName: "Devon Okafor",
    phoneE164: "+12395557015",
    phoneRaw: "(239) 555-7015",
    email: "devon@brightpath.example",
    city: "Fort Myers",
    notes: null,
    bmiPersonId: null,
    accountId: "88",
    accountName: "BrightPath Dental",
    contactId: "5",
    leadId: null,
    leadPublicId: null,
    matchedBy: null,
    decision: "new",
    status: "ready",
    disposition: null,
    dispositionNote: null,
    dispositionAt: null,
    dispositionBy: null,
    callbackAt: null,
    touchCount: 0,
    createdAt: "2026-09-13T18:00:00.000Z",
    ...over,
  };
}

interface Recorder {
  reads: string[];
  writes: { rowId: string; patch: Record<string, unknown> }[];
  activities: Record<string, unknown>[];
  created: Record<string, unknown>[];
  links: { rowId: string; leadId: string }[];
  stored: ColdRowView;
  createResult: Record<string, unknown>;
}

let rec: Recorder;

function deps(over: Partial<ColdDispositionDeps> = {}): ColdDispositionDeps {
  return {
    read: async (id: string) => {
      rec.reads.push(id);
      return id === rec.stored.id ? rec.stored : null;
    },
    write: async (rowId: string, patch) => {
      rec.writes.push({ rowId, patch: patch as unknown as Record<string, unknown> });
      rec.stored = {
        ...rec.stored,
        disposition: patch.disposition,
        dispositionNote: patch.note,
        dispositionBy: patch.actorEmail,
        dispositionAt: patch.at.toISOString(),
        callbackAt: patch.callbackAt ? patch.callbackAt.toISOString() : null,
        touchCount: rec.stored.touchCount + 1,
      };
      return rec.stored;
    },
    activity: async (a) => {
      rec.activities.push(a as unknown as Record<string, unknown>);
      return String(rec.activities.length);
    },
    link: async (rowId: string, leadId: string, contactId, accountId) => {
      rec.links.push({ rowId, leadId });
      rec.stored = {
        ...rec.stored,
        leadId,
        leadPublicId: "L-1051",
        contactId: contactId ?? rec.stored.contactId,
        accountId: accountId ?? rec.stored.accountId,
      };
      return rec.stored;
    },
    create: (async (input: Record<string, unknown>, opts: Record<string, unknown>) => {
      rec.created.push({ input, opts });
      return rec.createResult;
    }) as unknown as ColdDispositionDeps["create"],
    now: () => NOW,
    ...over,
  };
}

beforeEach(() => {
  rec = {
    reads: [],
    writes: [],
    activities: [],
    created: [],
    links: [],
    stored: row(),
    createResult: {
      lead: {
        id: "1051",
        publicId: "L-1051",
        contactId: "5",
        accountId: "88",
        repName: null,
      },
      created: true,
      mint: {
        status: "minted",
        projectId: "63000000009561437",
        projectNumber: "H12345",
        personId: "63000000009561438",
        assignedAgent: { name: "Kelsea" },
      },
      notify: null,
      suggestion: { suggestion: null, trace: [], outcome: "none" },
      assignment: { lead: { repName: "Kelsea Kosco" } },
    },
  };
});

describe("the vocabulary", () => {
  it("is the Calls screen's six outcomes plus Interested, in that order", () => {
    expect(COLD_DISPOSITIONS).toEqual([COLD_INTERESTED, ...CALL_DISPOSITIONS]);
    // Spelled identically, so C7 counts a cold call with no special case.
    expect(COLD_DISPOSITIONS).toContain("Voicemail");
    expect(COLD_DISPOSITIONS).toContain("No answer");
    expect(COLD_DISPOSITIONS).toContain("Callback scheduled");
  });
});

describe("callbackFor", () => {
  it("keeps a date only for the outcome that promises one", () => {
    expect(callbackFor("Callback scheduled", "2027-01-08T15:00:00Z")).toEqual(
      new Date("2027-01-08T15:00:00Z"),
    );
    expect(callbackFor("Reached", "2027-01-08T15:00:00Z")).toBeNull();
    expect(callbackFor("Callback scheduled", null)).toBeNull();
    expect(callbackFor("Callback scheduled", "not a date")).toBeNull();
  });
});

describe("applyColdDisposition", () => {
  it("stores the outcome and writes ONE activity the KPI screens can count", async () => {
    const out = await applyColdDisposition(
      { rowId: "501", disposition: "Voicemail", note: "left a message", user: USER },
      deps(),
    );
    expect(out.row.disposition).toBe("Voicemail");
    expect(rec.activities).toHaveLength(1);
    expect(rec.activities[0]).toMatchObject({
      kind: "call",
      direction: "out",
      outcome: "Voicemail",
      actorEmail: "kelsea@headpinz.com",
      repId: "3",
      leadId: null,
      contactId: "5",
      body: "left a message",
    });
  });

  it("keys the activity on the touch count, so a double tap writes one row", async () => {
    const d = deps();
    await applyColdDisposition({ rowId: "501", disposition: "No answer", user: USER }, d);
    const first = rec.activities[0]!.externalRef;
    expect(first).toBe(coldActivityRef("501", 1));
    await applyColdDisposition({ rowId: "501", disposition: "Reached", user: USER }, d);
    expect(rec.activities[1]!.externalRef).toBe(coldActivityRef("501", 2));
    expect(rec.activities[1]!.externalRef).not.toBe(first);
  });

  it("stores a callback for 'Callback scheduled' and nothing for the rest", async () => {
    await applyColdDisposition(
      {
        rowId: "501",
        disposition: "Callback scheduled",
        callbackAt: "2027-01-08T15:00:00.000Z",
        user: USER,
      },
      deps(),
    );
    expect(rec.writes[0]!.patch.callbackAt).toEqual(new Date("2027-01-08T15:00:00.000Z"));

    await applyColdDisposition({ rowId: "501", disposition: "Reached", user: USER }, deps());
    expect(rec.writes.at(-1)!.patch.callbackAt).toBeNull();
  });

  it("turns an empty note into null rather than an empty string", async () => {
    await applyColdDisposition(
      { rowId: "501", disposition: "Reached", note: "   ", user: USER },
      deps(),
    );
    expect(rec.writes[0]!.patch.note).toBeNull();
  });

  it("refuses a row that is not there", async () => {
    await expect(
      applyColdDisposition({ rowId: "999", disposition: "Reached", user: USER }, deps()),
    ).rejects.toBeInstanceOf(ColdRowNotFoundError);
    expect(rec.writes).toHaveLength(0);
    expect(rec.activities).toHaveLength(0);
  });

  it("carries the lead once the row has one, so the deal timeline shows the call", async () => {
    rec.stored = row({ leadId: "1051", leadPublicId: "L-1051" });
    await applyColdDisposition({ rowId: "501", disposition: "Reached", user: USER }, deps());
    expect(rec.activities[0]).toMatchObject({ leadId: "1051" });
  });
});

describe("convertColdRow", () => {
  const draft = {
    centre: "HPFM" as const,
    eventDate: "2026-11-14",
    eventTime: "18:30",
    guests: 40,
    type: "corporate" as const,
    firstName: "Devon",
    lastName: "Okafor",
    phone: "+12395557015",
    email: "devon@brightpath.example",
    company: "BrightPath Dental",
    notes: "Wants a fall team night",
  };

  it("creates a REAL lead — not a prospect — so the mint and the rules run", async () => {
    const out = await convertColdRow({ rowId: "501", draft, user: USER }, deps());
    expect(rec.created).toHaveLength(1);
    expect(rec.created[0]!.opts).toMatchObject({ source: "cold", isProspect: false });
    expect(out.mintStatus).toBe("minted");
    expect(out.assignedRepName).toBe("Kelsea Kosco");
    expect(out.created).toBe(true);
  });

  it("keeps the whole cold row in capture_payload, never only the draft", async () => {
    await convertColdRow({ rowId: "501", draft, user: USER }, deps());
    const input = rec.created[0]!.input as { capturePayload: Record<string, unknown> };
    expect(input.capturePayload).toMatchObject({
      source: "cold",
      coldRowId: "501",
      coldListId: "7",
      rowIndex: 3,
      company: "BrightPath Dental",
      phoneRaw: "(239) 555-7015",
    });
  });

  it("points the cold row at the lead and records the interest", async () => {
    const out = await convertColdRow({ rowId: "501", draft, user: USER }, deps());
    expect(rec.links).toEqual([{ rowId: "501", leadId: "1051" }]);
    expect(out.row.disposition).toBe(COLD_INTERESTED);
    expect(rec.activities.some((a) => a.externalKind === "crm-cold-convert")).toBe(true);
    expect(rec.activities.some((a) => a.outcome === COLD_INTERESTED)).toBe(true);
  });

  it("is idempotent: a row that already has a lead mints nothing a second time", async () => {
    rec.stored = row({ leadId: "1051", leadPublicId: "L-1051" });
    const out = await convertColdRow({ rowId: "501", draft, user: USER }, deps());
    expect(rec.created).toHaveLength(0);
    expect(rec.links).toHaveLength(0);
    expect(out.created).toBe(false);
    expect(out.leadId).toBe("1051");
  });

  it("reports an unmintable lead honestly instead of claiming success", async () => {
    rec.createResult = {
      ...rec.createResult,
      mint: { status: "none", error: "needs_email_or_time" },
      assignment: null,
    };
    const out = await convertColdRow(
      { rowId: "501", draft: { ...draft, email: null, eventTime: null }, user: USER },
      deps(),
    );
    expect(out.mintStatus).toBe("none");
    expect(out.mintError).toBe("needs_email_or_time");
  });

  it("marks a kids' birthday as kids, which is what routes it to Guest Services", async () => {
    await convertColdRow(
      { rowId: "501", draft: { ...draft, type: "birthday" }, user: USER },
      deps(),
    );
    expect(rec.created[0]!.input).toMatchObject({ kids: true, type: "birthday" });
  });

  it("refuses a row that is not there", async () => {
    await expect(
      convertColdRow({ rowId: "999", draft, user: USER }, deps()),
    ).rejects.toBeInstanceOf(ColdRowNotFoundError);
    expect(rec.created).toHaveLength(0);
  });
});
