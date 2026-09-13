"use client";

import { IconMail } from "@tabler/icons-react";
import { ICON } from "../primitives/icon-props";
import { EmptyState } from "../primitives/States";
import type { ConversationTabProps } from "./tabs";

/**
 * The Email tab's placeholder. C2 replaces EXACTLY ITS OWN LINE in `tabs.ts`
 * (`email: () => import("./email/EmailThread")`) and this file goes away with
 * it; nothing else in the Conversations screen changes.
 *
 * It states what is true rather than drawing an empty inbox: there is no
 * Outlook rail yet, so "no email with Dana" would be a claim we cannot make.
 */
export default function EmailComingLater({ detail }: ConversationTabProps) {
  const who = detail.contact?.firstName?.trim();
  return (
    <div style={{ padding: 16 }}>
      <EmptyState icon={<IconMail {...ICON} />}>
        Email arrives with the Outlook rail. Until then, email {who ? who : "this guest"} from your
        own mailbox — it is not linked to this conversation yet.
      </EmptyState>
    </div>
  );
}
