"use client";

import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import type { ScreenProps } from "~/features/crm/core/screens";
import { LEAD_TEST_IDS, type RepMyDay } from "~/features/crm/leads/contracts";
import { MY_DAY_POLL_MS, leadsKeys } from "~/features/crm/leads/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useUrlQuery } from "../lib/use-url-query";
import { useCrmFetch, useCrmSheet, useCrmToast, useTopbarSlot } from "../lib/use-crm-user";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { ErrorState, LoadingState } from "../primitives/States";
import { DealDrawer } from "../deal/DealDrawer";
import { useStatusIndex } from "../deal/use-deal";
import { BoardColumn } from "../leads/BoardColumn";
import { LeadCard } from "../leads/LeadCard";
import { NewLeadSheet } from "../leads/NewLeadSheet";
import { fetchMyDay } from "../leads/queries";
import { DirectorTodayScreen } from "./DirectorTodayScreen";

/**
 * `/admin/crm` — My Day (direction-b.html `today`). A rep's three columns,
 * left to right: Overdue · Due today · New leads; a director gets
 * `DirectorTodayScreen`. Cards open the deal as a drawer (`?deal=`).
 */
export default function MyDayScreen({ query }: ScreenProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const slot = useTopbarSlot();
  const { openSheet, closeSheet } = useCrmSheet();
  const statuses = useStatusIndex();
  const [urlQuery, setUrlQuery] = useUrlQuery(query);

  const q = useQuery({
    queryKey: leadsKeys.myDay(),
    queryFn: () => fetchMyDay(crmFetch),
    refetchInterval: MY_DAY_POLL_MS,
    refetchIntervalInBackground: false,
  });

  const now = new Date();
  const dealId = urlQuery.deal ?? null;
  const openDeal = (publicId: string) => setUrlQuery({ deal: publicId });
  const openNew = () =>
    openSheet({
      title: "New lead",
      icon: <IconPlus {...ICON} />,
      wide: true,
      body: (
        <NewLeadSheet
          onCancel={closeSheet}
          onCreated={(r) => {
            closeSheet();
            const m = r.mint;
            if (m.status === "minted")
              toast(`Lead ${r.lead.publicId} saved · BMI project ${m.projectNumber}`);
            else if (m.status === "none")
              toast(
                `Lead ${r.lead.publicId} saved · add email and time to create it in BMI`,
                "warn",
              );
            else toast(`Lead ${r.lead.publicId} saved · BMI project failed, retry queued`, "warn");
            openDeal(r.lead.publicId);
          }}
        />
      ),
    });

  const view = q.data?.view;

  return (
    <>
      {slot
        ? createPortal(
            <button type="button" className="btn btn-sm" onClick={openNew}>
              <IconPlus {...ICON} /> <span className="lbl">New lead</span>
            </button>,
            slot,
          )
        : null}

      {q.isPending ? <LoadingState label="Loading your day…" /> : null}
      {q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : null}

      {view?.kind === "director" ? (
        <DirectorTodayScreen view={view} now={now} statuses={statuses} onOpen={openDeal} />
      ) : view ? (
        <RepBoard view={view} now={now} statuses={statuses} onOpen={openDeal} />
      ) : null}

      {dealId ? (
        <DealDrawer
          publicId={dealId}
          onClose={() => setUrlQuery({ deal: null, tab: null })}
          query={urlQuery}
          setQuery={setUrlQuery}
        />
      ) : null}
    </>
  );
}

function RepBoard({
  view,
  now,
  statuses,
  onOpen,
}: {
  view: RepMyDay;
  now: Date;
  statuses: ReturnType<typeof useStatusIndex>;
  onOpen: (publicId: string) => void;
}) {
  const col = (
    id: "overdue" | "due" | "new",
    label: string,
    kind: "lost" | "warn" | "open",
    leads: RepMyDay["overdue"],
    empty: string,
  ) => (
    <BoardColumn
      testId={LEAD_TEST_IDS.myDayColumn(id)}
      header={
        <>
          <Chip kind={kind}>{label}</Chip>
          <span className="n">{leads.length}</span>
        </>
      }
      count={leads.length}
      empty={empty}
    >
      {leads.map((l) => (
        <LeadCard
          key={l.id}
          lead={l}
          status={statuses.get(l.status)}
          now={now}
          onOpen={onOpen}
          hideRep
        />
      ))}
    </BoardColumn>
  );
  return (
    <div className="stack" style={{ gap: 16 }} data-testid={LEAD_TEST_IDS.myDay}>
      <div>
        <h2 style={{ fontSize: 18, margin: 0 }}>{view.greeting}</h2>
        <div className="sub muted small">{view.dateLabel} · three columns, left to right</div>
      </div>
      <div className="mini-board">
        {col("overdue", "Overdue", "lost", view.overdue, "Nothing overdue")}
        {col("due", "Due today", "warn", view.dueToday, "Clear for today")}
        {col("new", "New leads", "open", view.newLeads, "No new leads")}
      </div>
    </div>
  );
}
