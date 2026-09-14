"use client";

import { IconAlertTriangle, IconHeadset } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { RULES_TEST_IDS, type GsMemberWire, type GsPostBody } from "~/features/crm/rules/contracts";
import { rulesKeys } from "~/features/crm/rules/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { Pill } from "../primitives/Pill";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { Table } from "../primitives/Table";
import { parseDepartmentIds } from "./model";
import { fetchGs, postGs } from "./queries";

/**
 * "Guest Services" — the bucket's shift coverage and its sign-in list (owner
 * decision 2026-09-13, §5.7b).
 *
 * Guest Services is not a 7shifts USER, it is a 7shifts DEPARTMENT: the bucket
 * counts as on shift whenever anyone in the call centre is. The department id
 * lives in `crm_settings.sevenshifts` and is editable here.
 *
 * The toggle column is deliberately NOT a bulk import. The department contains
 * both directors; mapping its emails to the bucket would sign Eric and Jacob in
 * AS Guest Services and lose their own rows, so every member starts OFF, anyone
 * who already has a rep row (or is a service account) cannot be ticked at all,
 * and the director ticks the real agents one at a time.
 */
export function GuestServicesCard({ canEdit }: { canEdit: boolean }) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const ids = useId();
  const [departmentsText, setDepartmentsText] = useState<string | null>(null);

  const gsQ = useQuery({
    queryKey: rulesKeys.gs(),
    queryFn: () => fetchGs(crmFetch),
  });

  const post = useMutation({
    mutationFn: (body: GsPostBody) => postGs(crmFetch, body),
    onSuccess: (data, body) => {
      qc.setQueryData(rulesKeys.gs(), data);
      void qc.invalidateQueries({ queryKey: rulesKeys.all });
      if (body.action === "departments") {
        setDepartmentsText(null);
        toast("Guest Services departments saved");
      } else {
        toast(
          body.works
            ? `${body.email} works leads as Guest Services`
            : `${body.email} no longer works leads as Guest Services`,
        );
      }
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const data = gsQ.data;
  const busy = post.isPending;
  const stored = data ? data.setting.gsDepartmentIds.join(", ") : "";
  const text = departmentsText ?? stored;
  const parsedIds = parseDepartmentIds(text);
  const dirty = departmentsText !== null && text.trim() !== stored;

  return (
    <div className="card" data-testid={RULES_TEST_IDS.gs}>
      <div className="card-h">
        <h2>Guest Services{data ? ` · ${data.setting.gsDepartmentName}` : ""}</h2>
        <div className="right">{data?.gsRep ? <Pill>{data.gsRep.displayName}</Pill> : null}</div>
      </div>

      {gsQ.isPending ? <LoadingState label="Loading the call center…" /> : null}
      {gsQ.isError ? (
        <div className="pad">
          <ErrorState message={errorMessage(gsQ.error)} onRetry={() => void gsQ.refetch()} />
        </div>
      ) : null}

      {data ? (
        <div className="pad stack">
          <div className="xs muted">
            The bucket is on shift whenever anyone in these 7shifts departments is. Membership
            decides shift coverage only — who may work leads as Guest Services is ticked below, one
            person at a time.
          </div>

          <div className="field">
            <label htmlFor={`${ids}-depts`}>7shifts department ids</label>
            <span className="hstack">
              <input
                id={`${ids}-depts`}
                className="input tabular"
                inputMode="numeric"
                value={text}
                disabled={!canEdit || busy}
                aria-invalid={parsedIds === null}
                onChange={(e) => setDepartmentsText(e.target.value)}
              />
              {canEdit ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || !dirty || parsedIds === null}
                  onClick={() =>
                    parsedIds && post.mutate({ action: "departments", ids: parsedIds })
                  }
                >
                  Save
                </button>
              ) : null}
            </span>
          </div>
          {parsedIds === null ? (
            <Banner tone="warn">Department ids are whole numbers, separated by commas.</Banner>
          ) : null}

          {!data.configured ? (
            <Banner tone="warn">
              SEVEN_SHIFTS_API_TOKEN is not set, so the department cannot be read. The bucket has no
              mirrored shifts until it is.
            </Banner>
          ) : null}
          {data.membersError ? (
            <Banner tone="crit" icon={<IconAlertTriangle {...ICON} />}>
              7shifts did not answer: {data.membersError}
            </Banner>
          ) : null}
          {!data.gsRep ? (
            <Banner tone="warn">
              There is no Guest Services rep row yet — run the seed from Statuses before ticking
              anyone.
            </Banner>
          ) : null}
        </div>
      ) : null}

      {data && data.configured && data.members.length === 0 && !data.membersError ? (
        <EmptyState>Nobody is in those departments.</EmptyState>
      ) : null}

      {data && data.members.length > 0 ? (
        <Table
          columns={[
            { key: "person", label: "Person" },
            { key: "email", label: "Sign-in address" },
            { key: "works", label: "Works leads as Guest Services" },
          ]}
          caption={`Members of ${data.setting.gsDepartmentName}`}
        >
          {data.members.map((m) => (
            <MemberRow
              key={m.sevenShiftsUserId}
              member={m}
              canEdit={canEdit}
              busy={busy}
              onToggle={(works) =>
                m.email && post.mutate({ action: "login", email: m.email, works })
              }
            />
          ))}
        </Table>
      ) : null}
    </div>
  );
}

function MemberRow({
  member,
  canEdit,
  busy,
  onToggle,
}: {
  member: GsMemberWire;
  canEdit: boolean;
  busy: boolean;
  onToggle: (works: boolean) => void;
}) {
  const disabled = !canEdit || busy || (!member.eligible && !member.worksAsGs);
  return (
    <tr>
      <td>
        <span className="hstack">
          <IconHeadset {...ICON} />
          {member.name}
        </span>
      </td>
      <td>
        {member.email ? (
          <span className="hstack">
            {member.email}
            {member.external ? <Chip kind="warn">personal address</Chip> : null}
          </span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        <span className="hstack">
          <button
            type="button"
            className="toggle"
            role="switch"
            aria-checked={member.worksAsGs}
            aria-label={`${member.name} works leads as Guest Services`}
            data-testid={RULES_TEST_IDS.gsToggle(member.sevenShiftsUserId)}
            disabled={disabled}
            onClick={() => onToggle(!member.worksAsGs)}
          />
          {member.blockedReason ? (
            <span className="xs muted">{member.blockedReason}</span>
          ) : (
            <span className="xs muted">{member.worksAsGs ? "signs in as the bucket" : "no"}</span>
          )}
        </span>
      </td>
    </tr>
  );
}
