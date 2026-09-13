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
import { CRM_BASE } from "~/features/crm/core/contracts";
import type { LeadView } from "~/features/crm/leads/contracts";
import { contactKey, phoneKey } from "~/features/crm/sms/keys";
import { leadName } from "../leads/model";

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
 *   C2 (done)  `email` → the Graph draft-then-send composer, opened as a
 *              SHEET rather than handing the guest to the device's mail app:
 *              a `mailto:` send never reaches Neon, never records first touch
 *              and never carries the `X-HP-Lead` header a reply is matched by.
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
 * collide.
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
 *   sheet   the slot's own sheet, opened inside the CRM over the drawer.
 */
export type QuickActionTarget =
  | { kind: "href"; href: string }
  | { kind: "route"; href: string }
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

// No `href(...)` factory any more. Every one of the five slots now resolves to
// a `route` (C1's Text) or a `sheet` (C2 Email, C3 Call, B4 Note and Snooze),
// so the device hand-off helper had no caller left and lint failed the build on
// it. `{kind:"href"}` REMAINS a target kind — `QuickActions` still navigates it
// with `location.assign`, and a slot that genuinely wants `tel:` or `mailto:`
// re-adds its own one-liner.

/** An in-app CRM path — navigated with the router, never a page load. */
const route = (value: string | null): QuickActionTarget | null =>
  value ? { kind: "route", href: value } : null;

/** This slot opens its `QUICK_ACTION_SHEETS` entry, when the lead can support it. */
const sheet = (id: QuickActionId, when: boolean): QuickActionTarget | null =>
  when ? { kind: "sheet", id } : null;

/**
 * This slot opens its own sheet; the lead never leaves the CRM.
 *
 * (A slot with nothing wired yet returns null from `resolve` and renders
 * disabled with its `disabledTitle` — C1/C2/C3 replace `href(...)` with their
 * own `ownSheet(...)` when their composer lands.)
 */
const ownSheet = (id: QuickActionId) => (): QuickActionTarget => ({ kind: "sheet", id });

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
    resolve: (lead) => sheet("call", Boolean(lead.guest.phone)),
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
    resolve: (lead) => (lead.guest.email ? { kind: "sheet", id: "email" } : null),
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
 * The sheets a `{kind:"sheet"}` target opens — ONE LINE PER SLOT, like
 * `core/screens.ts` and `deal/tabs.ts`, so a channel PR adds its own key and
 * nothing else in this file changes.
 *
 * A slot whose `resolve` returns `{kind:"sheet"}` with no entry here renders
 * disabled, which is a bug rather than a state, so `actions.test.ts` pins that
 * the two agree.
 *
 * The titles are the prototype's (crm-shared.js:267, :276, :278). B4's two
 * take their test ids from `activities/contracts.ts`, so the sheet a Playwright
 * run looks for and the sheet the timeline writes to are named by the same
 * constant.
 *
 * C1's `text` is deliberately NOT here: it is a `route` to the guest's
 * Conversations thread, so there is one composer, one consent check and one
 * place a text is recorded — not a second in-drawer composer beside it.
 */
export const QUICK_ACTION_SHEETS: Partial<Record<QuickActionId, QuickActionSheetSlot>> = {
  // C3: ring the guest on the rep's 3CX extension, then log what happened.
  call: {
    title: (lead) => `Calling ${leadName(lead)}`,
    wide: true,
    testId: "crm-deal-action-call",
    load: () => import("../calls/DealCallSheet"),
  },
  // Prototype title, verbatim (crm-shared.js:267 `Email ${l.guest.first}`).
  email: {
    title: (lead) => `Email ${lead.guest.first || "guest"}`,
    wide: true,
    testId: "crm-email-sheet",
    load: () => import("../conversations/email/EmailSheet"),
  },
  // B4: both are in-app sheets, one key each.
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
