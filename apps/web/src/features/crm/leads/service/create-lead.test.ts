import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CrmAccount, CrmContact } from "../../core/types";
import type { LeadView } from "../contracts";
import type { NewLeadRow } from "../data/leads-db";
import { PROTO_NOW, REPS, makeLead } from "../test-support";
import type { AssignResult } from "./assign";
import type { CreateLeadDeps, CreateLeadInput } from "./create-lead";
import type { MintLeadResult } from "./mint";
import type { NotifyOutcome } from "./notify";

/**
 * `createLead` ORDER and isolation (R2): the row exists before Pandora is
 * asked; a missing email stores `needs_email_or_time` without a call; each
 * notification channel failing — or the notifier itself rejecting — never
 * fails the capture; a resubmit re-uses the recent row; the engine's pick is
 * assigned with reason `rule`. Every collaborator is an injected fake that
 * records the CALL ORDER.
 */

const { captureLine, createLead } = await import("./create-lead");

const INPUT: CreateLeadInput = {
  centre: "FT",
  firstName: "CRM",
  lastName: "Test",
  phone: "(239) 555-1234",
  email: "crm-test@example.com",
  company: "Gulf Coast Logistics",
  eventDate: "2026-10-16",
  eventTime: "17:30",
  guests: 42,
  type: "corporate",
  kids: false,
  notes: "Quarterly team event.",
  capturePayload: { raw: true },
  createdBy: null,
};

interface Fakes {
  deps: CreateLeadDeps;
  order: string[];
  inserted: NewLeadRow[];
  assigns: Parameters<CreateLeadDeps["assign"]>[0][];
  mintArgs: unknown[][];
  notifyArgs: Parameters<CreateLeadDeps["notify"]>[0][];
}

function fakes(
  over: Partial<CreateLeadDeps> = {},
  opts: {
    dup?: LeadView | null;
    mint?: MintLeadResult["outcome"];
    /** `CRM_AUTO_ASSIGN` — the kill switch, default ON. */
    autoAssign?: boolean;
  } = {},
): Fakes {
  const order: string[] = [];
  const inserted: NewLeadRow[] = [];
  const assigns: Parameters<CreateLeadDeps["assign"]>[0][] = [];
  const mintArgs: unknown[][] = [];
  const notifyArgs: Parameters<CreateLeadDeps["notify"]>[0][] = [];
  const account: CrmAccount = {
    id: "7",
    kind: "business",
    name: "Gulf Coast Logistics",
    nameKey: "gulf coast logistics",
    centre: "FT",
    lifetimeCents: 0,
    meta: null,
    archivedAt: null,
    createdAt: "",
    updatedAt: "",
  };
  const contact: CrmContact = {
    id: "9",
    accountId: "7",
    firstName: "CRM",
    lastName: "Test",
    phoneE164: "+12395551234",
    email: "crm-test@example.com",
    bmiPersonId: null,
    prefers: null,
    meta: null,
    createdAt: "",
    updatedAt: "",
  };
  let stored: LeadView | null = null;
  const deps: CreateLeadDeps = {
    upsertAccount: async () => {
      order.push("account");
      return account;
    },
    upsertContact: async (c) => {
      order.push("contact");
      return { ...contact, email: c.email, phoneE164: c.phoneE164 };
    },
    insertLead: async (row) => {
      order.push("insertLead");
      inserted.push(row);
      stored = makeLead({
        id: "5001",
        centre: row.centre,
        eventTime: row.eventTime,
        mintStatus: row.mintStatus,
        mintError: row.mintError,
        guest: {
          first: "CRM",
          last: "Test",
          phone: "+12395551234",
          email: INPUT.email,
          company: "Gulf Coast Logistics",
          prefers: null,
        },
      });
      return "5001";
    },
    getLead: async () => stored,
    findDuplicate: async () => {
      order.push("findDuplicate");
      return opts.dup ?? null;
    },
    recordActivity: async (a) => {
      order.push(`activity:${a.kind}`);
      return "1";
    },
    suggest: async () => ({ suggestion: null, trace: [], outcome: "none" as const }),
    mintLead: async (lead, extras, _deps, actor) => {
      order.push("mint");
      mintArgs.push([lead, extras, actor]);
      const outcome = opts.mint ?? {
        status: "minted" as const,
        projectId: "63000000009561437",
        projectNumber: "DH3249",
        personId: "63000000009561438",
        assignedAgent: { userId: "28267036", name: "Kelsea Kosco" },
      };
      const after: LeadView = {
        ...lead,
        mintStatus: outcome.status === "minted" ? "minted" : outcome.status,
        bmi: { ...lead.bmi, projectId: outcome.status === "minted" ? outcome.projectId : null },
      };
      stored = after;
      return { outcome, lead: after };
    },
    notify: async (input) => {
      order.push("notify");
      notifyArgs.push(input);
      const ok = { ok: true };
      return {
        planner: { displayName: "Kelsea", isIndividual: true },
        unassignedCard: ok,
        plannerCard: ok,
        sms: ok,
        email: ok,
      } as NotifyOutcome;
    },
    notifyAlreadySent: async ({ projectId }) => {
      order.push("notifyAlreadySent");
      const skipped = { ok: true, status: null, skipped: true, reason: "already sent" };
      return {
        planner: projectId ? { displayName: "Kelsea", isIndividual: true } : null,
        unassignedCard: skipped,
        plannerCard: skipped,
        sms: skipped,
        email: skipped,
      } as NotifyOutcome;
    },
    assign: async (input) => {
      order.push("assign");
      assigns.push(input);
      // A `hold` row PARKS the lead: `held_for_rep_id` is stamped and
      // `assigned_rep_id` stays NULL (assign.ts). The fake mirrors that, or the
      // "still held, NOT assigned" expectation below would be vacuous.
      const held = input.repId === REPS.mkt.id;
      return {
        lead: {
          ...(stored as LeadView),
          rep: held ? null : input.repId,
          heldForRep: held ? input.repId : null,
        },
        assignment: { id: "1" } as AssignResult["assignment"],
        bmi: { status: held ? "skipped" : "synced" },
      };
    },
    autoAssignEnabled: () => opts.autoAssign ?? true,
    now: () => PROTO_NOW,
    ...over,
  };
  return { deps, order, inserted, assigns, mintArgs, notifyArgs };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createLead", () => {
  it("persists to Neon BEFORE Pandora, then notifies; the row carries the raw capture", async () => {
    const f = fakes();
    const r = await createLead(INPUT, { source: "web" }, f.deps);
    expect(f.order).toEqual([
      "findDuplicate",
      "account",
      "contact",
      "insertLead",
      "activity:system",
      "mint",
      "notify",
      "activity:system",
    ]);
    expect(r.created).toBe(true);
    expect(r.mint.status).toBe("minted");
    expect(f.inserted[0]).toMatchObject({
      contactId: "9",
      accountId: "7",
      centre: "FT",
      source: "web",
      mintStatus: "pending",
      mintError: null,
      capturePayload: { raw: true },
    });
    // the pick is null (stub) → agent "First Available" is decided in buildMintInput; here it is null
    expect(f.mintArgs[0]![1]).toMatchObject({ agent: null });
    expect(r.assignment).toBeNull();
  });

  it("Pandora down: the lead exists with mint failed — the capture is never lost", async () => {
    const f = fakes(
      {},
      { mint: { status: "failed", error: "Pandora returned 502", httpStatus: 502 } },
    );
    const r = await createLead(INPUT, { source: "web" }, f.deps);
    expect(f.order.indexOf("insertLead")).toBeLessThan(f.order.indexOf("mint"));
    expect(r.created).toBe(true);
    expect(r.mint).toEqual({ status: "failed", error: "Pandora returned 502", httpStatus: 502 });
    expect(r.lead.mintStatus).toBe("failed");
  });

  it("missing email → stored with mint_status none / needs_email_or_time (phone lead from the CRM)", async () => {
    const f = fakes();
    await createLead(
      { ...INPUT, email: null },
      { source: "phone", actorEmail: "kelsea@headpinz.com" },
      f.deps,
    );
    expect(f.inserted[0]).toMatchObject({
      mintStatus: "none",
      mintError: "needs_email_or_time",
      source: "phone",
    });
  });

  it("missing time → the same", async () => {
    const f = fakes();
    await createLead(
      { ...INPUT, eventTime: null },
      { source: "walkin", actorEmail: "gs@headpinz.com" },
      f.deps,
    );
    expect(f.inserted[0]).toMatchObject({ mintStatus: "none", mintError: "needs_email_or_time" });
  });

  it("a notifier that REJECTS never fails the capture (each channel failing is the notifier's own test)", async () => {
    const f = fakes({
      notify: async () => {
        throw new Error("Teams exploded");
      },
    });
    const r = await createLead(INPUT, { source: "web" }, f.deps);
    expect(r.lead.publicId).toBe("L-5001");
    expect(r.notify).toBeNull();
    expect(r.mint.status).toBe("minted");
  });

  it("a resubmit within the window re-uses a row whose mint failed (one lead, a second mint attempt)", async () => {
    const dup = makeLead({ id: "4999", mintStatus: "failed", mintError: "Pandora returned 502" });
    const f = fakes({}, { dup });
    const r = await createLead(INPUT, { source: "web" }, f.deps);
    expect(r.created).toBe(false);
    expect(f.inserted).toHaveLength(0);
    expect(f.order).toContain("mint");
    expect(r.lead.id).toBe("4999");
  });

  it("a resubmit of an already-MINTED lead is returned as-is: no second project, no second text", async () => {
    const dup = makeLead({
      id: "4998",
      mintStatus: "minted",
      bmi: {
        projectId: "63000000009561437",
        projectNumber: "DH3249",
        stateId: null,
        stateName: null,
        personId: null,
        syncedAt: null,
      },
    });
    const f = fakes({}, { dup });
    const r = await createLead(INPUT, { source: "web" }, f.deps);
    expect(r.created).toBe(false);
    expect(f.order).toEqual(["findDuplicate", "notifyAlreadySent"]);
    expect(r.mint).toMatchObject({
      status: "minted",
      projectId: "63000000009561437",
      projectNumber: "DH3249",
    });
    // The SECOND answer must be indistinguishable from the first: the planner
    // is the one Pandora actually picked, and every channel is a neutral skip
    // rather than the "not attempted" that used to read as a failure.
    expect(r.notify?.planner).toEqual({ displayName: "Kelsea", isIndividual: true });
    expect(r.notify?.sms).toEqual({
      ok: true,
      status: null,
      skipped: true,
      reason: "already sent",
    });
    expect(f.order).not.toContain("notify");
    expect(f.order).not.toContain("mint");
  });

  it("a kids' birthday still ROUTES to Guest Services at capture, with reason 'rule' and the rule's trace", async () => {
    const f = fakes({
      suggest: async () => ({
        suggestion: {
          rep: REPS.gs,
          reason: "routed to Guest Services",
          ruleId: "3",
          finalRuleLabel: "R3",
        },
        trace: [{ ruleId: "3", code: "R3", label: "Kids' birthdays", hit: true }],
        outcome: "route" as const,
      }),
    });
    const r = await createLead(
      { ...INPUT, type: "birthday", kids: true },
      { source: "web" },
      f.deps,
    );
    expect(f.mintArgs[0]![1]).toMatchObject({ agent: "Guest Services" });
    expect(f.assigns[0]).toMatchObject({
      leadId: "5001",
      repId: REPS.gs.id,
      reason: "rule",
      ruleId: "3",
      actor: "web",
    });
    expect(f.assigns[0]!.trace).toEqual([
      { ruleId: "3", code: "R3", label: "Kids' birthdays", hit: true },
    ]);
    expect(r.assignment?.bmi).toEqual({ status: "synced" });
    expect(r.lead.rep).toBe(REPS.gs.id);
    expect(f.notifyArgs[0]!.assigned).toBe(true);
  });

  it("a HOLD decision parks the lead at capture — held for the Marketing Director, NOT assigned", async () => {
    const f = fakes({
      suggest: async () => ({
        suggestion: {
          rep: REPS.mkt,
          reason: "held for Marketing Director",
          ruleId: "1",
          finalRuleLabel: "R1",
        },
        trace: [{ ruleId: "1", code: "R1", label: "100+ guests", hit: true }],
        outcome: "hold" as const,
      }),
    });
    const r = await createLead(INPUT, { source: "web" }, f.deps);
    expect(f.assigns[0]).toMatchObject({ repId: REPS.mkt.id, reason: "rule", ruleId: "1" });
    // Parked, not handed over: it stays on the queue board with its pill, and
    // `listSweepCandidates` (held_for_rep_id IS NULL) never touches it again.
    expect(r.lead.rep).toBeNull();
    expect(r.lead.heldForRep).toBe(REPS.mkt.id);
    // The Marketing Director has no Office user, so nothing is written to BMI.
    expect(r.assignment?.bmi).toEqual({ status: "skipped" });
    // Nobody owns it → the Assignment Pending chat is the one that hears.
    expect(f.notifyArgs[0]!.assigned).toBe(false);
  });

  /**
   * THE CHANGE (owner, 2026-09-13 14:50: "let's get rid of the hour sweep rule
   * just capture right away"). The balancing rule's pick used to be shown in
   * the queue and left for the sweep's 60-minute delay. It is applied now,
   * with the same `reason: "rule"` and the same trace the sweep would have
   * stored — and, because the lead now has an owner, its Teams card goes to
   * that planner and NOT to "Sales Leads - Assignment Pending".
   */
  it("an ordinary web lead is ASSIGNED at capture with reason 'rule' and the rule's trace", async () => {
    const trace = [
      { ruleId: "6", code: "R6", label: "Lowest volume for the party's month", hit: true },
    ];
    const f = fakes({
      suggest: async () => ({
        suggestion: {
          rep: REPS.kelsea,
          reason: "lowest Oct volume",
          ruleId: "6",
          finalRuleLabel: "R6",
        },
        trace,
        outcome: "assign" as const,
      }),
    });
    const r = await createLead(INPUT, { source: "web" }, f.deps);
    expect(f.mintArgs[0]![1]).toMatchObject({ agent: "Kelsea Kosco" });
    expect(f.assigns).toHaveLength(1);
    expect(f.assigns[0]).toMatchObject({
      leadId: "5001",
      repId: REPS.kelsea.id,
      reason: "rule",
      ruleId: "6",
      actor: "web",
    });
    expect(f.assigns[0]!.trace).toEqual(trace);
    expect(r.lead.rep).toBe(REPS.kelsea.id);
    expect(r.assignment?.bmi).toEqual({ status: "synced" });
    // …and it happens BEFORE the notifications, so they know who owns it.
    expect(f.order.indexOf("assign")).toBeLessThan(f.order.indexOf("notify"));
    expect(f.notifyArgs[0]!.assigned).toBe(true);
  });

  it("at ANY hour — capture time never consults a clock or a business-hours window", async () => {
    const pick = {
      suggestion: {
        rep: REPS.kelsea,
        reason: "lowest Oct volume",
        ruleId: "6",
        finalRuleLabel: "R6",
      },
      trace: [],
      outcome: "assign" as const,
    };
    for (const iso of ["2026-09-13T03:00:00-04:00", "2026-09-12T22:15:00-04:00"]) {
      const f = fakes({ suggest: async () => pick, now: () => new Date(iso) });
      const r = await createLead(INPUT, { source: "web" }, f.deps);
      expect(f.assigns).toHaveLength(1);
      expect(r.lead.rep).toBe(REPS.kelsea.id);
    }
  });

  it("the engine resolving NOBODY leaves the lead unassigned for the safety net and the Pending chat", async () => {
    const f = fakes({
      suggest: async () => ({
        suggestion: null,
        trace: [{ ruleId: "7", code: "R7", label: "Otherwise park it for Jacob", hit: true }],
        outcome: "queue" as const,
      }),
    });
    const r = await createLead(INPUT, { source: "web" }, f.deps);
    expect(f.assigns).toHaveLength(0);
    expect(r.lead.rep).toBeNull();
    expect(r.assignment).toBeNull();
    // Pandora is told "First Available" rather than a name we did not pick.
    expect(f.mintArgs[0]![1]).toMatchObject({ agent: null });
    expect(f.notifyArgs[0]!.assigned).toBe(false);
  });

  it('CRM_AUTO_ASSIGN="false" disables capture-time assignment — and keeps the rules out of Pandora too', async () => {
    const f = fakes(
      {
        suggest: async () => ({
          suggestion: {
            rep: REPS.kelsea,
            reason: "lowest Oct volume",
            ruleId: "6",
            finalRuleLabel: "R6",
          },
          trace: [],
          outcome: "assign" as const,
        }),
      },
      { autoAssign: false },
    );
    const r = await createLead(INPUT, { source: "web" }, f.deps);
    expect(f.assigns).toHaveLength(0);
    expect(r.lead.rep).toBeNull();
    // Not "assigned in BMI but unassigned here": Pandora falls back to its own
    // round robin rather than being handed a pick the kill switch forbids.
    expect(f.mintArgs[0]![1]).toMatchObject({ agent: null });
    // The suggestion is still computed, so the queue can show what it WOULD do.
    expect(r.suggestion.suggestion?.rep.slug).toBe(REPS.kelsea.slug);
  });

  it("an assign that throws after capture is logged, not fatal", async () => {
    const f = fakes({
      suggest: async () => ({
        suggestion: { rep: REPS.kelsea, reason: "x", ruleId: null, finalRuleLabel: null },
        trace: [],
        outcome: "route" as const,
      }),
      assign: async () => {
        throw new Error("Neon hiccup");
      },
    });
    const r = await createLead(INPUT, { source: "web" }, f.deps);
    expect(r.assignment).toBeNull();
    expect(r.lead.publicId).toBe("L-5001");
  });

  it("a cold-list prospect: no mint, no notifications, is_prospect on the row", async () => {
    const f = fakes();
    const r = await createLead(
      INPUT,
      { source: "cold", actorEmail: "kelsea@headpinz.com" },
      f.deps,
    );
    expect(f.inserted[0]).toMatchObject({
      isProspect: true,
      mintStatus: "none",
      mintError: null,
      source: "cold",
    });
    expect(f.order).not.toContain("mint");
    expect(f.order).not.toContain("notify");
    expect(r.mint).toEqual({ status: "none", error: "prospect" });
  });

  it("captureLine wording follows the prototype's system lines", () => {
    expect(captureLine("web", null)).toBe("Lead captured from the web form");
    expect(captureLine("phone", "gs@headpinz.com")).toBe(
      "Logged by gs@headpinz.com from an inbound call",
    );
    expect(captureLine("walkin", null)).toBe("Logged by staff from a walk-in");
    expect(captureLine("referral", "jacob@headpinz.com")).toBe(
      "Referral entered by jacob@headpinz.com",
    );
    expect(captureLine("cold", "kelsea@headpinz.com")).toBe(
      "Lead created from cold list by kelsea@headpinz.com",
    );
  });
});
