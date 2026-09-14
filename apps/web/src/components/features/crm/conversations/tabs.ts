import type { ComponentType } from "react";
import type { ConversationDetail } from "~/features/crm/sms/types";

/**
 * THE CONVERSATION TAB REGISTRY (`conv-tabs`, crm-shared.js:326).
 *
 * One entry per PERSON, two tabs: Text and Email. Same shape as the deal's
 * `tabs.ts` and for the same reason — C2 flips EXACTLY ITS OWN LINE (`email`)
 * to its `conversations/email` components, and the two PRs cannot conflict.
 *
 * The counts in the tab labels come from the loaded conversation, so a zero is
 * a real zero.
 *
 * The `email` line pointed at `EmailComingLater` — a placeholder written before
 * C2 and never flipped when C2 shipped — so a rep could email a guest from
 * their deal, see it in the Conversations list, open it, and be told the
 * feature did not exist yet (owner, 2026-09-14: "I sent an email from an event
 * why can't I send another via conversasions").
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
  email: () => import("./email/ConversationEmail"),
};

/** Which PR owns each line next — documentation, not behaviour. */
export const CONVERSATION_TAB_OWNER: Record<ConversationTabId, "C1" | "C2"> = {
  sms: "C1",
  email: "C2",
};

export function isConversationTabId(value: unknown): value is ConversationTabId {
  return typeof value === "string" && (CONVERSATION_TAB_IDS as readonly string[]).includes(value);
}

/**
 * The tab a URL asks for, else the channel this person actually uses.
 *
 * Owner, 2026-09-14: "if its email it should default to email. If its sms
 * should default to sms." Landing on Text for somebody who has only ever been
 * emailed shows an empty thread and a composer for a number we may not even
 * have — the conversation's own history is a better default than a constant.
 * An explicit `?tab=` always wins, so a rep who picks a tab keeps it.
 */
export function activeConversationTab(
  query: Record<string, string>,
  detail?: ConversationDetail | null,
): ConversationTabId {
  if (isConversationTabId(query.tab)) return query.tab;
  const channels = detail?.summary.channels ?? [];
  // Whichever spoke last. `lastEmailAt` is the email side's own stamp, so a
  // person with both lands on the one they used most recently.
  if (channels.includes("email") && !channels.includes("sms")) return "email";
  if (channels.includes("email") && detail?.summary.lastEmailAt) {
    const sms = detail.messages.filter((m) => m.kind === "sms").at(-1)?.occurredAt ?? null;
    if (!sms || detail.summary.lastEmailAt > sms) return "email";
  }
  return "sms";
}

/** The count each tab shows (`<span class="n">`). */
export function tabCounts(detail: ConversationDetail | null): Record<ConversationTabId, number> {
  return {
    sms: detail ? detail.messages.filter((m) => m.kind === "sms").length : 0,
    email: detail?.summary.emailCount ?? 0,
  };
}
