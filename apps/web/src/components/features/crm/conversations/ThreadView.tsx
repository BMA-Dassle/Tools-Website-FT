"use client";

import { IconAlertTriangle, IconMessage } from "@tabler/icons-react";
import { fStamp } from "~/features/crm/core/dates";
import { SMS_TEST_IDS, type SmsMessage } from "~/features/crm/sms/types";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";
import { EmptyState } from "../primitives/States";
import type { ConversationTabProps } from "./tabs";
import { refusalMessage } from "./model";
import { SmsComposer } from "./SmsComposer";

/**
 * The Text tab (`threadBody`, crm-shared.js:322-331): the bubbles, the template
 * strip and the composer.
 *
 * A `system` message — "Guest texted STOP to this number" — is drawn as a
 * centred line rather than a bubble, because nobody said it. It is the only
 * thing that explains why the composer below is closed, so it must be visible
 * in the thread and not only in a banner.
 *
 * `sendStatus` is shown on the bubble when it is not plain "sent": a failed
 * text says so, a suppressed one says so, and a text that went out from the
 * A2P number because Vox rejected the rep's DID says THAT — the flag
 * `lib/sms-retry.ts` never used to report (`sentFrom`, added by this PR).
 */
export default function ThreadView({ detail, refresh }: ConversationTabProps) {
  const refusal = refusalMessage(detail.consent.refusal);

  return (
    <div
      data-testid={SMS_TEST_IDS.threadView}
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
    >
      <div className="thread" style={{ flex: 1, overflow: "auto" }}>
        {detail.messages.length === 0 ? (
          <EmptyState icon={<IconMessage {...ICON} />}>
            No texts yet. Start with a template below.
          </EmptyState>
        ) : (
          detail.messages.map((m) => <MessageRow key={m.id} message={m} />)
        )}
      </div>

      {refusal ? (
        <div style={{ padding: "0 16px" }}>
          <Banner
            tone={detail.consent.refusal === "stopped" ? "crit" : "warn"}
            icon={<IconAlertTriangle {...ICON} />}
            testId={
              detail.consent.refusal === "no_did" ? SMS_TEST_IDS.noDid : SMS_TEST_IDS.noConsent
            }
          >
            {refusal}
          </Banner>
        </div>
      ) : null}

      <SmsComposer detail={detail} refresh={refresh} />
    </div>
  );
}

function MessageRow({ message }: { message: SmsMessage }) {
  if (message.kind === "system") {
    return (
      <>
        <div className="stamp">{fStamp(message.occurredAt)}</div>
        <div className="stamp" style={{ color: "var(--crit-ink, var(--muted))" }}>
          {message.body}
        </div>
      </>
    );
  }
  return (
    <>
      <div className="stamp">{fStamp(message.occurredAt)}</div>
      <div className={`msg ${message.direction}`}>
        <div className={`bubble ${message.direction}`}>
          {message.body}
          {statusNote(message) ? (
            <div className="xs muted" style={{ marginTop: 4 }}>
              {statusNote(message)}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

/** What a bubble adds under the text when something is worth saying. */
export function statusNote(m: SmsMessage): string | null {
  if (m.direction === "in") return null;
  if (m.sendStatus === "failed") {
    return m.deliveryError ? `Not delivered — ${m.deliveryError}` : "Not delivered — retry queued";
  }
  if (m.sendStatus === "suppressed") return "Blocked — this number has opted out";
  if (m.sendStatus === "pending") return "Sending…";
  if (m.fallbackDid && m.sentFrom) {
    return `Sent from ${m.sentFrom} — your own number was rejected`;
  }
  if (m.fallbackDid) {
    // Vox was quota'd and Twilio carried it. Twilio picks its own sender, so we
    // were never told which number the guest saw — and their reply goes to a
    // number with no MO webhook into the CRM. Say so; a silent bubble here
    // would have the rep waiting for an answer that can never arrive.
    return "Sent by the backup carrier — not from your number; a reply will not reach this thread";
  }
  if (m.deliveryStatus && m.deliveryStatus !== "delivered" && m.deliveryStatus !== "sent") {
    return `Carrier says ${m.deliveryStatus}`;
  }
  return null;
}
