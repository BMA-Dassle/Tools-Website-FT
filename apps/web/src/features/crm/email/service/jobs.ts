/**
 * The email sub's two `crm_jobs` handlers (brief §3.5, §3.9).
 *
 *   graph-renew          — daily: create / renew / recreate every mailbox
 *                          subscription. Idempotency key `graph-renew:<ET day>`
 *                          (`graphRenewIdempotencyKey`), so the cron drain and
 *                          a director's "Run" press collapse into one row.
 *   graph-fetch-message  — retry lane for a webhook whose `getMessage` failed
 *                          (Graph hiccup, a throttle). Payload
 *                          `{mailbox, messageId}`; the work is the SAME
 *                          `linkGraphMessage` the webhook runs, so a retry can
 *                          never produce a different row.
 *   email-send-retry     — a draft Graph ACCEPTED whose `/send` then failed
 *                          (429, 503, or our 20 s timeout firing after Graph
 *                          had already queued it). It RE-READS the message
 *                          before doing anything — `isDraft` false means the
 *                          send landed after all and the row is simply marked
 *                          sent; only a message still sitting in Drafts is
 *                          re-sent. Sending blind here is how a guest gets the
 *                          same email twice.
 *
 * Both return a `JobOutcome` rather than throwing for expected failures: an
 * unconfigured Graph is `park`ed (retrying 20 times before the owner has
 * pasted `CRM_GRAPH_*` into Vercel is noise, not resilience), while a transient
 * Graph error is an ordinary failure the runner backs off and retries.
 *
 * `ensureSubscriptions` refuses without `CRM_GRAPH_WEBHOOK_URL`, so running
 * this job on a preview reports `skipped: "no_webhook_url"` and creates
 * nothing — exactly the behaviour §1.12 requires.
 */

import { todayEasternYmd } from "~/features/web-sales";
import type { JobContext, JobOutcome } from "../../jobs/registry";
import { listReps } from "../../reps";
import {
  EMAIL_SEND_RETRY_KIND,
  GRAPH_FETCH_MESSAGE_KIND,
  GRAPH_RENEW_KIND,
  emailSendRetryIdempotencyKey,
  graphFetchIdempotencyKey,
} from "../contracts";
import { getLink, markLinkFailed, markLinkSent } from "../data/email-links-db";
import { GraphError, getMessage, graphConfigured, sendDraft } from "./graph-client";
import { ensureSubscriptions } from "./subscriptions";
import { linkGraphMessage } from "./webhook";

/**
 * The kinds and their keys are defined in `../contracts` (pure, client-safe)
 * so the public webhook route can import the SHIPPED key function without
 * pulling a transport into its test. Re-exported here because this is where
 * every other caller looks for them.
 */
export {
  EMAIL_SEND_RETRY_KIND,
  GRAPH_FETCH_MESSAGE_KIND,
  GRAPH_RENEW_KIND,
  emailSendRetryIdempotencyKey,
  graphFetchIdempotencyKey,
};

/** One renewal per ET calendar day (R10: ET helpers, never a UTC `Date`). */
export function graphRenewIdempotencyKey(now: Date = new Date()): string {
  return `${GRAPH_RENEW_KIND}:${todayEasternYmd(now)}`;
}

/** Active reps that have a mailbox — the set the subscriptions cover. */
export async function subscribedMailboxes(): Promise<string[]> {
  const reps = await listReps();
  const out: string[] = [];
  for (const rep of reps) {
    const email = rep.email?.trim().toLowerCase();
    if (email && !out.includes(email)) out.push(email);
  }
  return out;
}

export const runGraphRenewJob = async ({ now }: JobContext): Promise<JobOutcome> => {
  if (!graphConfigured()) {
    return { ok: false, error: "CRM_GRAPH_* not configured", park: true };
  }
  const mailboxes = await subscribedMailboxes();
  const result = await ensureSubscriptions(mailboxes, now);
  if (result.skipped === "no_webhook_url") {
    return { ok: false, error: "CRM_GRAPH_WEBHOOK_URL is not set (production scope)", park: true };
  }
  const failed = result.outcomes.filter((o) => o.action === "failed");
  if (failed.length > 0 && failed.length === result.outcomes.length) {
    return { ok: false, error: failed[0].error ?? "every subscription failed" };
  }
  return { ok: true, result };
};

export const runGraphFetchMessageJob = async ({ payload }: JobContext): Promise<JobOutcome> => {
  const mailbox = typeof payload.mailbox === "string" ? payload.mailbox : "";
  const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
  if (!mailbox || !messageId) {
    return { ok: false, error: "payload needs {mailbox, messageId}", park: true };
  }
  if (!graphConfigured()) {
    return { ok: false, error: "CRM_GRAPH_* not configured", park: true };
  }
  try {
    const msg = await getMessage(mailbox, messageId);
    return { ok: true, result: await linkGraphMessage(mailbox, msg) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // A message that no longer exists is never coming back — park it rather
    // than spending twenty attempts on a deleted draft.
    if (err instanceof GraphError && err.status === 404) return { ok: false, error, park: true };
    return { ok: false, error };
  }
};

/**
 * Finish a send Graph accepted as a draft and then failed to post.
 *
 * RE-READ FIRST, ALWAYS (R5 applied to Graph). `/send` answers 202 and the
 * three ways it fails — 429, 503, and our own 20 s abort — all leave the
 * message in a state we cannot infer: Graph may have queued and delivered it
 * before the socket died. So the job asks: still `isDraft`? Only then does it
 * re-issue `/send`. Anything already out of Drafts is recorded as sent with
 * Graph's own `sentDateTime`, and the guest gets exactly one email.
 */
export const runEmailSendRetryJob = async ({ payload }: JobContext): Promise<JobOutcome> => {
  const linkId = typeof payload.linkId === "string" ? payload.linkId : "";
  const mailbox = typeof payload.mailbox === "string" ? payload.mailbox : "";
  const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
  if (!linkId || !mailbox || !messageId) {
    return { ok: false, error: "payload needs {linkId, mailbox, messageId}", park: true };
  }
  if (!graphConfigured()) {
    return { ok: false, error: "CRM_GRAPH_* not configured", park: true };
  }
  const link = await getLink(linkId);
  if (!link) return { ok: false, error: `crm_email_links ${linkId} is gone`, park: true };
  if (link.sendStatus === "sent") return { ok: true, result: { linkId, already: "sent" } };

  try {
    const msg = await getMessage(mailbox, messageId);
    if (msg.isDraft === false) {
      // It left after all. Record it rather than sending a second copy.
      await markLinkSent(linkId, "graph", {
        graphError: link.graphError,
        sentAt: msg.sentDateTime ? new Date(msg.sentDateTime) : undefined,
      });
      return { ok: true, result: { linkId, outcome: "already_sent", sentAt: msg.sentDateTime } };
    }
    await sendDraft(mailbox, messageId);
    await markLinkSent(linkId, "graph", { graphError: link.graphError });
    return { ok: true, result: { linkId, outcome: "resent" } };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // The draft is gone (someone deleted it, or the mailbox moved on): there is
    // nothing left to send, so stop and say so on the row.
    if (err instanceof GraphError && err.status === 404) {
      await markLinkFailed(linkId, error, { graphError: error });
      return { ok: false, error, park: true };
    }
    return { ok: false, error };
  }
};
