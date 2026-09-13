"use client";

import { IconList, IconUpload } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { createPortal } from "react-dom";
import { COLD_POLL_MS, coldKeys } from "~/features/crm/cold/queries";
import { COLD_TEST_IDS, type ColdListView } from "~/features/crm/cold/contracts";
import { CRM_BASE } from "~/features/crm/core/contracts";
import { fDateY } from "~/features/crm/core/dates";
import type { ScreenProps } from "~/features/crm/core/screens";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmSheet, useCrmToast, useTopbarSlot } from "../lib/use-crm-user";
import { Avatar } from "../primitives/Avatar";
import { ICON } from "../primitives/icon-props";
import { Meter } from "../primitives/Meter";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { ColdListDetail } from "./ColdListDetail";
import { ImportSheet } from "./ImportSheet";
import { listMeta, pct } from "./model";
import { fetchColdLists } from "./queries";

/**
 * `/admin/crm/cold[/<listId>]` (`crm-shared.js:439-443`).
 *
 * One screen id, two views, exactly as the prototype's `on("cold", id => …)`:
 * with no id it is the list of lists, with one it is that list's dialling
 * board. The detail lives in its own file so neither is a thousand lines.
 */
export default function ColdListsScreen({ view, query }: ScreenProps) {
  const listId = view[0] ?? null;
  return listId ? <ColdListDetail listId={listId} query={query} /> : <ColdLists />;
}

function ColdLists() {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const slot = useTopbarSlot();
  const { openSheet, closeSheet } = useCrmSheet();

  const q = useQuery({
    queryKey: coldKeys.lists(),
    queryFn: () => fetchColdLists(crmFetch),
    refetchInterval: COLD_POLL_MS,
    refetchIntervalInBackground: false,
  });

  const data = q.data;

  const openImport = () =>
    openSheet({
      title: "Import cold list",
      icon: <IconUpload {...ICON} />,
      wide: true,
      testId: COLD_TEST_IDS.importSheet,
      body: data ? (
        <ImportSheet
          reps={data.reps}
          defaultOwnerRepId={null}
          onImported={(list) => {
            toast(`${list.name} imported`);
            closeSheet();
          }}
        />
      ) : null,
    });

  return (
    <>
      {slot
        ? createPortal(
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={openImport}
              disabled={!data}
            >
              <IconUpload {...ICON} /> <span className="lbl">Import CSV</span>
            </button>,
            slot,
          )
        : null}

      <div data-testid={COLD_TEST_IDS.screen}>
        {q.isPending ? <LoadingState label="Loading your cold lists…" /> : null}
        {q.isError ? (
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        ) : null}

        {data ? (
          <div className="card list" data-testid={COLD_TEST_IDS.lists}>
            {data.lists.map((list) => (
              <ColdListRow key={list.id} list={list} />
            ))}
            {data.lists.length === 0 ? (
              <EmptyState icon={<IconList {...ICON} />}>
                No cold lists yet. Import a CSV — chamber members, an association export, last
                year&rsquo;s hosts — map the columns, and dial down it.
              </EmptyState>
            ) : null}
          </div>
        ) : null}

        <p className="muted xs">
          A cold row is a prospect, not a lead: nothing is booked in BMI until a rep converts one on
          real interest. Cold rows are Call and Email only — they have not given us a number for an
          enquiry, so there is no basis for a text.
        </p>
      </div>
    </>
  );
}

/** One `.row` of the lists card (`crm-shared.js:442`), with its progress meter. */
function ColdListRow({ list }: { list: ColdListView }) {
  const called = pct(list.stats.called, list.stats.rows);
  return (
    <Link
      className="row"
      href={`${CRM_BASE}/cold/${encodeURIComponent(list.id)}`}
      data-testid={COLD_TEST_IDS.listRow(list.id)}
    >
      <Avatar icon={<IconList {...ICON} />} />
      <div>
        <div className="title">{list.name}</div>
        <div className="meta">
          {listMeta(list).map((m) => (
            <span key={m}>{m}</span>
          ))}
          <span>imported {fDateY(list.createdAt)}</span>
        </div>
        <Meter pct={called} className="cold-progress" label={`${called}% of ${list.name} called`} />
      </div>
      <div className="right">
        <span className="small">
          <b>{list.stats.interested}</b> interested · <b>{list.stats.booked}</b> booked
        </span>
        <span className="xs muted">{called}% called</span>
      </div>
    </Link>
  );
}
