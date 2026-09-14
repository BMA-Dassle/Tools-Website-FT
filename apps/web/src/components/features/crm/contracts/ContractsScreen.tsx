"use client";

import {
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconFile,
  IconSearch,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRef, useState } from "react";
import type { ContractRow, ContractWindow } from "~/features/crm/contracts/contracts";
import {
  CONTRACTS_PAGE_SIZE,
  CONTRACT_TEST_IDS,
  type ContractStatusFilter,
} from "~/features/crm/contracts/contracts";
import { contractsKeys } from "~/features/crm/contracts/queries";
import { CRM_BASE } from "~/features/crm/core/contracts";
import type { ScreenProps } from "~/features/crm/core/screens";
import { rulesKeys } from "~/features/crm/rules/queries";
import { ApproveSheet } from "../deal/ApproveSheet";
import { ContractPanel } from "../deal/ContractPanel";
import { errorMessage } from "../lib/crm-fetch";
import { useDebouncedValue } from "../lib/use-debounced";
import { useUrlQuery } from "../lib/use-url-query";
import { useCrmFetch, useCrmSheet, useCrmUser } from "../lib/use-crm-user";
import { Folders } from "../primitives/Folders";
import { ICON } from "../primitives/icon-props";
import { Seg } from "../primitives/Seg";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { Table } from "../primitives/Table";
import { fetchRoster } from "../rules/queries";
import { AttentionTiles } from "./AttentionTiles";
import { ContractTableRow } from "./ContractRow";
import {
  CENTRE_OPTIONS,
  WINDOW_OPTIONS,
  emptyMessage,
  pagerSummary,
  statusFolderOptions,
  withWeekHeaders,
} from "./model";
import { fetchContracts } from "./queries";
import { live, LIVE_LIST_MS } from "../lib/live";

/**
 * `/admin/crm/contracts` — the prototype's `contracts` screen (crm-events.js:209).
 *
 * Defaults to "Needs attention", which is the whole point of the board: it
 * opens on what a human has to do, not on a list of everything. Every filter
 * lives in the URL, so a link is a saved view (§3.1).
 *
 * PAGING IS KEYSET, so "Page 5" is reached by walking, not by an OFFSET that
 * shifts under you while contracts are being signed. The cursor of each page
 * visited is kept in a ref, which is what makes Back work without re-reading
 * from the start.
 *
 * A row opens the CONTRACT, not the deal: most group-event contracts predate
 * the CRM and have no lead to open. When one does have a lead, the sheet links
 * straight to it.
 */
const SEARCH_DEBOUNCE_MS = 300;

const STATUS_OPTIONS = statusFolderOptions();

export default function ContractsScreen({ query }: ScreenProps) {
  const crmFetch = useCrmFetch();
  const qc = useQueryClient();
  const { isDirector } = useCrmUser();
  const { openSheet, closeSheet } = useCrmSheet();
  const [urlQuery, setQuery] = useUrlQuery(query);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  /** cursor for each page visited; `[0]` is always null (the first page). */
  const trail = useRef<(string | null)[]>([null]);

  const win = (urlQuery.win ?? "attention") as ContractWindow;
  const status = (urlQuery.status ?? "all") as ContractStatusFilter;
  const centre = urlQuery.centre ?? "all";
  const rep = urlQuery.rep ?? "all";
  const closed = urlQuery.closed === "1";
  const past = urlQuery.past === "1";
  const rawSearch = urlQuery.q ?? "";
  const search = useDebouncedValue(rawSearch.trim(), SEARCH_DEBOUNCE_MS, rawSearch.trim());

  const filters = {
    win,
    status,
    centre,
    rep,
    q: search,
    closed: closed ? "1" : "0",
    past: past ? "1" : "0",
  };

  const list = useQuery({
    queryKey: [...contractsKeys.list(filters), cursor ?? "first"],
    queryFn: () =>
      fetchContracts(crmFetch, {
        win,
        status,
        centre,
        rep,
        q: search,
        closed,
        past,
        cursor,
        limit: CONTRACTS_PAGE_SIZE,
      }),
    ...live(LIVE_LIST_MS),
  });

  // The rep dropdown's names. `/roster` is the roster every role may read; it
  // is already cached by the Rules screen, so this is usually free.
  const roster = useQuery({
    queryKey: rulesKeys.roster(),
    queryFn: () => fetchRoster(crmFetch),
    staleTime: 5 * 60_000,
  });

  /** Any filter change restarts the walk — a cursor is only valid for its filters. */
  const patch = (next: Record<string, string | null>) => {
    setCursor(null);
    setPageIndex(0);
    trail.current = [null];
    setQuery(next);
  };

  const rows = list.data?.rows ?? [];
  const counts = list.data?.counts ?? {
    attention: 0,
    pendingApproval: 0,
    outUnsigned: 0,
    outUnsignedCents: 0,
    depositsHeldCents: 0,
    balanceOutstandingCents: 0,
  };
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / CONTRACTS_PAGE_SIZE));
  const banded = withWeekHeaders(rows, win);

  const refresh = () => {
    closeSheet();
    void qc.invalidateQueries({ queryKey: contractsKeys.all });
  };

  const openContract = (row: ContractRow) => {
    if (!row.shortId) return;
    openSheet({
      title: row.title,
      icon: <IconFile {...ICON} />,
      wide: true,
      body: (
        <ContractPanel
          shortId={row.shortId}
          footerLink={
            row.leadPublicId
              ? {
                  href: `${CRM_BASE}/deal/${row.leadPublicId}?tab=contract`,
                  label: "Open the deal ↗",
                }
              : null
          }
        />
      ),
    });
  };

  const openApprove = (row: ContractRow) => {
    if (!row.shortId) return;
    openSheet({
      title: "Approve post-paid contract",
      icon: <IconCheck {...ICON} />,
      testId: CONTRACT_TEST_IDS.approveSheet,
      body: <ApproveSheet row={row} onCancel={closeSheet} onDone={refresh} />,
    });
  };

  const goNext = () => {
    const next = list.data?.nextCursor ?? null;
    if (!next) return;
    trail.current = [...trail.current.slice(0, pageIndex + 1), next];
    setCursor(next);
    setPageIndex(pageIndex + 1);
  };

  const goBack = () => {
    if (pageIndex === 0) return;
    const prev = trail.current[pageIndex - 1] ?? null;
    setCursor(prev);
    setPageIndex(pageIndex - 1);
  };

  return (
    <div className="stack" style={{ gap: 16 }} data-testid={CONTRACT_TEST_IDS.screen}>
      <AttentionTiles counts={counts} onShowAttention={() => patch({ win: "attention" })} />

      <div className="card">
        <div
          className="pad"
          style={{
            padding: "10px 14px",
            display: "flex",
            flexWrap: "wrap",
            gap: "8px 12px",
            alignItems: "center",
          }}
        >
          <Seg
            label="Event window"
            testId={CONTRACT_TEST_IDS.windows}
            value={win}
            options={WINDOW_OPTIONS.map((o) => ({
              value: o.value,
              label: o.label,
              badge: o.value === "attention" ? counts.attention : undefined,
            }))}
            onChange={(v) =>
              // "Past" without closed contracts is an empty board by
              // construction, so the prototype turns the archive on with it.
              patch(v === "past" ? { win: v, closed: "1" } : { win: v })
            }
          />

          <label className="sr-only" htmlFor="crm-contracts-centre">
            Centre
          </label>
          <select
            id="crm-contracts-centre"
            className="select"
            style={{ width: "auto" }}
            value={centre}
            onChange={(e) => patch({ centre: e.target.value === "all" ? null : e.target.value })}
          >
            <option value="all">All centers</option>
            {CENTRE_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>

          <label className="sr-only" htmlFor="crm-contracts-rep">
            Salesperson
          </label>
          <select
            id="crm-contracts-rep"
            className="select"
            style={{ width: "auto" }}
            value={rep}
            onChange={(e) => patch({ rep: e.target.value === "all" ? null : e.target.value })}
          >
            <option value="all">All reps</option>
            {(roster.data?.rows ?? [])
              .filter((r) => r.rep.role !== "hold")
              .map((r) => (
                <option key={r.rep.slug} value={r.rep.slug}>
                  {r.rep.displayName}
                </option>
              ))}
          </select>

          <div className="search" style={{ flex: 1, minWidth: 180, padding: "6px 10px" }}>
            <IconSearch {...ICON} />
            <input
              data-testid={CONTRACT_TEST_IDS.search}
              type="search"
              aria-label="Search contracts"
              placeholder="Guest, business, event #, phone…"
              value={rawSearch}
              onChange={(e) => patch({ q: e.target.value })}
            />
          </div>

          {/* A span, not a <label>: the control is a role="switch" button, which
              a <label> cannot be associated with, and the button already carries
              its own accessible name. */}
          <span className="hstack xs muted" style={{ gap: 6 }}>
            <button
              type="button"
              className="toggle"
              role="switch"
              aria-checked={closed}
              data-testid={CONTRACT_TEST_IDS.closedToggle}
              aria-label="Show completed and cancelled"
              onClick={() => patch({ closed: closed ? null : "1" })}
            />
            show completed &amp; cancelled
          </span>
          {/* Past events are OUT of Needs attention by default, financial issue
              or not (owner, 2026-09-14: "By default hide past contracts even if
              finacial issue. Just have a toggle or something to show"). Turning
              it on also brings in the unsettled day-of Square orders going back
              to May, which is the ~230 the badge used to count over a list that
              never showed them. Only meaningful on the attention window. */}
          {win === "attention" ? (
            <span className="hstack xs muted" style={{ gap: 6 }}>
              <button
                type="button"
                className="toggle"
                role="switch"
                aria-checked={past}
                data-testid={CONTRACT_TEST_IDS.pastToggle}
                aria-label="Show past events that still need attention"
                onClick={() => patch({ past: past ? null : "1" })}
              />
              show past
            </span>
          ) : null}
        </div>

        <div style={{ padding: "0 14px 10px" }}>
          <Folders
            label="Contract status"
            testId={CONTRACT_TEST_IDS.statusFolders}
            value={status}
            options={STATUS_OPTIONS}
            onChange={(v) => patch({ status: v === "all" ? null : v })}
          />
        </div>
      </div>

      <div className="card">
        {list.isPending ? <LoadingState label="Loading contracts…" /> : null}
        {list.isError ? (
          <div className="pad">
            <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
          </div>
        ) : null}
        {list.data && rows.length === 0 ? (
          <EmptyState icon={<IconCheck {...ICON} />}>{emptyMessage(win)}</EmptyState>
        ) : null}
        {rows.length ? (
          <Table
            className="contracts"
            testId={CONTRACT_TEST_IDS.table}
            caption="Group-event contracts by event date"
            columns={[
              { key: "event", label: "Event" },
              { key: "guest", label: "Guest" },
              { key: "status", label: "Status · why it is here" },
              { key: "total", label: "Total", num: true },
              { key: "deposit", label: "Deposit", num: true },
              { key: "balance", label: "Balance", num: true },
              { key: "rep", label: "Rep" },
              { key: "actions", label: <span className="sr-only">Actions</span> },
            ]}
          >
            {banded.map(({ row, weekHeader }) => (
              <ContractTableRow
                key={row.shortId ?? row.quoteId}
                row={row}
                weekHeader={weekHeader}
                columns={8}
                onOpen={openContract}
                onApprove={isDirector ? openApprove : null}
              />
            ))}
          </Table>
        ) : null}

        <div
          className="pad hstack between xs muted"
          style={{ padding: "10px 14px" }}
          data-testid={CONTRACT_TEST_IDS.pager}
        >
          <span>{pagerSummary(total, CONTRACTS_PAGE_SIZE)}</span>
          <span className="hstack">
            <button
              type="button"
              className="btn btn-sm"
              disabled={pageIndex === 0 || list.isFetching}
              onClick={goBack}
              aria-label="Previous page"
            >
              <IconChevronLeft {...ICON} />
            </button>
            <span>
              Page {pageIndex + 1} of {pages}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!list.data?.nextCursor || list.isFetching}
              onClick={goNext}
              aria-label="Next page"
            >
              <IconChevronRight {...ICON} />
            </button>
          </span>
        </div>
      </div>

      <div className="xs muted">
        Automatic behind the scenes: BMI &ldquo;Send Contract&rdquo; creates and sends · deposit
        paid flips BMI to Confirmation · balance charges 72 h out · day-of order pays from the gift
        card and closes after the event · BMI &ldquo;Cancellation&rdquo; refunds. Failures show up
        in Needs attention, never silently.{" "}
        <Link href={`${CRM_BASE}/statuses`}>Statuses &amp; BMI ↗</Link>
      </div>
    </div>
  );
}
