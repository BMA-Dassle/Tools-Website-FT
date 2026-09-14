"use client";

import { IconDeviceFloppy, IconRefresh } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  TEST_IDS,
  type CentreSummary,
  type OfficeStateName,
  type OfficeStateProposal,
  type StatusesMapPostBody,
} from "~/features/crm/core/contracts";
import type { CentreCode, CrmStatus, StatusBmiMapRow } from "~/features/crm/core/types";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { Pill } from "../primitives/Pill";
import { Seg } from "../primitives/Seg";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { Table } from "../primitives/Table";
import { mapRowFor, proposalFor } from "./model";
import { fetchOfficeStates, postStatusMap, statusesKeys } from "./queries";

/**
 * The per-centre map editor: pick a centre → the server lists that Office
 * tenant's state names (`GET /statuses/office-states?centre=`) and PROPOSES a
 * match per status by name → the director confirms each with Save
 * (`POST /statuses/map`). Nothing is invented: when Office cannot be reached
 * the seed renders with the saved map and an "unmapped" badge, and the select
 * stays disabled until the names arrive.
 */
export interface OfficeStatesCardProps {
  centres: CentreSummary[];
  statuses: CrmStatus[];
  map: StatusBmiMapRow[];
  centre: CentreCode | null;
  onCentre: (centre: CentreCode) => void;
  canEdit: boolean;
}

export function OfficeStatesCard({
  centres,
  statuses,
  map,
  centre,
  onCentre,
  canEdit,
}: OfficeStatesCardProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();

  const officeQ = useQuery({
    queryKey: statusesKeys.officeStates(centre ?? "HPFM"),
    queryFn: () => fetchOfficeStates(crmFetch, centre ?? "HPFM"),
    enabled: centre !== null,
  });

  const saveMap = useMutation({
    mutationFn: (body: StatusesMapPostBody) => postStatusMap(crmFetch, body),
    onSuccess: (_data, body) => {
      void qc.invalidateQueries({ queryKey: statusesKeys.all });
      toast(`Mapped ${body.statusId} → ${body.bmiStateName}`);
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const selected = centres.find((c) => c.code === centre) ?? null;
  const clientKey = officeQ.data?.clientKey ?? selected?.clientKey ?? null;
  const states = officeQ.data?.states ?? [];
  const proposals = officeQ.data?.proposals ?? [];

  return (
    <div className="card" data-testid={TEST_IDS.officeStates}>
      <div className="card-h">
        <h2>BMI state per center</h2>
        <div className="right">
          {centres.length > 0 && centre ? (
            <Seg
              label="Center"
              value={centre}
              onChange={onCentre}
              options={centres.map((c) => ({ value: c.code, label: c.short }))}
            />
          ) : null}
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            aria-label="Reload Office state names"
            disabled={officeQ.isFetching || centre === null}
            onClick={() => void officeQ.refetch()}
          >
            <IconRefresh {...ICON} />
          </button>
        </div>
      </div>
      <div className="pad stack">
        {centre === null ? <EmptyState>No centers to map.</EmptyState> : null}
        {officeQ.isPending && centre !== null ? (
          <LoadingState label="Asking Office for its state names…" />
        ) : null}
        {officeQ.isError ? (
          <ErrorState
            message={errorMessage(officeQ.error)}
            onRetry={() => void officeQ.refetch()}
          />
        ) : null}
        {officeQ.data ? (
          officeQ.data.source === "office" ? (
            <div className="hstack xs muted">
              <Pill>from Office · {states.length} states</Pill>
              <span>
                tenant <span className="mono">{officeQ.data.clientKey}</span>
              </span>
            </div>
          ) : (
            <Banner tone="warn">
              Office unavailable{officeQ.data.error ? ` — ${officeQ.data.error}` : ""}. Showing the
              saved map; no state ids are guessed.
            </Banner>
          )
        ) : null}
      </div>
      {officeQ.data && clientKey ? (
        <Table
          columns={[
            { key: "status", label: "Our status" },
            { key: "saved", label: "Saved BMI state" },
            { key: "pick", label: "Office state" },
            { key: "save", label: <span className="sr-only">Save</span> },
          ]}
          caption={`BMI state per status at ${selected?.short ?? centre}`}
        >
          {statuses.map((s) => (
            <MapRow
              key={`${s.id}:${clientKey}`}
              status={s}
              clientKey={clientKey}
              states={states}
              saved={mapRowFor(map, s.id, clientKey)}
              proposal={proposalFor(proposals, s.id)}
              canEdit={canEdit}
              busy={saveMap.isPending}
              onSave={(state) =>
                saveMap.mutate({
                  statusId: s.id,
                  clientKey,
                  bmiStateId: state.id,
                  bmiStateName: state.name,
                })
              }
            />
          ))}
        </Table>
      ) : null}
    </div>
  );
}

interface MapRowProps {
  status: CrmStatus;
  clientKey: string;
  states: OfficeStateName[];
  saved: StatusBmiMapRow | undefined;
  proposal: OfficeStateProposal | undefined;
  canEdit: boolean;
  busy: boolean;
  onSave: (state: OfficeStateName) => void;
}

function MapRow({
  status,
  clientKey,
  states,
  saved,
  proposal,
  canEdit,
  busy,
  onSave,
}: MapRowProps) {
  const [picked, setPicked] = useState<string>(saved?.bmiStateId ?? proposal?.bmiStateId ?? "");
  const chosen = states.find((st) => st.id === picked);
  const dirty = picked !== "" && picked !== (saved?.bmiStateId ?? "");
  const selectId = `crm-map-${clientKey}-${status.id}`;

  return (
    <tr>
      <td>
        <Chip kind={status.kind} st={status.id}>
          {status.label}
        </Chip>
      </td>
      <td>
        {saved ? (
          <span title={`Office state id ${saved.bmiStateId}`}>{saved.bmiStateName}</span>
        ) : proposal ? (
          <Chip kind="open" title={`Proposed by name: id ${proposal.bmiStateId}`}>
            proposed · {proposal.bmiStateName}
          </Chip>
        ) : (
          <Chip kind="warn">unmapped</Chip>
        )}
      </td>
      <td>
        <label className="sr-only" htmlFor={selectId}>
          Office state for {status.label}
        </label>
        <select
          id={selectId}
          className="select"
          style={{ width: "auto", maxWidth: 260 }}
          value={picked}
          disabled={!canEdit || states.length === 0}
          onChange={(e) => setPicked(e.target.value)}
        >
          <option value="">
            {states.length ? "— pick a state —" : "Office names unavailable"}
          </option>
          {states.map((st) => (
            <option key={st.id} value={st.id}>
              {st.name}
            </option>
          ))}
        </select>
      </td>
      <td>
        {canEdit ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={!dirty || !chosen || busy}
            onClick={() => chosen && onSave(chosen)}
          >
            <IconDeviceFloppy {...ICON} /> Save
          </button>
        ) : null}
      </td>
    </tr>
  );
}
