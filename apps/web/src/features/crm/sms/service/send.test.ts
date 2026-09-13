import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendCrmSms, smsRetryIdempotencyKey, type SendDeps } from "./send";
import type { CrmRep, CrmUser } from "../../core/types";
import type { LinkedContact, LinkedLead, SmsMessage, SmsThread } from "../types";

/**
 * The send path, with every transport injected (R12): the ORDER is the thing
 * under test — Neon row first, then Vox — plus the refusals that must never
 * reach a provider at all.
 */

const REP_DID = "+12392058142";

function rep(over: Partial<CrmRep> = {}): CrmRep {
  return {
    id: "7",
    slug: "kelsea",
    displayName: "Kelsea Kosco",
    firstName: "Kelsea",
    initials: "KK",
    role: "rep",
    email: "kelsea@headpinz.com",
    ssoSub: null,
    bmiUserId: "28267036",
    bmiUsername: "Kelsea Kosco",
    sevenShiftsUserId: 10832991,
    voxDid: REP_DID,
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

const contact: LinkedContact = {
  id: "9",
  firstName: "Dana",
  lastName: "Whitfield",
  phoneE164: "+12395551234",
  email: "dana@example.com",
  accountName: "Lee Health",
};

const lead: LinkedLead = {
  id: "1042",
  publicId: "L-1042",
  source: "web",
  isProspect: false,
  assignedRepId: "7",
  centre: "HPFM",
  eventDate: "2026-10-17",
  eventType: "corporate",
  guests: 60,
  statusId: "assigned",
};

const thread: SmsThread = {
  id: "55",
  repId: "7",
  repDid: REP_DID,
  guestE164: "+12395551234",
  contactId: "9",
  leadId: "1042",
  lastMessageAt: null,
  lastInboundAt: null,
  readAt: null,
  unreadCount: 0,
  stoppedAt: null,
  createdAt: "2026-09-13T12:00:00.000Z",
  updatedAt: "2026-09-13T12:00:00.000Z",
};

const pending: SmsMessage = {
  id: "900",
  threadId: "55",
  leadId: "1042",
  direction: "out",
  kind: "sms",
  body: "Hi Dana",
  sentFrom: REP_DID,
  provider: null,
  providerMessageId: null,
  deliveryStatus: null,
  deliveryError: null,
  sendStatus: "pending",
  fallbackDid: false,
  templateId: null,
  actorEmail: "kelsea@headpinz.com",
  occurredAt: "2026-09-13T12:00:00.000Z",
};

interface Calls {
  order: string[];
  patches: { id: string; patch: Record<string, unknown> }[];
  jobs: { kind: string; idempotencyKey: string; payload?: Record<string, unknown> }[];
  logs: Record<string, unknown>[];
  activities: Record<string, unknown>[];
  touches: number;
}

function deps(
  over: Partial<SendDeps> = {},
  facts: { lead?: LinkedLead | null; stopped?: boolean; hasInbound?: boolean } = {},
): { deps: SendDeps; calls: Calls } {
  const calls: Calls = {
    order: [],
    patches: [],
    jobs: [],
    logs: [],
    activities: [],
    touches: 0,
  };
  const base: SendDeps = {
    resolveGuestLink: async () => ({
      contact,
      lead: facts.lead === undefined ? lead : facts.lead,
    }),
    contactById: async () => contact,
    leadForContact: async () => (facts.lead === undefined ? lead : facts.lead),
    leadById: async () => (facts.lead === undefined ? lead : facts.lead),
    threadsForGuest: async () => [{ ...thread, stoppedAt: facts.stopped ? "x" : null }],
    upsertThread: async () => ({ ...thread, stoppedAt: facts.stopped ? "x" : null }),
    hasInboundFrom: async () => facts.hasInbound === true,
    insertMessage: async () => {
      calls.order.push("neon-insert");
      return pending;
    },
    patchSendOutcome: async (id, patch) => {
      calls.patches.push({ id, patch: patch as unknown as Record<string, unknown> });
      return { ...pending, sendStatus: patch.sendStatus };
    },
    markOutbound: async () => undefined,
    voxSend: async () => {
      calls.order.push("vox");
      return { ok: true, status: 200, voxId: "vx_1", provider: "vox", sentFrom: REP_DID };
    },
    logSms: async (entry) => {
      calls.logs.push(entry as unknown as Record<string, unknown>);
    },
    recordActivity: async (a) => {
      calls.activities.push(a as unknown as Record<string, unknown>);
      return "1";
    },
    noteOutboundTouch: async () => {
      calls.touches += 1;
      return { recorded: true, firstTouchAt: "2026-09-13T12:00:00.000Z" };
    },
    enqueue: async (input) => {
      calls.jobs.push(input);
      return { job: { id: "1" } as never, created: true };
    },
    smsEnabled: () => true,
    now: () => new Date("2026-09-13T12:00:00.000Z"),
  };
  return { deps: { ...base, ...over }, calls };
}

beforeEach(() => vi.restoreAllMocks());

describe("sendCrmSms", () => {
  it("writes the Neon row BEFORE it calls Vox (R2)", async () => {
    const { deps: d, calls } = deps();
    const res = await sendCrmSms({ key: "c-9", body: "Hi Dana" }, user(), d);
    expect(res.ok).toBe(true);
    expect(calls.order).toEqual(["neon-insert", "vox"]);
  });

  it("sends from the rep's own DID and records it", async () => {
    const seen: { from?: string } = {};
    const { deps: d, calls } = deps({
      voxSend: async (_to, _body, opts) => {
        seen.from = opts?.fromOverride;
        return { ok: true, status: 200, voxId: "vx_1", provider: "vox", sentFrom: REP_DID };
      },
    });
    await sendCrmSms({ key: "c-9", body: "Hi Dana" }, user(), d);
    expect(seen.from).toBe(REP_DID);
    expect(calls.patches[0].patch).toMatchObject({
      sendStatus: "sent",
      sentFrom: REP_DID,
      fallbackDid: false,
      providerMessageId: "vx_1",
    });
  });

  it("REFUSES when the rep has no DID — and never touches Vox", async () => {
    const { deps: d, calls } = deps();
    const res = await sendCrmSms(
      { key: "c-9", body: "Hi" },
      user({ rep: rep({ voxDid: null }) }),
      d,
    );
    expect(res).toEqual({ ok: false, message: null, threadId: null, error: "no_did" });
    expect(calls.order).toEqual([]);
  });

  it("REFUSES a cold prospect with no inbound — the consent gate, before any write", async () => {
    const cold: LinkedLead = { ...lead, source: "cold", isProspect: true };
    const { deps: d, calls } = deps({}, { lead: cold });
    const res = await sendCrmSms({ key: "c-9", body: "Hi" }, user(), d);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no_consent");
    expect(calls.order).toEqual([]);
  });

  it("allows that same cold row once they have texted us first", async () => {
    const cold: LinkedLead = { ...lead, source: "cold", isProspect: true };
    const { deps: d, calls } = deps({}, { lead: cold, hasInbound: true });
    const res = await sendCrmSms({ key: "c-9", body: "Hi" }, user(), d);
    expect(res.ok).toBe(true);
    expect(calls.order).toEqual(["neon-insert", "vox"]);
  });

  it("REFUSES after a STOP on this rep's number", async () => {
    const { deps: d } = deps({}, { stopped: true, hasInbound: true });
    const res = await sendCrmSms({ key: "c-9", body: "Hi" }, user(), d);
    expect(res.error).toBe("stopped");
  });

  it("refuses a body we cannot send as GSM-7, and sends the em-dash one after normalising", async () => {
    const { deps: d } = deps();
    expect((await sendCrmSms({ key: "c-9", body: "party 🎉" }, user(), d)).error).toBe("not_gsm7");

    const bodies: string[] = [];
    const { deps: d2 } = deps({
      voxSend: async (_to, body) => {
        bodies.push(body);
        return { ok: true, status: 200, voxId: "vx_2", provider: "vox", sentFrom: REP_DID };
      },
    });
    await sendCrmSms({ key: "c-9", body: "Hi Dana — checking in" }, user(), d2);
    expect(bodies[0]).toBe("Hi Dana - checking in");
  });

  it("a SUPPRESSED send is recorded as suppressed and NEVER retried", async () => {
    const { deps: d, calls } = deps({
      voxSend: async () => ({
        ok: false,
        status: null,
        error: "suppressed: opted out",
        suppressed: true,
        suppressionOutcome: "opt_out",
      }),
    });
    const res = await sendCrmSms({ key: "c-9", body: "Hi" }, user(), d);
    expect(res.ok).toBe(false);
    expect(calls.patches[0].patch).toMatchObject({ sendStatus: "suppressed" });
    expect(calls.jobs).toEqual([]);
  });

  it("a transport failure queues exactly one retry job, keyed by the message row", async () => {
    const { deps: d, calls } = deps({
      voxSend: async () => ({ ok: false, status: 500, error: "vox down" }),
    });
    const res = await sendCrmSms({ key: "c-9", body: "Hi" }, user(), d);
    expect(res.ok).toBe(false);
    expect(calls.patches[0].patch).toMatchObject({ sendStatus: "failed" });
    expect(calls.jobs).toEqual([
      {
        kind: "sms-send-retry",
        idempotencyKey: smsRetryIdempotencyKey("900"),
        payload: { messageId: "900" },
        createdBy: "kelsea@headpinz.com",
      },
    ]);
  });

  it("a fallback to the A2P DID is flagged on the row, never passed off as the rep's number", async () => {
    const { deps: d, calls } = deps({
      voxSend: async () => ({
        ok: true,
        status: 200,
        voxId: "vx_3",
        provider: "vox",
        sentFrom: "+12394412867",
      }),
    });
    await sendCrmSms({ key: "c-9", body: "Hi" }, user(), d);
    expect(calls.patches[0].patch).toMatchObject({
      sentFrom: "+12394412867",
      fallbackDid: true,
    });
  });

  it("logs to the shared SMS log under its own source and records the first touch", async () => {
    const { deps: d, calls } = deps();
    await sendCrmSms({ key: "c-9", body: "Hi Dana" }, user(), d);
    expect(calls.logs[0]).toMatchObject({ source: "crm-sms", ok: true, phone: "+12395551234" });
    expect(calls.activities[0]).toMatchObject({
      kind: "sms",
      direction: "out",
      externalKind: "vox",
      externalRef: "vx_1",
      actorEmail: "kelsea@headpinz.com",
    });
    expect(calls.touches).toBe(1);
  });

  it("the kill switch refuses before anything else", async () => {
    const { deps: d, calls } = deps({ smsEnabled: () => false });
    expect((await sendCrmSms({ key: "c-9", body: "Hi" }, user(), d)).error).toBe("sms_off");
    expect(calls.order).toEqual([]);
  });

  it("a director with no rep row has no number to send from", async () => {
    const { deps: d } = deps();
    const res = await sendCrmSms(
      { key: "c-9", body: "Hi" },
      user({ rep: null, role: "director" }),
      d,
    );
    expect(res.error).toBe("no_rep");
  });

  it("a key that names no contact is a bad number, not a send", async () => {
    const { deps: d, calls } = deps({
      contactById: async () => null,
      leadForContact: async () => null,
    });
    const res = await sendCrmSms({ key: "c-404", body: "Hi" }, user(), d);
    expect(res.error).toBe("bad_number");
    expect(calls.order).toEqual([]);
  });
});
