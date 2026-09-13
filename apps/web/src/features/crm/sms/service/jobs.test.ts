import { describe, expect, it, vi } from "vitest";
import { runSmsSendRetryJob, type SmsRetryJobDeps } from "./jobs";
import type { JobContext } from "~/features/crm/jobs";
import type { SmsMessage, SmsThread } from "../types";

/**
 * `sms-send-retry`. The verdicts matter more than the send: a SUPPRESSION is
 * the guest's revocation and must be PARKED, never retried, and the retry has
 * to leave from the thread's own DID rather than whatever number is handy.
 */

const thread: SmsThread = {
  id: "55",
  repId: "7",
  repDid: "+12392058142",
  guestE164: "+12395551234",
  contactId: "9",
  leadId: "1042",
  lastMessageAt: null,
  lastInboundAt: null,
  readAt: null,
  unreadCount: 0,
  stoppedAt: null,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
};

const failed: SmsMessage = {
  id: "900",
  threadId: "55",
  leadId: "1042",
  direction: "out",
  kind: "sms",
  body: "Hi Dana",
  sentFrom: null,
  provider: "vox",
  providerMessageId: null,
  deliveryStatus: null,
  deliveryError: "vox down",
  sendStatus: "failed",
  fallbackDid: false,
  templateId: null,
  actorEmail: "kelsea@headpinz.com",
  occurredAt: "2026-09-13T12:00:00.000Z",
};

function ctx(payload: Record<string, unknown>): JobContext {
  return {
    job: { id: "1", kind: "sms-send-retry", payload } as unknown as JobContext["job"],
    payload,
    actorEmail: null,
    now: new Date("2026-09-13T12:05:00.000Z"),
  };
}

function deps(over: Partial<SmsRetryJobDeps> = {}): SmsRetryJobDeps {
  return {
    getMessage: async () => failed,
    getThread: async () => thread,
    retry: async () => ({ ok: true, error: null }),
    sendDeps: () => ({}) as never,
    ...over,
  };
}

describe("the sms-send-retry job", () => {
  it("re-sends from the thread's own DID", async () => {
    const seen: { did?: string; phone?: string } = {};
    const out = await runSmsSendRetryJob(
      ctx({ messageId: "900" }),
      deps({
        retry: async (_m, opts) => {
          seen.did = opts.did;
          seen.phone = opts.phone;
          return { ok: true, error: null };
        },
      }),
    );
    expect(out.ok).toBe(true);
    expect(seen.did).toBe("+12392058142");
    expect(seen.phone).toBe("+12395551234");
  });

  it("PARKS a suppressed row — a revocation is not a transport fault", async () => {
    const out = await runSmsSendRetryJob(
      ctx({ messageId: "900" }),
      deps({ getMessage: async () => ({ ...failed, sendStatus: "suppressed" }) }),
    );
    expect(out).toEqual({ ok: false, error: "guest revoked consent", park: true });
  });

  it("a row that has since been sent is a success, not a second send", async () => {
    const retry = vi.fn();
    const out = await runSmsSendRetryJob(
      ctx({ messageId: "900" }),
      deps({ getMessage: async () => ({ ...failed, sendStatus: "sent" }), retry: retry as never }),
    );
    expect(out.ok).toBe(true);
    expect(retry).not.toHaveBeenCalled();
  });

  it("parks what a retry cannot fix", async () => {
    expect(await runSmsSendRetryJob(ctx({}), deps())).toMatchObject({ park: true });
    expect(
      await runSmsSendRetryJob(ctx({ messageId: "900" }), deps({ getMessage: async () => null })),
    ).toMatchObject({ park: true });
    expect(
      await runSmsSendRetryJob(ctx({ messageId: "900" }), deps({ getThread: async () => null })),
    ).toMatchObject({ park: true });
  });

  it("a transport failure retries with backoff (not parked)", async () => {
    const out = await runSmsSendRetryJob(
      ctx({ messageId: "900" }),
      deps({ retry: async () => ({ ok: false, error: "vox down" }) }),
    );
    expect(out).toEqual({ ok: false, error: "vox down" });
  });
});
