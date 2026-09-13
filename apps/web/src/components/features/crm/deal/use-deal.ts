"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { CrmStatus } from "~/features/crm/core/types";
import { leadsKeys } from "~/features/crm/leads/queries";
import { useCrmFetch } from "../lib/use-crm-user";
import { fetchLead, statusIndex } from "../leads/queries";
import { fetchStatuses, statusesKeys } from "../statuses/queries";

/** The deal in one read (`GET /leads/[id]`), keyed by public id. */
export function useLeadDetail(publicId: string | null) {
  const crmFetch = useCrmFetch();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: leadsKeys.detail(publicId ?? ""),
    queryFn: () => fetchLead(crmFetch, publicId!),
    enabled: !!publicId,
  });
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: leadsKeys.all });
  }, [qc]);
  return { ...q, refresh };
}

/** `crm_statuses` as a lookup for chips — shared with the Statuses screen's cache. */
export function useStatusIndex(): Map<string, CrmStatus> {
  const crmFetch = useCrmFetch();
  const q = useQuery({
    queryKey: statusesKeys.list(),
    queryFn: () => fetchStatuses(crmFetch),
    staleTime: 5 * 60_000,
  });
  return statusIndex(q.data?.statuses);
}
