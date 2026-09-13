import { describe, expect, it } from "vitest";
import type { EmailMessageView, EmailSenderView } from "~/features/crm/email/contracts";
import { SENDGRID_FALLBACK_CHIP } from "~/features/crm/email/contracts";
import type { LeadView } from "~/features/crm/leads/contracts";
import {
  cardFootnote,
  composerButtonCopy,
  composerFootnoteFor,
  convFromLine,
  emptyThreadCopy,
  initialsFor,
  sendStateChip,
  sortNewestFirst,
  whoLine,
} from "./model";

/** The prototype's copy, verbatim — a test is the only thing that keeps it so. */

const lead = {
  guest: { first: "Dana", last: "Acme", email: "dana@example.com" },
} as unknown as LeadView;

const sender: EmailSenderView = {
  mailbox: "kelsea@headpinz.com",
  displayName: "Kelsea Kosco",
  repId: "1",
  repSlug: "kelsea",
  cc: [],
  graph: true,
  graphReason: null,
};

function msg(over: Partial<EmailMessageView> = {}): EmailMessageView {
  return {
    id: "1",
    mailbox: "kelsea@headpinz.com",
    graphMessageId: "AA",
    leadId: "1042",
    repId: "1",
    direction: "out",
    subject: "HeadPinz Fort Myers — Corporate on Dec 12",
    preview: "Hi Dana,",
    fromEmail: "kelsea@headpinz.com",
    toEmails: ["dana@example.com"],
    ccEmails: [],
    at: "2026-09-12T23:40:05Z",
    sendStatus: "sent",
    provider: "graph",
    sendError: null,
    matchedBy: "composer",
    webLink: null,
    ...over,
  };
}

describe("ordering", () => {
  it("is newest first, like the prototype's Email tab", () => {
    const older = msg({ id: "a", at: "2026-09-10T00:00:00Z" });
    const newer = msg({ id: "b", at: "2026-09-13T00:00:00Z" });
    expect(sortNewestFirst([older, newer]).map((m) => m.id)).toEqual(["b", "a"]);
  });
});

describe("copy", () => {
  it("names the two sides the way the prototype does", () => {
    expect(whoLine(msg(), lead)).toBe("You → dana@example.com");
    expect(whoLine(msg({ direction: "in" }), lead)).toBe("Dana Acme → you");
  });

  it("uses the rep's initials outbound and the guest's inbound", () => {
    expect(initialsFor(msg(), lead, "KK")).toBe("KK");
    expect(initialsFor(msg({ direction: "in" }), lead, "KK")).toBe("DA");
  });

  it("keeps the empty, composer-button and header lines verbatim", () => {
    expect(emptyThreadCopy(lead)).toBe("No email with Dana yet.");
    expect(composerButtonCopy(sender)).toBe("New email from kelsea@headpinz.com");
    expect(convFromLine(lead, sender)).toBe("dana@example.com ↔ kelsea@headpinz.com");
  });

  it("tells the truth about which rail a message went out on", () => {
    expect(cardFootnote(msg(), lead)).toBe("Sent from your mailbox via the CRM");
    expect(cardFootnote(msg({ provider: "sendgrid" }), lead)).toBe(SENDGRID_FALLBACK_CHIP);
    expect(cardFootnote(msg({ direction: "in", fromEmail: "dana@example.com" }), lead)).toBe(
      "Landed in your Outlook inbox · linked by dana@example.com",
    );
  });

  it("swaps the Graph footnote for the fallback chip when Graph is not connected", () => {
    expect(composerFootnoteFor(sender, "GRAPH")).toBe("GRAPH");
    expect(composerFootnoteFor({ ...sender, graph: false }, "GRAPH")).toBe(SENDGRID_FALLBACK_CHIP);
  });
});

describe("sendStateChip", () => {
  it("says nothing on a clean Graph send", () => {
    expect(sendStateChip(msg())).toBeNull();
    expect(sendStateChip(msg({ direction: "in", provider: "graph" }))).toBeNull();
  });

  it("shows the fallback chip on a SendGrid send", () => {
    expect(sendStateChip(msg({ provider: "sendgrid" }))).toEqual({
      text: SENDGRID_FALLBACK_CHIP,
      tone: "warn",
    });
  });

  it("shows the reason on a failure, and never pretends a pending row is sent", () => {
    expect(sendStateChip(msg({ sendStatus: "failed", sendError: "SendGrid 401" }))).toEqual({
      text: "Not sent — SendGrid 401",
      tone: "crit",
    });
    expect(sendStateChip(msg({ sendStatus: "pending", provider: null }))).toEqual({
      text: "Sending…",
      tone: "warn",
    });
  });
});
