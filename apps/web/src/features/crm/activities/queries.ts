/**
 * React Query keys for the activities sub (brief §3.4). CLIENT-SAFE — no
 * imports. Components import this file by path, never the sub's server barrel.
 *
 * The timeline hangs off the LEAD, so a note, a snooze or a logged call
 * invalidates `leadsKeys.all` as well — the deal header, the board card and
 * the sidebar badges all read the same lead row.
 */

export const activitiesKeys = {
  all: ["crm", "activities"] as const,
  timeline: (leadId: string) => ["crm", "activities", "timeline", leadId] as const,
};

export type ActivitiesKey =
  | typeof activitiesKeys.all
  | ReturnType<(typeof activitiesKeys)["timeline"]>;
