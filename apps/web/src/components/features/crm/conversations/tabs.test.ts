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

  it("`sms` really loads the thread view; `email` is the placeholder C2 replaces", async () => {
    const sms = await CONVERSATION_TABS.sms();
    const email = await CONVERSATION_TABS.email();
    expect(typeof sms.default).toBe("function");
    expect(sms.default.name).toBe("ThreadView");
    expect(email.default.name).toBe("EmailComingLater");
  });

  it("the URL picks the tab; anything else is Text", () => {
    expect(activeConversationTab({ tab: "email" })).toBe("email");
    expect(activeConversationTab({ tab: "sms" })).toBe("sms");
    expect(activeConversationTab({})).toBe("sms");
    expect(activeConversationTab({ tab: "carrier-pigeon" })).toBe("sms");
    expect(isConversationTabId("email")).toBe(true);
    expect(isConversationTabId("post")).toBe(false);
  });

  it("the counts are real: texts are counted, system lines are not, email is a true zero", () => {
    const detail = {
      messages: [{ kind: "sms" }, { kind: "sms" }, { kind: "system" }],
    } as unknown as ConversationDetail;
    expect(tabCounts(detail)).toEqual({ sms: 2, email: 0 });
    expect(tabCounts(null)).toEqual({ sms: 0, email: 0 });
  });
});
