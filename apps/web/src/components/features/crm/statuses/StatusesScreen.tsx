"use client";

import { IconPlus, IconStack2 } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import type { StatusesPostBody } from "~/features/crm/core/contracts";
import type { ScreenProps } from "~/features/crm/core/screens";
import type { CentreCode, CrmStatus } from "~/features/crm/core/types";
import { errorMessage } from "../lib/crm-fetch";
import { useUrlQuery } from "../lib/use-url-query";
import {
  useCrmFetch,
  useCrmSheet,
  useCrmToast,
  useCrmUser,
  useTopbarSlot,
} from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { BmiWritesCard } from "./BmiWritesCard";
import { OfficeStatesCard } from "./OfficeStatesCard";
import { RunJobCard } from "./RunJobCard";
import { StatusForm } from "./StatusForm";
import { StatusesTable } from "./StatusesTable";
import { activeStatuses, archivedCount, clientKeyColumns, initialCentre, moveId } from "./model";
import { fetchStatuses, postStatuses, statusesKeys } from "./queries";

/**
 * `/admin/crm/statuses` — REAL in PR1 (brief §4): the seed-confirmation
 * surface. Ported from the prototype's `statuses` screen (crm-shared.js:475):
 * the statuses table, the BMI-writes kill switch, and — beyond the prototype —
 * the per-centre map editor fed by Office's own state names, plus the "Run
 * job" smoke control. Director-only; every control is also gated on the role.
 */
export default function StatusesScreen({ query }: ScreenProps) {
  const { isDirector } = useCrmUser();
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const { openSheet, closeSheet } = useCrmSheet();
  const slot = useTopbarSlot();
  const qc = useQueryClient();
  const [urlQuery, setUrlQuery] = useUrlQuery(query);

  const statusesQ = useQuery({
    queryKey: statusesKeys.list(),
    queryFn: () => fetchStatuses(crmFetch),
  });

  const post = useMutation({
    mutationFn: (body: StatusesPostBody) => postStatuses(crmFetch, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: statusesKeys.all }),
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const statuses = statusesQ.data ? activeStatuses(statusesQ.data.statuses) : [];
  const map = statusesQ.data?.map ?? [];
  const centres = statusesQ.data?.centres ?? [];
  const columns = clientKeyColumns(centres);
  const archived = statusesQ.data ? archivedCount(statusesQ.data.statuses) : 0;
  const centre: CentreCode | null = statusesQ.data ? initialCentre(urlQuery, centres) : null;
  const canEdit = isDirector;
  const busy = post.isPending;

  const openForm = (initial?: CrmStatus) =>
    openSheet({
      title: initial ? `Edit ${initial.label}` : "Add status",
      icon: <IconStack2 {...ICON} />,
      body: (
        <StatusForm
          initial={initial}
          nextPosition={(statuses[statuses.length - 1]?.position ?? 0) + 1}
          onCancel={closeSheet}
          onSubmit={async (input) => {
            await post.mutateAsync({ action: "upsert", status: input });
            closeSheet();
            toast(initial ? `Status ${input.label} saved` : `Status ${input.label} added`);
          }}
        />
      ),
    });

  const onArchive = (s: CrmStatus) =>
    openSheet({
      title: `Archive ${s.label}?`,
      body: (
        <div className="stack">
          <p className="small" style={{ margin: 0 }}>
            The status leaves the board and the pickers. Leads already in it keep their status until
            they move; nothing is written to BMI.
          </p>
          <div className="hstack" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={closeSheet}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                try {
                  await post.mutateAsync({ action: "archive", id: s.id });
                } catch {
                  return; // the mutation's onError already showed the reason; the sheet stays open
                }
                closeSheet();
                toast(`Status ${s.label} archived`);
              }}
            >
              Archive
            </button>
          </div>
        </div>
      ),
    });

  const onMove = (s: CrmStatus, dir: -1 | 1) => {
    const ids = statuses.map((x) => x.id);
    const next = moveId(ids, s.id, dir);
    if (next.join("|") === ids.join("|")) return;
    post.mutate({ action: "reorder", ids: next });
  };

  const onToggleBoard = (s: CrmStatus) =>
    post.mutate(
      {
        action: "upsert",
        status: {
          id: s.id,
          label: s.label,
          kind: s.kind,
          position: s.position,
          slaLabel: s.slaLabel,
          slaHours: s.slaHours,
          onBoard: !s.onBoard,
        },
      },
      { onSuccess: () => toast(`${s.label} ${s.onBoard ? "hidden from" : "shown on"} the board`) },
    );

  return (
    <>
      {slot && canEdit
        ? createPortal(
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => openForm()}
              disabled={!statusesQ.data}
            >
              <IconPlus {...ICON} /> <span className="lbl">Add status</span>
            </button>,
            slot,
          )
        : null}

      <Banner tone="info" icon={<IconStack2 {...ICON} />} role="none">
        Reps only ever see the left column. BMI state ids differ per centre (Fort Myers vs Naples),
        so the mapping is stored per centre.
      </Banner>

      <div className="card">
        {statusesQ.isPending ? <LoadingState label="Loading statuses…" /> : null}
        {statusesQ.isError ? (
          <div className="pad">
            <ErrorState
              message={errorMessage(statusesQ.error)}
              onRetry={() => void statusesQ.refetch()}
            />
          </div>
        ) : null}
        {statusesQ.data && statuses.length === 0 ? (
          <EmptyState>No statuses yet — run the seed below, or add one.</EmptyState>
        ) : null}
        {statusesQ.data && statuses.length > 0 ? (
          <StatusesTable
            statuses={statuses}
            map={map}
            columns={columns}
            canEdit={canEdit}
            busy={busy}
            onEdit={openForm}
            onToggleBoard={onToggleBoard}
            onMove={onMove}
            onArchive={onArchive}
          />
        ) : null}
        {archived > 0 ? (
          <div className="pad xs muted" style={{ paddingTop: 8 }}>
            {archived} archived status{archived === 1 ? "" : "es"} hidden
          </div>
        ) : null}
      </div>

      <BmiWritesCard columns={columns} canEdit={canEdit} />

      {statusesQ.data ? (
        <OfficeStatesCard
          centres={centres}
          statuses={statuses}
          map={map}
          centre={centre}
          onCentre={(c) => setUrlQuery({ centre: c })}
          canEdit={canEdit}
        />
      ) : null}

      <RunJobCard canEdit={canEdit} />
    </>
  );
}
