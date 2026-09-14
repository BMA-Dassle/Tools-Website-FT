"use client";

import { IconMail } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import Link from "next/link";
import { CRM_BASE } from "~/features/crm/core/contracts";
import { EMAIL_TEST_IDS, type EmailMessageView } from "~/features/crm/email/contracts";
import { EMAIL_POLL_MS, emailKeys } from "~/features/crm/email/queries";
import { leadsKeys } from "~/features/crm/leads/queries";
import { errorMessage } from "../../lib/crm-fetch";
import { useCrmFetch, useCrmUser } from "../../lib/use-crm-user";
import { fetchLead } from "../../leads/queries";
import { EmptyState, ErrorState, LoadingState } from "../../primitives/States";
import { ICON } from "../../primitives/icon-props";
import type { ConversationTabProps } from "../tabs";
import { EmailComposer } from "./EmailComposer";
import { EmailThread } from "./EmailThread";
import { fetchEmailContext } from "./queries";

/**
 * The Email half of a CONVERSATION — the same thread and composer the deal's
 * Email sheet uses, reached from the person rather than from the deal.
 *
 * This tab was `EmailComingLater`, a one-sentence placeholder saying email
 * "arrives with the Outlook rail" — written before C2 and never flipped when
 * C2 shipped. So a rep could email a guest from their deal, see the message in
 * the Conversations LIST, open it, and be told the feature did not exist yet.
 * Owner, 2026-09-14: "I sent an email from an event why can't I send another
 * via conversasions".
 *
 * EMAIL HANGS OFF A DEAL, and that is not an accident to paper over: the
 * templates merge a deal's fields, the thread is reconciled to a lead by
 * `internetMessageId`, and a message with no deal has nothing to file itself
 * against. A person we have never turned into a lead therefore gets a straight
 * answer and a way to fix it, rather than a composer that would fail on send.
 */
export default function ConversationEmail({ detail }: ConversationTabProps) {
  const crmFetch = useCrmFetch();
  const { initials, user } = useCrmUser();
  const [replySubject, setReplySubject] = useState<string | undefined>(undefined);
  const publicId = detail.lead?.publicId ?? null;

  const leadQ = useQuery({
    queryKey: leadsKeys.detail(publicId ?? ""),
    queryFn: () => fetchLead(crmFetch, publicId!),
    enabled: !!publicId,
  });
  const ctx = useQuery({
    queryKey: emailKeys.context(publicId ?? ""),
    queryFn: () => fetchEmailContext(crmFetch, publicId!),
    enabled: !!publicId,
    // A guest reply arrives by webhook while the tab is open. Foreground only
    // (§3.4) — a tab left open on a locked phone polls nothing.
    refetchInterval: EMAIL_POLL_MS,
    refetchIntervalInBackground: false,
  });

  if (!publicId) {
    return (
      <EmptyState icon={<IconMail {...ICON} />}>
        <div className="stack" style={{ gap: 8, alignItems: "center" }}>
          <div className="strong">No deal to attach email to</div>
          <div className="muted small" style={{ maxWidth: 420 }}>
            {detail.summary.name ? `${detail.summary.name} is` : "This person is"} not linked to a
            deal yet. Templates merge a deal&rsquo;s date, guests and centre, and a sent message
            files itself against the deal — so the deal comes first.
          </div>
          <Link className="btn btn-primary" href={`${CRM_BASE}/queue`}>
            Create a lead
          </Link>
        </div>
      </EmptyState>
    );
  }
  if (leadQ.isPending || ctx.isPending) return <LoadingState label="Loading this thread…" />;
  if (ctx.isError) {
    return <ErrorState message={errorMessage(ctx.error)} onRetry={() => void ctx.refetch()} />;
  }
  if (leadQ.isError || !leadQ.data) {
    return (
      <ErrorState
        message={leadQ.error ? errorMessage(leadQ.error) : "Could not load the deal."}
        onRetry={() => void leadQ.refetch()}
      />
    );
  }

  const lead = leadQ.data.lead;
  const { sender, to, templates, messages } = ctx.data;
  const reply = (msg: EmailMessageView) => {
    const subject = msg.subject ?? "";
    setReplySubject(/^re:/i.test(subject) ? subject : `RE: ${subject}`);
  };

  return (
    <div className="stack" data-testid={EMAIL_TEST_IDS.sheet}>
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
        onCancel={() => setReplySubject(undefined)}
        onSent={() => {
          setReplySubject(undefined);
          void ctx.refetch();
        }}
      />
    </div>
  );
}
