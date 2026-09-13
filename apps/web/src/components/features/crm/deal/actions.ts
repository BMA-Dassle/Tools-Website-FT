import {
  IconMail,
  IconMessage,
  IconNote,
  IconPhone,
  IconZzz,
  type TablerIcon,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import { ACTIVITY_TEST_IDS } from "~/features/crm/activities/contracts";
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
 *              and is honest about what exists.
 *   B4 (done)  `note` → the Note sheet, `snooze` → the Snooze sheet. Both are
 *              in-app sheets, so they are `{kind:"sheet"}` targets with a key
 *              in `QUICK_ACTION_SHEETS` — one line each, exactly as this
 *              registry was built for, and no second dispatch mechanism.
 *   C1         `text` → the rep's Vox DID composer (`sms/service/send.ts`).
 *   C2         `email` → the Graph composer.
 *   C3         `call` → 3CX click-to-dial on the rep's extension.
 *
 * `resolve` returning null disables the button and shows `disabledTitle`; a
 * slot never silently does nothing.
 *
 * A SLOT HAS TWO WAYS TO ACT, and this file is where they are declared so the
 * four PRs above never have to touch `QuickActions.tsx`. `{kind:"href"}` hands
 * the lead to the device; `{kind:"sheet"}` opens the slot's own sheet INSIDE
 * the CRM, which is what every real rail needs — a `mailto:` or `sms:` send
 * never reaches Neon, never records first touch and never carries the header
 * a reply is matched by. The sheet itself is registered in
 * `QUICK_ACTION_SHEETS` and lazily loaded, so a PR ships its rail by adding
 * ONE key here and ONE `resolve` line, and two PRs building in parallel do not
 * collide. B4 is the first to land two; the other three keys are still free.
 */

export const QUICK_ACTION_IDS = ["call", "text", "email", "note", "snooze"] as const;

export type QuickActionId = (typeof QUICK_ACTION_IDS)[number];

/**
 * What pressing the button does: hand the lead to the device (`tel:` / `sms:`
 * / `mailto:`), or open the slot's own sheet inside the CRM.
 */
export type QuickActionTarget =
  | { kind: "href"; href: string }
  | { kind: "sheet"; id: QuickActionId };

/** Props every quick-action sheet receives from `QuickActions`. */
export interface QuickActionSheetProps {
  lead: LeadView;
  onCancel: () => void;
  onDone: () => void;
}

/**
 * The sheet behind a `{kind:"sheet"}` target. Lazily loaded so a screen that
 * never opens one pays nothing, and so the registry itself stays a pure module
 * its unit test can import without React.
 */
export interface QuickActionSheetSlot {
  title: (lead: LeadView) => string;
  wide: boolean;
  testId?: string;
  load: () => Promise<{ default: ComponentType<QuickActionSheetProps> }>;
}

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

/**
 * This slot opens its own sheet; the lead never leaves the CRM.
 *
 * (A slot with nothing wired yet returns null from `resolve` and renders
 * disabled with its `disabledTitle` — C1/C2/C3 replace `href(...)` with their
 * own `ownSheet(...)` when their composer lands.)
 */
const ownSheet = (id: QuickActionId) => (): QuickActionTarget => ({ kind: "sheet", id });

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
    resolve: ownSheet("note"),
    // Never reached — a note needs nothing from the guest's record — but the
    // slot keeps a reason so the shape stays uniform and the test can pin it.
    disabledTitle: "Notes are unavailable on this lead",
    owner: "B4",
  },
  snooze: {
    id: "snooze",
    label: "Snooze",
    Icon: IconZzz,
    resolve: ownSheet("snooze"),
    disabledTitle: "This lead has no follow-up to move",
    owner: "B4",
  },
};

/**
 * The sheets a `{kind:"sheet"}` target opens. C1 (`text`), C2 (`email`) and
 * C3 (`call`) each add exactly their own key, in their own PR, on their own
 * line; B4's two are below.
 *
 * The titles are the prototype's (crm-shared.js:276, :278). The test ids come
 * from `activities/contracts.ts`, so the sheet a Playwright run looks for and
 * the sheet the timeline writes to are named by the same constant.
 */
export const QUICK_ACTION_SHEETS: Partial<Record<QuickActionId, QuickActionSheetSlot>> = {
  note: {
    title: () => "Add note",
    wide: false,
    testId: ACTIVITY_TEST_IDS.noteSheet,
    load: () => import("./NoteSheet"),
  },
  snooze: {
    title: () => "Snooze follow-up",
    wide: false,
    testId: ACTIVITY_TEST_IDS.snoozeSheet,
    load: () => import("./SnoozeSheet"),
  },
};

export function sheetSlotFor(id: QuickActionId): QuickActionSheetSlot | null {
  return QUICK_ACTION_SHEETS[id] ?? null;
}

/** The rail, in the prototype's order, with each slot resolved for this lead. */
export function quickActionsFor(
  lead: LeadView,
): { slot: QuickActionSlot; target: QuickActionTarget | null }[] {
  return QUICK_ACTION_IDS.map((id) => {
    const slot = QUICK_ACTIONS[id];
    return { slot, target: slot.resolve(lead) };
  });
}
