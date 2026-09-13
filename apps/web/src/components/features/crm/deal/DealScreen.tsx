"use client";

import Link from "next/link";
import { CRM_BASE } from "~/features/crm/core/contracts";
import type { ScreenProps } from "~/features/crm/core/screens";
import { CrmApiError, errorMessage } from "../lib/crm-fetch";
import { useUrlQuery } from "../lib/use-url-query";
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
