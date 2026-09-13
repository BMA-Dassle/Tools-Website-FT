import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installMsw } from "@/test/msw/server";
import { graphHandlers } from "@/test/msw/handlers/graph";
import {
  GRAPH_DRAFT_ROLE,
  GRAPH_NOT_CONFIGURED_REASON,
  GRAPH_SEND_ROLE,
  createDraft,
  draftBody,
  graphConfigured,
  graphSendReadiness,
  readGraphEnv,
  readinessFromRoles,
  resetGraphReadinessCache,
  resetGraphTokenCache,
  subscriptionExpiry,
  subscriptionResource,
  tokenRoles,
} from "./graph-client";
import { GRAPH_DRAFT_ID, GRAPH_SENT_ID } from "@/test/msw/handlers/graph";

installMsw(...graphHandlers);

const ENV = { ...process.env };

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.signature`;
}

beforeEach(() => {
  process.env = { ...ENV };
  resetGraphTokenCache();
  resetGraphReadinessCache();
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("env", () => {
  it("needs all three values, and never reuses the Teams bot's GRAPH_TENANT_ID", () => {
    process.env.GRAPH_TENANT_ID = "botframework.com";
    delete process.env.CRM_GRAPH_TENANT_ID;
    process.env.CRM_GRAPH_CLIENT_ID = "c";
    process.env.CRM_GRAPH_CLIENT_SECRET = "s";
    expect(readGraphEnv()).toBeNull();
    expect(graphConfigured()).toBe(false);
    process.env.CRM_GRAPH_TENANT_ID = "t";
    expect(readGraphEnv()).toEqual({ tenantId: "t", clientId: "c", clientSecret: "s" });
  });
});

describe("the draft body", () => {
  it("is plain text with our Message-ID and only X- headers", () => {
    const body = draftBody({
      subject: "S",
      text: "hello",
      to: [{ address: "dana@example.com", name: "Dana" }],
      cc: [{ address: "paula@headpinz.com" }],
      internetMessageId: "<CRM-L-1042-x@headpinz.com>",
      headers: { "X-HP-Lead": "L-1042" },
    });
    expect(body).toEqual({
      subject: "S",
      body: { contentType: "Text", content: "hello" },
      toRecipients: [{ emailAddress: { address: "dana@example.com", name: "Dana" } }],
      ccRecipients: [{ emailAddress: { address: "paula@headpinz.com" } }],
      internetMessageId: "<CRM-L-1042-x@headpinz.com>",
      internetMessageHeaders: [{ name: "X-HP-Lead", value: "L-1042" }],
    });
  });

  it("omits cc and headers entirely when there are none", () => {
    const body = draftBody({ subject: "S", text: "t", to: [{ address: "a@b.com" }] });
    expect("ccRecipients" in body).toBe(false);
    expect("internetMessageHeaders" in body).toBe(false);
  });
});

describe('Prefer: IdType="ImmutableId" is doing real work', () => {
  it("returns the id that SURVIVES the move to Sent Items", async () => {
    process.env.CRM_GRAPH_TENANT_ID = "t";
    process.env.CRM_GRAPH_CLIENT_ID = "c";
    process.env.CRM_GRAPH_CLIENT_SECRET = "s";
    const draft = await createDraft("kelsea@headpinz.com", {
      subject: "S",
      text: "t",
      to: [{ address: "dana@example.com" }],
    });
    // The fixtures are the SAME message under two ids; `createDraft` sends the
    // header, so it gets the sent-copy id. Without it we would store
    // GRAPH_DRAFT_ID and never match the Sent Items copy again.
    expect(draft.id).toBe(GRAPH_SENT_ID);
    expect(draft.id).not.toBe(GRAPH_DRAFT_ID);
  });
});

describe("readiness", () => {
  it("reads the roles claim without ever exposing the token", () => {
    expect(tokenRoles(jwt({ roles: ["Mail.Read", "Mail.Send"] }))).toEqual([
      "Mail.Read",
      "Mail.Send",
    ]);
    expect(tokenRoles("not-a-jwt")).toEqual([]);
    expect(tokenRoles(jwt({}))).toEqual([]);
  });

  it("needs Mail.ReadWrite AND Mail.Send — the draft flow is a mailbox WRITE", () => {
    expect(readinessFromRoles([GRAPH_DRAFT_ROLE, GRAPH_SEND_ROLE]).ready).toBe(true);
    const live = readinessFromRoles(["Mail.Read", "Mail.Send"]);
    expect(live.ready).toBe(false);
    expect(live.missing).toEqual(["Mail.ReadWrite"]);
    const noSend = readinessFromRoles(["Mail.Read", "Mail.ReadWrite"]);
    expect(noSend.missing).toEqual(["Mail.Send"]);
    expect(readinessFromRoles([]).missing).toEqual(["Mail.ReadWrite", "Mail.Send"]);
  });

  it("says so plainly when the env is not on this deployment", async () => {
    delete process.env.CRM_GRAPH_TENANT_ID;
    const r = await graphSendReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toBe(GRAPH_NOT_CONFIGURED_REASON);
  });
});

describe("subscriptions", () => {
  it("builds the resource Graph expects and stays inside the 4230-minute cap", () => {
    expect(subscriptionResource("kelsea@headpinz.com", "sentitems")).toBe(
      "/users/kelsea@headpinz.com/mailFolders/sentitems/messages",
    );
    const now = new Date("2026-09-13T12:00:00Z");
    expect(subscriptionExpiry(now, 99_999)).toBe(
      new Date(now.getTime() + 4230 * 60_000).toISOString(),
    );
  });
});
