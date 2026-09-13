import { describe, expect, it } from "vitest";
import {
  NO_CONSENT_MESSAGE,
  NO_DID_MESSAGE,
  type ConversationSummary,
} from "~/features/crm/sms/types";
import {
  PREVIEW_CHARS,
  REFUSAL_MESSAGE,
  SENT_TOAST,
  composerPlaceholder,
  conversationHref,
  convFromLine,
  displayName,
  filterConversations,
  folderOptions,
  previewOf,
  refusalMessage,
  sendErrorMessage,
} from "./model";

/**
 * The screen's pure half. The copy assertions are the acceptance spec: the
 * prototype's strings, verbatim, and one sentence per refusal code so the
 * composer can never explain itself differently from the service.
 */

function conv(over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    key: "c-9",
    contactId: "9",
    name: "Dana Whitfield",
    phoneE164: "+12395551234",
    leadId: "1042",
    leadPublicId: "L-1042",
    leadStatus: "quote",
    leadTitle: "Lee Health",
    reps: [{ slug: "kelsea", initials: "KK", name: "Kelsea Kosco" }],
    threadIds: ["1"],
    lastMessageAt: "2026-09-13T12:00:00.000Z",
    lastBody: "Yes, 6pm works for us",
    lastDirection: "in",
    unread: 0,
    stopped: false,
    ...over,
  };
}

describe("prototype copy", () => {
  it("the folders are All · Unread · Texts · Email, with the unread count", () => {
    expect(folderOptions(2)).toEqual([
      { value: "all", label: "All" },
      { value: "unread", label: "Unread", badge: 2 },
      { value: "texts", label: "Texts" },
      { value: "email", label: "Email" },
    ]);
    expect(folderOptions(0)[1]).toEqual({ value: "unread", label: "Unread" });
  });

  it("the channel line is `<phone> ↔ your number <did>` (crm-shared.js:326)", () => {
    expect(convFromLine("+12395551234", "+12392058142")).toBe(
      "+12395551234 ↔ your number +12392058142",
    );
  });

  it("the composer placeholder is `Text <first> from <did>…` (crm-shared.js:331)", () => {
    expect(composerPlaceholder("Dana", "+12392058142")).toBe("Text Dana from +12392058142…");
  });

  it("the sent toast is the prototype's, verbatim", () => {
    expect(SENT_TOAST).toBe("Text sent · logged on the deal");
  });

  it("with no DID, every line says the ONE sentence the service answers with", () => {
    expect(REFUSAL_MESSAGE.no_did).toBe(NO_DID_MESSAGE);
    expect(NO_DID_MESSAGE).toBe("No texting number assigned to you yet — ask the director");
    expect(convFromLine("+12395551234", null)).toContain("no texting number yet");
    expect(composerPlaceholder("Dana", null)).toBe("Text Dana…");
  });
});

describe("list helpers", () => {
  it("previews are one line, capped like the prototype's 70 characters", () => {
    expect(PREVIEW_CHARS).toBe(70);
    expect(previewOf("line one\nline two")).toBe("line one line two");
    expect(previewOf("x".repeat(200))).toHaveLength(71); // 70 + the ellipsis
    expect(previewOf(null)).toBe("");
  });

  it("a person with no name shows their number", () => {
    expect(displayName(conv())).toBe("Dana Whitfield");
    expect(displayName(conv({ name: null }))).toBe("+12395551234");
    expect(displayName(conv({ name: "  " }))).toBe("+12395551234");
  });

  it("the unread folder filters, and Email is empty until C2", () => {
    const list = [conv({ key: "c-1", unread: 0 }), conv({ key: "c-2", unread: 3 })];
    expect(filterConversations(list, "all")).toHaveLength(2);
    expect(filterConversations(list, "texts")).toHaveLength(2);
    expect(filterConversations(list, "unread").map((c) => c.key)).toEqual(["c-2"]);
    expect(filterConversations(list, "email")).toEqual([]);
  });

  it("links are same-origin relative paths under /admin/crm", () => {
    expect(conversationHref("c-9")).toBe("/admin/crm/conversations/c-9");
  });
});

describe("refusals read as sentences", () => {
  it("every refusal code has one, and none of them is a code", () => {
    for (const [code, text] of Object.entries(REFUSAL_MESSAGE)) {
      expect(text.length, code).toBeGreaterThan(20);
      expect(text, code).not.toContain("_");
    }
    expect(REFUSAL_MESSAGE.no_consent).toBe(NO_CONSENT_MESSAGE);
    expect(refusalMessage(null)).toBeNull();
  });

  it("a send error maps back to the same sentence the composer shows", () => {
    expect(sendErrorMessage("no_consent")).toBe(NO_CONSENT_MESSAGE);
    expect(sendErrorMessage("suppressed")).toContain("opted out");
    expect(sendErrorMessage("vox timeout")).toBe("Not sent — vox timeout");
    expect(sendErrorMessage(null)).toBe("");
  });
});
