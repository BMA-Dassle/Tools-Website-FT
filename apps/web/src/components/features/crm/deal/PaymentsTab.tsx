"use client";

import { IconCheck, IconGift, IconList, IconRefresh } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { CRM_BASE } from "~/features/crm/core/contracts";
import { CONTRACT_TEST_IDS } from "~/features/crm/contracts/contracts";
import { contractsKeys } from "~/features/crm/contracts/queries";
import { money, moneyExact } from "~/features/crm/core/format";
import { LEAD_TEST_IDS } from "~/features/crm/leads/contracts";
import { fetchContract, fetchContractPayments } from "../contracts/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { Kv } from "../primitives/Kv";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import type { DealTabProps } from "./tabs";

/**
 * The deal's Payments tab (crm-events.js:161) — the LIVE Square timeline for
 * the contract, not a projection of our own columns.
 *
 * A Square failure is SHOWN. The prototype had no failure state, and the
 * tempting version of this tab renders an empty timeline when Square is down,
 * which reads as "nothing has been collected" — the worst possible lie on a
 * payments screen. The service returns `{timeline, error}` and the error gets
 * a banner of its own; each node also carries its own `error` when one order
 * out of four could not be read, and that shows too.
 */
const NODE_ICON = {
  deposit: IconCheck,
  funding_gift_card: IconGift,
  balance: IconCheck,
  dayof_order: IconList,
  settled_order: IconList,
} as const;

export default function PaymentsTab({ detail }: DealTabProps) {
  const crmFetch = useCrmFetch();
  const shortId = detail.lead.gfShortId;

  const detailQ = useQuery({
    queryKey: contractsKeys.detail(shortId ?? ""),
    queryFn: () => fetchContract(crmFetch, shortId!),
    enabled: Boolean(shortId),
  });

  const paymentsQ = useQuery({
    queryKey: contractsKeys.payments(shortId ?? ""),
    queryFn: () => fetchContractPayments(crmFetch, shortId!),
    enabled: Boolean(shortId),
    staleTime: 30_000,
  });

  if (!shortId) {
    return (
      <div className="card" data-testid={LEAD_TEST_IDS.dealTab("payments")}>
        <EmptyState>No payments until the contract is sent and signed.</EmptyState>
      </div>
    );
  }

  const row = detailQ.data?.contract.row ?? null;
  const timeline = paymentsQ.data?.timeline ?? [];
  const squareError = paymentsQ.data?.error ?? null;

  return (
    <div className="deal-grid" data-testid={CONTRACT_TEST_IDS.paymentsTab}>
      <div className="stack" style={{ gap: 16 }}>
        <div className="card">
          <div className="card-h">
            <h2>Square timeline</h2>
            <div className="right">
              <button
                type="button"
                className="btn btn-sm"
                disabled={paymentsQ.isFetching}
                onClick={() => void paymentsQ.refetch()}
              >
                <IconRefresh {...ICON} />{" "}
                {paymentsQ.isFetching ? "Refreshing…" : "Refresh from Square"}
              </button>
            </div>
          </div>
          <div className="pad stack">
            {paymentsQ.isPending ? <LoadingState label="Reading Square…" /> : null}
            {paymentsQ.isError ? (
              <ErrorState
                message={errorMessage(paymentsQ.error)}
                onRetry={() => void paymentsQ.refetch()}
              />
            ) : null}
            {squareError ? (
              <Banner tone="crit">
                Square could not be read: {squareError}. This is NOT &ldquo;nothing collected&rdquo;
                — try Refresh, and check the money in Square directly before acting on this screen.
              </Banner>
            ) : null}
            {paymentsQ.data && timeline.length === 0 && !squareError ? (
              <EmptyState>Contract sent · nothing collected yet</EmptyState>
            ) : null}
          </div>
          {timeline.length ? (
            <div className="timeline">
              {timeline.map((n, i) => {
                const Icon = NODE_ICON[n.kind] ?? IconList;
                return (
                  <div key={`${n.kind}-${i}`} className="tl" data-kind="payment">
                    <div className="dot">
                      <Icon {...ICON} />
                    </div>
                    <div className="body">
                      <div className="who">
                        <span>{n.label}</span>
                      </div>
                      {n.order ? (
                        <>
                          <div className="txt">
                            <b>{moneyExact(n.order.totalCents)}</b>{" "}
                            <Chip
                              kind={
                                n.order.state === "COMPLETED"
                                  ? "won"
                                  : n.order.state === "OPEN"
                                    ? "open"
                                    : "warn"
                              }
                            >
                              {n.order.state}
                            </Chip>
                          </div>
                          <div className="xs muted">
                            <span className="mono">{n.order.id}</span> · due{" "}
                            {moneyExact(n.order.netDueCents)} · tax {moneyExact(n.order.taxCents)} ·
                            service charge {moneyExact(n.order.serviceChargeCents)}
                          </div>
                          {n.order.tenders.length ? (
                            <div className="xs muted">
                              {n.order.tenders.map((t) => (
                                <span key={t.paymentId} style={{ marginRight: 8 }}>
                                  {moneyExact(t.amountCents)} {t.status ?? ""}
                                  {t.refundedCents
                                    ? ` · refunded ${moneyExact(t.refundedCents)}`
                                    : ""}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                      {n.giftCard ? (
                        <div className="xs muted">
                          <span className="mono">{n.giftCard.gan}</span> · {n.giftCard.state} ·
                          balance {moneyExact(n.giftCard.balanceCents)}
                        </div>
                      ) : null}
                      {n.error ? (
                        <div className="xs" style={{ color: "var(--crit-ink)" }}>
                          {n.error}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        {row?.status === "balance_link_sent" ? (
          <Banner tone="warn">
            The card on file did not go through. A payment link has been sent
            {row.balanceLinkSentAt ? "" : ""}; it reconciles automatically when the guest pays.
          </Banner>
        ) : null}
      </div>

      <div className="stack" style={{ gap: 16 }}>
        <div className="card">
          <div className="card-h">
            <h2>Money</h2>
          </div>
          <div className="pad">
            {detailQ.isPending ? <LoadingState /> : null}
            {row ? (
              <Kv
                rows={[
                  { label: "Total", value: moneyExact(row.totalCents) },
                  { label: "Deposit due", value: moneyExact(row.depositDueCents) },
                  { label: "Collected", value: moneyExact(row.collectedCents) },
                  {
                    label: "Balance",
                    value: <span className="strong">{moneyExact(row.balanceCents)}</span>,
                  },
                  {
                    label: "Method",
                    value: row.balancePaidAt
                      ? "card on file"
                      : row.status === "balance_link_sent"
                        ? "payment link"
                        : "auto-charge at T-72h",
                  },
                ]}
              />
            ) : null}
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h2>Refunds &amp; edits</h2>
          </div>
          <div className="pad stack small">
            <div className="muted">
              Changing headcount, lanes, heats or food after signing re-prices the contract. A price
              increase charges the card on file; a decrease refunds to the card or to a HeadPinz
              gift card, and requires a reason for accounting.
            </div>
            <div className="hstack">
              <Link className="btn btn-sm" href={`${CRM_BASE}/builder/${detail.lead.publicId}`}>
                Edit event
              </Link>
            </div>
            <div className="xs muted">
              Refunds are issued by the settlement cron once BMI shows Cancellation — never from
              this screen. Cancel the event on the Contract tab and watch it confirm.
            </div>
            {row ? (
              <div className="xs muted">
                Collected {money(row.collectedCents)} of {money(row.totalCents)}.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
