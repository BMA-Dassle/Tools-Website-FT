"use client";

import { IconSend } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type CSSProperties } from "react";
import {
  GRAPH_COMPOSER_FOOTNOTE,
  SENDGRID_FALLBACK_CHIP,
  SEND_PENDING_CHIP,
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
import { composerFootnoteFor } from "./model";
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
 *
 * CANCEL / SEND STICK TO THE BOTTOM. The prototype puts them in the sheet's
 * `foot`, which the shell renders as a sticky bar — but the shell's sheet takes
 * ONE static spec, so a foot rendered up in `QuickActions` could not reach this
 * component's `subject`, `body` and `isPending`. Wiring a foot portal would
 * mean editing `crm-context.tsx` and `shell/Sheet.tsx`, which are PR1's. A
 * sticky row inside the body buys the same property — on a 390 px phone a rep
 * never scrolls past the thread and a six-row textarea to find Send — and
 * touches nothing outside this sub.
 */
/**
 * Module scope, never inside the render body (memory
 * `feedback_tdz_component_const_helpers`). `--ba-bg2` is the sheet's own
 * surface, so the bar reads as part of the sheet rather than floating over it.
 */
const STICKY_ACTIONS: CSSProperties = {
  justifyContent: "flex-end",
  position: "sticky",
  bottom: 0,
  background: "var(--ba-bg2)",
  paddingTop: 8,
  paddingBottom: 8,
  marginBottom: -8,
  borderTop: "1px solid var(--ba-border)",
  zIndex: 1,
};

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
  //
  // A REPLY IS NOT A FIRST TOUCH. `EmailSheet` remounts this component by key
  // with `initialSubject = "RE: …"`; opening that on the first-touch template's
  // BODY would put "Hi Dana, thanks for your enquiry…" under a reply subject.
  // A reply starts empty, with no template selected; picking one from the
  // select still fills both fields.
  const replying = Boolean(initialSubject);
  const first = replying ? null : (templates[0] ?? null);
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
      // rep's mailbox; the other two rails say what actually happened instead.
      if (r.sendPending) toast(SEND_PENDING_CHIP, "warn");
      else if (r.fellBack) toast(SENDGRID_FALLBACK_CHIP, "warn");
      else toast("Email sent from your Outlook");
      onSent(r);
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const recipients = to.length > 0 ? to : lead.guest.email ? [lead.guest.email] : [];
  const canSend = subject.trim().length > 0 && body.trim().length > 0 && recipients.length > 0;
  const footnote = composerFootnoteFor(sender, GRAPH_COMPOSER_FOOTNOTE);

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
        <div className="muted xs">{footnote}</div>
      ) : (
        <div className="stack" style={{ gap: 4 }} data-testid={EMAIL_TEST_IDS.fallbackChip}>
          <Chip kind="open">{footnote}</Chip>
          {/* The reason, so a director knows exactly what to fix rather than
              filing an "email looks wrong" ticket. It is a fixed sentence or a
              named missing permission — never an upstream body (C2-9). */}
          {sender.graphReason ? <div className="muted xs">{sender.graphReason}</div> : null}
        </div>
      )}

      <div className="hstack" style={STICKY_ACTIONS}>
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
