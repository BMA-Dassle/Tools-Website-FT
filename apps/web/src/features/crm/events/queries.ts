/**
 * React Query keys for the events sub (brief §3.4: `["crm", <sub>, …]` tuples;
 * a mutation invalidates the sub's root key). CLIENT-SAFE — no imports. The
 * fetchers live beside the screens in `components/features/crm/events/`.
 */

export const eventsKeys = {
  all: ["crm", "events"] as const,
  board: (centre: string, view: string, date: string, cancelled: boolean) =>
    ["crm", "events", "board", centre, view, date, cancelled] as const,
  detail: (projectId: string) => ["crm", "events", "detail", projectId] as const,
  leadEvent: (publicId: string) => ["crm", "events", "lead-event", publicId] as const,
  notes: (publicId: string) => ["crm", "events", "notes", publicId] as const,
};

export type EventsKey =
  | typeof eventsKeys.all
  | ReturnType<(typeof eventsKeys)["board"]>
  | ReturnType<(typeof eventsKeys)["detail"]>
  | ReturnType<(typeof eventsKeys)["leadEvent"]>
  | ReturnType<(typeof eventsKeys)["notes"]>;

/** The board re-reads while the tab is visible; BMI itself is cached 360 s. */
export const EVENTS_POLL_MS = 120_000;
