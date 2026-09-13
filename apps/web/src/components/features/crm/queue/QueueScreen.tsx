"use client";

import { IconBolt, IconClock, IconPlus, IconSettings, IconUsers } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { createPortal } from "react-dom";
import { CRM_BASE } from "~/features/crm/core/contracts";
import { fDate } from "~/features/crm/core/dates";
import type { ScreenProps } from "~/features/crm/core/screens";
import {
  EVENT_TYPE_LABEL,
  LEAD_SOURCE_LABEL,
  LEAD_TEST_IDS,
  type QueueLead,
  type QueueRepColumn,
} from "~/features/crm/leads/contracts";
import { QUEUE_POLL_MS, leadsKeys } from "~/features/crm/leads/queries";
import { responseBadge } from "~/features/crm/leads/response-badge";
import { errorMessage } from "../lib/crm-fetch";
import { useUrlQuery } from "../lib/use-url-query";
import { useCrmFetch, useCrmSheet, useCrmToast, useTopbarSlot } from "../lib/use-crm-user";
import { Avatar } from "../primitives/Avatar";
import { Chip } from "../primitives/Chip";
import { MON } from "../primitives/DateBlock";
import { ICON } from "../primitives/icon-props";
import { Pill } from "../primitives/Pill";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { Timer, formatMinutes } from "../primitives/Timer";
import { DealDrawer } from "../deal/DealDrawer";
import { useStatusIndex } from "../deal/use-deal";
import { BoardColumn } from "../leads/BoardColumn";
import { LeadCard, centreShort } from "../leads/LeadCard";
import { NewLeadSheet } from "../leads/NewLeadSheet";
import { leadTitle, relativeAge } from "../leads/model";
import { fetchQueue, postAssign } from "../leads/queries";
import { AssignSheet } from "./AssignSheet";

/**
 * `/admin/crm/queue` (direction-b.html `queue`) — director only: the
 * Unassigned column (oldest first, age timer, the engine's pick or "No
 * auto-pick yet", Assign) and one column per assignable rep with their open
 * volume by party month and the leads they were handed but have not touched.
 *
 * Drag-onto-a-rep is B4's DragLayer; Assign is the keyboard / tap path the
 * brief requires anyway (R13: no drag-only interaction).
 */
export default function QueueScreen({ query }: ScreenProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const slot = useTopbarSlot();
  const { openSheet, closeSheet } = useCrmSheet();
  const statuses = useStatusIndex();
  const [urlQuery, setUrlQuery] = useUrlQuery(query);

  const q = useQuery({
    queryKey: leadsKeys.queue(),
    queryFn: () => fetchQueue(crmFetch),
    refetchInterval: QUEUE_POLL_MS,
    refetchIntervalInBackground: false,
  });

  const autoAll = useMutation({
    mutationFn: async (items: QueueLead[]) => {
      let n = 0;
      for (const it of items) {
        if (!it.suggestion) continue;
        await postAssign(crmFetch, it.lead.publicId, { repId: it.suggestion.rep.id, note: null });
        n++;
      }
      return n;
    },
    onSuccess: (n) => {
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      toast(`Auto-assigned ${n} leads by the rules`);
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const now = new Date();
  const unassigned = q.data?.unassigned ?? [];
  const reps = q.data?.reps ?? [];
  const months = q.data?.months ?? [];
  const suggested = unassigned.filter((u) => u.suggestion);
  const dealId = urlQuery.deal ?? null;
  const openDeal = (publicId: string) => setUrlQuery({ deal: publicId });

  const openAssign = (item: QueueLead) =>
    openSheet({
      title: `Assign ${leadTitle(item.lead)}`,
      icon: <IconUsers {...ICON} />,
      wide: true,
      testId: LEAD_TEST_IDS.assignSheet,
      body: (
        <AssignSheet
          lead={item.lead}
          suggestion={item.suggestion}
          trace={item.trace}
          onCancel={closeSheet}
          onDone={closeSheet}
        />
      ),
    });

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

  return (
    <>
      {slot
        ? createPortal(
            <>
              <Link className="btn btn-sm" href={`${CRM_BASE}/rules`}>
                <IconSettings {...ICON} /> <span className="lbl">Rules</span>
              </Link>
              <button type="button" className="btn btn-sm" onClick={openNew}>
                <IconPlus {...ICON} /> <span className="lbl">New lead</span>
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={suggested.length === 0 || autoAll.isPending}
                title={
                  suggested.length === 0
                    ? "No auto-picks yet — the assignment rules are not wired to the queue"
                    : undefined
                }
                onClick={() => autoAll.mutate(suggested)}
              >
                <IconBolt {...ICON} /> <span className="lbl">Auto-assign all</span>
              </button>
            </>,
            slot,
          )
        : null}

      {q.isPending ? <LoadingState label="Loading the queue…" /> : null}
      {q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : null}

      {q.data ? (
        <div className="board-wrap" data-testid={LEAD_TEST_IDS.queue}>
          <div className="board-scroll" style={{ padding: 0 }}>
            <div className="board queue-board">
              <BoardColumn
                testId={LEAD_TEST_IDS.queueUnassigned}
                header={
                  <>
                    <Chip kind="lost">Unassigned</Chip>
                    <span className="n">{unassigned.length}</span>
                    {q.data.autoAssignInMinutes != null ? (
                      <span className="sum">
                        <Timer tone="warn" icon={<IconClock {...ICON} />}>
                          {q.data.autoAssignInMinutes} min
                        </Timer>
                      </span>
                    ) : null}
                  </>
                }
                count={unassigned.length}
                empty="Nothing waiting — every lead has a rep."
              >
                {unassigned.map((item) => (
                  <LeadCard
                    key={item.lead.id}
                    lead={item.lead}
                    status={statuses.get(item.lead.status)}
                    now={now}
                    onOpen={openDeal}
                    hideRep
                    extraMeta={
                      <>
                        <span>{EVENT_TYPE_LABEL[item.lead.type]}</span>
                        <Timer
                          tone={item.ageMinutes > 60 ? "crit" : item.ageMinutes > 30 ? "warn" : ""}
                        >
                          waiting {formatMinutes(item.ageMinutes)}
                        </Timer>
                        <span className="xs" style={{ flexBasis: "100%" }}>
                          {item.suggestion ? (
                            <>
                              Auto-pick: <b>{item.suggestion.rep.firstName}</b> ·{" "}
                              {item.suggestion.reason}
                            </>
                          ) : (
                            <span className="muted">No auto-pick yet</span>
                          )}
                        </span>
                      </>
                    }
                    footer={
                      <>
                        <span className="xs muted">{LEAD_SOURCE_LABEL[item.lead.source]}</span>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => openAssign(item)}
                        >
                          Assign
                        </button>
                      </>
                    }
                  />
                ))}
              </BoardColumn>

              {reps.map((col) => (
                <RepColumn key={col.rep.id} col={col} months={months} now={now} onOpen={openDeal} />
              ))}
            </div>
          </div>
        </div>
      ) : null}
      {q.data && unassigned.length === 0 && reps.length === 0 ? (
        <EmptyState>No reps on the roster yet — run the seed from Statuses.</EmptyState>
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

function RepColumn({
  col,
  months,
  now,
  onOpen,
}: {
  col: QueueRepColumn;
  months: string[];
  now: Date;
  onOpen: (publicId: string) => void;
}) {
  return (
    <BoardColumn
      testId={LEAD_TEST_IDS.queueRep(col.rep.slug)}
      header={
        <>
          <Avatar
            initials={col.rep.initials}
            repSlug={col.rep.slug}
            name={col.rep.displayName}
            sm
          />
          <span>{col.rep.displayName}</span>
          <span className="sum">
            <Pill title="Shift status arrives with the roster (assignment rules PR)">
              {col.rep.centres.map(centreShort).join(" · ")}
            </Pill>
          </span>
        </>
      }
    >
      <div className="card" style={{ padding: 10 }}>
        <div className="eyebrow" style={{ marginBottom: 6 }}>
          Open volume by party month
        </div>
        {months.map((m) => {
          const v = col.volume[m] ?? { guests: 0, count: 0 };
          return (
            <div key={m} className="meter-row" style={{ gridTemplateColumns: "36px 1fr auto" }}>
              <span className="small">{MON[Number(m.slice(5)) - 1]}</span>
              <div className="meter">
                <i style={{ width: `${Math.min(100, v.guests / 2)}%` }} />
              </div>
              <span className="n">
                {v.guests} <span className="muted">({v.count})</span>
              </span>
            </div>
          );
        })}
      </div>
      <div
        className="empty"
        style={{ border: "1px dashed var(--border)", borderRadius: 10, padding: "18px 8px" }}
      >
        Tap Assign on a lead to hand it to {col.rep.firstName}
      </div>
      {col.assigned.map((l) => {
        const rb = responseBadge(l, now);
        return (
          <LeadCard
            key={l.id}
            lead={l}
            now={now}
            onOpen={onOpen}
            hideRep
            quiet
            footer={<span />}
            extraMeta={
              <>
                {l.assignedAt ? <span>assigned {relativeAge(l.assignedAt, now)}</span> : null}
                {l.eventDate ? <span className="muted">{fDate(l.eventDate)}</span> : null}
                {rb.kind === "waiting" ? (
                  <Timer tone={rb.tone} icon={<IconClock {...ICON} />}>
                    no touch · {formatMinutes(rb.minutes)}
                  </Timer>
                ) : rb.kind === "touched" ? (
                  <Timer tone={rb.tone} icon={<IconBolt {...ICON} />}>
                    first touch {formatMinutes(rb.minutes)}
                  </Timer>
                ) : null}
              </>
            }
          />
        );
      })}
    </BoardColumn>
  );
}
