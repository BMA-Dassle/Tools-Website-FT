"use client";

import { IconBuilding, IconPlus, IconUser } from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { createPortal } from "react-dom";
import { CRM_BASE } from "~/features/crm/core/contracts";
import type { ScreenProps } from "~/features/crm/core/screens";
import { fDateY } from "~/features/crm/core/dates";
import { money } from "~/features/crm/core/format";
import { historyKeys } from "~/features/crm/bmi/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useTopbarSlot } from "../lib/use-crm-user";
import { Avatar } from "../primitives/Avatar";
import { ICON } from "../primitives/icon-props";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { Table } from "../primitives/Table";
import { Tile } from "../primitives/Tile";
import { IconAvatar } from "./IconAvatar";
import { accountSub, avgSpendCents, prettyPhone } from "./model";
import { fetchAccount } from "./queries";
import { HISTORY_TEST_IDS } from "./test-ids";

/**
 * `/admin/crm/account/<id>` — ported from the prototype's `account` screen
 * (crm-shared.js:434-436): the three tiles (Events · Avg spend · Contacts)
 * and the events table (Date · Ref · Guests · Status · Rep · Spend), every
 * year, newest first. The shell's back arrow points at History.
 *
 * The prototype's rows jump to the deal; deals are the leads PR's, so rows
 * here are plain until B3 links a mirrored project to its lead. "New lead" is
 * the same B3 rail — present, disabled, and says so.
 */
export default function AccountScreen({ view }: ScreenProps) {
  const crmFetch = useCrmFetch();
  const slot = useTopbarSlot();
  const id = view[0] ?? "";

  const accountQ = useInfiniteQuery({
    queryKey: historyKeys.account(id),
    queryFn: ({ pageParam }) => fetchAccount(crmFetch, id, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.eventsNextCursor ?? undefined,
    enabled: id !== "",
  });

  const first = accountQ.data?.pages[0] ?? null;
  const account = first?.account ?? null;
  const contacts = first?.contacts ?? [];
  const events = accountQ.data?.pages.flatMap((p) => p.events) ?? [];

  if (!id) {
    return (
      <div className="card">
        <EmptyState>
          No account id in the URL. <Link href={`${CRM_BASE}/history`}>Back to History</Link>
        </EmptyState>
      </div>
    );
  }

  return (
    <>
      {slot
        ? createPortal(
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled
              title="New leads arrive with the leads PR"
            >
              <IconPlus {...ICON} /> New lead
            </button>,
            slot,
          )
        : null}

      {accountQ.isPending ? <LoadingState label="Loading account…" /> : null}
      {accountQ.isError ? (
        <ErrorState
          message={errorMessage(accountQ.error)}
          onRetry={() => void accountQ.refetch()}
        />
      ) : null}

      {account ? (
        <>
          <div className="hstack" style={{ alignItems: "flex-start" }}>
            <IconAvatar label={account.kind === "business" ? "Business" : "Household"}>
              {account.kind === "business" ? <IconBuilding {...ICON} /> : <IconUser {...ICON} />}
            </IconAvatar>
            <div>
              <h2 style={{ fontSize: 18, margin: 0 }}>{account.name}</h2>
              <div className="small muted">{accountSub(account)}</div>
            </div>
          </div>

          <div className="grid grid-3">
            <Tile label="Events" value={account.eventCount} />
            <Tile label="Avg spend" value={money(avgSpendCents(account))} />
            <Tile
              label="Contacts"
              value={
                <span style={{ fontSize: 16 }}>
                  {contacts.length
                    ? contacts.map((c) => `${c.firstName} ${c.lastName}`.trim()).join(", ")
                    : "—"}
                </span>
              }
              sub={
                contacts.length
                  ? contacts
                      .map((c) => prettyPhone(c.phoneE164) ?? c.email)
                      .filter(Boolean)
                      .join(" · ")
                  : undefined
              }
            />
          </div>

          <div className="card">
            <div className="card-h">
              <h2>Events</h2>
            </div>
            {events.length === 0 ? (
              <EmptyState>No events mirrored for this account yet.</EmptyState>
            ) : (
              <Table
                testId={HISTORY_TEST_IDS.accountEvents}
                caption={`Events for ${account.name}`}
                columns={[
                  { key: "date", label: "Date" },
                  { key: "ref", label: "Ref" },
                  { key: "guests", label: "Guests" },
                  { key: "status", label: "Status" },
                  { key: "rep", label: "Rep" },
                  { key: "spend", label: "Spend", num: true },
                ]}
              >
                {events.map((e) => (
                  <tr key={e.projectId}>
                    <td>{e.eventDate ? fDateY(e.eventDate) : "—"}</td>
                    <td>{e.number ?? "—"}</td>
                    <td>{e.persons ?? "—"}</td>
                    <td>{e.stateName ?? "—"}</td>
                    <td>
                      {e.rep ? (
                        <span className="hstack">
                          <Avatar
                            initials={e.rep.initials}
                            repSlug={e.rep.slug}
                            name={e.rep.firstName}
                            sm
                          />{" "}
                          {e.rep.firstName}
                        </span>
                      ) : (
                        <span className="muted">{e.responsibleName ?? "—"}</span>
                      )}
                    </td>
                    <td className="num">{money(e.totalValueCents)}</td>
                  </tr>
                ))}
              </Table>
            )}
            {accountQ.hasNextPage ? (
              <div className="pad">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={accountQ.isFetchingNextPage}
                  onClick={() => void accountQ.fetchNextPage()}
                >
                  {accountQ.isFetchingNextPage ? "Loading…" : "Load more"}
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}
