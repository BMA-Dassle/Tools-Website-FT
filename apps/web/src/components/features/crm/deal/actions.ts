import {
  IconMail,
  IconMessage,
  IconNote,
  IconPhone,
  IconZzz,
  type TablerIcon,
} from "@tabler/icons-react";
import { CRM_BASE } from "~/features/crm/core/contracts";
import type { LeadView } from "~/features/crm/leads/contracts";
import { contactKey, phoneKey } from "~/features/crm/sms/keys";
import { contactHrefs } from "../leads/model";

/**
 * THE QUICK-ACTIONS SLOT REGISTRY — the deal's action rail
 * (`quickActions(l)`, crm-shared.js:245: Call · Text · Email · Note · Snooze).
 *
 * Same shape as `tabs.ts` and for the same reason: every rail button is a
 * named slot, pre-populated here, so a later PR flips EXACTLY ITS OWN LINE and
 * two PRs building in parallel cannot conflict.
 *
 *   B3 (here)  Call / Text / Email hand the lead to the device — `tel:`,
 *              `sms:`, `mailto:` — which is what a rep on a phone wants today
 *              and is honest about what exists. Note and Snooze are DISABLED
 *              with the reason, never faked.
 *   B4         `note` → the Note sheet, `snooze` → the Snooze sheet.
 *   C1         `text` → the rep's Vox DID composer (`sms/service/send.ts`).
 *   C2         `email` → the Graph draft-then-send composer.
 *   C3         `call` → 3CX click-to-dial on the rep's extension.
 *
 * `resolve` returning null disables the button and shows `disabledTitle`; a
 * slot never silently does nothing.
 */

export const QUICK_ACTION_IDS = ["call", "text", "email", "note", "snooze"] as const;

export type QuickActionId = (typeof QUICK_ACTION_IDS)[number];

/**
 * What pressing the button does, and HOW to go there:
 *
 *   href    a device hand-off — `tel:` / `sms:` / `mailto:`. The browser hands
 *           it to the dialer or mail client; `window.location.assign` is right.
 *   route   a CRM path. Must go through the router: a `location.assign` to an
 *           in-app URL throws away the TanStack cache, re-mints the admin API
 *           token, re-runs the SSO gate and re-mounts the whole shell — and on
 *           a phone the rep loses the drawer they were standing in.
 */
export type QuickActionTarget = { kind: "href" | "route"; href: string };

export interface QuickActionSlot {
  id: QuickActionId;
  /** Prototype copy, verbatim. */
  label: string;
  Icon: TablerIcon;
  /** The target for this lead, or null to disable the button. */
  resolve: (lead: LeadView) => QuickActionTarget | null;
  /** Why the button is disabled — the prototype has no such state; we do. */
  disabledTitle: string;
  /** The PR that owns this line next. Documentation, not behaviour. */
  owner: "B3" | "B4" | "C1" | "C2" | "C3";
}

const href = (value: string | null): QuickActionTarget | null =>
  value ? { kind: "href", href: value } : null;

/** An in-app CRM path — navigated with the router, never a page load. */
const route = (value: string | null): QuickActionTarget | null =>
  value ? { kind: "route", href: value } : null;

/** Nothing is wired for this slot yet — the button renders disabled. */
const notWiredYet = (): null => null;

/**
 * THE CONVERSATION THIS DEAL'S GUEST IS: the contact key when we know who they
 * are, the number otherwise — the same rule `foldConversations` uses to key the
 * list (`threads.ts`), so the row is actually highlighted when the rep lands.
 */
export function conversationKeyFor(lead: LeadView): string | null {
  // No number, no conversation: the button stays disabled with "No phone on
  // file" rather than opening a thread whose composer would refuse anyway.
  if (!lead.guest.phone) return null;
  const key = lead.contactId ? contactKey(lead.contactId) : phoneKey(lead.guest.phone);
  return `${CRM_BASE}/conversations/${key}`;
}

export const QUICK_ACTIONS: Record<QuickActionId, QuickActionSlot> = {
  call: {
    id: "call",
    label: "Call",
    Icon: IconPhone,
    resolve: (lead) => href(contactHrefs(lead).tel),
    disabledTitle: "No phone on file",
    owner: "C3",
  },
  text: {
    id: "text",
    label: "Text",
    Icon: IconMessage,
    // C1: the rep's own DID composer, which is the Conversations thread for
    // this person — one composer, one consent check, one place the text is
    // recorded. Deliberately NOT a second in-drawer composer: two of them
    // would be two chances to send a text the other one has not logged.
    //
    // A `route`, not an `href`: this is a CRM path, and the list keys a known
    // contact as `c-<id>` — so prefer the contact key the deal already knows,
    // or the same conversation ends up with two URLs and the row the rep
    // arrived at is never the highlighted one.
    resolve: (lead) => route(conversationKeyFor(lead)),
    disabledTitle: "No phone on file",
    owner: "C1",
  },
  email: {
    id: "email",
    label: "Email",
    Icon: IconMail,
    resolve: (lead) => href(contactHrefs(lead).mailto),
    disabledTitle: "No email on file",
    owner: "C2",
  },
  note: {
    id: "note",
    label: "Note",
    Icon: IconNote,
    resolve: notWiredYet,
    disabledTitle: "Arrives with the Pipeline PR",
    owner: "B4",
  },
  snooze: {
    id: "snooze",
    label: "Snooze",
    Icon: IconZzz,
    resolve: notWiredYet,
    disabledTitle: "Arrives with the Pipeline PR",
    owner: "B4",
  },
};

/** The rail, in the prototype's order, with each slot resolved for this lead. */
export function quickActionsFor(
  lead: LeadView,
): { slot: QuickActionSlot; target: QuickActionTarget | null }[] {
  return QUICK_ACTION_IDS.map((id) => {
    const slot = QUICK_ACTIONS[id];
    return { slot, target: slot.resolve(lead) };
  });
}
