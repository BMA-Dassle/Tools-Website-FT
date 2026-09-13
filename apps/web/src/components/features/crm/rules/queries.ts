import type {
  RosterPostBody,
  RosterResponse,
  RulesPostBody,
  RulesPostResponse,
  RulesResponse,
  TryLeadResponse,
} from "~/features/crm/rules/contracts";
import type { CrmFetch } from "../lib/crm-fetch";

/**
 * Fetchers for the Rules screen (keys live in `~/features/crm/rules/queries`;
 * mutations invalidate `rulesKeys.all`, which also re-runs "Try a lead").
 */

export const fetchRules = (f: CrmFetch) => f<RulesResponse>("/rules");

export const postRules = (f: CrmFetch, body: RulesPostBody) =>
  f<RulesPostResponse>("/rules", { body: { ...body } });

export interface TryLeadParams {
  guests: number;
  type: string;
  centre: string;
  eventDate?: string;
  kids?: boolean;
  source?: string;
}

export const fetchTryLead = (f: CrmFetch, q: TryLeadParams) => {
  const p = new URLSearchParams();
  p.set("guests", String(q.guests));
  p.set("type", q.type);
  p.set("centre", q.centre);
  if (q.eventDate) p.set("eventDate", q.eventDate);
  if (q.kids !== undefined) p.set("kids", q.kids ? "1" : "0");
  if (q.source) p.set("source", q.source);
  return f<TryLeadResponse>(`/rules/try?${p.toString()}`);
};

export const fetchRoster = (f: CrmFetch, date?: string) =>
  f<RosterResponse>(date ? `/roster?date=${encodeURIComponent(date)}` : "/roster");

export const postRoster = (f: CrmFetch, body: RosterPostBody) =>
  f<RosterResponse>("/roster", { body: { ...body } });
