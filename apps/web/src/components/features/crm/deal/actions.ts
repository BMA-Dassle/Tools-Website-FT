import {
  IconMail,
  IconMessage,
  IconNote,
  IconPhone,
  IconZzz,
  type TablerIcon,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import type { LeadView } from "~/features/crm/leads/contracts";
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
 * What pressing the button does.
 *
 * `href` is a device hand-off (`tel:` / `sms:` / `mailto:`) — the honest thing
 * to do while a channel has no CRM surface of its own. `sheet` opens the slot's
 * entry in `QUICK_ACTION_SHEETS` below, which is how a channel PR upgrades its
 * button without touching `QuickActions.tsx`: C3 did it for `call`, and C1 /
 * C2 / B4 each change one `resolve` line and add one `QUICK_ACTION_SHEETS`
 * line.
 */
export type QuickActionTarget = { kind: "href"; href: string } | { kind: "sheet" };

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

/** This slot opens its `QUICK_ACTION_SHEETS` entry, when the lead can support it. */
const sheet = (when: boolean): QuickActionTarget | null => (when ? { kind: "sheet" } : null);

/** Nothing is wired for this slot yet — the button renders disabled. */
const notWiredYet = (): null => null;

export const QUICK_ACTIONS: Record<QuickActionId, QuickActionSlot> = {
  call: {
    id: "call",
    label: "Call",
    Icon: IconPhone,
    resolve: (lead) => sheet(Boolean(lead.guest.phone)),
    disabledTitle: "No phone on file",
    owner: "C3",
  },
  text: {
    id: "text",
    label: "Text",
    Icon: IconMessage,
    resolve: (lead) => href(contactHrefs(lead).sms),
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

/** What a `{kind:"sheet"}` slot renders in the shell's root sheet. */
export interface QuickActionSheetProps {
  lead: LeadView;
  onDone: () => void;
}

export type QuickActionSheetLoader = () => Promise<{
  default: ComponentType<QuickActionSheetProps>;
}>;

/**
 * ONE LINE PER SLOT, like `core/screens.ts` and `deal/tabs.ts` — a channel PR
 * adds its own and nothing else in this file changes. A slot whose `resolve`
 * returns `{kind:"sheet"}` with no entry here renders disabled, which is a bug
 * rather than a state, so `actions.test.ts` pins that the two agree.
 */
export const QUICK_ACTION_SHEETS: Partial<Record<QuickActionId, QuickActionSheetLoader>> = {
  call: () => import("../calls/DealCallSheet"),
};

/** Title for the sheet a slot opens. */
export const QUICK_ACTION_SHEET_TITLE: Partial<Record<QuickActionId, (name: string) => string>> = {
  call: (name) => `Calling ${name}`,
};
