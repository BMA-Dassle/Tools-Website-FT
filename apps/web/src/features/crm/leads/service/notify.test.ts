import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLANNERS } from "@/lib/sales-lead-config";
import { QUEUE_LEADS } from "../test-support";
import type { MintOutcome } from "./mint";
import {
  HELD_FOR_PLANNER,
  plannerForOwner,
  ALREADY_SENT,
  CENTRE_TO_CENTER_KEY,
  UNASSIGNED_CHAT_ENV,
  centerConfigFor,
  notifyAlreadySent,
  notifyNewLead,
  unassignedCardSkipReason,
  salesCardKey,
  summarizeNotify,
  withoutCardActions,
  type NotifyDeps,
} from "./notify";

/**
 * Notification fan-out isolation (brief §4 B3 tests): Teams / SMS / email
 * each throwing → the lead is unaffected and every channel reports itself;
 * `CRM_UNASSIGNED_TEAMS_CHAT_ID` unset → the Assignment Pending card is
 * skipped with the logged reason; the guest's channels follow
 * `preferredContactMethod` exactly as the legacy route did, and only for web
 * leads.
 *
 * And the rule the owner's 2026-09-13 decision added: "Sales Leads -
 * Assignment Pending" hears about a lead ONLY when nobody owns it. An
 * ordinary lead is assigned at capture, so it gets exactly ONE card — in its
 * planner's chat — and never a second one in the director's.
 */

const MINTED: MintOutcome = {
  status: "minted",
  projectId: "63000000009561437",
  projectNumber: "DH3249",
  personId: "63000000009561438",
  assignedAgent: { userId: "28267036", name: "Kelsea Kosco" },
};

function fakes(over: Partial<NotifyDeps> = {}) {
  const calls: Record<string, unknown[][]> = {
    sms: [],
    email: [],
    card: [],
    redis: [],
    redisGet: [],
    note: [],
    stamp: [],
  };
  const deps: NotifyDeps = {
    sendSms: async (...a) => {
      calls.sms!.push(a);
      return { ok: true, status: 200 };
    },
    sendEmail: async (...a) => {
      calls.email!.push(a);
      return { ok: true, status: 202 };
    },
    sendCard: async (...a) => {
      calls.card!.push(a);
      return { id: `act-${calls.card!.length}` };
    },
    redisSet: async (...a) => {
      calls.redis!.push(a);
      return "OK";
    },
    redisGet: async (...a) => {
      calls.redisGet!.push(a);
      return null;
    },
    appendPrivateNote: async (...a) => {
      calls.note!.push(a);
      return { ok: true };
    },
    stampGuestIntro: async (...a) => {
      calls.stamp!.push(a);
    },
    unassignedChatId: () => "19:pending@thread.v2",
    now: () => new Date("2026-09-12T23:30:00Z"),
    ...over,
  };
  return { deps, calls };
}

const lead = QUEUE_LEADS[0]!; // FT, web, NOBODY on it
/**
 * The same lead with Kelsea on it. Ownership is what decides the planner now —
 * Pandora's `assignedAgent` is no longer consulted — so a test that wants a
 * named planner has to say so here rather than lean on `MINTED`.
 */
const owned = { ...lead, rep: "1", repSlug: "kelsea", repName: "Kelsea Kosco" };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("mapping", () => {
  it("centre → the form's centerKey config", () => {
    expect(CENTRE_TO_CENTER_KEY).toEqual({
      HPFM: "headpinz-ft-myers",
      FT: "fasttrax-ft-myers",
      HPN: "headpinz-naples",
    });
    expect(centerConfigFor("FT").pandoraKey).toBe("fasttrax");
    expect(centerConfigFor("HPN").displayName).toBe("HeadPinz Naples");
  });
  it("unassignedCardSkipReason: an owned lead never reaches the chat; an unset env var names itself", () => {
    expect(unassignedCardSkipReason(undefined, false)).toBe(`${UNASSIGNED_CHAT_ENV} not set`);
    expect(unassignedCardSkipReason("19:x", false)).toBeNull();
    expect(unassignedCardSkipReason("19:x", true, "Kelsea")).toBe(
      "assigned to Kelsea — their card is the one",
    );
    expect(unassignedCardSkipReason("19:x", true)).toBe(
      "assigned to a planner — their card is the one",
    );
  });
});

describe("notifyNewLead", () => {
  it("an OWNED web lead, no preference: guest text + email from the planner WE assigned, planner card, salescard state, two audit lines", async () => {
    const { deps, calls } = fakes();
    const out = await notifyNewLead({ lead: owned, mint: MINTED, source: "web" }, deps);
    expect(out.planner).toEqual({ displayName: "Kelsea", isIndividual: true });
    expect(out.sms.ok && out.email.ok && out.plannerCard.ok).toBe(true);
    expect(calls.sms![0]![0]).toBe("+12395552710");
    expect(calls.sms![0]![2]).toMatchObject({ fromOverride: PLANNERS.kelsea.phone });
    expect(calls.email![0]![0]).toMatchObject({
      to: lead.guest.email,
      from: { email: PLANNERS.kelsea.email },
      bcc: PLANNERS.kelsea.email,
    });
    // Owned → the planner's chat only; the Assignment Pending chat hears nothing.
    expect(calls.card!.map((c) => c[0])).toEqual([PLANNERS.kelsea.teamsChatId]);
    expect(calls.redis![0]![0]).toBe("salescard:63000000009561437");
    expect(calls.redis![0]![2]).toBe(60 * 60 * 24 * 90);
    expect(calls.note!.map((n) => (n[0] as { channel: string }).channel).sort()).toEqual([
      "email",
      "sms",
      "teams",
    ]);
    expect(calls.stamp![0]![0]).toBe(owned.id);
    // the planner card's activity id is persisted for the buttons
    const last = JSON.parse(calls.redis![calls.redis!.length - 1]![1] as string) as {
      cardActivityId: string;
    };
    expect(last.cardActivityId).toBe("act-1");
  });

  it("CRM_UNASSIGNED_TEAMS_CHAT_ID unset → the Assignment Pending card is skipped with the reason, logged, nothing else changes", async () => {
    const { deps, calls } = fakes({ unassignedChatId: () => undefined });
    const out = await notifyNewLead({ lead, mint: MINTED, source: "web" }, deps);
    expect(out.unassignedCard).toEqual({
      ok: true,
      status: null,
      skipped: true,
      reason: "CRM_UNASSIGNED_TEAMS_CHAT_ID not set",
    });
    // Nobody owns it, so there is no planner card either — hence zero cards.
    expect(calls.card).toHaveLength(0);
    expect(console.log).toHaveBeenCalledWith(
      "[crm] Assignment Pending card skipped",
      expect.objectContaining({ reason: "CRM_UNASSIGNED_TEAMS_CHAT_ID not set" }),
    );
  });

  // Owner, 2026-09-13: "where we can alert the none assigned groups". An
  // ordinary lead is assigned at capture, so exactly ONE card goes out.
  it("an ASSIGNED lead gets ONE card — the planner's — and the Assignment Pending chat hears nothing", async () => {
    const { deps, calls } = fakes();
    const out = await notifyNewLead({ lead: owned, mint: MINTED, source: "web" }, deps);
    expect(calls.card!.map((c) => c[0])).toEqual([PLANNERS.kelsea.teamsChatId]);
    expect(out.plannerCard.ok).toBe(true);
    expect(out.unassignedCard).toEqual({
      ok: true,
      status: null,
      skipped: true,
      reason: "assigned to Kelsea — their card is the one",
    });
  });

  it("`assigned` defaults to the lead's own rep, so a lead with an owner is never double-carded", async () => {
    const { deps, calls } = fakes();
    const out = await notifyNewLead({ lead: owned, mint: MINTED, source: "web" }, deps);
    expect(calls.card).toHaveLength(1);
    expect(out.unassignedCard.skipped).toBe(true);
  });

  it("Teams, SMS and email each throwing → resolves with per-channel failures, never rejects", async () => {
    const { deps } = fakes({
      sendSms: async () => {
        throw new Error("vox down");
      },
      sendEmail: async () => {
        throw new Error("sendgrid down");
      },
      sendCard: async () => {
        throw new Error("bot down");
      },
    });
    const out = await notifyNewLead({ lead: owned, mint: MINTED, source: "web" }, deps);
    expect(out.sms).toEqual({ ok: false, error: "vox down" });
    expect(out.email).toEqual({ ok: false, error: "sendgrid down" });
    expect(out.plannerCard).toEqual({ ok: false, error: "bot down" });
  });

  it("even Redis or the audit writer throwing does not reject", async () => {
    const { deps } = fakes({
      redisSet: async () => {
        throw new Error("redis down");
      },
    });
    const out = await notifyNewLead({ lead, mint: MINTED, source: "web" }, deps);
    expect(out.sms.ok).toBe(false);
    expect(out.unassignedCard.ok).toBe(false);
  });

  it("preferredContactMethod: text → SMS only; email → email only; phone → email only", async () => {
    for (const [pref, sms, email] of [
      ["text", 1, 0],
      ["email", 0, 1],
      ["phone", 0, 1],
    ] as const) {
      const { deps, calls } = fakes();
      const out = await notifyNewLead(
        { lead: owned, mint: MINTED, source: "web", preferredContactMethod: pref },
        deps,
      );
      expect(calls.sms).toHaveLength(sms);
      expect(calls.email).toHaveLength(email);
      if (!sms) expect(out.sms.reason).toBe(`skipped — customer prefers ${pref}`);
      if (!email) expect(out.email.reason).toBe(`skipped — customer prefers ${pref}`);
    }
  });

  it("a staff-logged phone lead: internal cards only, no automated guest message", async () => {
    const { deps, calls } = fakes();
    const out = await notifyNewLead(
      { lead: { ...lead, source: "phone" }, mint: MINTED, source: "phone" },
      deps,
    );
    expect(calls.sms).toHaveLength(0);
    expect(calls.email).toHaveLength(0);
    expect(out.sms.skipped && out.email.skipped).toBe(true);
    expect(out.sms.reason).toContain("staff-logged phone lead");
    expect(calls.card).toHaveLength(1); // the Assignment Pending card; nobody owns it
  });

  it("not minted: only the Assignment Pending card goes (keyed by the lead's public id); no planner, no guest, no salescard", async () => {
    const { deps, calls } = fakes();
    const out = await notifyNewLead(
      { lead, mint: { status: "failed", error: "boom", httpStatus: 502 }, source: "web" },
      deps,
    );
    expect(out.planner).toBeNull();
    expect(calls.card).toHaveLength(1);
    expect(calls.card![0]![0]).toBe("19:pending@thread.v2");
    expect(calls.redis).toHaveLength(0);
    expect(calls.sms).toHaveLength(0);
    expect(out.plannerCard.reason).toBe(
      "nobody owns this lead — the Assignment Pending card is the one",
    );
  });

  it("summarizeNotify is one readable line", () => {
    const line = summarizeNotify({
      planner: { displayName: "Kelsea", isIndividual: true },
      unassignedCard: {
        ok: true,
        skipped: true,
        reason: "assigned to Kelsea — their card is the one",
      },
      plannerCard: { ok: true },
      sms: { ok: true },
      email: { ok: false, error: "sendgrid down" },
    });
    expect(line).toBe(
      "Guest text sent · guest email FAILED (sendgrid down) · Teams card to Kelsea sent · Assignment Pending card skipped (assigned to Kelsea — their card is the one)",
    );
  });
});

describe("the Assignment Pending card's buttons", () => {
  const actionSets = (card: Record<string, unknown>) =>
    (card.body as Array<{ type?: string }>).filter((b) => b?.type === "ActionSet");

  it("withoutCardActions strips the ActionSet and any top-level actions", () => {
    const stripped = withoutCardActions({
      type: "AdaptiveCard",
      body: [{ type: "TextBlock" }, { type: "ActionSet", actions: [{ verb: "sales_lead_ack" }] }],
      actions: [{ verb: "sales_lead_ack" }],
    });
    expect(stripped.body).toEqual([{ type: "TextBlock" }]);
    expect("actions" in stripped).toBe(false);
    expect(stripped.type).toBe("AdaptiveCard");
  });

  it("an un-minted lead gets a READ-ONLY card: its verbs read salescard:{projectID}, which is never written", async () => {
    const { deps, calls } = fakes();
    await notifyNewLead(
      { lead, mint: { status: "failed", error: "boom", httpStatus: 502 }, source: "web" },
      deps,
    );
    expect(calls.redis).toHaveLength(0);
    expect(calls.card).toHaveLength(1);
    const card = calls.card![0]![1] as Record<string, unknown>;
    expect(actionSets(card)).toHaveLength(0);
  });

  it("a minted lead keeps them — the state they read exists", async () => {
    const { deps, calls } = fakes();
    await notifyNewLead({ lead, mint: MINTED, source: "web" }, deps);
    // Nobody owns it, so the Assignment Pending card is the only one.
    const pendingCard = calls.card![0]![1] as Record<string, unknown>;
    expect(actionSets(pendingCard)).toHaveLength(1);
    expect(calls.redis![0]![0]).toBe(salesCardKey(MINTED.projectId));
  });
});

/**
 * The 2026-09-13 regression, in test form.
 *
 * Lead L-228 (500 guests, FastTrax) was held for the Marketing Director by rule
 * R1 — correctly — and the success screen and the guest's text both said
 * "Kelsea", because the planner was read off Pandora's `assignedAgent.name`
 * instead of our own assignment.
 */
describe("the planner is OURS, and a held lead holds its welcome", () => {
  it("Pandora naming Kelsea does not make Kelsea the planner when we held the lead", async () => {
    const { deps, calls } = fakes();
    // MINTED carries assignedAgent "Kelsea Kosco"; the lead has nobody on it.
    const out = await notifyNewLead({ lead, mint: MINTED, source: "web" }, deps);
    expect(out.planner).toBeNull();
    expect(calls.sms).toHaveLength(0);
    expect(calls.email).toHaveLength(0);
    expect(out.sms.reason).toBe(HELD_FOR_PLANNER);
    expect(out.email.reason).toBe(HELD_FOR_PLANNER);
    // Never stamped, because the guest has not been introduced to anybody yet.
    expect(calls.stamp).toHaveLength(0);
    // And the disagreement between the two engines is on the record.
    expect(console.warn).toHaveBeenCalledWith(
      "[crm] Pandora assigned somebody else",
      expect.objectContaining({ pandora: "Kelsea Kosco", ours: expect.stringContaining("nobody") }),
    );
  });

  it("a held lead still reaches the Assignment Pending chat — it is held, not dropped", async () => {
    const { deps, calls } = fakes();
    const out = await notifyNewLead({ lead, mint: MINTED, source: "web" }, deps);
    expect(calls.card!.map((c) => c[0])).toEqual(["19:pending@thread.v2"]);
    expect(out.unassignedCard.ok).toBe(true);
  });

  it("plannerForOwner: the three planners are themselves, gs is Guest Services, a hold is nobody", () => {
    const center = centerConfigFor("FT");
    expect(plannerForOwner("kelsea", center)).toBe(PLANNERS.kelsea);
    expect(plannerForOwner("lori", center)).toBe(PLANNERS.lori);
    expect(plannerForOwner("stephanie", center)).toBe(PLANNERS.stephanie);
    const gs = plannerForOwner("gs", center);
    expect(gs?.isIndividual).toBe(false);
    expect(gs?.displayName).toBe("Guest Services");
    // The Marketing hold bucket and the directors have no guest-facing name.
    expect(plannerForOwner("mkt", center)).toBeNull();
    expect(plannerForOwner("jacob", center)).toBeNull();
    expect(plannerForOwner(null, center)).toBeNull();
  });

  it("a Guest Services lead is introduced generically — a real owner, but not a person", async () => {
    const { deps, calls } = fakes();
    const out = await notifyNewLead(
      { lead: { ...lead, rep: "4", repSlug: "gs" }, mint: MINTED, source: "web" },
      deps,
    );
    expect(out.planner).toEqual({ displayName: "Guest Services", isIndividual: false });
    expect(calls.sms).toHaveLength(1);
    expect(calls.sms![0]![1]).toContain("Guest Services team will reach out");
    expect(calls.sms![0]![1]).not.toContain("Kelsea");
  });

  it("the welcome is sent ONCE — an already-introduced lead is skipped", async () => {
    const { deps, calls } = fakes();
    const out = await notifyNewLead(
      { lead: { ...owned, guestIntroAt: "2026-09-13T12:00:00.000Z" }, mint: MINTED, source: "web" },
      deps,
    );
    expect(calls.sms).toHaveLength(0);
    expect(calls.email).toHaveLength(0);
    expect(out.sms.reason).toBe("the guest has already been introduced");
  });
});

describe("notifyAlreadySent (a resubmit inside the dedupe window)", () => {
  const state = (displayName: string, isIndividual: boolean) =>
    JSON.stringify({
      projectID: "63000000009561437",
      projectNumber: "DH2891",
      planner: { displayName, isIndividual },
    });

  it("names the planner the FIRST submission used, not Guest Services", async () => {
    const { deps } = fakes({ redisGet: async () => state("Kelsea", true) });
    const out = await notifyAlreadySent({ lead, projectId: "63000000009561437" }, deps);
    expect(out.planner).toEqual({ displayName: "Kelsea", isIndividual: true });
  });

  it("reads the card state by project id and sends nothing", async () => {
    const keys: string[] = [];
    const { deps, calls } = fakes({
      redisGet: async (k) => {
        keys.push(k);
        return state("Guest Services", false);
      },
    });
    const out = await notifyAlreadySent({ lead, projectId: "63000000009561437" }, deps);
    expect(keys).toEqual([salesCardKey("63000000009561437")]);
    expect(calls.sms).toHaveLength(0);
    expect(calls.email).toHaveLength(0);
    expect(calls.card).toHaveLength(0);
    expect(calls.note).toHaveLength(0);
    for (const c of [out.sms, out.email, out.plannerCard, out.unassignedCard])
      expect(c).toEqual({ ok: true, status: null, skipped: true, reason: ALREADY_SENT });
  });

  it("an expired state is null, never a guessed name; a throwing Redis is not fatal", async () => {
    const gone = await notifyAlreadySent(
      { lead, projectId: "63000000009561437" },
      fakes({ redisGet: async () => null }).deps,
    );
    expect(gone.planner).toBeNull();
    const boom = await notifyAlreadySent(
      { lead, projectId: "63000000009561437" },
      fakes({
        redisGet: async () => {
          throw new Error("redis down");
        },
      }).deps,
    );
    expect(boom.planner).toBeNull();
    expect(boom.sms.reason).toBe(ALREADY_SENT);
  });

  it("no project id → no read at all", async () => {
    const keys: string[] = [];
    const { deps } = fakes({
      redisGet: async (k) => {
        keys.push(k);
        return null;
      },
    });
    expect((await notifyAlreadySent({ lead, projectId: null }, deps)).planner).toBeNull();
    expect(keys).toEqual([]);
  });
});
