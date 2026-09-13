"use client";

import { IconMail, IconMessage, IconNote, IconPhone, IconZzz } from "@tabler/icons-react";
import type { LeadView } from "~/features/crm/leads/contracts";
import { ICON } from "../primitives/icon-props";
import { contactHrefs } from "../leads/model";

/**
 * `quickActions(l)` (crm-shared.js:245): Call · Text · Email · Note · Snooze.
 * In B3 Call / Text / Email open the phone's dialer, messages and mail
 * (`tel:` / `sms:` / `mailto:`); C3 / C1 / C2 swap in 3CX, the rep's Vox DID
 * and Graph. Note and Snooze are B4's sheets — shown disabled, never faked.
 */
export function QuickActions({ lead }: { lead: LeadView }) {
  const h = contactHrefs(lead);
  const go = (href: string | null) => {
    if (href && typeof window !== "undefined") window.location.assign(href);
  };
  return (
    <div className="quick">
      <button
        type="button"
        disabled={!h.tel}
        onClick={() => go(h.tel)}
        title={h.tel ? undefined : "No phone on file"}
      >
        <IconPhone {...ICON} />
        Call
      </button>
      <button
        type="button"
        disabled={!h.sms}
        onClick={() => go(h.sms)}
        title={h.sms ? undefined : "No phone on file"}
      >
        <IconMessage {...ICON} />
        Text
      </button>
      <button
        type="button"
        disabled={!h.mailto}
        onClick={() => go(h.mailto)}
        title={h.mailto ? undefined : "No email on file"}
      >
        <IconMail {...ICON} />
        Email
      </button>
      <button type="button" disabled title="Arrives with the Pipeline PR">
        <IconNote {...ICON} />
        Note
      </button>
      <button type="button" disabled title="Arrives with the Pipeline PR">
        <IconZzz {...ICON} />
        Snooze
      </button>
    </div>
  );
}
