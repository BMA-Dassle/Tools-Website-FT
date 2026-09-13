import type { ComponentType } from "react";
import type { LeadDetailResponse } from "~/features/crm/leads/contracts";
import type { UrlQueryPatch } from "../lib/use-url-query";

/**
 * THE DEAL TAB REGISTRY (crm-events.js:71 `TABS`). `DealDrawer` and
 * `DealScreen` render the active tab through this map with `React.lazy`; the
 * active tab lives in the URL (`?tab=`).
 *
 * Pre-populated for EVERY id so a later PR flips ONE line: B5 points
 * `contract`, `payments` and `history` at its tabs, B6 `notes` and `event`.
 * Until then each id renders `TabComingLater` — the title and the
 * prototype's one-line description, `data-testid="crm-deal-tab-<id>"`.
 */
export const DEAL_TAB_IDS = [
  "overview",
  "contract",
  "notes",
  "event",
  "payments",
  "history",
] as const;

export type DealTabId = (typeof DEAL_TAB_IDS)[number];

export const DEAL_TAB_LABEL: Record<DealTabId, string> = {
  overview: "Overview",
  contract: "Contract",
  notes: "Notes",
  event: "Event",
  payments: "Payments",
  history: "History",
};

/** One line per tab, from the prototype's panels (crm-events.js:1-2, 80, 161, 177). */
export const DEAL_TAB_DESCRIPTION: Record<DealTabId, string> = {
  overview: "Notes, timeline and the rail — contact, BMI project, availability and collateral.",
  contract:
    "Group-event contract rail — the reservation-admin and group-function functionality folded into the CRM. A contract is created the moment the BMI state is flipped to Send Contract.",
  notes:
    "BMI notes — the CRM log, the Office private log (FastTrax Web and Portal Staff sections intact) and the public notes the guest sees.",
  event: "Event detail — schedules, products, people and the responsible from the BMI project.",
  payments:
    "Payments — deposit, balance and the day-of gift card. No payments until the contract is sent and signed.",
  history: "contract audit log · versions · status changes · BMI syncs",
};

export type LeadDetail = Omit<LeadDetailResponse, "ok">;

export interface DealTabProps {
  tab: DealTabId;
  detail: LeadDetail;
  query: Record<string, string>;
  setQuery: (patch: UrlQueryPatch) => void;
  /** Re-fetch the deal after a mutation. */
  refresh: () => void;
}

export type DealTabComponent = ComponentType<DealTabProps>;

export type DealTabLoader = () => Promise<{ default: DealTabComponent }>;

export const DEAL_TABS: Record<DealTabId, DealTabLoader> = {
  overview: () => import("./OverviewTab"),
  contract: () => import("./ContractTab"),
  notes: () => import("./NotesTab"),
  event: () => import("./EventTab"),
  payments: () => import("./PaymentsTab"),
  history: () => import("./HistoryTab"),
};

export function isDealTabId(value: unknown): value is DealTabId {
  return typeof value === "string" && (DEAL_TAB_IDS as readonly string[]).includes(value);
}

/** The tab a URL asks for, else overview. */
export function activeTab(query: Record<string, string>): DealTabId {
  return isDealTabId(query.tab) ? query.tab : "overview";
}
