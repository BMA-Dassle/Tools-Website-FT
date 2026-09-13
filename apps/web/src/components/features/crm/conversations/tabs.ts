import type { ComponentType } from "react";
import type { ConversationDetail } from "~/features/crm/sms/types";

/**
 * THE CONVERSATION TAB REGISTRY (`conv-tabs`, crm-shared.js:326).
 *
 * One entry per PERSON, two tabs: Text and Email. Same shape as the deal's
 * `tabs.ts` and for the same reason — C2 flips EXACTLY ITS OWN LINE (`email`)
 * to its `conversations/email` components, and the two PRs cannot conflict.
 *
 * The counts in the tab labels come from the loaded conversation, so "Email 0"
 * is a real zero rather than a placeholder: there is no email rail yet, and the
 * panel says so in one sentence instead of pretending.
 */

export const CONVERSATION_TAB_IDS = ["sms", "email"] as const;

export type ConversationTabId = (typeof CONVERSATION_TAB_IDS)[number];

/** Prototype labels, verbatim (crm-shared.js:326). */
export const CONVERSATION_TAB_LABEL: Record<ConversationTabId, string> = {
  sms: "Text",
  email: "Email",
};

export interface ConversationTabProps {
  detail: ConversationDetail;
  /** Re-fetch after a send or a read. */
  refresh: () => void;
}

export type ConversationTabComponent = ComponentType<ConversationTabProps>;

export type ConversationTabLoader = () => Promise<{ default: ConversationTabComponent }>;

export const CONVERSATION_TABS: Record<ConversationTabId, ConversationTabLoader> = {
  sms: () => import("./ThreadView"),
  email: () => import("./EmailComingLater"),
};

/** Which PR owns each line next — documentation, not behaviour. */
export const CONVERSATION_TAB_OWNER: Record<ConversationTabId, "C1" | "C2"> = {
  sms: "C1",
  email: "C2",
};

export function isConversationTabId(value: unknown): value is ConversationTabId {
  return typeof value === "string" && (CONVERSATION_TAB_IDS as readonly string[]).includes(value);
}

/** The tab a URL asks for, else Text. */
export function activeConversationTab(query: Record<string, string>): ConversationTabId {
  return isConversationTabId(query.tab) ? query.tab : "sms";
}

/** The count each tab shows (`<span class="n">`). */
export function tabCounts(detail: ConversationDetail | null): Record<ConversationTabId, number> {
  return {
    sms: detail ? detail.messages.filter((m) => m.kind === "sms").length : 0,
    email: 0,
  };
}
