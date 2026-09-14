"use client";

import Link from "next/link";
import { CRM_BASE } from "~/features/crm/core/contracts";
import type { ScreenProps } from "~/features/crm/core/screens";
import { fDate } from "~/features/crm/core/dates";
import { CENTRES } from "~/features/crm/core/centres";
import { CrmApiError, errorMessage } from "../lib/crm-fetch";
import { useUrlQuery } from "../lib/use-url-query";
import { useScreenHead } from "../lib/use-crm-user";
import { leadTitle } from "../leads/model";
import { ErrorState, LoadingState } from "../primitives/States";
import { DealBody } from "./DealBody";
import { useLeadDetail } from "./use-deal";

/**
 * `/admin/crm/deal/<publicId>[?tab=…]` — the deal as a full page (brief §3.1).
 * The drawer variant (`DealDrawer`) renders the same `DealBody`.
 */
export default function DealScreen({ view, query }: ScreenProps) {
  const publicId = view[0] ?? null;
  const [urlQuery, setUrlQuery] = useUrlQuery(query);
  const q = useLeadDetail(publicId);

  /**
   * THE APP BAR CARRIES THE GUEST, not the word "Deal".
   *
   * Owner, 2026-09-14: "The app bar ('← Deal ☀') is a whole row that says
   * nothing the card beneath it does not." On a phone that row is most of the
   * space above the fold, and it was spending it on a label the URL, the back
   * arrow and the card underneath all already imply.
   *
   * It now says WHOSE deal this is, with the date and centre beneath — so once
   * the header card scrolls away the bar is still answering "what am I looking
   * at". `useScreenHead` is a no-op until the lead loads, so the shell keeps
   * its own "Deal" title while the request is in flight rather than flashing
   * an empty bar.
   *
   * Full page only. The drawer has its own header with the same name in it,
   * and setting this from `DealBody` would retitle the BOARD behind the
   * drawer — which is not the screen anybody is looking at.
   */
  const lead = q.data?.lead ?? null;
  useScreenHead(
    lead ? leadTitle(lead) : null,
    lead ? `${fDate(lead.eventDate)} · ${CENTRES[lead.centre].short}` : null,
  );

  if (!publicId) {
    return (
      <div className="card" style={{ maxWidth: 640 }}>
        <div className="pad stack">
          <div className="eyebrow">No lead</div>
          <h2 style={{ fontSize: 16 }}>Open a deal from My Day, the queue or the pipeline.</h2>
          <div>
            <Link href={CRM_BASE} className="btn btn-sm">
              Back to My Day
            </Link>
          </div>
        </div>
      </div>
    );
  }
  if (q.isPending) return <LoadingState label="Loading deal…" />;
  if (q.isError) {
    const notFound = q.error instanceof CrmApiError && q.error.status === 404;
    return (
      <div className="card" style={{ maxWidth: 640 }}>
        <div className="pad stack">
          {notFound ? (
            <>
              <div className="eyebrow">Not found</div>
              <h2 style={{ fontSize: 16 }}>There is no lead {publicId}.</h2>
            </>
          ) : (
            <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
          )}
          <div>
            <Link href={CRM_BASE} className="btn btn-sm">
              Back to My Day
            </Link>
          </div>
        </div>
      </div>
    );
  }
  return <DealBody detail={q.data} query={urlQuery} setQuery={setUrlQuery} refresh={q.refresh} />;
}
