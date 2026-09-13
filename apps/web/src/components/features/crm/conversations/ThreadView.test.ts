import { describe, expect, it } from "vitest";
import type { SmsMessage } from "~/features/crm/sms/types";
import { statusNote } from "./ThreadView";

/**
 * WHAT THE BUBBLE ADMITS. `statusNote` is the only place a rep learns that a
 * text did not go the way the composer implied, so every branch is pinned —
 * especially the two "not from your number" cases, which mean different things
 * to the guest and must not read the same.
 */

function message(over: Partial<SmsMessage> = {}): SmsMessage {
  return {
    id: "900",
    threadId: "55",
    leadId: null,
    direction: "out",
    kind: "sms",
    body: "Hi Dana",
    sentFrom: "+12392058142",
    provider: "vox",
    providerMessageId: "vx_1",
    deliveryStatus: null,
    deliveryError: null,
    sendStatus: "sent",
    fallbackDid: false,
    templateId: null,
    actorEmail: "kelsea@headpinz.com",
    occurredAt: "2026-09-13T12:00:00.000Z",
    ...over,
  };
}

describe("statusNote", () => {
  it("says nothing about a normal outbound text, or about anything inbound", () => {
    expect(statusNote(message())).toBeNull();
    expect(statusNote(message({ direction: "in", sendStatus: "received" }))).toBeNull();
    expect(statusNote(message({ deliveryStatus: "delivered" }))).toBeNull();
  });

  it("a failure names the carrier's reason when there is one, and the retry when there is not", () => {
    expect(statusNote(message({ sendStatus: "failed", deliveryError: "21610 unsubscribed" }))).toBe(
      "Not delivered — 21610 unsubscribed",
    );
    expect(statusNote(message({ sendStatus: "failed" }))).toBe("Not delivered — retry queued");
  });

  it("a suppression and a pending send each say so", () => {
    expect(statusNote(message({ sendStatus: "suppressed" }))).toBe(
      "Blocked — this number has opted out",
    );
    expect(statusNote(message({ sendStatus: "pending" }))).toBe("Sending…");
  });

  it("the A2P fallback names the number the guest actually saw", () => {
    expect(statusNote(message({ fallbackDid: true, sentFrom: "+12394412867" }))).toBe(
      "Sent from +12394412867 — your own number was rejected",
    );
  });

  it("A TWILIO FAILOVER — fallbackDid with NO sender — warns that a reply cannot come back", () => {
    // Twilio picks its own sender and never tells us which number it used, so
    // `sentFrom` is null. The rep must not be left waiting for a reply that is
    // going to a number with no MO webhook into the CRM.
    expect(statusNote(message({ fallbackDid: true, sentFrom: null }))).toBe(
      "Sent by the backup carrier — not from your number; a reply will not reach this thread",
    );
  });

  it("an unresolved carrier verdict is quoted rather than interpreted", () => {
    expect(statusNote(message({ deliveryStatus: "queued" }))).toBe("Carrier says queued");
    expect(statusNote(message({ deliveryStatus: "sent" }))).toBeNull();
  });
});
