"use client";

import { IconBolt, IconFile, IconFlag, IconLayersIntersect } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ContractHistoryEntry } from "~/features/daily-events/types";
import { CONTRACT_TEST_IDS } from "~/features/crm/contracts/contracts";
import { contractsKeys } from "~/features/crm/contracts/queries";
import { fStamp } from "~/features/crm/core/dates";
import type { CrmActivity } from "~/features/crm/core/types";
import { fetchContractHistory } from "../contracts/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch } from "../lib/use-crm-user";
import { ICON } from "../primitives/icon-props";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import type { DealTabProps } from "./tabs";

/**
 * The deal's History tab (crm-events.js:172) — "contract audit log · versions ·
 * status changes · BMI syncs", newest first.
 *
 * Two sources, merged: the CONTRACT's own history, which
 * `daily-events/service.ts getContractHistory` already assembles for the
 * reservations-admin board (audit ledger + versions + milestones, with
 * consecutive guest views collapsed), and the CRM's own `crm_activities` rows
 * for this lead. Reusing the first rather than rebuilding it is why the two
 * boards cannot drift apart.
 *
 * A lead with no contract still has a history — its CRM activities — so this
 * tab is never empty just because a contract has not been sent.
 */
type Merged = {
  key: string;
  at: string;
  kind: "contract" | "version" | "status" | "bmi" | "system";
  text: string;
  detail: string | null;
  who: string | null;
  count?: number;
  pdfUrl?: string | null;
};

const KIND_ICON = {
  contract: IconFile,
  version: IconLayersIntersect,
  status: IconFlag,
  bmi: IconBolt,
  system: IconBolt,
} as const;

/** The CRM activity kinds this tab shows — the others live on the Overview timeline. */
const ACTIVITY_KINDS = new Set(["status", "bmi", "system", "payment", "assign"]);

export function mergeHistory(
  entries: readonly ContractHistoryEntry[],
  activities: readonly CrmActivity[],
): Merged[] {
  const rows: Merged[] = [];
  for (const e of entries) {
    rows.push({
      key: `c-${e.kind}-${e.at}-${e.label}`,
      at: e.at,
      kind: e.kind === "version" ? "version" : "contract",
      text: e.label,
      detail: e.detail ?? null,
      who: e.actor ?? null,
      count: e.count,
      pdfUrl: e.pdfUrl ?? null,
    });
  }
  for (const a of activities) {
    if (!ACTIVITY_KINDS.has(a.kind)) continue;
    rows.push({
      key: `a-${a.id}`,
      at: a.occurredAt,
      kind: a.kind === "bmi" ? "bmi" : a.kind === "status" ? "status" : "system",
      text: a.body ?? a.subject ?? a.kind,
      detail: null,
      who: a.actorEmail ?? null,
    });
  }
  return rows.sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
}

export default function HistoryTab({ detail }: DealTabProps) {
  const crmFetch = useCrmFetch();
  const shortId = detail.lead.gfShortId;

  const q = useQuery({
    queryKey: contractsKeys.history(shortId ?? ""),
    queryFn: () => fetchContractHistory(crmFetch, shortId!),
    enabled: Boolean(shortId),
  });

  const rows = mergeHistory(q.data?.entries ?? [], detail.activities);

  return (
    <div className="card" data-testid={CONTRACT_TEST_IDS.historyTab}>
      <div className="card-h">
        <h2>History</h2>
        <div className="right xs muted">
          contract audit log · versions · status changes · BMI syncs
        </div>
      </div>
      {shortId && q.isPending ? <LoadingState label="Loading the contract history…" /> : null}
      {shortId && q.isError ? (
        <div className="pad">
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        </div>
      ) : null}
      {rows.length === 0 && !q.isPending ? (
        <EmptyState>Nothing has happened to this deal yet.</EmptyState>
      ) : null}
      {rows.length ? (
        <div className="timeline">
          {rows.map((r) => {
            const Icon = KIND_ICON[r.kind];
            return (
              <div
                key={r.key}
                className="tl"
                data-kind={
                  r.kind === "contract" ? "payment" : r.kind === "version" ? "bmi" : r.kind
                }
              >
                <div className="dot">
                  <Icon {...ICON} />
                </div>
                <div className="body">
                  <div className="who">
                    <span>{fStamp(r.at)}</span>
                    {r.who ? <span>{r.who}</span> : null}
                  </div>
                  <div className="txt small">
                    {r.text}
                    {r.count && r.count > 1 ? <span className="muted"> ×{r.count}</span> : null}
                  </div>
                  {r.detail ? <div className="xs muted">{r.detail}</div> : null}
                  {r.pdfUrl ? (
                    <div className="xs">
                      <Link href={r.pdfUrl} target="_blank" rel="noreferrer">
                        Signed PDF
                      </Link>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
