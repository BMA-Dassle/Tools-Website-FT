/**
 * Microsoft Graph, app-only — the C2 port of the portal's `api/lib/graph.ts`
 * (brief §1.11, portal facts F2.1–F2.6).
 *
 *   POST  https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token   → {access_token, expires_in}
 *   POST  /v1.0/users/{mailbox}/messages                                  create DRAFT → message (id = DRAFT id)
 *   POST  /v1.0/users/{mailbox}/messages/{id}/send                        202, no body
 *   GET   /v1.0/users/{mailbox}/messages/{id}                             draft / SENT copy / inbound reply
 *   POST  /v1.0/subscriptions                                             → subscription
 *   PATCH /v1.0/subscriptions/{id}                                        → subscription with the new expiry
 *
 * THE TRAP THESE FIXTURES CARRY: without `Prefer: IdType="ImmutableId"` the
 * message id CHANGES when the draft moves to Sent Items. `graph-draft-created`
 * and `graph-sent-item` are the same message (same `internetMessageId` and
 * `conversationId`) under two different `id`s. A store keyed on the draft id
 * never matches the sent copy — hence the reconciliation by `internetMessageId`
 * / `X-HP-Lead`. The create handler honours the header: with ImmutableId the
 * draft is returned under the SENT id, so a test can prove both paths.
 */

import { HttpResponse, http, rawJson } from "../server";
import { fixtureText } from "./fixture";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const GRAPH_LOGIN = "https://login.microsoftonline.com";

export const graphFixtures = {
  token: () => fixtureText("graph-token.json.txt"),
  draft: () => fixtureText("graph-draft-created.json.txt"),
  sent: () => fixtureText("graph-sent-item.json.txt"),
  inbound: () => fixtureText("graph-inbound-message.json.txt"),
  subscription: () => fixtureText("graph-subscription.json.txt"),
};

export const GRAPH_DRAFT_ID = (JSON.parse(graphFixtures.draft()) as { id: string }).id;
export const GRAPH_SENT_ID = (JSON.parse(graphFixtures.sent()) as { id: string }).id;
export const GRAPH_INBOUND_ID = (JSON.parse(graphFixtures.inbound()) as { id: string }).id;

export const graphHandlers = [
  http.post(`${GRAPH_LOGIN}/:tenant/oauth2/v2.0/token`, () => rawJson(graphFixtures.token())),
  http.post(`${GRAPH_BASE}/users/:mailbox/messages`, ({ request }) => {
    const immutable = /IdType="ImmutableId"/i.test(request.headers.get("prefer") ?? "");
    // With ImmutableId the id is stable across the move to Sent Items — the
    // sent fixture's id IS the immutable one; without it, the draft id.
    return rawJson(immutable ? graphFixtures.sent() : graphFixtures.draft(), { status: 201 });
  }),
  http.post(
    `${GRAPH_BASE}/users/:mailbox/messages/:id/send`,
    () => new HttpResponse(null, { status: 202 }),
  ),
  http.get(`${GRAPH_BASE}/users/:mailbox/messages/:id`, ({ params }) => {
    if (params.id === GRAPH_DRAFT_ID) return rawJson(graphFixtures.draft());
    if (params.id === GRAPH_SENT_ID) return rawJson(graphFixtures.sent());
    if (params.id === GRAPH_INBOUND_ID) return rawJson(graphFixtures.inbound());
    return HttpResponse.json(
      {
        error: {
          code: "ErrorItemNotFound",
          message: "The specified object was not found in the store.",
        },
      },
      { status: 404 },
    );
  }),
  http.post(`${GRAPH_BASE}/subscriptions`, () =>
    rawJson(graphFixtures.subscription(), { status: 201 }),
  ),
  http.patch(`${GRAPH_BASE}/subscriptions/:id`, async ({ request }) => {
    const body = (await request.json()) as { expirationDateTime?: string };
    const sub = JSON.parse(graphFixtures.subscription()) as Record<string, unknown>;
    return HttpResponse.json({
      ...sub,
      expirationDateTime: body.expirationDateTime ?? sub.expirationDateTime,
    });
  }),
];
