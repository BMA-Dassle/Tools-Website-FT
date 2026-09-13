"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import {
  ACTIVITY_TEST_IDS,
  TOUCH_CHANNELS,
  TOUCH_RULE_COPY,
  type TouchCounts,
} from "~/features/crm/activities/contracts";
import { activitiesKeys } from "~/features/crm/activities/queries";
import type { CrmActivity } from "~/features/crm/core/types";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch } from "../lib/use-crm-user";
import { ErrorState } from "../primitives/States";
import { fetchTimeline } from "./queries";
import { TimelineItem } from "./Timeline";

/**
 * The lead's full timeline: the merged, keyset-paginated read
 * (`GET /leads/[id]/activities`), newest first, with "Load older" rather than
 * a page number — `crm_activities` is never paged by OFFSET (R10).
 *
 * The header carries today's touch tally, which is the rule the accountability
 * screen scores on (crm-shared.js:418) stated where a rep can see it: a second
 * call today still appears on the timeline, and still does not add to the
 * count. Saying so here is what stops "but I called them four times" being a
 * surprise at the end of the week.
 *
 * The first page comes from the deal read the drawer already did, so opening a
 * deal costs one request, not two.
 */
export interface LeadTimelineProps {
  leadPublicId: string;
  /** The first page, already fetched with the deal. */
  initialActivities: CrmActivity[];
}

function touchLine(counts: TouchCounts): string {
  const named = TOUCH_CHANNELS.filter((c) => counts[c] > 0);
  if (named.length === 0) return "No touches logged today";
  const label: Record<string, string> = {
    call: "call",
    sms: "text",
    email: "email",
    reachout: "reach-out",
  };
  return `Today: ${named.map((c) => label[c]).join(" · ")}`;
}

export function LeadTimeline({ leadPublicId, initialActivities }: LeadTimelineProps) {
  const crmFetch = useCrmFetch();

  const q = useInfiniteQuery({
    queryKey: activitiesKeys.timeline(leadPublicId),
    queryFn: ({ pageParam }) => fetchTimeline(crmFetch, leadPublicId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const activities = q.data ? q.data.pages.flatMap((p) => p.activities) : initialActivities;
  const touches = q.data?.pages[0]?.touchesToday;

  return (
    <div className="card" data-testid={ACTIVITY_TEST_IDS.timeline}>
      <div className="card-h">
        <h2>Timeline</h2>
        <div className="right">
          {touches ? (
            <span className="xs muted" title={TOUCH_RULE_COPY}>
              {touchLine(touches)}
            </span>
          ) : null}
          <span className="pill">{activities.length} events</span>
        </div>
      </div>
      {q.isError ? (
        <div className="pad">
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        </div>
      ) : null}
      {activities.length === 0 ? (
        <div className="empty">Nothing logged yet.</div>
      ) : (
        <div className="timeline">
          {activities.map((a) => (
            <TimelineItem key={a.id} a={a} />
          ))}
        </div>
      )}
      {q.hasNextPage ? (
        <div className="pad">
          <button
            type="button"
            className="btn btn-sm"
            data-testid={ACTIVITY_TEST_IDS.timelineMore}
            disabled={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            {q.isFetchingNextPage ? "Loading…" : "Load older"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
