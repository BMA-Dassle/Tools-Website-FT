"use client";

import { IconArrowLeft, IconMail, IconPhone, IconPlus } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { createPortal } from "react-dom";
import {
  COLD_FILTER_LABEL,
  COLD_ROW_FILTERS,
  COLD_TEST_IDS,
  isColdRowFilter,
  type ColdListView,
  type ColdRowFilter,
  type ColdRowView,
} from "~/features/crm/cold/contracts";
import { COLD_POLL_MS, coldKeys } from "~/features/crm/cold/queries";
import { CRM_BASE } from "~/features/crm/core/contracts";
import { fStamp } from "~/features/crm/core/dates";
import { prettyNumber } from "../calls/model";
import { errorMessage } from "../lib/crm-fetch";
import { useUrlQuery } from "../lib/use-url-query";
import { useCrmFetch, useCrmSheet, useCrmToast, useTopbarSlot } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { Seg } from "../primitives/Seg";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { Table } from "../primitives/Table";
import { Tile } from "../primitives/Tile";
import { ColdDispositionSheet } from "./ColdDispositionSheet";
import { ConvertSheet } from "./ConvertSheet";
import { callbackDue, canConvert, dispositionKind, matchLabel, pct, rowTitle } from "./model";
import { fetchColdList } from "./queries";

/**
 * The dialling list (`crm-shared.js:439-441`): four tiles, the row table, and
 * "Dial next" in the topbar.
 *
 * CALL AND EMAIL ONLY, by design (R8). A cold row never gave us its number for
 * an enquiry, so no consent basis exists for a text; the row offers a call and
 * a mail link, and the disposition sheet says why there is no third button.
 * That changes the day the contact texts us first, which is C1's rail, not
 * this one's.
 */
export function ColdListDetail({
  listId,
  query,
}: {
  listId: string;
  query: Record<string, string>;
}) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const slot = useTopbarSlot();
  const { openSheet, closeSheet } = useCrmSheet();
  const [urlQuery, setUrlQuery] = useUrlQuery(query);

  const filter: ColdRowFilter = isColdRowFilter(urlQuery.f) ? urlQuery.f : "all";
  const cursor = urlQuery.cursor ?? null;
  const params: Record<string, string> = {};
  if (filter !== "all") params.filter = filter;
  if (cursor) params.cursor = cursor;

  const q = useQuery({
    queryKey: coldKeys.list(listId, params),
    queryFn: () => fetchColdList(crmFetch, listId, params),
    refetchInterval: COLD_POLL_MS,
    refetchIntervalInBackground: false,
  });

  const data = q.data;
  const list = data?.list ?? null;

  const openConvert = (row: ColdRowView) =>
    openSheet({
      title: `Convert ${rowTitle(row)}`,
      icon: <IconPlus {...ICON} />,
      wide: true,
      testId: COLD_TEST_IDS.convertSheet,
      body: (
        <ConvertSheet
          row={row}
          defaultCentre={list?.centre ?? null}
          onDone={(_updated, publicId) => {
            void qc.invalidateQueries({ queryKey: coldKeys.all });
            toast(`${publicId} is on the pipeline`);
            closeSheet();
          }}
        />
      ),
    });

  const openDispo = (row: ColdRowView) =>
    openSheet({
      title: `Log this call · ${rowTitle(row)}`,
      icon: <IconPhone {...ICON} />,
      wide: true,
      testId: COLD_TEST_IDS.dispositionSheet,
      body: (
        <ColdDispositionSheet
          row={row}
          onDone={() => closeSheet()}
          onInterested={(r) => openConvert(r)}
        />
      ),
    });

  const next = data?.next ?? null;

  return (
    <>
      {slot && next
        ? createPortal(
            <a className="btn btn-primary btn-sm" href={`tel:${next.phoneE164}`}>
              <IconPhone {...ICON} /> <span className="lbl">Dial next · {rowTitle(next)}</span>
            </a>,
            slot,
          )
        : null}

      <div data-testid={COLD_TEST_IDS.list}>
        <div className="hstack" style={{ gap: 8, marginBottom: 8 }}>
          <Link href={`${CRM_BASE}/cold`} className="btn btn-sm">
            <IconArrowLeft {...ICON} /> <span className="lbl">All cold lists</span>
          </Link>
          {list ? <h2 style={{ fontSize: 16, margin: 0 }}>{list.name}</h2> : null}
        </div>

        {q.isPending ? <LoadingState label="Loading the list…" /> : null}
        {q.isError ? (
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        ) : null}

        {list && list.status === "staged" ? (
          <Banner tone="warn">
            This import was never finished — the rows are saved, but the columns have not been
            confirmed. Nothing is lost; open Import CSV to finish it.
          </Banner>
        ) : null}

        {list ? <ColdTiles list={list} /> : null}

        <Seg
          label="Filter rows"
          options={COLD_ROW_FILTERS.map((f) => ({ value: f, label: COLD_FILTER_LABEL[f] }))}
          value={filter}
          onChange={(v) => setUrlQuery({ f: v === "all" ? null : v, cursor: null })}
        />

        {data ? (
          <div className="card" data-testid={COLD_TEST_IDS.rows}>
            <Table
              caption={`Rows of ${list?.name ?? "this list"}`}
              columns={[
                { key: "company", label: "Company" },
                { key: "contact", label: "Contact" },
                { key: "phone", label: "Phone" },
                { key: "disposition", label: "Disposition" },
                { key: "when", label: "When" },
                { key: "actions", label: <span className="sr-only">Actions</span> },
              ]}
            >
              {data.rows.map((row) => (
                <ColdRow
                  key={row.id}
                  row={row}
                  onLog={() => openDispo(row)}
                  onConvert={() => openConvert(row)}
                />
              ))}
            </Table>
            {data.rows.length === 0 ? (
              <EmptyState icon={<IconPhone {...ICON} />}>
                {filter === "all" ? "Nothing in this list yet." : "No rows match this filter."}
              </EmptyState>
            ) : null}
          </div>
        ) : null}

        {data && (data.nextCursor || cursor) ? (
          <div className="hstack" style={{ justifyContent: "center", padding: 8, gap: 8 }}>
            {cursor ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setUrlQuery({ cursor: null })}
              >
                Back to the top
              </button>
            ) : null}
            {data.nextCursor ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setUrlQuery({ cursor: data.nextCursor })}
              >
                More rows
              </button>
            ) : null}
          </div>
        ) : null}

        <p className="muted xs">
          Call and email only — a cold row has not given us a number for an enquiry, so a text has
          no consent basis. Every outcome you log counts on Accountability.
        </p>
      </div>
    </>
  );
}

/** The four tiles (`crm-shared.js:440`), with conversion where the prototype had it. */
function ColdTiles({ list }: { list: ColdListView }) {
  const called = pct(list.stats.called, list.stats.rows);
  return (
    <div className="grid grid-4" data-testid={COLD_TEST_IDS.stats}>
      <Tile
        label="Called"
        value={`${called}%`}
        meter={{ p: called }}
        sub={`${list.stats.called} of ${list.stats.rows}`}
      />
      <Tile
        label="Interested"
        value={list.stats.interested}
        sub={`${list.stats.converted} converted`}
      />
      <Tile
        label="Booked"
        value={list.stats.booked}
        sub={
          list.stats.converted
            ? `${pct(list.stats.booked, list.stats.converted)}% of conversions`
            : "none yet"
        }
      />
      <Tile
        label="Owner"
        value={<span style={{ fontSize: 16 }}>{list.ownerRepName ?? "Nobody"}</span>}
        sub={
          list.stats.skipped
            ? `${list.stats.skipped} skipped at import`
            : `${list.stats.dialable} with a number`
        }
      />
    </div>
  );
}

function ColdRow({
  row,
  onLog,
  onConvert,
}: {
  row: ColdRowView;
  onLog: () => void;
  onConvert: () => void;
}) {
  const matched = matchLabel(row);
  const due = callbackDue(row, new Date());
  return (
    <tr data-testid={COLD_TEST_IDS.rowRow(row.id)}>
      <td className="strong">
        {row.leadPublicId ? (
          <Link href={`${CRM_BASE}/deal/${encodeURIComponent(row.leadPublicId)}`}>
            {rowTitle(row)}
          </Link>
        ) : (
          rowTitle(row)
        )}
        {row.city ? <div className="muted xs">{row.city}</div> : null}
      </td>
      <td>
        {row.contactName ?? <span className="muted">—</span>}
        {matched ? (
          <div className="muted xs">
            Matched · {matched}
            {row.accountName ? ` · ${row.accountName}` : ""}
          </div>
        ) : null}
      </td>
      <td>
        {row.phoneE164 ? (
          <a href={`tel:${row.phoneE164}`}>{prettyNumber(row.phoneE164)}</a>
        ) : (
          <span className="muted" title={row.phoneRaw ?? undefined}>
            {row.phoneRaw ? `${row.phoneRaw} · cannot dial` : "—"}
          </span>
        )}
      </td>
      <td>
        {row.disposition ? (
          <Chip kind={dispositionKind(row.disposition)}>{row.disposition}</Chip>
        ) : (
          <span className="muted">Not called</span>
        )}
        {row.leadPublicId ? <div className="muted xs">&rarr; {row.leadPublicId}</div> : null}
        {due ? <div className="muted xs">callback due</div> : null}
      </td>
      <td className="muted">{row.dispositionAt ? fStamp(row.dispositionAt) : "—"}</td>
      <td>
        <div className="hstack" style={{ gap: 4, justifyContent: "flex-end" }}>
          {row.phoneE164 ? (
            <a
              className="btn btn-sm btn-icon"
              href={`tel:${row.phoneE164}`}
              aria-label={`Call ${rowTitle(row)}`}
              title={`Call ${rowTitle(row)}`}
            >
              <IconPhone {...ICON} />
            </a>
          ) : null}
          {row.email ? (
            <a
              className="btn btn-sm btn-icon"
              href={`mailto:${row.email}`}
              aria-label={`Email ${rowTitle(row)}`}
              title={`Email ${rowTitle(row)}`}
            >
              <IconMail {...ICON} />
            </a>
          ) : null}
          <button type="button" className="btn btn-sm" onClick={onLog}>
            {row.disposition ? "Re-log" : "Log this call"}
          </button>
          {canConvert(row) ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={onConvert}>
              Convert
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
