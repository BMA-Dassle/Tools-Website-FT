import { NextResponse, type NextRequest } from "next/server";
import {
  clientStateMatches,
  defaultWebhookDeps,
  graphFetchIdempotencyKey,
  handleNotification,
  GRAPH_FETCH_MESSAGE_KIND,
  type GraphNotification,
  type GraphNotificationBody,
  type NotificationOutcome,
} from "~/features/crm/email";
import { neonJobStore } from "~/features/crm/jobs";

/**
 * PUBLIC BY NECESSITY — one of the THREE documented `/api/crm/**` exceptions
 * to the CRM's "everything behind the admin gate" rule (brief R3; the others
 * are `3cx/{lookup,journal}` and `share/[token]`).
 *
 * WHY IT CANNOT BE GATED: Microsoft Graph posts change notifications from its
 * own infrastructure with no bearer we control, no cookie, and no way to add a
 * header. There is nothing for `isAdminApiRequest` to check. Graph's own
 * scheme is a shared secret ROUND-TRIPPED PER SUBSCRIPTION — the `clientState`
 * we mint at creation time and it echoes on every notification — so that is
 * what authenticates a caller here, verified against
 * `crm_graph_subscriptions.client_state` for the `subscriptionId` the
 * notification names. A notification with no `clientState`, an unknown
 * subscription, or a mismatched state is DROPPED before anything is fetched;
 * it still gets a 202, because a spoofer learns nothing from a 202.
 *
 * ORDER, which is the whole security and correctness story (§1.11):
 *   1. `?validationToken=…` → echo it verbatim as `text/plain`, 200, FIRST and
 *      alone. Graph waits synchronously for this when a subscription is
 *      created; it happens before any `clientState` exists so it cannot be
 *      authenticated, and it must not be delayed by anything above.
 *   2. A non-POST is 200 with no work (Graph and monitors both probe).
 *   3. Notifications are PROCESSED BEFORE WE RESPOND. Vercel freezes the
 *      function the instant it returns, so "respond then fetch" silently drops
 *      the message; Graph allows ~30 s and we take far less. A fetch that
 *      fails enqueues `graph-fetch-message` instead of being lost.
 *
 * Subscriptions themselves are created only from PRODUCTION (Graph validates
 * `notificationUrl` synchronously and a protected preview cannot answer), so
 * nothing reaches this route on a preview — see `service/subscriptions.ts`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Graph's own cap is 30 s; leave room for a slow `getMessage`. */
export const maxDuration = 30;

const NO_STORE = { "cache-control": "no-store" } as const;

function textPlain(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE },
  });
}

/** The handshake, on every method Graph might use. */
function validationEcho(req: NextRequest): Response | null {
  const token = req.nextUrl.searchParams.get("validationToken");
  return token === null ? null : textPlain(token);
}

export async function GET(req: NextRequest): Promise<Response> {
  return validationEcho(req) ?? textPlain("ok");
}

export async function POST(req: NextRequest): Promise<Response> {
  const handshake = validationEcho(req);
  if (handshake) return handshake;

  let body: GraphNotificationBody;
  try {
    body = (await req.json()) as GraphNotificationBody;
  } catch {
    return NextResponse.json({ ok: true, outcomes: [] }, { status: 202, headers: NO_STORE });
  }

  const notes: GraphNotification[] = Array.isArray(body?.value) ? body.value : [];
  const outcomes: NotificationOutcome[] = [];
  for (const note of notes) {
    outcomes.push(
      await handleNotification(note, {
        ...defaultWebhookDeps,
        statesMatch: clientStateMatches,
        onFetchFailure: async (mailbox, messageId, error) => {
          // Never lose a notification to a Graph hiccup: the retry lane owns it
          // from here, under an idempotency key that a replayed notification
          // collapses into the same row.
          await neonJobStore.enqueue({
            kind: GRAPH_FETCH_MESSAGE_KIND,
            idempotencyKey: graphFetchIdempotencyKey(mailbox, messageId),
            payload: { mailbox, messageId, error },
            createdBy: "graph-webhook",
          });
        },
      }),
    );
  }

  const summary = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log("[crm] graph webhook", { notifications: notes.length, ...summary });

  return NextResponse.json({ ok: true, outcomes }, { status: 202, headers: NO_STORE });
}
