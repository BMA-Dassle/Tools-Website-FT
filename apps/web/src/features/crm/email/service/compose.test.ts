import { afterEach, describe, expect, it } from "vitest";
import type { CrmRep, CrmUser } from "../../core/types";
import type { LeadView } from "../../leads/contracts";
import { readinessFromRoles } from "./graph-client";
import {
  CRM_EMAIL_OFF_REASON,
  MERGE_TOKENS,
  NoSenderMailboxError,
  applyReadiness,
  crmMessageId,
  mergeTemplate,
  mergeValues,
  resolveSender,
  unresolvedTokens,
} from "./compose";

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
});

function rep(over: Partial<CrmRep> = {}): CrmRep {
  return {
    id: "1",
    slug: "kelsea",
    displayName: "Kelsea Kosco",
    firstName: "Kelsea",
    initials: "KK",
    role: "rep",
    email: "kelsea@headpinz.com",
    ssoSub: null,
    bmiUserId: "28267036",
    bmiUsername: "Kelsea Kosco",
    sevenShiftsUserId: null,
    voxDid: null,
    threecxExtension: null,
    teamsChatId: null,
    phoneE164: null,
    centres: ["HPFM", "FT"],
    active: true,
    sortOrder: 10,
    ...over,
  };
}

function user(over: Partial<CrmUser> = {}): CrmUser {
  return {
    email: "kelsea@headpinz.com",
    name: "Kelsea Kosco",
    sub: null,
    roles: ["access", "sales"],
    role: "rep",
    rep: rep(),
    ...over,
  };
}

function lead(over: Partial<LeadView> = {}): LeadView {
  return {
    id: "1042",
    publicId: "L-1042",
    contactId: "77",
    accountId: "9",
    centre: "HPFM",
    eventDate: "2026-12-12",
    eventTime: "18:00",
    guests: 42,
    type: "corporate",
    source: "web",
    isProspect: false,
    status: "assigned",
    rep: "1",
    assignedAt: null,
    heldForRep: null,
    firstTouchAt: null,
    nextAction: null,
    valueCents: 0,
    lostReason: null,
    notes: null,
    bmi: {
      projectId: null,
      projectNumber: null,
      stateId: null,
      stateName: null,
      personId: null,
      syncedAt: null,
    },
    mintStatus: "none",
    mintError: null,
    mintAttempts: 0,
    gfShortId: null,
    lastYearBmiProjectId: null,
    coldRowId: null,
    createdBy: null,
    createdAt: "2026-09-12T12:00:00.000Z",
    updatedAt: "2026-09-12T12:00:00.000Z",
    archivedAt: null,
    kids: false,
    guest: {
      first: "Dana",
      last: "Acme",
      phone: "+12395551234",
      email: "dana@example.com",
      company: "Acme Health",
      prefers: "email",
    },
    repSlug: "kelsea",
    repName: "Kelsea Kosco",
    // B7 made this a required field on LeadView; an email fixture has no
    // guest request of its own.
    requestedRep: null,
    ...over,
  };
}

describe("resolveSender", () => {
  it("sends as the rep, with no CC", () => {
    process.env.CRM_GRAPH_TENANT_ID = "t";
    process.env.CRM_GRAPH_CLIENT_ID = "c";
    process.env.CRM_GRAPH_CLIENT_SECRET = "s";
    delete process.env.CRM_EMAIL;
    const s = resolveSender(user());
    expect(s).toMatchObject({ mailbox: "kelsea@headpinz.com", repSlug: "kelsea", cc: [] });
    expect(s.graph).toBe(true);
  });

  it("GUEST SERVICES: sends from the shared mailbox and CCs the agent (owner rule)", () => {
    const s = resolveSender(
      user({
        email: "paula@headpinz.com",
        name: "Paula",
        rep: rep({
          id: "4",
          slug: "gs",
          displayName: "Guest Services",
          firstName: "Guest Services",
          initials: "GS",
          role: "bucket",
          email: "guestservices@headpinz.com",
        }),
      }),
    );
    expect(s.mailbox).toBe("guestservices@headpinz.com");
    expect(s.cc).toEqual(["paula@headpinz.com"]);
  });

  it("does not CC the bucket's own address when the agent IS the bucket", () => {
    const s = resolveSender(
      user({
        email: "guestservices@headpinz.com",
        rep: rep({ slug: "gs", email: "guestservices@headpinz.com" }),
      }),
    );
    expect(s.cc).toEqual([]);
  });

  it("REFUSES rather than inventing a from-address", () => {
    expect(() => resolveSender(user({ rep: null }))).toThrow(NoSenderMailboxError);
    expect(() => resolveSender(user({ rep: rep({ slug: "mkt", email: null }) }))).toThrow(
      /no_sender_mailbox/,
    );
  });

  it("reports graph:false when the kill switch is off, even with the env set", () => {
    process.env.CRM_GRAPH_TENANT_ID = "t";
    process.env.CRM_GRAPH_CLIENT_ID = "c";
    process.env.CRM_GRAPH_CLIENT_SECRET = "s";
    process.env.CRM_EMAIL = "false";
    expect(resolveSender(user()).graph).toBe(false);
  });

  it("reports graph:false when CRM_GRAPH_* is not on this deployment yet", () => {
    delete process.env.CRM_GRAPH_TENANT_ID;
    delete process.env.CRM_GRAPH_CLIENT_ID;
    delete process.env.CRM_GRAPH_CLIENT_SECRET;
    delete process.env.CRM_EMAIL;
    expect(resolveSender(user()).graph).toBe(false);
  });

  it("names the kill switch as the reason when it is what turned Graph off", () => {
    process.env.CRM_EMAIL = "false";
    expect(resolveSender(user()).graphReason).toBe(CRM_EMAIL_OFF_REASON);
  });
});

describe("applyReadiness", () => {
  const base = {
    mailbox: "kelsea@headpinz.com",
    displayName: "Kelsea Kosco",
    repId: "1",
    repSlug: "kelsea",
    cc: [] as string[],
    graph: true,
    graphReason: null as string | null,
  };

  it("confirms Graph when the tenant consented to BOTH permissions", () => {
    const s = applyReadiness(
      base,
      readinessFromRoles(["Mail.Read", "Mail.Send", "Mail.ReadWrite"]),
    );
    expect(s).toMatchObject({ graph: true, graphReason: null });
  });

  /**
   * PROBED LIVE 2026-09-13 against the real app registration: the token came
   * back with exactly ["Mail.Read","Mail.Send"], and the draft create answered
   * 403 ErrorAccessDenied. `Mail.Send` does not authorise CREATING a message —
   * only `sendMail` and `/messages/{id}/send` — and `sendMail` gives no id to
   * store. So this is the state the CRM ships in until an admin grants
   * Mail.ReadWrite, and it must SAY so rather than promise Outlook.
   */
  it("falls back, with the permission named, on the live tenant's actual grant", () => {
    const s = applyReadiness(base, readinessFromRoles(["Mail.Read", "Mail.Send"]));
    expect(s.graph).toBe(false);
    expect(s.graphReason).toContain("Mail.ReadWrite");
    expect(s.graphReason).toContain("HeadPinz Sales CRM");
  });

  it("never flips a sender Graph had already ruled out back on", () => {
    const off = { ...base, graph: false, graphReason: CRM_EMAIL_OFF_REASON };
    expect(applyReadiness(off, readinessFromRoles(["Mail.ReadWrite", "Mail.Send"]))).toBe(off);
  });
});

describe("merge", () => {
  it("fills the tokens it has from the lead", () => {
    const values = mergeValues({ lead: lead(), repFirstName: "Kelsea" });
    expect(values["guest.first"]).toBe("Dana");
    expect(values["rep.first"]).toBe("Kelsea");
    expect(values["centre.name"]).toBe("HeadPinz Fort Myers");
    expect(values["event.type"]).toBe("corporate");
    expect(values["event.guests"]).toBe("42");
    expect(values["account.name"]).toBe("Acme Health");
  });

  it("LEAVES an unresolved token visible instead of blanking the sentence", () => {
    const values = mergeValues({ lead: lead(), repFirstName: "Kelsea" });
    const out = mergeTemplate("Holding your lanes until {{hold.until}}.", values);
    expect(out).toBe("Holding your lanes until {{hold.until}}.");
    expect(unresolvedTokens(out)).toEqual(["hold.until"]);
  });

  it("leaves a token nobody defined alone", () => {
    expect(mergeTemplate("{{not.a.token}}", {})).toBe("{{not.a.token}}");
  });

  it("renders the seeded T-4 subject exactly as the prototype does", () => {
    const values = mergeValues({ lead: lead(), repFirstName: "Kelsea" });
    expect(mergeTemplate("{{centre.name}} — {{event.type}} on {{event.date}}", values)).toBe(
      "HeadPinz Fort Myers — corporate on Sat, Dec 12",
    );
  });

  it("covers every documented token", () => {
    const values = mergeValues({ lead: lead(), repFirstName: "Kelsea" });
    for (const token of MERGE_TOKENS) expect(token in values).toBe(true);
  });
});

describe("crmMessageId", () => {
  it("is a valid RFC 5322 id carrying the lead's public id", () => {
    expect(crmMessageId("L-1042", "deadbeef")).toBe("<CRM-L-1042-deadbeef@headpinz.com>");
  });

  it("strips anything that would break the header", () => {
    expect(crmMessageId("L 10<42>@evil", "x")).toBe("<CRM-L1042evil-x@headpinz.com>");
  });
});
