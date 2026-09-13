"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { EMAIL_TEST_IDS, type EmailMessageView } from "~/features/crm/email/contracts";
import { emailKeys } from "~/features/crm/email/queries";
import type { QuickActionSheetProps } from "../../deal/actions";
import { errorMessage } from "../../lib/crm-fetch";
import { useCrmFetch, useCrmUser } from "../../lib/use-crm-user";
import { ErrorState, LoadingState } from "../../primitives/States";
import { EmailComposer } from "./EmailComposer";
import { EmailThread } from "./EmailThread";
import { convFromLine } from "./model";
import { fetchEmailContext } from "./queries";

/**
 * The deal rail's Email sheet: this lead's mail, then the composer
 * (crm-shared.js:267 opens the composer; :327-328 is the thread it sits under).
 *
 * ONE read gives the composer everything it needs — sender, recipients,
 * templates merged for this lead, and the messages — so the sheet opens
 * without a waterfall. The quick-action registry loads this lazily, so the
 * deal page never pays for it until a rep presses Email.
 */
export default function EmailSheet({ lead, onCancel, onDone }: QuickActionSheetProps) {
  const crmFetch = useCrmFetch();
  const { initials, user } = useCrmUser();
  const [replySubject, setReplySubject] = useState<string | undefined>(undefined);

  const ctx = useQuery({
    queryKey: emailKeys.context(lead.publicId),
    queryFn: () => fetchEmailContext(crmFetch, lead.publicId),
  });

  if (ctx.isPending) return <LoadingState label="Loading this thread…" />;
  if (ctx.isError) {
    return <ErrorState message={errorMessage(ctx.error)} onRetry={() => void ctx.refetch()} />;
  }

  const { sender, to, templates, messages } = ctx.data;

  const reply = (msg: EmailMessageView) => {
    const subject = msg.subject ?? "";
    setReplySubject(/^re:/i.test(subject) ? subject : `RE: ${subject}`);
  };

  return (
    <div className="stack" data-testid={EMAIL_TEST_IDS.sheet}>
      <div className="conv-from xs muted">{convFromLine(lead, sender)}</div>
      <EmailThread
        lead={lead}
        sender={sender}
        messages={messages}
        repInitials={user.rep?.initials ?? initials}
        repSlug={sender.repSlug}
        onReply={reply}
      />
      <EmailComposer
        key={replySubject ?? "new"}
        lead={lead}
        sender={sender}
        to={to}
        templates={templates}
        initialSubject={replySubject}
        onCancel={onCancel}
        onSent={onDone}
      />
    </div>
  );
}
