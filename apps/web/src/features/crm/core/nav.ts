/**
 * The COMPLETE navigation, ported from `direction-b.html:51-57,121` (brief §3.5).
 *
 * Pure data: no React, no icons. `icon` is a semantic key the shell maps to a
 * `@tabler/icons-react` component; `badge` names a provider the shell resolves
 * (PR1 ships no providers, so every badge renders empty).
 *
 * `ready` is the ONLY field a feature PR edits, and only on its own line: PR1
 * sets `ready: true` for `statuses` alone (the one screen it builds a body for)
 * and `ready: false` everywhere else — the shell renders `NotBuiltYet` for
 * those. The prototype's `leads` route is `pipeline`
 * here (the URL scheme in §3.1); `goals` is reached from KPI and the phone
 * "More" list, not from the sidebar, exactly as in the prototype.
 */

import { ADMIN_NAV_GROUP_ID, DIRECTOR_ONLY_SCREENS } from "./contracts";
import type { CrmRole, ScreenId } from "./types";
import { SCREEN_IDS } from "./types";

export type NavIcon =
  | "home"
  | "kanban"
  | "bolt"
  | "file"
  | "calendar"
  | "message"
  | "phone"
  | "history"
  | "list"
  | "target"
  | "chart"
  | "settings"
  | "dots"
  | "logout";

export type BadgeKey = "overdue" | "unassigned" | "pendingApproval" | "unread";

export interface NavItem {
  id: ScreenId;
  label: string;
  icon: NavIcon;
  /** Director-only: hidden for reps in the sidebar, and `NotForRole` if typed. */
  director?: boolean;
  badge?: BadgeKey;
  /** A feature PR flips ITS line to true when its screen ships. */
  ready: boolean;
}

export type NavGroupId = "main" | "grow" | "measure" | typeof ADMIN_NAV_GROUP_ID;

export interface NavGroup {
  id: NavGroupId;
  /** null = the unlabelled first group. */
  label: string | null;
  items: NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "main",
    label: null,
    items: [
      { id: "today", label: "My Day", icon: "home", badge: "overdue", ready: true },
      { id: "pipeline", label: "Pipeline", icon: "kanban", ready: false },
      {
        id: "queue",
        label: "Lead queue",
        icon: "bolt",
        director: true,
        badge: "unassigned",
        ready: true,
      },
      { id: "contracts", label: "Contracts", icon: "file", badge: "pendingApproval", ready: false },
      { id: "events", label: "Events", icon: "calendar", ready: false },
      {
        id: "conversations",
        label: "Conversations",
        icon: "message",
        badge: "unread",
        ready: true,
      },
      { id: "calls", label: "Calls", icon: "phone", ready: false },
    ],
  },
  {
    id: "grow",
    label: "Find & grow",
    items: [
      { id: "history", label: "History & accounts", icon: "history", ready: true },
      { id: "cold", label: "Cold lists", icon: "list", ready: false },
      { id: "collateral", label: "Collateral", icon: "file", ready: false },
    ],
  },
  {
    id: "measure",
    label: "Measure",
    items: [
      { id: "accountability", label: "Accountability", icon: "target", ready: false },
      { id: "kpi", label: "KPI dashboard", icon: "chart", ready: false },
    ],
  },
  {
    id: ADMIN_NAV_GROUP_ID,
    label: "Admin",
    items: [
      { id: "rules", label: "Assignment rules", icon: "bolt", director: true, ready: true },
      { id: "statuses", label: "Statuses & BMI", icon: "settings", director: true, ready: true },
    ],
  },
];

/** The phone's bottom tabs (`direction-b.html:57`). */
export const PHONE_TABS: readonly NavItem[] = [
  { id: "today", label: "My Day", icon: "home", badge: "overdue", ready: true },
  { id: "pipeline", label: "Pipeline", icon: "kanban", ready: false },
  { id: "contracts", label: "Contracts", icon: "file", ready: false },
  { id: "conversations", label: "Messages", icon: "message", ready: true },
  { id: "more", label: "More", icon: "dots", ready: false },
];

/** The phone "More" list (`direction-b.html:121`), director items flagged. */
export const MORE_ITEMS: readonly NavItem[] = [
  { id: "queue", label: "Lead queue", icon: "bolt", director: true, ready: true },
  { id: "events", label: "Events", icon: "calendar", ready: false },
  { id: "calls", label: "Calls", icon: "phone", ready: false },
  { id: "history", label: "History & accounts", icon: "history", ready: true },
  { id: "cold", label: "Cold lists", icon: "list", ready: false },
  { id: "collateral", label: "Collateral & templates", icon: "file", ready: false },
  { id: "accountability", label: "Accountability", icon: "target", ready: false },
  { id: "kpi", label: "KPI dashboard", icon: "chart", ready: false },
  { id: "goals", label: "Goals", icon: "target", director: true, ready: false },
  { id: "rules", label: "Assignment rules (admin)", icon: "bolt", director: true, ready: true },
  {
    id: "statuses",
    label: "Statuses & BMI (admin)",
    icon: "settings",
    director: true,
    ready: true,
  },
];

export interface ScreenMeta {
  title: string;
  description: string;
}

/** Title + one-line description per screen — what `NotBuiltYet` shows. */
export const SCREEN_META: Record<ScreenId, ScreenMeta> = {
  today: {
    title: "My Day",
    description: "Overdue, due today and new leads — three columns, left to right.",
  },
  pipeline: {
    title: "Pipeline",
    description:
      "Our statuses are the columns. Drag a card to change status (writes the mapped BMI state).",
  },
  queue: {
    title: "Lead queue",
    description:
      "Drag a lead onto a rep, or tap Assign. Untouched leads auto-assign after 60 minutes using the rules.",
  },
  deal: {
    title: "Deal",
    description: "Overview, contract, notes, event, payments and history for one lead.",
  },
  contracts: {
    title: "Contracts",
    description:
      "Group-event contracts by event date · defaults to what needs a human · closed ones are archived",
  },
  events: {
    title: "Events",
    description:
      "Group events by day · BMI truth plus contract and payment state · the old Daily Events board",
  },
  conversations: {
    title: "Conversations",
    description: "Texts on your number · email from your Outlook",
  },
  calls: {
    title: "Calls",
    description: "Your 3CX extension, matched to leads automatically",
  },
  history: {
    title: "History & accounts",
    description: "Every event across centres and years, from the BMI mirror",
  },
  account: { title: "Account", description: "One business or household across every year." },
  cold: { title: "Cold lists", description: "Import a CSV, map the columns, dial down the list" },
  collateral: {
    title: "Collateral & templates",
    description:
      "Flyers, pricing and menus to share in one tap · quote templates for Build in BMI · message templates with merge fields",
  },
  accountability: {
    title: "Accountability",
    description: "Counts every logged call, text, email and last-year reach-out for the week",
  },
  kpi: {
    title: "KPI dashboard",
    description: "Booked + quoted, conversion and pacing by month and salesperson.",
  },
  goals: {
    title: "Goals",
    description:
      "Monthly booked-revenue goal per salesperson · last year's actual shown beside each month.",
  },
  rules: {
    title: "Assignment rules",
    description: "Evaluated top to bottom for every new lead · the hourly sweep uses the same list",
  },
  statuses: {
    title: "Statuses",
    description:
      "Our pipeline on top of BMI. Each of our statuses writes one BMI state per centre.",
  },
  availability: {
    title: "Availability",
    description: "Lane and heat availability for a lead's date and size.",
  },
  builder: {
    title: "Build in BMI",
    description: "Products, prices, lanes and heats written to the Office project.",
  },
  more: { title: "More", description: "Everything that is not on the bottom tabs." },
};

export function isScreenId(value: unknown): value is ScreenId {
  return typeof value === "string" && (SCREEN_IDS as readonly string[]).includes(value);
}

export function isDirectorOnlyScreen(id: ScreenId): boolean {
  return DIRECTOR_ONLY_SCREENS.includes(id);
}

/** May this role open this screen? Reps are refused the director-only set. */
export function canViewScreen(role: CrmRole, id: ScreenId): boolean {
  return role === "director" || !isDirectorOnlyScreen(id);
}

/** Sidebar groups for a role: director items dropped, empty groups dropped. */
export function navForRole(role: CrmRole): NavGroup[] {
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => !i.director || role === "director"),
  })).filter((g) => g.items.length > 0);
}

export function tabsForRole(role: CrmRole): NavItem[] {
  return PHONE_TABS.filter((t) => !t.director || role === "director");
}

export function moreForRole(role: CrmRole): NavItem[] {
  return MORE_ITEMS.filter((i) => !i.director || role === "director");
}

/** Every nav id, in sidebar order, once. */
export function allNavIds(): ScreenId[] {
  const seen = new Set<ScreenId>();
  for (const g of NAV_GROUPS) for (const i of g.items) seen.add(i.id);
  for (const t of PHONE_TABS) seen.add(t.id);
  for (const m of MORE_ITEMS) seen.add(m.id);
  return [...seen];
}
