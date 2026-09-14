"use client";

import { IconPlus } from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { createPortal } from "react-dom";
import { CRM_BASE, type MirrorEvent } from "~/features/crm/core/contracts";
import type { ScreenProps } from "~/features/crm/core/screens";
import { fDateY } from "~/features/crm/core/dates";
import { money } from "~/features/crm/core/format";
import { eventDayHref } from "~/features/crm/core/nav";
import { historyKeys } from "~/features/crm/bmi/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useScreenHead, useTopbarSlot } from "../lib/use-crm-user";
import { Avatar } from "../primitives/Avatar";
import { ICON } from "../primitives/icon-props";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { Table } from "../primitives/Table";
import { Tile } from "../primitives/Tile";
import { accountSub, avgSpendCents, prettyPhone } from "./model";
import { fetchAccount } from "./queries";
import { HISTORY_TEST_IDS } from "./test-ids";

/**
 * `/admin/crm/account/<id>` — ported from the prototype's `account` screen
 * (crm-shared.js:434-436): the three tiles (Events · Avg spend · Contacts)
 * and the events table (Date · Ref · Guests · Status · Rep · Spend), every
 * year, newest first. The shell's back arrow points at History.
 *
 * THE ROWS GO SOMEWHERE NOW. They were plain text — the comment here used to
 * say "until B3 links a mirrored project to its lead", and most of these
 * bookings never will have a lead: they predate the CRM. What every one of them
 * does have is a DAY, and the Events board reads BMI directly, so the date cell
 * opens the booking on the day it happened — the same lens the Contracts board
 * links to (owner, 2026-09-13: "Contracts should be more intergrated to
 * events"). A row whose mirrored project has no placeable date stays plain.
 *
 * "New lead" is still the B3 rail — present, disabled, and says so.
 */
export default function AccountScreen({ view }: ScreenProps) {
  const crmFetch = useCrmFetch();
  const slot = useTopbarSlot();
  const id = view[0] ?? "";
  // Hooks stay above every early return (react-hooks/rules-of-hooks).

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

  // The topbar names the ACCOUNT (prototype: "Acme Corp" · "Business · HeadPinz
  // Fort Myers · lifetime $14,260"), so the page has one heading, not two.
  useScreenHead(account?.name ?? null, account ? accountSub(account) : null);

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
                    <td>
                      <EventDayCell event={e} />
                    </td>
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

/**
 * The Date cell, and the way into the booking behind the row: the Events board
 * on the day it happened. A real `<Link>` dressed as the text it replaced
 * (`.link-cell`, the same shape the Contracts table's Event cell uses), so Tab
 * and Enter reach it — a `<tr onClick>` reaches neither.
 */
function EventDayCell({ event }: { event: MirrorEvent }) {
  const href = eventDayHref(event);
  const label = event.eventDate ? fDateY(event.eventDate) : "—";
  if (!href) return <>{label}</>;
  return (
    <Link className="link-cell" href={href} title={`Open the Events board for ${label}`}>
      {label}
    </Link>
  );
}
