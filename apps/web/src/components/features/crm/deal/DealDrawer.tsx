"use client";

import { IconArrowsMaximize } from "@tabler/icons-react";
import Link from "next/link";
import { CRM_BASE } from "~/features/crm/core/contracts";
import { errorMessage } from "../lib/crm-fetch";
import type { UrlQueryPatch } from "../lib/use-url-query";
import { ICON } from "../primitives/icon-props";
import { ErrorState, LoadingState } from "../primitives/States";
import { Drawer } from "../shell/Drawer";
import { leadTitle } from "../leads/model";
import { DealBody } from "./DealBody";
import { DealStepper } from "./DealStepper";
import { useLeadDetail } from "./use-deal";

/**
 * The deal as a right-hand drawer over a board (`direction-b.html` "Deal
 * opens as a drawer over the pipeline (desktop) or full page (phone)"). The
 * board keeps `?deal=<publicId>` in its URL; B4's pipeline, the queue and My
 * Day all open it the same way. Full width under 769px by crm.css.
 */
export interface DealDrawerProps {
  publicId: string;
  onClose: () => void;
  query: Record<string, string>;
  setQuery: (patch: UrlQueryPatch) => void;
  /**
   * The public ids the SCREEN is showing, in the order it shows them — the
   * pipeline's column order, the queue's oldest-first, the events board's day
   * order. Supplying it turns on the prev/next stepper; leaving it off is the
   * old behaviour. The drawer never derives this itself (see
   * `features/crm/deals/stepper.ts`).
   */
  order?: readonly string[];
}

export function DealDrawer({ publicId, onClose, query, setQuery, order }: DealDrawerProps) {
  const q = useLeadDetail(publicId);
  const title = q.data ? leadTitle(q.data.lead) : publicId;
  const full = `${CRM_BASE}/deal/${publicId}${query.tab ? `?tab=${query.tab}` : ""}`;
  return (
    <Drawer
      open
      title={title}
      onClose={onClose}
      testId="crm-deal-drawer"
      actions={
        <>
          {/* Stepping keeps the tab you are on: a rep checking contracts down
              a column wants the Contract tab on the next one too, not to be
              dropped back on Overview every time. */}
          <DealStepper
            order={order}
            current={publicId}
            onStep={(next) => setQuery({ deal: next })}
          />
          <Link className="btn btn-sm" href={full}>
            <IconArrowsMaximize {...ICON} /> Full page
          </Link>
        </>
      }
    >
      {q.isPending ? <LoadingState label="Loading deal…" /> : null}
      {q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : null}
      {q.data ? (
        <DealBody detail={q.data} query={query} setQuery={setQuery} refresh={q.refresh} compact />
      ) : null}
    </Drawer>
  );
}
