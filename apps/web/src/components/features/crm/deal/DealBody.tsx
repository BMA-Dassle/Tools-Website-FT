"use client";

import { IconEdit, IconUsers } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Suspense, lazy, type LazyExoticComponent } from "react";
import { LEAD_TEST_IDS } from "~/features/crm/leads/contracts";
import { leadsKeys } from "~/features/crm/leads/queries";
import { errorMessage } from "../lib/crm-fetch";
import type { UrlQueryPatch } from "../lib/use-url-query";
import { useCrmFetch, useCrmSheet, useCrmToast, useCrmUser } from "../lib/use-crm-user";
import { ICON } from "../primitives/icon-props";
import { LoadingState } from "../primitives/States";
import { postMint } from "../leads/queries";
import { leadTitle } from "../leads/model";
import { AssignSheet } from "../queue/AssignSheet";
import { DealHeader } from "./DealHeader";
import { EditLeadSheet } from "./EditLeadSheet";
import { QuickActions } from "./QuickActions";
import {
  DEAL_TABS,
  DEAL_TAB_IDS,
  DEAL_TAB_LABEL,
  activeTab,
  type DealTabComponent,
  type DealTabId,
  type LeadDetail,
} from "./tabs";
import { useStatusIndex } from "./use-deal";

/** One lazy component per tab, created ONCE at module scope (never in render). */
const LAZY_TABS = Object.fromEntries(DEAL_TAB_IDS.map((id) => [id, lazy(DEAL_TABS[id])])) as Record<
  DealTabId,
  LazyExoticComponent<DealTabComponent>
>;

/**
 * Header · quick actions · tabs · the active tab — shared by the drawer and
 * the full page. The active tab is `?tab=` in the URL.
 */
export interface DealBodyProps {
  detail: LeadDetail;
  query: Record<string, string>;
  setQuery: (patch: UrlQueryPatch) => void;
  refresh: () => void;
}

export function DealBody({ detail, query, setQuery, refresh }: DealBodyProps) {
  const { isDirector } = useCrmUser();
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const { openSheet, closeSheet } = useCrmSheet();
  const statuses = useStatusIndex();
  const { lead, activities } = detail;
  const tab = activeTab(query);
  const Tab = LAZY_TABS[tab];
  const now = new Date();

  const mint = useMutation({
    mutationFn: () => postMint(crmFetch, lead.publicId),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      if (r.mint.status === "minted") toast(`BMI project ${r.mint.projectNumber} created`);
      else toast(`BMI project not created: ${r.mint.error ?? "unknown"} — retry queued`, "warn");
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const edit = (thenMint: boolean) =>
    openSheet({
      title: thenMint ? "Complete to create in BMI" : `Edit ${lead.guest.first || "lead"}`,
      icon: <IconEdit {...ICON} />,
      wide: true,
      body: (
        <EditLeadSheet
          lead={lead}
          thenMint={thenMint}
          onCancel={closeSheet}
          onDone={() => {
            closeSheet();
            refresh();
          }}
        />
      ),
    });

  const reassign = () =>
    openSheet({
      title: `${lead.rep ? "Reassign" : "Assign"} ${leadTitle(lead)}`,
      icon: <IconUsers {...ICON} />,
      wide: true,
      testId: LEAD_TEST_IDS.assignSheet,
      body: (
        <AssignSheet
          lead={lead}
          suggestion={null}
          trace={[]}
          onCancel={closeSheet}
          onDone={() => {
            closeSheet();
            refresh();
          }}
        />
      ),
    });

  return (
    <div className="stack" style={{ gap: 16 }} data-testid={LEAD_TEST_IDS.deal}>
      <DealHeader
        lead={lead}
        status={statuses.get(lead.status)}
        now={now}
        isDirector={isDirector}
        onReassign={reassign}
        onEdit={edit}
        onMint={() => mint.mutate()}
        minting={mint.isPending}
      />
      <QuickActions lead={lead} onDone={refresh} />
      <div
        className="deal-tabs"
        role="group"
        aria-label="Deal sections"
        data-testid={LEAD_TEST_IDS.dealTabs}
      >
        {DEAL_TAB_IDS.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={id === tab}
            onClick={() => setQuery({ tab: id === "overview" ? null : id })}
          >
            {DEAL_TAB_LABEL[id]}{" "}
            {id === "contract" && !lead.gfShortId ? <span className="xs muted">none</span> : null}
            {id === "history" ? <span className="n">{activities.length}</span> : null}
          </button>
        ))}
      </div>
      <Suspense fallback={<LoadingState />}>
        <Tab tab={tab} detail={detail} query={query} setQuery={setQuery} refresh={refresh} />
      </Suspense>
    </div>
  );
}
