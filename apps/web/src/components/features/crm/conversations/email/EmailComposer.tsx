"use client";

import { IconSend } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import {
  GRAPH_COMPOSER_FOOTNOTE,
  SENDGRID_FALLBACK_CHIP,
  EMAIL_TEST_IDS,
  type EmailSendResponse,
  type EmailSenderView,
  type EmailTemplateView,
} from "~/features/crm/email/contracts";
import { emailKeys } from "~/features/crm/email/queries";
import { leadsKeys } from "~/features/crm/leads/queries";
import type { LeadView } from "~/features/crm/leads/contracts";
import { errorMessage } from "../../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../../lib/use-crm-user";
import { Banner } from "../../primitives/Banner";
import { Chip } from "../../primitives/Chip";
import { ICON } from "../../primitives/icon-props";
import { postEmail } from "./queries";

/**
 * The composer, field for field from the prototype's email sheet
 * (crm-shared.js:267-274): From · To · Template · Subject · Body · the Graph
 * footnote · Cancel / Send.
 *
 * Two honest departures from the mock, both because the real rail exists:
 *   - the CC line appears when the acting user is working the Guest Services
 *     bucket, because the owner's rule (§5.7b) CCs them on the shared
 *     mailbox's send. The mock had no bucket.
 *   - the footnote becomes `SENDGRID_FALLBACK_CHIP` when Graph is not
 *     configured, because "through Microsoft Graph" would not be true. The
 *     server decides (`sender.graph`); the composer only reports it.
 *
 * There is no attachment row: collateral attachments are C6's share links, and
 * a disabled paperclip that looks like it works is worse than no paperclip.
 */
export interface EmailComposerProps {
  lead: LeadView;
  sender: EmailSenderView;
  to: string[];
  templates: readonly EmailTemplateView[];
  /** Pre-filled subject (a Reply passes `RE: …`). */
  initialSubject?: string;
  onCancel: () => void;
  onSent: (result: EmailSendResponse) => void;
}

export function EmailComposer({
  lead,
  sender,
  to,
  templates,
  initialSubject,
  onCancel,
  onSent,
}: EmailComposerProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const id = useId();

  // The prototype opens on T-4 ("First-touch email with pricing"), the first
  // email template; `templates` arrives in `position` order already merged.
  const first = templates[0] ?? null;
  const [templateId, setTemplateId] = useState<string>(first?.id ?? "");
  const [subject, setSubject] = useState<string>(initialSubject ?? first?.subject ?? "");
  const [body, setBody] = useState<string>(first?.body ?? "");

  const pickTemplate = (value: string) => {
    setTemplateId(value);
    const t = templates.find((x) => x.id === value);
    if (!t) return;
    setSubject(t.subject);
    setBody(t.body);
  };

  const send = useMutation({
    mutationFn: () =>
      postEmail(crmFetch, {
        leadId: lead.publicId,
        subject: subject.trim(),
        body,
        templateId: templateId || null,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: emailKeys.all });
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      // Prototype toast (crm-shared.js:275) when it really did go out from the
      // rep's mailbox; the fallback says what actually happened instead.
      if (r.fellBack) toast(SENDGRID_FALLBACK_CHIP, "warn");
      else toast("Email sent from your Outlook");
      onSent(r);
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const recipients = to.length > 0 ? to : lead.guest.email ? [lead.guest.email] : [];
  const canSend = subject.trim().length > 0 && body.trim().length > 0 && recipients.length > 0;

  return (
    <div className="stack" data-testid={EMAIL_TEST_IDS.composer}>
      <dl className="kv">
        <dt>From</dt>
        <dd>
          {sender.mailbox} {sender.graph ? "(your Outlook)" : null}
        </dd>
        <dt>To</dt>
        <dd>{recipients.join(", ") || "—"}</dd>
        {sender.cc.length > 0 ? (
          <>
            <dt>Cc</dt>
            <dd>{sender.cc.join(", ")}</dd>
          </>
        ) : null}
      </dl>

      {recipients.length === 0 ? (
        <Banner tone="warn">
          No email on file for {lead.guest.first || "this guest"} — add one on the deal first.
        </Banner>
      ) : null}

      <div className="field">
        <label htmlFor={`${id}-tpl`}>Template</label>
        <select
          id={`${id}-tpl`}
          className="select"
          value={templateId}
          onChange={(e) => pickTemplate(e.target.value)}
        >
          <option value="">(no template)</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor={`${id}-subject`}>Subject</label>
        <input
          id={`${id}-subject`}
          className="input"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor={`${id}-body`}>Body</label>
        <textarea
          id={`${id}-body`}
          className="textarea"
          rows={6}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>

      {sender.graph ? (
        <div className="muted xs">{GRAPH_COMPOSER_FOOTNOTE}</div>
      ) : (
        <div className="stack" style={{ gap: 4 }} data-testid={EMAIL_TEST_IDS.fallbackChip}>
          <Chip kind="open">{SENDGRID_FALLBACK_CHIP}</Chip>
          {/* The reason, so a director knows exactly what to fix rather than
              filing a "email looks wrong" ticket. */}
          {sender.graphReason ? <div className="muted xs">{sender.graphReason}</div> : null}
        </div>
      )}

      <div className="hstack" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel} disabled={send.isPending}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSend || send.isPending}
          onClick={() => send.mutate()}
        >
          <IconSend {...ICON} /> {send.isPending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

export default EmailComposer;
