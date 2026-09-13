/**
 * Screen id → lazy component (brief §3.5).
 *
 * PRE-POPULATED FOR EVERY ID so the shell renders on day one and no later PR
 * adds a key: a feature PR replaces EXACTLY ITS OWN LINE with
 * `() => import("~/components/features/crm/<sub>/<Screen>")` and nothing else
 * in this file. `CrmApp` resolves `view[0] ?? "today"` here through
 * `React.lazy`; an unknown id is an in-app NotFound, never Next's 404.
 *
 * Kept as one arrow per line on purpose (no shared `notBuilt` constant), so a
 * feature PR's diff is a one-line replacement that cannot conflict with
 * another PR's one-line replacement.
 */

import type { ComponentType } from "react";
import type { ScreenId } from "./types";

/** What every screen component receives from the shell. */
export interface ScreenProps {
  screen: ScreenId;
  /** The URL segments after the screen id: `/deal/L-7` → `["L-7"]`. */
  view: string[];
  /** The query string at mount time (first value per key). */
  query: Record<string, string>;
}

export type ScreenComponent = ComponentType<ScreenProps>;

export type ScreenLoader = () => Promise<{ default: ScreenComponent }>;

export const SCREENS: Record<ScreenId, ScreenLoader> = {
  today: () => import("~/components/features/crm/today/MyDayScreen"),
  pipeline: () => import("~/components/features/crm/shell/NotBuiltYet"),
  queue: () => import("~/components/features/crm/queue/QueueScreen"),
  deal: () => import("~/components/features/crm/deal/DealScreen"),
  contracts: () => import("~/components/features/crm/contracts/ContractsScreen"),
  events: () => import("~/components/features/crm/events/EventsScreen"),
  conversations: () => import("~/components/features/crm/conversations/ConversationsScreen"),
  calls: () => import("~/components/features/crm/calls/CallsScreen"),
  history: () => import("~/components/features/crm/history/HistoryScreen"),
  account: () => import("~/components/features/crm/history/AccountScreen"),
  cold: () => import("~/components/features/crm/shell/NotBuiltYet"),
  collateral: () => import("~/components/features/crm/collateral/CollateralScreen"),
  accountability: () => import("~/components/features/crm/shell/NotBuiltYet"),
  kpi: () => import("~/components/features/crm/shell/NotBuiltYet"),
  goals: () => import("~/components/features/crm/shell/NotBuiltYet"),
  rules: () => import("~/components/features/crm/rules/RulesScreen"),
  statuses: () => import("~/components/features/crm/statuses/StatusesScreen"),
  availability: () => import("~/components/features/crm/availability/AvailabilityScreen"),
  builder: () => import("~/components/features/crm/shell/NotBuiltYet"),
  more: () => import("~/components/features/crm/shell/NotBuiltYet"),
};
