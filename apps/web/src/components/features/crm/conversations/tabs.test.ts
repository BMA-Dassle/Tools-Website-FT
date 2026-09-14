import { describe, expect, it } from "vitest";
import type { ConversationDetail } from "~/features/crm/sms/types";
import {
  CONVERSATION_TABS,
  CONVERSATION_TAB_IDS,
  CONVERSATION_TAB_LABEL,
  CONVERSATION_TAB_OWNER,
  activeConversationTab,
  isConversationTabId,
  tabCounts,
} from "./tabs";

/**
 * The registry C2 flips one line of. Its shape is the contract between this PR
 * and the email PR: two tabs, `sms` pointing at the real thread and `email` at
 * a placeholder that says so.
 */
describe("conversation tab registry", () => {
  it("is Text and Email, in that order, each with a loader and an owner", () => {
    expect(CONVERSATION_TAB_IDS).toEqual(["sms", "email"]);
    expect(CONVERSATION_TAB_IDS.map((id) => CONVERSATION_TAB_LABEL[id])).toEqual(["Text", "Email"]);
    for (const id of CONVERSATION_TAB_IDS) {
      expect(typeof CONVERSATION_TABS[id], id).toBe("function");
    }
    expect(CONVERSATION_TAB_OWNER).toEqual({ sms: "C1", email: "C2" });
  });

  it("both tabs load a real panel — `email` is no longer the placeholder", async () => {
    const sms = await CONVERSATION_TABS.sms();
    const email = await CONVERSATION_TABS.email();
    expect(typeof sms.default).toBe("function");
    expect(sms.default.name).toBe("ThreadView");
    // `EmailComingLater` said the rail had not shipped. It had — so a rep could
    // email from a deal, see it in the list, open it and be told otherwise.
    expect(email.default.name).toBe("ConversationEmail");
  });

  it("the URL picks the tab; anything else is Text", () => {
    expect(activeConversationTab({ tab: "email" })).toBe("email");
    expect(activeConversationTab({ tab: "sms" })).toBe("sms");
    expect(activeConversationTab({})).toBe("sms");
    expect(activeConversationTab({ tab: "carrier-pigeon" })).toBe("sms");
    expect(isConversationTabId("email")).toBe(true);
    expect(isConversationTabId("post")).toBe(false);
  });

  // Owner, 2026-09-14: "if its email it should default to email. If its sms
  // should default to sms."
  it("with no tab in the URL, the channel this person actually uses wins", () => {
    const conv = (over: Record<string, unknown>) =>
      ({
        summary: { channels: [], lastEmailAt: null, emailCount: 0, ...over },
        messages: [],
      }) as unknown as ConversationDetail;

    expect(activeConversationTab({}, conv({ channels: ["email"] }))).toBe("email");
    expect(activeConversationTab({}, conv({ channels: ["sms"] }))).toBe("sms");
    expect(activeConversationTab({}, null)).toBe("sms");

    // Both channels: whichever spoke last.
    const both = {
      summary: {
        channels: ["sms", "email"],
        lastEmailAt: "2026-09-14T10:00:00.000Z",
        emailCount: 1,
      },
      messages: [{ kind: "sms", occurredAt: "2026-09-13T10:00:00.000Z" }],
    } as unknown as ConversationDetail;
    expect(activeConversationTab({}, both)).toBe("email");

    const textLast = {
      summary: {
        channels: ["sms", "email"],
        lastEmailAt: "2026-09-12T10:00:00.000Z",
        emailCount: 1,
      },
      messages: [{ kind: "sms", occurredAt: "2026-09-13T10:00:00.000Z" }],
    } as unknown as ConversationDetail;
    expect(activeConversationTab({}, textLast)).toBe("sms");

    // An explicit tab always wins over the inference.
    expect(activeConversationTab({ tab: "sms" }, conv({ channels: ["email"] }))).toBe("sms");
  });

  it("the counts are real: texts are counted, system lines are not, email comes from the summary", () => {
    const detail = {
      messages: [{ kind: "sms" }, { kind: "sms" }, { kind: "system" }],
      summary: { emailCount: 3 },
    } as unknown as ConversationDetail;
    expect(tabCounts(detail)).toEqual({ sms: 2, email: 3 });
    expect(tabCounts(null)).toEqual({ sms: 0, email: 0 });
  });
});
