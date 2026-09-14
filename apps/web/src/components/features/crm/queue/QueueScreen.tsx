"use client";

import { DndContext, useDraggable, useDroppable, type UniqueIdentifier } from "@dnd-kit/core";
import { IconBolt, IconClock, IconPlus, IconSettings, IconUsers } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { createPortal } from "react-dom";
import { CRM_BASE } from "~/features/crm/core/contracts";
import { fDate } from "~/features/crm/core/dates";
import type { ScreenProps } from "~/features/crm/core/screens";
import type { CrmStatus } from "~/features/crm/core/types";
import {
  EVENT_TYPE_LABEL,
  LEAD_SOURCE_LABEL,
  LEAD_TEST_IDS,
  type LeadView,
  type QueueLead,
  type QueueRepColumn,
} from "~/features/crm/leads/contracts";
import { requestedPlannerLabel } from "~/features/crm/leads/planners";
import { QUEUE_POLL_MS, leadsKeys } from "~/features/crm/leads/queries";
import { responseBadge } from "~/features/crm/leads/response-badge";
import { errorMessage } from "../lib/crm-fetch";
import {
  crmAnnouncements,
  crmCollisionDetection,
  dragInstructions,
  useCrmDragSensors,
} from "../lib/dnd";
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
import { DragGhost } from "../leads/DragGhost";
import { DragHandle } from "../leads/DragHandle";
import { LeadCard, centreShort } from "../leads/LeadCard";
import { NewLeadSheet } from "../leads/NewLeadSheet";
import { assignToastText, leadTitle, relativeAge } from "../leads/model";
import { fetchQueue, postAssign } from "../leads/queries";
import { AssignSheet } from "./AssignSheet";

/**
 * `/admin/crm/queue` (direction-b.html `queue`) — director only: the Parked
 * column (oldest first, age timer, WHY each lead is still here, Assign) and
 * one column per assignable rep with their open volume by party month and the
 * leads they were handed but have not touched.
 *
 * The prototype's "auto-assign in 18 min" countdown is NOT here: the rules
 * assign the moment a lead is captured (owner, 2026-09-13), so this column
 * holds only leads parked on purpose — held by a rule, or with no eligible
 * rep — plus the few the capture-time assign could not complete. Each card
 * says which, from the server's `park` verdict.
 *
 * The screen's own subtitle has always promised "Drag a lead onto a rep, or tap
 * Assign", and now it is true: a parked card is a dnd-kit draggable and each rep
 * column is a droppable, dropping one on the other runs the SAME `postAssign`
 * the sheet's "Assign to <first>" button runs. Assign remains the tap and
 * keyboard path the brief requires anyway (R13: no drag-only interaction), and
 * it is the only path that can carry a note.
 */
export default function QueueScreen({ query }: ScreenProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const slot = useTopbarSlot();
  const { openSheet, closeSheet } = useCrmSheet();
  const statuses = useStatusIndex();
  const [urlQuery, setUrlQuery] = useUrlQuery(query);
  const sensors = useCrmDragSensors();
  /** The lead being written right now — its card goes quiet until it settles. */
  const [pendingLeadId, setPendingLeadId] = useState<string | null>(null);
  const [draggingLeadId, setDraggingLeadId] = useState<string | null>(null);

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

  /**
   * The drop. Deliberately the same call, the same invalidation and the same
   * toast as `AssignSheet` — a drag is a shortcut to the sheet's primary
   * button, not a second way of assigning that could drift from it. The note
   * the sheet can carry is null here: a gesture cannot type.
   */
  const assign = useMutation({
    mutationFn: (v: { lead: LeadView; repId: string }) =>
      postAssign(crmFetch, v.lead.publicId, { repId: v.repId, note: null }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      const first = r.assignment.toRepName?.split(/\s+/)[0] ?? "rep";
      const t = assignToastText(first, r.bmi);
      toast(t.text, t.kind);
    },
    onError: (err) => toast(errorMessage(err), "crit"),
    onSettled: () => setPendingLeadId(null),
  });

  const now = new Date();
  const unassigned = q.data?.unassigned ?? [];
  const reps = q.data?.reps ?? [];
  const months = q.data?.months ?? [];
  // Only the leads the safety net would take: a lead PARKED by a hold rule is
  // not a candidate (its "suggestion" is the hold row, so assigning it would
  // just re-park it), and one with no eligible rep has nothing to assign to.
  const suggested = unassigned.filter((u) => u.park.kind === "retry" && u.suggestion);
  const dealId = urlQuery.deal ?? null;
  const openDeal = (publicId: string) => setUrlQuery({ deal: publicId });

  const parked = new Map(unassigned.map((it) => [it.lead.id, it.lead]));
  const dragged = draggingLeadId ? (parked.get(draggingLeadId) ?? null) : null;

  /** A lead, a rep — whatever is in flight, said the way a person says it. */
  const nameOf = (id: UniqueIdentifier) => {
    const key = String(id);
    const lead = parked.get(key);
    if (lead) return leadTitle(lead);
    return reps.find((c) => c.rep.id === key)?.rep.displayName ?? key;
  };

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
                    ? "Nothing to auto-assign — every lead here is parked on purpose or has no eligible rep"
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
            <DndContext
              sensors={sensors}
              collisionDetection={crmCollisionDetection}
              accessibility={{
                announcements: crmAnnouncements(nameOf),
                screenReaderInstructions: dragInstructions("the team's columns"),
              }}
              onDragStart={({ active }) => setDraggingLeadId(String(active.id))}
              onDragCancel={() => setDraggingLeadId(null)}
              onDragEnd={({ active, over }) => {
                setDraggingLeadId(null);
                if (!over) return;
                const lead = parked.get(String(active.id));
                if (!lead) return;
                setPendingLeadId(lead.id);
                assign.mutate({ lead, repId: String(over.id) });
              }}
            >
              <div className="board queue-board">
                <BoardColumn
                  testId={LEAD_TEST_IDS.queueUnassigned}
                  header={
                    <>
                      <Chip kind="lost">Parked</Chip>
                      <span className="n">{unassigned.length}</span>
                      <span className="sum">
                        <Pill title="The rules assign every lead as it arrives. What is here was parked on purpose, or the rules could not name a rep.">
                          needs a decision
                        </Pill>
                      </span>
                    </>
                  }
                  count={unassigned.length}
                  empty="Nothing parked — every lead has a rep."
                >
                  {unassigned.map((item) => (
                    <ParkedCard
                      key={item.lead.id}
                      item={item}
                      status={statuses.get(item.lead.status)}
                      now={now}
                      busy={pendingLeadId === item.lead.id}
                      onOpen={openDeal}
                      onAssign={openAssign}
                    />
                  ))}
                </BoardColumn>

                {reps.map((col) => (
                  <RepColumn
                    key={col.rep.id}
                    col={col}
                    months={months}
                    now={now}
                    onOpen={openDeal}
                  />
                ))}
              </div>
              <DragGhost testId={LEAD_TEST_IDS.queueDragGhost} lead={dragged} />
            </DndContext>
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

/**
 * A parked lead: the shared `LeadCard`, made draggable, keeping every word it
 * had — the age timer, the requested planner, WHY it is parked, the auto-pick —
 * and both ways out of the column. The grab bar sits beside Assign so the two
 * paths are next to each other and neither looks like the only one.
 */
function ParkedCard({
  item,
  status,
  now,
  busy,
  onOpen,
  onAssign,
}: {
  item: QueueLead;
  status: CrmStatus | undefined;
  now: Date;
  busy: boolean;
  onOpen: (publicId: string) => void;
  onAssign: (item: QueueLead) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: item.lead.id,
    disabled: busy,
  });

  return (
    <div
      ref={setNodeRef}
      data-lead={item.lead.id}
      style={{ opacity: isDragging ? 0.4 : undefined, touchAction: "manipulation" }}
      {...listeners}
    >
      <LeadCard
        lead={item.lead}
        status={status}
        now={now}
        onOpen={onOpen}
        hideRep
        quiet={busy}
        extraMeta={
          <>
            <span>{EVENT_TYPE_LABEL[item.lead.type]}</span>
            <Timer tone={item.ageMinutes > 60 ? "crit" : item.ageMinutes > 30 ? "warn" : ""}>
              waiting {formatMinutes(item.ageMinutes)}
            </Timer>
            {/* B7 — what the guest asked for, honoured or not. */}
            {item.lead.requestedRep ? (
              <span className="xs" style={{ flexBasis: "100%" }}>
                <b>{requestedPlannerLabel(item.lead.requestedRep.firstName)}</b>
              </span>
            ) : null}
            {/*
              Why it is parked, not how long until a timer fires: the rules
              assign at capture, so there is nothing to count down to (owner,
              2026-09-13).
            */}
            <span className="xs" style={{ flexBasis: "100%" }}>
              <b>{item.park.label}</b>
            </span>
            {item.park.kind !== "held" && item.suggestion ? (
              <span className="xs muted" style={{ flexBasis: "100%" }}>
                Auto-pick: {item.suggestion.rep.firstName} · {item.suggestion.reason}
              </span>
            ) : null}
          </>
        }
        footer={
          <>
            <span className="xs muted">{LEAD_SOURCE_LABEL[item.lead.source]}</span>
            <DragHandle
              attributes={attributes}
              setRef={setActivatorNodeRef}
              label={`Move ${leadTitle(item.lead)} onto a rep`}
              disabled={busy}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => onAssign(item)}
            >
              Assign
            </button>
          </>
        }
      />
    </div>
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
  const { isOver, setNodeRef } = useDroppable({ id: col.rep.id });
  return (
    <BoardColumn
      testId={LEAD_TEST_IDS.queueRep(col.rep.slug)}
      setRef={setNodeRef}
      style={{
        outline: isOver ? "2px solid var(--acc, #5b8cff)" : undefined,
        outlineOffset: isOver ? 2 : undefined,
      }}
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
        style={{
          border: `1px dashed ${isOver ? "var(--acc, #5b8cff)" : "var(--border)"}`,
          borderRadius: 10,
          padding: "18px 8px",
          transition: "border-color .12s ease",
        }}
      >
        Drop a lead here, or tap Assign, to hand it to {col.rep.firstName}
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
