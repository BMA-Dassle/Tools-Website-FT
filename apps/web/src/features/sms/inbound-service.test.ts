import { describe, it, expect, vi } from "vitest";
import { handleInbound, type InboundEffects } from "./inbound-service";
import type { MoPayload } from "./mo-payload";

function payload(body: string, id = "msg1"): MoPayload {
  return {
    id,
    from: "+12395551234",
    to: "+12394412867",
    body,
    receivedAt: "2026-08-20T01:13:42.000Z",
    apiVersion: "2025-02-01",
  };
}

type ConsentArg = Parameters<InboundEffects["recordConsent"]>[0];
type ReviewArg = Parameters<InboundEffects["enqueueReview"]>[0];

/** Effects double. `firstTime` and `recorded` are the two knobs the
 *  compliance rules turn on.
 *
 *  Parameters are declared (and voided) rather than omitted: a zero-arg
 *  `vi.fn` infers an empty argument tuple, so `mock.calls[0][0]` then
 *  fails typecheck even though it works at runtime. */
function effects(over: Partial<{ recorded: boolean; firstTime: boolean; sendOk: boolean }> = {}) {
  const recorded = over.recorded ?? true;
  const firstTime = over.firstTime ?? true;
  const sendOk = over.sendOk ?? true;
  const calls = {
    recordConsent: vi.fn(async (input: ConsentArg) => {
      void input;
      return { recorded, firstTime };
    }),
    sendReply: vi.fn(async (phoneE164: string, body: string) => {
      void phoneE164;
      void body;
      return { ok: sendOk };
    }),
    enqueueReview: vi.fn(async (item: ReviewArg) => {
      void item;
      return { added: true };
    }),
  };
  return calls satisfies InboundEffects;
}

describe("STOP", () => {
  it("writes the ledger and sends exactly one confirmation", async () => {
    const e = effects();
    const r = await handleInbound(payload("STOP"), e);
    expect(r.outcome).toBe("opted_out");
    expect(e.recordConsent).toHaveBeenCalledTimes(1);
    expect(e.sendReply).toHaveBeenCalledTimes(1);
    expect(e.sendReply.mock.calls[0][1]).toMatch(/opted out/i);
  });

  it("records the consent BEFORE replying", async () => {
    // If the reply went first and the write failed, the guest would hold
    // a text saying "you're opted out" while we kept texting them.
    const order: string[] = [];
    const e = {
      recordConsent: vi.fn(async () => {
        order.push("record");
        return { recorded: true, firstTime: true };
      }),
      sendReply: vi.fn(async () => {
        order.push("send");
        return { ok: true };
      }),
      enqueueReview: vi.fn(async () => ({ added: true })),
    } as unknown as InboundEffects;
    await handleInbound(payload("STOP"), e);
    expect(order).toEqual(["record", "send"]);
  });

  it("uses the Vox message id as the idempotency key", async () => {
    const e = effects();
    await handleInbound(payload("STOP", "vox-abc"), e);
    expect(e.recordConsent.mock.calls[0][0].providerMessageId).toBe("vox-abc");
  });

  it("sends NOTHING on a retried callback", async () => {
    // Vox retries a non-2xx up to ~5 times. Five confirmations would
    // violate (a)(12) five times over.
    const e = effects({ recorded: false });
    const r = await handleInbound(payload("STOP"), e);
    expect(r.outcome).toBe("duplicate_callback");
    expect(e.sendReply).not.toHaveBeenCalled();
  });

  it("does not send a SECOND confirmation to an already-suppressed guest", async () => {
    // (a)(12) is one confirmation per revocation, not per message.
    const e = effects({ firstTime: false });
    const r = await handleInbound(payload("STOP"), e);
    expect(r.outcome).toBe("opted_out_repeat");
    expect(e.recordConsent).toHaveBeenCalledTimes(1);
    expect(e.sendReply).not.toHaveBeenCalled();
  });

  it("keeps the suppression when the confirmation fails to send", async () => {
    // The important half succeeded. Do not unwind it.
    const e = effects({ sendOk: false });
    const r = await handleInbound(payload("STOP"), e);
    expect(r.outcome).toBe("opted_out");
    expect(r.replied).toBe(false);
    expect(r.replyFailed).toBe(true);
    expect(e.recordConsent).toHaveBeenCalledTimes(1);
  });

  it("honors the punctuation and casing forms too", async () => {
    for (const body of ["stop", "Stop.", "STOP!", "Stop ", "  STOP  ", "OPT OUT"]) {
      const e = effects();
      const r = await handleInbound(payload(body), e);
      expect(r.outcome, `${JSON.stringify(body)} should opt out`).toBe("opted_out");
    }
  });
});

describe("START", () => {
  it("writes an opt_in and confirms", async () => {
    const e = effects();
    const r = await handleInbound(payload("START"), e);
    expect(r.outcome).toBe("opted_in");
    expect(e.recordConsent.mock.calls[0][0].action).toBe("opt_in");
    expect(e.sendReply.mock.calls[0][1]).toMatch(/back on/i);
  });

  it("confirms even when the guest was never suppressed", async () => {
    // Silence would read as failure to the guest, and confirming a no-op
    // carries no legal weight.
    const e = effects({ firstTime: false });
    const r = await handleInbound(payload("start"), e);
    expect(r.outcome).toBe("opted_in_repeat");
    expect(e.sendReply).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a retried callback", async () => {
    const e = effects({ recorded: false });
    const r = await handleInbound(payload("START"), e);
    expect(r.outcome).toBe("duplicate_callback");
    expect(e.sendReply).not.toHaveBeenCalled();
  });

  it("handles the exact form we captured live", async () => {
    const e = effects();
    const r = await handleInbound(payload("Start "), e);
    expect(r.outcome).toBe("opted_in");
  });
});

describe("HELP", () => {
  it("replies without touching consent state", async () => {
    const e = effects();
    const r = await handleInbound(payload("HELP"), e);
    expect(r.outcome).toBe("helped");
    expect(e.recordConsent).not.toHaveBeenCalled();
    expect(e.sendReply.mock.calls[0][1]).toMatch(/help/i);
  });
});

describe("review — never auto-actioned, never dropped", () => {
  it("queues a sentence-embedded opt-out as high priority", async () => {
    const e = effects();
    const r = await handleInbound(payload("please stop texting me"), e);
    expect(r.outcome).toBe("queued_for_review");
    expect(e.recordConsent).not.toHaveBeenCalled();
    expect(e.sendReply).not.toHaveBeenCalled();
    expect(e.enqueueReview.mock.calls[0][0].priority).toBe("high");
  });

  it("queues T-Mobile's counter-example at NORMAL priority", async () => {
    const e = effects();
    await handleInbound(payload("I cannot get my device to stop, can you help?"), e);
    expect(e.enqueueReview.mock.calls[0][0].priority).toBe("normal");
  });

  it("queues an ordinary question without replying", async () => {
    const e = effects();
    const r = await handleInbound(payload("what time is my race"), e);
    expect(r.outcome).toBe("queued_for_review");
    expect(e.sendReply).not.toHaveBeenCalled();
  });

  it("preserves the raw body for the human to read", async () => {
    const e = effects();
    await handleInbound(payload("you have the wrong number, stop"), e);
    expect(e.enqueueReview.mock.calls[0][0].body).toBe("you have the wrong number, stop");
  });

  it("does not auto-opt-out a bare YES", async () => {
    // Manufacturing consent is the worse error.
    const e = effects();
    const r = await handleInbound(payload("Yes"), e);
    expect(r.outcome).toBe("queued_for_review");
    expect(e.recordConsent).not.toHaveBeenCalled();
  });

  it("never auto-actions a call-center-style cancellation", async () => {
    const e = effects();
    const r = await handleInbound(payload("cancel my 4pm"), e);
    expect(r.outcome).toBe("queued_for_review");
    expect(e.recordConsent).not.toHaveBeenCalled();
  });
});
