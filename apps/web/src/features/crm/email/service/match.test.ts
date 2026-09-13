import { describe, expect, it, vi } from "vitest";
import { fixtureText } from "@/test/msw/handlers/fixture";
import type { GraphMessage } from "./graph-client";
import {
  addressesOf,
  counterpartyOf,
  directionOf,
  firstMessageId,
  headerValue,
  matchMessage,
  occurredAtOf,
  preferredLead,
  previewOf,
  type MatchDeps,
  type MatchedLead,
} from "./match";

const KELSEA = "kelsea@headpinz.com";

function msg(name: string): GraphMessage {
  return JSON.parse(fixtureText(name)) as GraphMessage;
}

const inbound = () => msg("graph-inbound-message.json.txt");
const sent = () => msg("graph-sent-item.json.txt");

function lead(over: Partial<MatchedLead> = {}): MatchedLead {
  return {
    id: "1042",
    publicId: "L-1042",
    contactId: "77",
    assignedRepId: "1",
    guestEmail: "dana@example.com",
    statusKindOpen: true,
    archived: false,
    ...over,
  };
}

function deps(over: Partial<MatchDeps> = {}): MatchDeps {
  return {
    leadsByGuestEmail: vi.fn(async () => []),
    linkByInternetMessageId: vi.fn(async () => null),
    leadByRef: vi.fn(async () => null),
    ...over,
  };
}

describe("pure pluckers", () => {
  it("reads a header case-insensitively", () => {
    expect(headerValue(inbound(), "in-reply-to")).toBe("<CRM-L-1042-01J7QA@headpinz.com>");
    expect(headerValue(inbound(), "X-Nope")).toBeNull();
  });

  it("takes the first angle-bracketed id out of In-Reply-To", () => {
    expect(firstMessageId("  <a@b>  <c@d> ")).toBe("<a@b>");
    expect(firstMessageId("bare-id")).toBe("bare-id");
    expect(firstMessageId(null)).toBeNull();
  });

  it("calls a message from the mailbox 'out' and one to it 'in'", () => {
    expect(directionOf(sent(), KELSEA)).toBe("out");
    expect(directionOf(inbound(), KELSEA)).toBe("in");
    // The SAME message read from the guest's side would be inbound — direction
    // is a property of the mailbox we are reading, not of the message.
    expect(directionOf(sent(), "dana@example.com")).toBe("in");
  });

  it("finds the guest on both sides", () => {
    expect(counterpartyOf(inbound(), KELSEA)).toBe("dana@example.com");
    expect(counterpartyOf(sent(), KELSEA)).toBe("dana@example.com");
  });

  it("keeps recipients and the timestamp Graph actually gave", () => {
    expect(addressesOf(sent().toRecipients)).toEqual(["dana@example.com"]);
    expect(occurredAtOf(sent())).toBe("2026-09-12T23:40:05Z");
    expect(occurredAtOf(inbound())).toBe("2026-09-13T13:05:22Z");
    expect(previewOf(inbound())).toBe("Thanks Kelsea — can we do 42 people at 6pm?");
  });
});

describe("preferredLead", () => {
  it("prefers an open lead over a closed one, and ignores archived rows", () => {
    const closed = lead({ id: "1", statusKindOpen: false });
    const open = lead({ id: "2" });
    const gone = lead({ id: "3", archived: true });
    expect(preferredLead([gone, closed, open], "dana@example.com")?.id).toBe("2");
    expect(preferredLead([gone, closed], "dana@example.com")?.id).toBe("1");
    expect(preferredLead([gone], "dana@example.com")).toBeNull();
  });

  it("only matches the EXACT address, case-insensitively", () => {
    const other = lead({ guestEmail: "dana.acme@example.com" });
    expect(preferredLead([other], "dana@example.com")).toBeNull();
    expect(preferredLead([lead({ guestEmail: "DANA@example.com" })], "dana@EXAMPLE.com")?.id).toBe(
      "1042",
    );
  });
});

describe("match order — from-address, then In-Reply-To, then X-HP-Lead", () => {
  it("1. matches on the from-address first, without consulting the other two", async () => {
    const d = deps({ leadsByGuestEmail: vi.fn(async () => [lead()]) });
    const r = await matchMessage(inbound(), KELSEA, d);
    expect(r.matchedBy).toBe("from");
    expect(r.lead?.publicId).toBe("L-1042");
    expect(d.linkByInternetMessageId).not.toHaveBeenCalled();
    expect(d.leadByRef).not.toHaveBeenCalled();
  });

  it("2. falls to In-Reply-To when the address is unknown", async () => {
    const d = deps({
      linkByInternetMessageId: vi.fn(async () => ({ leadId: "1042" })),
      leadByRef: vi.fn(async () => lead()),
    });
    const r = await matchMessage(inbound(), KELSEA, d);
    expect(r.matchedBy).toBe("in-reply-to");
    expect(d.linkByInternetMessageId).toHaveBeenCalledWith("<CRM-L-1042-01J7QA@headpinz.com>");
  });

  it("3. falls to our own X-HP-Lead header last", async () => {
    const d = deps({ leadByRef: vi.fn(async () => lead()) });
    // The sent copy carries X-HP-Lead but no In-Reply-To.
    const r = await matchMessage(sent(), KELSEA, d);
    expect(r.matchedBy).toBe("x-hp-lead");
    expect(d.leadByRef).toHaveBeenCalledWith("L-1042");
  });

  it("matches nothing rather than guessing", async () => {
    const r = await matchMessage(inbound(), KELSEA, deps());
    expect(r).toEqual({ lead: null, matchedBy: null });
  });

  it("does not let a spoofed X-HP-Lead beat a real from-address", async () => {
    const spoofed = inbound();
    spoofed.internetMessageHeaders = [{ name: "X-HP-Lead", value: "L-9999" }];
    const real = lead({ id: "1042", publicId: "L-1042" });
    const d = deps({
      leadsByGuestEmail: vi.fn(async () => [real]),
      leadByRef: vi.fn(async () => lead({ id: "9999", publicId: "L-9999" })),
    });
    const r = await matchMessage(spoofed, KELSEA, d);
    expect(r.lead?.publicId).toBe("L-1042");
    expect(d.leadByRef).not.toHaveBeenCalled();
  });
});
