/**
 * INBOUND — the CRM's branch inside the EXISTING Vox MO webhook.
 *
 * There is exactly ONE inbound URL (`/api/sms-webhook/vox/inbound`) and there
 * will go on being one (R8, §6.4). A second endpoint would mean two consent
 * ledgers, two idempotency keys for the same carrier message and two places to
 * point a DID at. So this module plugs into the seam the route already has:
 * `handleInbound`'s `enqueueReview` effect. `routeInbound` tries the CRM first
 * — the message arrived on a rep's DID, so it belongs in that rep's thread —
 * and falls back to `enqueueForReview` for everything else, which is exactly
 * today's behaviour for the A2P number.
 *
 * STOP / START / HELP never come here: `handleInbound` classifies and answers
 * them first, because the consent ledger outranks a CRM thread. What this
 * module adds for those is `noteConsentOnRepDid`, which writes a visible
 * system line into the rep's thread and sets `stopped_at`, so a rep looking at
 * the conversation can see why their next text was refused instead of
 * wondering.
 *
 * IDEMPOTENCY. Vox retries a non-2xx up to five times and a duplicate MO must
 * not become two messages: `crm_sms_messages (provider, provider_message_id)`
 * is unique, `insertMessage` returns null on the conflict, and the second
 * arrival stops right there — before the unread count is bumped.
 *
 * NO NEW CHAT SENDS. The owner removed the call-centre Teams alert rail
 * (2026-08) and §5.7b forbids a second card about a lead, so an inbound text
 * does not post to Teams. The rep-facing ping is C9's web push, which is built
 * on this row landing in Neon.
 */

import type { MoPayload } from "~/features/sms/mo-payload";
import type { ReviewItem } from "~/features/sms/review-queue";
import { recordActivity } from "~/features/crm/activities";
import type { CrmRep } from "../../core/types";
import { insertMessage } from "../data/messages-db";
import { resolveGuestLink } from "../data/links-db";
import {
  linkThread,
  markInbound,
  setThreadStopped,
  threadsForGuest,
  upsertThread,
} from "../data/threads-db";
import { repForDid } from "./dids";

/** The thread line a STOP leaves behind. Staff-facing (the CRM is staff-only). */
export const STOP_SYSTEM_LINE =
  "Guest texted STOP to this number. Texting is paused until they text START.";
export const START_SYSTEM_LINE = "Guest texted START. Texting is allowed again.";

/** The `voxSend` surface the auto-reply needs — injected so it can be asserted. */
export type ReplySender = (
  to: string,
  body: string,
  opts: {
    bypassSuppression: true;
    skipFooter: true;
    fromOverride: string;
    auditSource: string;
  },
) => Promise<{ ok: boolean }>;

/**
 * The STOP / START / HELP auto-reply, sent FROM THE DID THE GUEST TEXTED.
 *
 * Built here rather than inline in the route so the rule is testable: before
 * this PR the route passed `allowedDids()[0]` — the A2P number — while its own
 * comment said "reply FROM the DID the guest texted". Harmless while that was
 * the only inbound DID; with rep DIDs in the list it would answer a STOP sent
 * to Kelsea's number from a number the guest has never seen, which is both
 * confusing and a poor look on a consent confirmation.
 *
 * `payload.to` is already canonical E.164 (`mo-payload.ts`).
 */
export function inboundReplyEffect(
  payload: MoPayload,
  send: ReplySender,
): (phoneE164: string, body: string) => Promise<{ ok: boolean }> {
  return async (phoneE164, body) => {
    const res = await send(phoneE164, body, {
      // By definition we may have just suppressed this number; that one
      // message is what 64.1200(a)(12) permits.
      bypassSuppression: true,
      // The replies carry their own instructions; the generic footer would be
      // nonsense on "You're opted out".
      skipFooter: true,
      fromOverride: payload.to,
      auditSource: "sms-inbound-reply",
    });
    return { ok: res.ok };
  };
}

export interface InboundRouteResult {
  /** "crm" when it landed in a rep's thread, "review" when it was parked. */
  handled: "crm" | "review";
  /** True when the CRM (or the review queue) actually stored something. */
  added: boolean;
  threadId: string | null;
  /** Set when this exact Vox message id had already been recorded. */
  duplicate?: boolean;
}

export interface InboundDeps {
  repForDid: typeof repForDid;
  resolveGuestLink: typeof resolveGuestLink;
  upsertThread: typeof upsertThread;
  insertMessage: typeof insertMessage;
  markInbound: typeof markInbound;
  linkThread: typeof linkThread;
  recordActivity: typeof recordActivity;
  threadsForGuest: typeof threadsForGuest;
  setThreadStopped: typeof setThreadStopped;
}

export function defaultInboundDeps(): InboundDeps {
  return {
    repForDid,
    resolveGuestLink,
    upsertThread,
    insertMessage,
    markInbound,
    linkThread,
    recordActivity,
    threadsForGuest,
    setThreadStopped,
  };
}

/**
 * Try the CRM by DID, else the review queue.
 *
 * `payload` carries the DID the guest texted (`to`), which `ReviewItem` does
 * not — that is why the route passes both.
 */
export async function routeInbound(
  payload: MoPayload,
  item: ReviewItem,
  fallback: (item: ReviewItem) => Promise<{ added: boolean }>,
  deps: InboundDeps = defaultInboundDeps(),
): Promise<InboundRouteResult> {
  let rep: CrmRep | null = null;
  try {
    rep = await deps.repForDid(payload.to);
  } catch (err) {
    // A CRM outage must not swallow a guest's message. Park it where the
    // existing rail already looks.
    console.error("[crm-sms] inbound rep lookup failed; parking for review", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!rep) {
    const parked = await fallback(item);
    return { handled: "review", added: parked.added, threadId: null };
  }

  try {
    const link = await deps.resolveGuestLink(payload.from);
    const thread = await deps.upsertThread({
      repId: rep.id,
      repDid: payload.to,
      guestE164: payload.from,
      contactId: link.contact?.id ?? null,
      leadId: link.lead?.id ?? null,
    });
    const at = payload.receivedAt ?? new Date().toISOString();
    const stored = await deps.insertMessage({
      threadId: thread.id,
      leadId: link.lead?.id ?? null,
      direction: "in",
      kind: "sms",
      body: payload.body,
      sentFrom: payload.from,
      provider: "vox",
      providerMessageId: payload.id,
      sendStatus: "received",
      occurredAt: at,
    });
    if (!stored) {
      // Already recorded — a retried callback. Do NOT bump the unread count.
      return { handled: "crm", added: false, threadId: thread.id, duplicate: true };
    }
    await deps.markInbound(thread.id, at);
    await deps.linkThread(thread.id, {
      contactId: link.contact?.id ?? null,
      leadId: link.lead?.id ?? null,
    });
    await deps.recordActivity({
      leadId: link.lead?.id ?? null,
      contactId: link.contact?.id ?? null,
      repId: rep.id,
      actorEmail: null,
      kind: "sms",
      direction: "in",
      occurredAt: at,
      body: payload.body,
      externalKind: "vox-mo",
      externalRef: payload.id,
      meta: { threadId: thread.id, to: payload.to },
    });
    return { handled: "crm", added: true, threadId: thread.id };
  } catch (err) {
    console.error("[crm-sms] inbound write failed; parking for review", {
      error: err instanceof Error ? err.message : String(err),
    });
    const parked = await fallback(item);
    return { handled: "review", added: parked.added, threadId: null };
  }
}

/**
 * A STOP or START that arrived on a REP's DID: mark the thread and leave a
 * line in it. No-ops (quietly) for the A2P number, which has no CRM thread.
 *
 * `handleInbound` has already written the consent ledger and sent the single
 * permitted confirmation; this is only what the CRM screen shows.
 */
export async function noteConsentOnRepDid(
  payload: MoPayload,
  stopped: boolean,
  deps: InboundDeps = defaultInboundDeps(),
): Promise<{ noted: boolean; threadId: string | null }> {
  try {
    const rep = await deps.repForDid(payload.to);
    if (!rep) return { noted: false, threadId: null };
    const existing = await deps.threadsForGuest(payload.from);
    const mine = existing.find((t) => t.repDid === payload.to);
    const thread =
      mine ??
      (await deps.upsertThread({
        repId: rep.id,
        repDid: payload.to,
        guestE164: payload.from,
      }));
    const at = payload.receivedAt ?? new Date().toISOString();
    // The system line is keyed by the SAME Vox id as the message, under its own
    // provider name, so a retried callback cannot leave two lines.
    const stored = await deps.insertMessage({
      threadId: thread.id,
      direction: "in",
      kind: "system",
      body: stopped ? STOP_SYSTEM_LINE : START_SYSTEM_LINE,
      provider: "vox-keyword",
      providerMessageId: payload.id,
      sendStatus: "received",
      occurredAt: at,
    });
    await deps.setThreadStopped(thread.id, stopped);
    return { noted: stored !== null, threadId: thread.id };
  } catch (err) {
    console.error("[crm-sms] consent note failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { noted: false, threadId: null };
  }
}
