/**
 * SEND ONE TEXT, from the signed-in rep's own number.
 *
 * ── The order, and why it is not negotiable ─────────────────────────
 *
 *  1. kill switch, rep, DID          — refuse before anything is written
 *  2. resolve the person             — contact / lead by number
 *  3. thread upsert                  — (rep DID, guest number)
 *  4. consent (R8)                   — inbound on file, or an enquiry source
 *  5. GSM-7 normalise + assert (R11) — what we store is what left
 *  6. INSERT `crm_sms_messages` `pending`   ← NEON FIRST (R2)
 *  7. `voxSend(…, {fromOverride: rep.vox_did})`
 *  8. patch the row with what the provider said
 *  9. `logSms({source:"crm-sms"})`, `crm_activities`, first touch
 * 10. a failure enqueues `sms-send-retry`; a SUPPRESSION never does
 *
 * Step 6 before step 7 is the Pizza Bowl lesson: a text the guest received but
 * we never recorded is unrecoverable, and a row we wrote for a send that
 * failed is merely a red chip with a retry behind it.
 *
 * ── NEVER THE A2P DID ───────────────────────────────────────────────
 *
 * A CRM text leaves from `crm_reps.vox_did` or it does not leave. No rep has
 * one yet (owner item D5), so today every send refuses with `no_did` and the
 * composer says so. Falling back to `+12394412867` would put a rep's personal
 * sales conversation on the automated A2P number, where the guest's reply is
 * answered by a keyword matcher — the exact collision `features/sms/sender.ts`
 * was written to make impossible. `voxSend`'s own 400/403 fallback to the A2P
 * number is a different thing (Vox rejected OUR DID) and is recorded as
 * `fallback_did` so the thread can say so.
 */

import { canonicalizePhone } from "@/lib/participant-contact";
import { logSms } from "@/lib/sms-log";
import { voxSend, type VoxSendResult } from "@/lib/sms-retry";
import { recordActivity } from "~/features/crm/activities";
import { neonJobStore } from "~/features/crm/jobs";
import { noteOutboundTouch } from "~/features/crm/leads";
import { crmSmsEnabled } from "../../core/flags";
import type { CrmUser } from "../../core/types";
import { hasInboundFrom, insertMessage, patchSendOutcome } from "../data/messages-db";
import { contactById, leadById, leadForContact, resolveGuestLink } from "../data/links-db";
import { markOutbound, threadsForGuest, upsertThread } from "../data/threads-db";
import { e164FromDigits, parseConversationKey } from "../keys";
import type { LinkedContact, LinkedLead, SendRefusal, SendSmsResult, SmsMessage } from "../types";
import { consentFor } from "./consent";
import { toGsm7 } from "./templates-merge";

export const SMS_RETRY_JOB_KIND = "sms-send-retry" as const;

/** One retry chain per message row; re-sending the same row is idempotent. */
export function smsRetryIdempotencyKey(messageId: string): string {
  return `${SMS_RETRY_JOB_KIND}:${messageId}`;
}

export interface SendDeps {
  resolveGuestLink: typeof resolveGuestLink;
  contactById: typeof contactById;
  leadForContact: typeof leadForContact;
  leadById: typeof leadById;
  threadsForGuest: typeof threadsForGuest;
  upsertThread: typeof upsertThread;
  hasInboundFrom: typeof hasInboundFrom;
  insertMessage: typeof insertMessage;
  patchSendOutcome: typeof patchSendOutcome;
  markOutbound: typeof markOutbound;
  voxSend: typeof voxSend;
  logSms: typeof logSms;
  recordActivity: typeof recordActivity;
  noteOutboundTouch: typeof noteOutboundTouch;
  enqueue: (typeof neonJobStore)["enqueue"];
  smsEnabled: () => boolean;
  now: () => Date;
}

export function defaultSendDeps(): SendDeps {
  return {
    resolveGuestLink,
    contactById,
    leadForContact,
    leadById,
    threadsForGuest,
    upsertThread,
    hasInboundFrom,
    insertMessage,
    patchSendOutcome,
    markOutbound,
    voxSend,
    logSms,
    recordActivity,
    noteOutboundTouch,
    enqueue: (input) => neonJobStore.enqueue(input),
    smsEnabled: crmSmsEnabled,
    now: () => new Date(),
  };
}

export interface SendSmsInput {
  /** A conversation key (`c-12` / `p-12395551234`) — the Conversations screen. */
  key?: string | null;
  /** A raw number — the deal's "new text" path. One of `key` / `to` is required. */
  to?: string | null;
  body: string;
  templateId?: string | null;
  /** Pin the text to a lead; otherwise the person's current lead is used. */
  leadId?: string | null;
}

function refusal(code: SendRefusal, threadId: string | null = null): SendSmsResult {
  return { ok: false, message: null, threadId, error: code };
}

/** The destination the caller named, canonical, or null. */
export function destinationFor(input: SendSmsInput): string | null {
  if (input.to) return canonicalizePhone(input.to);
  const parsed = input.key ? parseConversationKey(input.key) : null;
  if (parsed?.kind === "phone") return e164FromDigits(parsed.digits);
  return null;
}

export async function sendCrmSms(
  input: SendSmsInput,
  user: CrmUser,
  deps: SendDeps = defaultSendDeps(),
): Promise<SendSmsResult> {
  if (!deps.smsEnabled()) return refusal("sms_off");
  const rep = user.rep;
  if (!rep) return refusal("no_rep");
  const did = rep.voxDid ? canonicalizePhone(rep.voxDid) : null;
  // NEVER the A2P DID. See the header.
  if (!did) return refusal("no_did");

  // Who are we texting? A `c-<id>` key resolves through the contact row, so a
  // rep can never text a number the key did not name.
  let phone = destinationFor(input);
  let contact: LinkedContact | null = null;
  let lead: LinkedLead | null = null;

  const parsed = input.key ? parseConversationKey(input.key) : null;
  if (!phone && parsed?.kind === "contact") {
    contact = await deps.contactById(parsed.contactId);
    lead = contact ? await deps.leadForContact(contact.id) : null;
    phone = contact?.phoneE164 ?? null;
  }
  if (!phone) return refusal("bad_number");

  if (!contact) {
    const link = await deps.resolveGuestLink(phone);
    contact = link.contact;
    lead = link.lead;
  }
  if (input.leadId) lead = (await deps.leadById(input.leadId)) ?? lead;

  const thread = await deps.upsertThread({
    repId: rep.id,
    repDid: did,
    guestE164: phone,
    contactId: contact?.id ?? null,
    leadId: lead?.id ?? null,
  });

  // Consent is asked of the PERSON, so every thread they have counts towards
  // "have they texted us" — a guest who replied to Lori has given Kelsea the
  // same basis.
  const siblings = await deps.threadsForGuest(phone);
  const hasInbound = await deps.hasInboundFrom(
    siblings.length > 0 ? siblings.map((t) => t.id) : [thread.id],
  );
  const verdict = consentFor({
    lead,
    hasInbound,
    stopped: thread.stoppedAt !== null,
    repDid: did,
    smsEnabled: true,
    hasRep: true,
  });
  if (!verdict.allowed) return refusal(verdict.refusal ?? "no_consent", thread.id);

  const gsm = toGsm7(input.body, input.templateId ? `crm-template-${input.templateId}` : "crm-sms");
  if (!gsm.ok) return refusal("not_gsm7", thread.id);
  const body = gsm.body.trim();
  if (!body) return refusal("bad_number", thread.id);

  const at = deps.now();
  const pending = await deps.insertMessage({
    threadId: thread.id,
    leadId: lead?.id ?? null,
    direction: "out",
    kind: "sms",
    body,
    sentFrom: did,
    sendStatus: "pending",
    templateId: input.templateId ?? null,
    actorEmail: user.email,
    occurredAt: at.toISOString(),
  });
  if (!pending) {
    // Only a provider-id conflict can return null, and a pending row has none.
    return { ok: false, message: null, threadId: thread.id, error: "not_recorded" };
  }

  const res: VoxSendResult = await deps.voxSend(phone, body, {
    fromOverride: did,
    fallbackPrefix: `(From ${rep.firstName} at ${did}) `,
    category: "transactional",
    auditSource: "crm-sms",
  });

  const sentFrom = res.sentFrom ?? (res.ok ? did : null);
  const fallbackDid = sentFrom !== null && sentFrom !== did;
  const providerMessageId = res.voxId ?? res.twilioSid ?? null;
  const status = res.suppressed ? "suppressed" : res.ok ? "sent" : "failed";

  const stored =
    (await deps.patchSendOutcome(pending.id, {
      sendStatus: status,
      provider: res.provider ?? null,
      providerMessageId,
      sentFrom,
      fallbackDid,
      deliveryError: res.ok ? null : (res.error ?? null),
    })) ?? pending;

  await deps.markOutbound(thread.id, at.toISOString());

  await safely(() =>
    deps.logSms({
      ts: at.toISOString(),
      phone,
      source: "crm-sms",
      status: res.status,
      ok: res.ok,
      error: res.error,
      body,
      provider: res.provider,
      failedOver: res.failedOver,
      providerMessageId: providerMessageId ?? undefined,
    }),
  );

  if (res.ok) {
    await safely(() =>
      deps.recordActivity({
        leadId: lead?.id ?? null,
        contactId: contact?.id ?? null,
        repId: rep.id,
        actorEmail: user.email,
        kind: "sms",
        direction: "out",
        occurredAt: at,
        body,
        externalKind: providerMessageId ? "vox" : null,
        externalRef: providerMessageId,
        meta: { threadId: thread.id, sentFrom, fallbackDid },
      }),
    );
    if (lead) {
      await safely(() =>
        deps.noteOutboundTouch(
          { kind: "sms", direction: "out", repId: rep.id, occurredAt: at },
          { id: lead!.id, rep: lead!.assignedRepId },
        ),
      );
    }
  } else if (!res.suppressed) {
    // A suppression is terminal — the guest revoked consent and there is
    // nothing to retry. Everything else is a transport fault worth a job.
    await safely(() =>
      deps.enqueue({
        kind: SMS_RETRY_JOB_KIND,
        idempotencyKey: smsRetryIdempotencyKey(stored.id),
        payload: { messageId: stored.id },
        createdBy: user.email,
      }),
    );
  }

  return {
    ok: res.ok,
    message: stored,
    threadId: thread.id,
    error: res.ok ? null : res.suppressed ? "suppressed" : (res.error ?? "send_failed"),
  };
}

/** Diary entries never fail a send that already happened. */
async function safely(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error("[crm-sms] post-send bookkeeping failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Re-attempt one failed outbound row (the `sms-send-retry` job). */
export async function retryCrmSms(
  message: SmsMessage,
  opts: { did: string; phone: string },
  deps: SendDeps = defaultSendDeps(),
): Promise<{ ok: boolean; error: string | null }> {
  if (!deps.smsEnabled()) return { ok: false, error: "sms_off" };
  const res = await deps.voxSend(opts.phone, message.body, {
    fromOverride: opts.did,
    category: "transactional",
    auditSource: "crm-sms-retry",
  });
  const sentFrom = res.sentFrom ?? (res.ok ? opts.did : null);
  await deps.patchSendOutcome(message.id, {
    sendStatus: res.suppressed ? "suppressed" : res.ok ? "sent" : "failed",
    provider: res.provider ?? null,
    providerMessageId: res.voxId ?? res.twilioSid ?? null,
    sentFrom,
    fallbackDid: sentFrom !== null && sentFrom !== opts.did,
    deliveryError: res.ok ? null : (res.error ?? null),
  });
  await safely(() =>
    deps.logSms({
      ts: deps.now().toISOString(),
      phone: opts.phone,
      source: "crm-sms",
      status: res.status,
      ok: res.ok,
      error: res.error,
      body: message.body,
      provider: res.provider,
      providerMessageId: res.voxId ?? undefined,
    }),
  );
  if (res.suppressed) return { ok: false, error: "suppressed" };
  return { ok: res.ok, error: res.ok ? null : (res.error ?? "send_failed") };
}
