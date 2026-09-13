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
}

export function DealDrawer({ publicId, onClose, query, setQuery }: DealDrawerProps) {
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
        <Link className="btn btn-sm" href={full}>
          <IconArrowsMaximize {...ICON} /> Full page
        </Link>
      }
    >
      {q.isPending ? <LoadingState label="Loading deal…" /> : null}
      {q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : null}
      {q.data ? (
        <DealBody detail={q.data} query={query} setQuery={setQuery} refresh={q.refresh} />
      ) : null}
    </Drawer>
  );
}
