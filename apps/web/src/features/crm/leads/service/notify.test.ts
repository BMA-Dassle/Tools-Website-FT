import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLANNERS } from "@/lib/sales-lead-config";
import { QUEUE_LEADS } from "../test-support";
import type { MintOutcome } from "./mint";
import {
  ALREADY_SENT,
  CENTRE_TO_CENTER_KEY,
  QUEUE_CHAT_ENV,
  centerConfigFor,
  notifyAlreadySent,
  notifyNewLead,
  queueCardSkipReason,
  salesCardKey,
  summarizeNotify,
  withoutCardActions,
  type NotifyDeps,
} from "./notify";

/**
 * Notification fan-out isolation (brief §4 B3 tests): Teams / SMS / email
 * each throwing → the lead is unaffected and every channel reports itself;
 * `CRM_JACOB_TEAMS_CHAT_ID` unset → the queue card is skipped with the logged
 * reason; the guest's channels follow `preferredContactMethod` exactly as the
 * legacy route did, and only for web leads.
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
    queueChatId: () => "19:queue@thread.v2",
    now: () => new Date("2026-09-12T23:30:00Z"),
    ...over,
  };
  return { deps, calls };
}

const lead = QUEUE_LEADS[0]!; // FT, web

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
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
  it("queueCardSkipReason names the env var", () => {
    expect(queueCardSkipReason(undefined)).toBe(`${QUEUE_CHAT_ENV} not set`);
    expect(queueCardSkipReason("19:x")).toBeNull();
  });
});

describe("notifyNewLead", () => {
  it("web lead, no preference: guest text + email from the planner Pandora picked, planner card, queue card, salescard state, three audit lines", async () => {
    const { deps, calls } = fakes();
    const out = await notifyNewLead({ lead, mint: MINTED, source: "web" }, deps);
    expect(out.planner).toEqual({ displayName: "Kelsea", isIndividual: true });
    expect(out.sms.ok && out.email.ok && out.plannerCard.ok && out.queueCard.ok).toBe(true);
    expect(calls.sms![0]![0]).toBe("+12395552710");
    expect(calls.sms![0]![2]).toMatchObject({ fromOverride: PLANNERS.kelsea.phone });
    expect(calls.email![0]![0]).toMatchObject({
      to: lead.guest.email,
      from: { email: PLANNERS.kelsea.email },
      bcc: PLANNERS.kelsea.email,
    });
    expect(calls.card!.map((c) => c[0])).toEqual([
      PLANNERS.kelsea.teamsChatId,
      "19:queue@thread.v2",
    ]);
    expect(calls.redis![0]![0]).toBe("salescard:63000000009561437");
    expect(calls.redis![0]![2]).toBe(60 * 60 * 24 * 90);
    expect(calls.note!.map((n) => (n[0] as { channel: string }).channel)).toEqual([
      "sms",
      "email",
      "teams",
    ]);
    // the planner card's activity id is persisted for the buttons
    const last = JSON.parse(calls.redis![calls.redis!.length - 1]![1] as string) as {
      cardActivityId: string;
    };
    expect(last.cardActivityId).toBe("act-1");
  });

  it("CRM_JACOB_TEAMS_CHAT_ID unset → the queue card is skipped with the reason, logged, nothing else changes", async () => {
    const { deps, calls } = fakes({ queueChatId: () => undefined });
    const out = await notifyNewLead({ lead, mint: MINTED, source: "web" }, deps);
    expect(out.queueCard).toEqual({
      ok: true,
      status: null,
      skipped: true,
      reason: "CRM_JACOB_TEAMS_CHAT_ID not set",
    });
    expect(calls.card).toHaveLength(1);
    expect(console.log).toHaveBeenCalledWith(
      "[crm] queue Teams card skipped",
      expect.objectContaining({ reason: "CRM_JACOB_TEAMS_CHAT_ID not set" }),
    );
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
    const out = await notifyNewLead({ lead, mint: MINTED, source: "web" }, deps);
    expect(out.sms).toEqual({ ok: false, error: "vox down" });
    expect(out.email).toEqual({ ok: false, error: "sendgrid down" });
    expect(out.plannerCard).toEqual({ ok: false, error: "bot down" });
    expect(out.queueCard).toEqual({ ok: false, error: "bot down" });
  });

  it("even Redis or the audit writer throwing does not reject", async () => {
    const { deps } = fakes({
      redisSet: async () => {
        throw new Error("redis down");
      },
    });
    const out = await notifyNewLead({ lead, mint: MINTED, source: "web" }, deps);
    expect(out.sms.ok).toBe(false);
    expect(out.queueCard.ok).toBe(false);
  });

  it("preferredContactMethod: text → SMS only; email → email only; phone → email only", async () => {
    for (const [pref, sms, email] of [
      ["text", 1, 0],
      ["email", 0, 1],
      ["phone", 0, 1],
    ] as const) {
      const { deps, calls } = fakes();
      const out = await notifyNewLead(
        { lead, mint: MINTED, source: "web", preferredContactMethod: pref },
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
    expect(calls.card).toHaveLength(2);
  });

  it("not minted: only the queue card goes (keyed by the lead's public id); no planner, no guest, no salescard", async () => {
    const { deps, calls } = fakes();
    const out = await notifyNewLead(
      { lead, mint: { status: "failed", error: "boom", httpStatus: 502 }, source: "web" },
      deps,
    );
    expect(out.planner).toBeNull();
    expect(calls.card).toHaveLength(1);
    expect(calls.card![0]![0]).toBe("19:queue@thread.v2");
    expect(calls.redis).toHaveLength(0);
    expect(calls.sms).toHaveLength(0);
    expect(out.plannerCard.reason).toBe("no BMI project yet");
  });

  it("summarizeNotify is one readable line", () => {
    const line = summarizeNotify({
      planner: { displayName: "Kelsea", isIndividual: true },
      queueCard: { ok: true, skipped: true, reason: "CRM_JACOB_TEAMS_CHAT_ID not set" },
      plannerCard: { ok: true },
      sms: { ok: true },
      email: { ok: false, error: "sendgrid down" },
    });
    expect(line).toBe(
      "Guest text sent · guest email FAILED (sendgrid down) · Teams card to Kelsea sent · queue card skipped (CRM_JACOB_TEAMS_CHAT_ID not set)",
    );
  });
});

describe("the queue card's buttons", () => {
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

  it("an un-minted lead gets a READ-ONLY queue card: its verbs read salescard:{projectID}, which is never written", async () => {
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
    // [0] = the planner's card, [1] = the queue card.
    const queueCard = calls.card![1]![1] as Record<string, unknown>;
    expect(actionSets(queueCard)).toHaveLength(1);
    expect(calls.redis![0]![0]).toBe(salesCardKey(MINTED.projectId));
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
    for (const c of [out.sms, out.email, out.plannerCard, out.queueCard])
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
