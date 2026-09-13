import type {
  AccountResponse,
  BackfillJobPayload,
  HistoryResponse,
  JobsRunResponse,
  LastYearResponse,
} from "~/features/crm/core/contracts";
import type { CrmFetch } from "../lib/crm-fetch";

/**
 * Fetchers for the History & Accounts screens (keys live in
 * `~/features/crm/bmi/queries`, imported by path — never the server barrel).
 */
export interface HistoryParams {
  q: string;
  accountsCursor?: string | null;
  eventsCursor?: string | null;
  /** That list has been paged to its end: ask the server to skip it entirely. */
  accountsDone?: boolean;
  eventsDone?: boolean;
  /** The mirror's counts — first page of a screen only (two table counts). */
  withStatus?: boolean;
}

function qs(params: Record<string, string | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const fetchHistory = (f: CrmFetch, p: HistoryParams) =>
  f<HistoryResponse>(
    `/history${qs({
      q: p.q,
      accountsCursor: p.accountsCursor,
      eventsCursor: p.eventsCursor,
      accounts: p.accountsDone ? "0" : null,
      events: p.eventsDone ? "0" : null,
      status: p.withStatus === false ? "0" : null,
    })}`,
  );

export const fetchAccount = (f: CrmFetch, id: string, cursor?: string | null) =>
  f<AccountResponse>(`/accounts/${encodeURIComponent(id)}${qs({ cursor })}`);

export const fetchLastYear = (f: CrmFetch, clientKey: string | null, cursor?: string | null) =>
  f<LastYearResponse>(`/last-year${qs({ clientKey, cursor })}`);

/**
 * One backfill RUN. The first press sends `{clientKey, from, until}`; every
 * press after that sends the cursor the previous run returned as
 * `result.nextPayload`, which is what makes a multi-window span finish (a
 * fresh span payload always restarts at the first window).
 */
export const runBackfill = (f: CrmFetch, payload: BackfillJobPayload | Record<string, unknown>) =>
  f<JobsRunResponse>("/jobs/run", { body: { kind: "bmi-mirror-backfill", payload } });

export const runDelta = (f: CrmFetch, clientKey: string | null) =>
  f<JobsRunResponse>("/jobs/run", {
    body: { kind: "bmi-mirror-delta", payload: clientKey ? { clientKey } : {} },
  });
