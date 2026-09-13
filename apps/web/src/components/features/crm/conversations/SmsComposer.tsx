"use client";

import { IconSend } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { smsKeys } from "~/features/crm/sms/queries";
import { SMS_TEST_IDS } from "~/features/crm/sms/types";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { ICON } from "../primitives/icon-props";
import { TemplatePicker } from "./TemplatePicker";
import { postSend } from "./queries";
import type { ConversationTabProps } from "./tabs";
import { SENT_TOAST, composerPlaceholder, sendErrorMessage } from "./model";

/**
 * The composer (`crm-shared.js:331`): the template strip, the textarea and
 * Send.
 *
 * CLOSED RATHER THAN OPTIMISTIC. When `consent.allowed` is false the textarea
 * and the button are disabled and the banner above says why — the service
 * would refuse anyway, and a rep who types a paragraph into a box that then
 * rejects it has been lied to by the screen. Today that means EVERY rep sees
 * the "no texting number" state, because no DID has been provisioned yet
 * (owner item D5): the composer says the sentence the service answers with,
 * not a guess.
 *
 * A send that comes back `ok:false` keeps the draft in the box. The text was
 * never sent, so throwing it away would be the one unrecoverable outcome.
 */
export function SmsComposer({ detail, refresh }: ConversationTabProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");

  const send = useMutation({
    mutationFn: (body: string) =>
      postSend(crmFetch, detail.summary.key, { body, leadId: detail.lead?.id ?? null }),
    onSuccess: (res) => {
      if (res.result.ok) {
        setDraft("");
        toast(SENT_TOAST);
      } else {
        toast(sendErrorMessage(res.result.error), "warn");
      }
      void qc.invalidateQueries({ queryKey: smsKeys.all });
      refresh();
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const blocked = !detail.consent.allowed;
  const disabled = blocked || send.isPending;
  const canSend = !disabled && draft.trim().length > 0;

  return (
    <>
      <TemplatePicker
        conversationKey={detail.summary.key}
        disabled={blocked}
        onPick={(text) => setDraft(text)}
      />
      <div className="composer" data-testid={SMS_TEST_IDS.composer}>
        <textarea
          aria-label="Message"
          value={draft}
          disabled={disabled}
          placeholder={composerPlaceholder(detail.contact?.firstName ?? null, detail.myDid)}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary btn-icon"
          aria-label="Send"
          disabled={!canSend}
          onClick={() => send.mutate(draft.trim())}
        >
          <IconSend {...ICON} />
        </button>
      </div>
    </>
  );
}
