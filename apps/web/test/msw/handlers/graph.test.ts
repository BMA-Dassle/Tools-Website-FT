import { describe, expect, it } from "vitest";
import { installMsw } from "../server";
import {
  GRAPH_BASE,
  GRAPH_DRAFT_ID,
  GRAPH_INBOUND_ID,
  GRAPH_LOGIN,
  GRAPH_SENT_ID,
  graphHandlers,
} from "./graph";

/**
 * Graph transport: the draft-id ≠ sent-id trap (brief §1.11) is in the
 * fixtures, and the create handler honours `Prefer: IdType="ImmutableId"`.
 */

installMsw(...graphHandlers);

const MAILBOX = `${GRAPH_BASE}/users/kelsea@headpinz.com`;

describe("msw: Microsoft Graph", () => {
  it("app-only token", async () => {
    const res = await fetch(`${GRAPH_LOGIN}/tenant-id/oauth2/v2.0/token`, {
      method: "POST",
      body: "grant_type=client_credentials",
    });
    expect((await res.json()).access_token).toBe("msw-graph-app-token");
  });

  it("WITHOUT ImmutableId the draft id differs from the sent copy's id (same internetMessageId)", async () => {
    const created = await fetch(`${MAILBOX}/messages`, { method: "POST", body: "{}" });
    expect(created.status).toBe(201);
    const draft = (await created.json()) as { id: string; internetMessageId: string };
    expect(draft.id).toBe(GRAPH_DRAFT_ID);

    const sent = (await (await fetch(`${MAILBOX}/messages/${GRAPH_SENT_ID}`)).json()) as {
      id: string;
      internetMessageId: string;
    };
    expect(sent.id).not.toBe(draft.id);
    expect(sent.internetMessageId).toBe(draft.internetMessageId);
  });

  it("WITH ImmutableId the created id is the one the sent copy keeps", async () => {
    const created = await fetch(`${MAILBOX}/messages`, {
      method: "POST",
      headers: { Prefer: 'IdType="ImmutableId"' },
      body: "{}",
    });
    expect(((await created.json()) as { id: string }).id).toBe(GRAPH_SENT_ID);
  });

  it("send is a bodyless 202; an inbound reply carries In-Reply-To; subscriptions create and renew", async () => {
    const send = await fetch(`${MAILBOX}/messages/${GRAPH_DRAFT_ID}/send`, { method: "POST" });
    expect(send.status).toBe(202);
    expect(await send.text()).toBe("");

    const inbound = (await (await fetch(`${MAILBOX}/messages/${GRAPH_INBOUND_ID}`)).json()) as {
      internetMessageHeaders: { name: string; value: string }[];
    };
    expect(inbound.internetMessageHeaders.find((h) => h.name === "In-Reply-To")?.value).toBe(
      "<CRM-L-1042-01J7QA@headpinz.com>",
    );

    const sub = (await (
      await fetch(`${GRAPH_BASE}/subscriptions`, { method: "POST", body: "{}" })
    ).json()) as { id: string; resource: string };
    expect(sub.resource).toBe("/users/kelsea@headpinz.com/mailFolders/inbox/messages");
    const renewed = (await (
      await fetch(`${GRAPH_BASE}/subscriptions/${sub.id}`, {
        method: "PATCH",
        body: JSON.stringify({ expirationDateTime: "2026-09-18T00:00:00.000Z" }),
      })
    ).json()) as { expirationDateTime: string };
    expect(renewed.expirationDateTime).toBe("2026-09-18T00:00:00.000Z");
  });
});
