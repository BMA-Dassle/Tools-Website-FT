/**
 * The prototype's display labels for the enumerations (`crm-data.js:57-58`
 * `typeLabel` / `sourceLabel`) and the rule-kind chips (`crm-shared.js:449`).
 * CLIENT-SAFE: no imports beyond types.
 */

import type { ChipKind, EventType, LeadSource, RuleKind } from "~/features/crm/core/types";

export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  corporate: "Corporate",
  birthday: "Birthday",
  team: "Team outing",
  school: "School / youth",
  fundraiser: "Fundraiser",
  holiday: "Holiday party",
};

export const LEAD_SOURCE_LABEL: Record<LeadSource, string> = {
  web: "Web form",
  phone: "Phone",
  walkin: "Walk-in",
  cold: "Cold list",
  historical: "Last year",
  referral: "Referral",
};

/** `kindChip` — label and chip hue per rule kind. */
export const RULE_KIND_CHIP: Record<RuleKind, { label: string; kind: ChipKind }> = {
  hold: { label: "Hold", kind: "warn" },
  route: { label: "Route", kind: "open" },
  avail: { label: "Availability", kind: "open" },
  standard: { label: "Balance", kind: "won" },
  fallback: { label: "Fallback", kind: "lost" },
};
