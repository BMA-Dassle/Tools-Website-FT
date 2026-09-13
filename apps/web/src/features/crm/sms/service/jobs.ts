/**
 * The `sms-send-retry` job (brief §3.9 / §4 C1): one failed outbound row,
 * re-attempted from the same rep DID.
 *
 * Verdicts follow the runner's contract: `ok` when the row is (already) sent,
 * `{ok:false}` to retry with backoff, `park` for anything a retry cannot fix —
 * a deleted row, a thread whose rep lost their DID, or a SUPPRESSION, which is
 * the guest's revocation and must never be retried at all.
 */

import type { JobContext, JobOutcome } from "~/features/crm/jobs";
import { getMessage } from "../data/messages-db";
import { getThread } from "../data/threads-db";
import { defaultSendDeps, retryCrmSms, type SendDeps } from "./send";

export interface SmsRetryJobDeps {
  getMessage: typeof getMessage;
  getThread: typeof getThread;
  retry: typeof retryCrmSms;
  sendDeps: () => SendDeps;
}

export function defaultSmsRetryJobDeps(): SmsRetryJobDeps {
  return { getMessage, getThread, retry: retryCrmSms, sendDeps: defaultSendDeps };
}

export async function runSmsSendRetryJob(
  ctx: JobContext,
  deps: SmsRetryJobDeps = defaultSmsRetryJobDeps(),
): Promise<JobOutcome> {
  const messageId = typeof ctx.payload.messageId === "string" ? ctx.payload.messageId : null;
  if (!messageId) return { ok: false, error: "payload.messageId missing", park: true };

  const message = await deps.getMessage(messageId);
  if (!message) return { ok: false, error: `message ${messageId} not found`, park: true };
  if (message.direction !== "out")
    return { ok: false, error: "not an outbound message", park: true };
  if (message.sendStatus === "sent") {
    return { ok: true, result: { messageId, already: "sent" } };
  }
  if (message.sendStatus === "suppressed") {
    return { ok: false, error: "guest revoked consent", park: true };
  }

  const thread = await deps.getThread(message.threadId);
  if (!thread) return { ok: false, error: "thread missing", park: true };
  // Send from the DID the thread belongs to — never the A2P number, and never
  // whichever DID the retry happens to run next to.
  const did = thread.repDid;
  if (!did) return { ok: false, error: "thread has no rep DID", park: true };

  const out = await deps.retry(message, { did, phone: thread.guestE164 }, deps.sendDeps());
  if (out.ok) return { ok: true, result: { messageId, sentFrom: did } };
  if (out.error === "suppressed") return { ok: false, error: "guest revoked consent", park: true };
  if (out.error === "sms_off") return { ok: false, error: "CRM_SMS is off", park: true };
  return { ok: false, error: out.error ?? "send failed" };
}
