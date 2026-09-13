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
import { GraphError, getMessage, graphConfigured } from "./graph-client";
import { ensureSubscriptions } from "./subscriptions";
import { linkGraphMessage } from "./webhook";

export const GRAPH_RENEW_KIND = "graph-renew";
export const GRAPH_FETCH_MESSAGE_KIND = "graph-fetch-message";

/** One renewal per ET calendar day (R10: ET helpers, never a UTC `Date`). */
export function graphRenewIdempotencyKey(now: Date = new Date()): string {
  return `${GRAPH_RENEW_KIND}:${todayEasternYmd(now)}`;
}

/** One fetch per (mailbox, message) — a retried webhook reuses the same row. */
export function graphFetchIdempotencyKey(mailbox: string, messageId: string): string {
  return `${GRAPH_FETCH_MESSAGE_KIND}:${mailbox.toLowerCase()}:${messageId}`;
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
