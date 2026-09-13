/**
 * Graph change notifications for the sales mailboxes — create, renew, and
 * recreate after a 404 (brief §1.11).
 *
 * WHY THIS NEVER RUNS LOCALLY OR ON A PREVIEW, and the code enforces it:
 * `POST /subscriptions` makes Graph call `notificationUrl` SYNCHRONOUSLY and
 * wait for the `validationToken` echo. Vercel's Deployment Protection means a
 * preview cannot answer that call, and this box has no public URL at all — so
 * a subscription created from either place fails, and a subscription created
 * from a laptop pointing at production would hand a live webhook to a machine
 * that is about to be switched off. `CRM_GRAPH_WEBHOOK_URL` is therefore a
 * PRODUCTION-SCOPE-ONLY env var, and `ensureSubscriptions` REFUSES with
 * `skipped: "no_webhook_url"` when it is unset instead of guessing a host.
 *
 * `clientState` is a per-(mailbox, folder) secret minted once and kept in
 * `crm_graph_subscriptions.client_state`. The webhook compares what Graph
 * sends against THAT ROW — the portal's own webhook does not check it at all,
 * and we do (brief §1.11, portal T19). A rotation is just deleting the row.
 *
 * Renewal window: Graph caps a mail subscription at 4230 minutes (~70 h). We
 * renew anything inside `RENEW_WITHIN_MS` (12 h) so a daily `graph-renew` job
 * has five chances to catch one before it lapses.
 */

import { randomBytes } from "node:crypto";
import {
  GRAPH_FOLDERS,
  listSubscriptions,
  recordSubscription,
  recordSubscriptionError,
  upsertSubscriptionRow,
  type GraphFolder,
  type GraphSubscriptionRow,
} from "../data/email-links-db";
import {
  GraphError,
  SUBSCRIPTION_MAX_MINUTES,
  createSubscription,
  graphConfigured,
  renewSubscription,
  subscriptionExpiry,
  subscriptionResource,
} from "./graph-client";

/** Renew when the current expiry is inside this window. */
export const RENEW_WITHIN_MS = 12 * 60 * 60_000;

export const GRAPH_WEBHOOK_PATH = "/api/crm/graph-webhook";

/** Production only (brief §5.1). Unset = we do not create subscriptions. */
export function graphWebhookUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.CRM_GRAPH_WEBHOOK_URL?.trim();
  if (!raw) return null;
  return raw.startsWith("https://") ? raw : null;
}

export function newClientState(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Constant-time-ish comparison of the state Graph echoed against the row's.
 * Length is compared first because a mismatch there is not a secret.
 */
export function clientStateMatches(expected: string, actual: string | null | undefined): boolean {
  if (typeof actual !== "string" || actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1)
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}

export function needsRenewal(row: GraphSubscriptionRow, now: Date): boolean {
  if (!row.subscriptionId) return true;
  if (!row.expiresAt) return true;
  const at = Date.parse(row.expiresAt);
  if (Number.isNaN(at)) return true;
  return at - now.getTime() <= RENEW_WITHIN_MS;
}

export type SubscriptionAction = "created" | "renewed" | "recreated" | "ok" | "failed";

export interface SubscriptionOutcome {
  mailbox: string;
  folder: GraphFolder;
  action: SubscriptionAction;
  subscriptionId: string | null;
  expiresAt: string | null;
  error?: string;
}

export interface EnsureSubscriptionsResult {
  skipped?: "no_webhook_url" | "not_configured" | "no_mailboxes";
  notificationUrl: string | null;
  outcomes: SubscriptionOutcome[];
}

export interface SubscriptionDeps {
  create: typeof createSubscription;
  renew: typeof renewSubscription;
  list: typeof listSubscriptions;
  upsert: typeof upsertSubscriptionRow;
  record: typeof recordSubscription;
  recordError: typeof recordSubscriptionError;
  configured: typeof graphConfigured;
  webhookUrl: typeof graphWebhookUrl;
  newState: typeof newClientState;
}

export const defaultSubscriptionDeps: SubscriptionDeps = {
  create: createSubscription,
  renew: renewSubscription,
  list: listSubscriptions,
  upsert: upsertSubscriptionRow,
  record: recordSubscription,
  recordError: recordSubscriptionError,
  configured: graphConfigured,
  webhookUrl: graphWebhookUrl,
  newState: newClientState,
};

async function createFor(
  row: GraphSubscriptionRow,
  notificationUrl: string,
  now: Date,
  deps: SubscriptionDeps,
  action: "created" | "recreated",
): Promise<SubscriptionOutcome> {
  const sub = await deps.create({
    resource: subscriptionResource(row.mailbox, row.folder),
    notificationUrl,
    clientState: row.clientState,
    expirationDateTime: subscriptionExpiry(now, SUBSCRIPTION_MAX_MINUTES),
  });
  await deps.record(row.id, { subscriptionId: sub.id, expiresAt: sub.expirationDateTime });
  return {
    mailbox: row.mailbox,
    folder: row.folder,
    action,
    subscriptionId: sub.id,
    expiresAt: sub.expirationDateTime,
  };
}

/**
 * One row per (mailbox, folder) for every mailbox given; create what is
 * missing, renew what is close to lapsing, recreate what Graph has forgotten.
 * A failure on one mailbox is recorded on its row and does not stop the rest.
 */
export async function ensureSubscriptions(
  mailboxes: readonly string[],
  now: Date = new Date(),
  deps: SubscriptionDeps = defaultSubscriptionDeps,
): Promise<EnsureSubscriptionsResult> {
  if (!deps.configured()) return { skipped: "not_configured", notificationUrl: null, outcomes: [] };
  const notificationUrl = deps.webhookUrl();
  if (!notificationUrl) return { skipped: "no_webhook_url", notificationUrl: null, outcomes: [] };
  const boxes = mailboxes.map((m) => m.trim().toLowerCase()).filter(Boolean);
  if (boxes.length === 0) return { skipped: "no_mailboxes", notificationUrl, outcomes: [] };

  const outcomes: SubscriptionOutcome[] = [];
  for (const mailbox of boxes) {
    for (const folder of GRAPH_FOLDERS) {
      const row = await deps.upsert(mailbox, folder, deps.newState());
      try {
        if (!needsRenewal(row, now)) {
          outcomes.push({
            mailbox,
            folder,
            action: "ok",
            subscriptionId: row.subscriptionId,
            expiresAt: row.expiresAt,
          });
          continue;
        }
        if (!row.subscriptionId) {
          outcomes.push(await createFor(row, notificationUrl, now, deps, "created"));
          continue;
        }
        try {
          const sub = await deps.renew(
            row.subscriptionId,
            subscriptionExpiry(now, SUBSCRIPTION_MAX_MINUTES),
          );
          await deps.record(row.id, {
            subscriptionId: sub.id,
            expiresAt: sub.expirationDateTime,
          });
          outcomes.push({
            mailbox,
            folder,
            action: "renewed",
            subscriptionId: sub.id,
            expiresAt: sub.expirationDateTime,
          });
        } catch (err) {
          // Graph forgets a lapsed subscription entirely: a 404 on PATCH is
          // "make a new one", not an error (brief §1.11).
          if (err instanceof GraphError && err.status === 404) {
            outcomes.push(await createFor(row, notificationUrl, now, deps, "recreated"));
          } else {
            throw err;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await deps.recordError(row.id, message);
        outcomes.push({
          mailbox,
          folder,
          action: "failed",
          subscriptionId: row.subscriptionId,
          expiresAt: row.expiresAt,
          error: message,
        });
      }
    }
  }
  return { notificationUrl, outcomes };
}
