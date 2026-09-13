import type {
  ContractActionResponse,
  ContractCancelResponse,
  ContractDetailResponse,
  ContractHistoryResponse,
  ContractPaymentsResponse,
  ContractsListResponse,
} from "~/features/crm/contracts/contracts";
import type { CrmFetch } from "../lib/crm-fetch";

/**
 * Fetchers for the contracts routes (keys live in
 * `~/features/crm/contracts/queries`, imported by path — never the server
 * barrel). Mutations invalidate `contractsKeys.all`.
 */

function qs(params: Record<string, string | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export interface ContractsListParams {
  win: string;
  status?: string;
  centre?: string;
  rep?: string;
  q?: string;
  closed?: boolean;
  cursor?: string | null;
  limit?: number;
}

export const fetchContracts = (f: CrmFetch, p: ContractsListParams) =>
  f<ContractsListResponse>(
    `/contracts${qs({
      win: p.win,
      status: p.status && p.status !== "all" ? p.status : null,
      centre: p.centre && p.centre !== "all" ? p.centre : null,
      rep: p.rep && p.rep !== "all" ? p.rep : null,
      q: p.q?.trim() || null,
      closed: p.closed ? "1" : null,
      cursor: p.cursor ?? null,
      limit: p.limit ? String(p.limit) : null,
    })}`,
  );

export const fetchContractCounts = (f: CrmFetch) => f<ContractsListResponse>("/contracts?counts=1");

const base = (shortId: string) => `/contracts/${encodeURIComponent(shortId)}`;

export const fetchContract = (f: CrmFetch, shortId: string) =>
  f<ContractDetailResponse>(base(shortId));

export const fetchContractPayments = (f: CrmFetch, shortId: string) =>
  f<ContractPaymentsResponse>(`${base(shortId)}?payments=1`);

export const fetchContractHistory = (f: CrmFetch, shortId: string) =>
  f<ContractHistoryResponse>(`${base(shortId)}?history=1`);

export const postApprove = (f: CrmFetch, shortId: string, memo: string | null) =>
  f<ContractActionResponse>(`${base(shortId)}/approve`, { body: { memo } });

export const postDeny = (f: CrmFetch, shortId: string, reason: string) =>
  f<ContractActionResponse>(`${base(shortId)}/deny`, { body: { reason } });

export const postResend = (f: CrmFetch, shortId: string, note: string | null) =>
  f<ContractActionResponse>(`${base(shortId)}/resend`, { body: { note } });

export const postRemind = (f: CrmFetch, shortId: string, ruleKey: string) =>
  f<ContractActionResponse>(`${base(shortId)}/remind`, { body: { ruleKey } });

export const postChargeBalance = (f: CrmFetch, shortId: string, reason: string | null) =>
  f<ContractActionResponse>(`${base(shortId)}/charge-balance`, { body: { reason } });

export const postSendBalanceLink = (f: CrmFetch, shortId: string, reason: string | null) =>
  f<ContractActionResponse>(`${base(shortId)}/send-balance-link`, { body: { reason } });

export const postBackfillDayof = (f: CrmFetch, shortId: string) =>
  f<ContractActionResponse>(`${base(shortId)}/backfill-dayof`, { body: {} });

export const postCancel = (
  f: CrmFetch,
  shortId: string,
  body: { reason: string; note: string | null },
) => f<ContractCancelResponse>(`${base(shortId)}/cancel`, { body: { ...body } });
