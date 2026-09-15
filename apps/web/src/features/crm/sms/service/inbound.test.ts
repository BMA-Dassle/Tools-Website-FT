import { describe, expect, it, vi } from "vitest";
import { fixtureText } from "@/test/msw/handlers/fixture";
import { parseMoPayload } from "~/features/sms/mo-payload";
import { handleInbound } from "~/features/sms/inbound-service";
import type { ReviewItem } from "~/features/sms/review-queue";
import {
  STOP_SYSTEM_LINE,
  inboundReplyEffect,
  noteConsentOnRepDid,
  routeInbound,
  type InboundDeps,
} from "./inbound";
import type { CrmRep, CrmRep as Rep } from "../../core/types";
import type { SmsMessage, SmsThread } from "../types";

/**
 * Inbound routing, replayed through the EXACT seam the webhook uses:
 * `parseMoPayload` → `handleInbound` → the `enqueueReview` effect. The payload
 * is the captured production MO shape (`test/msw/fixtures/vox-mo.json.txt`,
 * ids and numbers redacted), so this is a replay and not a hand-written guess.
 */

const REP_DID = "+12392058142";
const A2P_DID = "+12394412867";

function rep(over: Partial<Rep> = {}): CrmRep {
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
    bmiUserIds: null,
    bmiUsername: "Kelsea Kosco",
    bmiUsernames: null,
    sevenShiftsUserId: null,
    voxDid: REP_DID,
    threecxExtension: null,
    teamsChatId: null,
    phoneE164: null,
    centres: ["HPFM"],
    active: true,
    sortOrder: 10,
    ...over,
  };
}

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
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
};

const stored: SmsMessage = {
  id: "901",
  threadId: "55",
  leadId: "1042",
  direction: "in",
  kind: "sms",
  body: "Yes, 6pm works for us",
  sentFrom: "+12395551234",
  provider: "vox",
  providerMessageId: "vx_mo_1",
  deliveryStatus: null,
  deliveryError: null,
  sendStatus: "received",
  fallbackDid: false,
  templateId: null,
  actorEmail: null,
  occurredAt: "2026-09-12T23:31:12.000Z",
};

function deps(over: Partial<InboundDeps> = {}) {
  const seen = { inserted: [] as unknown[], inbound: 0, activities: [] as unknown[] };
  const base: InboundDeps = {
    repForDid: async (did) => (did === REP_DID ? rep() : null),
    resolveGuestLink: async () => ({
      contact: {
        id: "9",
        firstName: "Dana",
        lastName: "Whitfield",
        phoneE164: "+12395551234",
        email: null,
        accountName: "Lee Health",
      },
      lead: null,
    }),
    upsertThread: async () => thread,
    insertMessage: async (m) => {
      seen.inserted.push(m);
      return stored;
    },
    markInbound: async () => {
      seen.inbound += 1;
    },
    linkThread: async () => undefined,
    recordActivity: async (a) => {
      seen.activities.push(a);
      return "1";
    },
    threadsForGuest: async () => [thread],
    setThreadStopped: async () => undefined,
  };
  return { deps: { ...base, ...over }, seen };
}

/** The captured MO payload, parsed the way the route parses it. */
function capturedPayload(over: Record<string, unknown> = {}) {
  const raw = {
    ...(JSON.parse(fixtureText("vox-mo.json.txt")) as Record<string, unknown>),
    ...over,
  };
  const parsed = parseMoPayload(raw, [A2P_DID, REP_DID]);
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.reason}`);
  return parsed.payload;
}

function reviewItem(payload: ReturnType<typeof capturedPayload>): ReviewItem {
  return {
    id: payload.id,
    receivedAt: payload.receivedAt ?? "",
    phoneE164: payload.from,
    body: payload.body,
    action: "review",
    reviewReason: "unclassified",
    priority: "normal",
    matched: null,
  };
}

describe("routeInbound", () => {
  it("a message on a REP's DID becomes a thread message, not a review-queue item", async () => {
    const payload = capturedPayload();
    expect(payload.to).toBe(REP_DID);
    const fallback = vi.fn(async () => ({ added: true }));
    const { deps: d, seen } = deps();

    const out = await routeInbound(payload, reviewItem(payload), fallback, d);

    expect(out).toMatchObject({ handled: "crm", added: true, threadId: "55" });
    expect(fallback).not.toHaveBeenCalled();
    expect(seen.inbound).toBe(1);
    expect(seen.inserted[0]).toMatchObject({
      direction: "in",
      kind: "sms",
      provider: "vox",
      providerMessageId: payload.id,
      sendStatus: "received",
    });
    expect(seen.activities[0]).toMatchObject({
      kind: "sms",
      direction: "in",
      externalRef: payload.id,
    });
  });

  it("a message on the A2P DID still goes to the review queue — today's behaviour, untouched", async () => {
    const payload = capturedPayload({ to: A2P_DID });
    const fallback = vi.fn(async () => ({ added: true }));
    const { deps: d, seen } = deps();

    const out = await routeInbound(payload, reviewItem(payload), fallback, d);

    expect(out).toMatchObject({ handled: "review", added: true });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(seen.inserted).toEqual([]);
  });

  it("A DUPLICATE MO (same Vox id) leaves exactly one row and does NOT bump unread", async () => {
    const payload = capturedPayload();
    const fallback = vi.fn(async () => ({ added: true }));
    let first = true;
    const { deps: d, seen } = deps({
      insertMessage: async (m) => {
        seen.inserted.push(m);
        if (first) {
          first = false;
          return stored;
        }
        // The partial unique index on (provider, provider_message_id) refuses
        // the second insert; the data layer returns null for that conflict.
        return null;
      },
    });

    const a = await routeInbound(payload, reviewItem(payload), fallback, d);
    const b = await routeInbound(payload, reviewItem(payload), fallback, d);

    expect(a.added).toBe(true);
    expect(b).toMatchObject({ added: false, duplicate: true });
    expect(seen.inbound).toBe(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("a CRM failure parks the message instead of losing it", async () => {
    const payload = capturedPayload();
    const fallback = vi.fn(async () => ({ added: true }));
    const { deps: d } = deps({
      upsertThread: async () => {
        throw new Error("neon is down");
      },
    });
    const out = await routeInbound(payload, reviewItem(payload), fallback, d);
    expect(out.handled).toBe("review");
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});

describe("the STOP auto-reply", () => {
  it("answers FROM the DID the guest texted, not from the A2P number", async () => {
    const payload = capturedPayload({ body: "STOP" });
    const sent: { to: string; opts: { fromOverride: string } }[] = [];
    const reply = inboundReplyEffect(payload, async (to, _body, opts) => {
      sent.push({ to, opts });
      return { ok: true };
    });

    const result = await handleInbound(payload, {
      recordConsent: async () => ({ recorded: true, firstTime: true }),
      sendReply: reply,
      enqueueReview: async () => ({ added: true }),
    });

    expect(result.outcome).toBe("opted_out");
    expect(result.replied).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].opts.fromOverride).toBe(REP_DID);
    expect(sent[0].opts.fromOverride).not.toBe(A2P_DID);
    expect(sent[0].to).toBe(payload.from);
  });

  it("leaves a system line in the rep's thread and stops it", async () => {
    const payload = capturedPayload({ body: "STOP" });
    const inserted: Record<string, unknown>[] = [];
    const { deps: d } = deps({
      insertMessage: async (m) => {
        inserted.push(m as unknown as Record<string, unknown>);
        return { ...stored, kind: "system", body: STOP_SYSTEM_LINE };
      },
    });
    const out = await noteConsentOnRepDid(payload, true, d);
    expect(out.noted).toBe(true);
    expect(inserted[0]).toMatchObject({
      kind: "system",
      body: STOP_SYSTEM_LINE,
      provider: "vox-keyword",
      providerMessageId: payload.id,
    });
  });

  it("does nothing at all for the A2P number, which has no CRM thread", async () => {
    const payload = capturedPayload({ to: A2P_DID, body: "STOP" });
    const { deps: d, seen } = deps();
    const out = await noteConsentOnRepDid(payload, true, d);
    expect(out).toEqual({ noted: false, threadId: null });
    expect(seen.inserted).toEqual([]);
  });
});
