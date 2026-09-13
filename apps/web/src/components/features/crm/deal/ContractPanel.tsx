"use client";

import {
  IconAlertTriangle,
  IconBolt,
  IconCheck,
  IconClock,
  IconEye,
  IconFile,
  IconLink,
  IconMail,
  IconMessage,
  IconSend,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { ContractDetail } from "~/features/crm/contracts/contracts";
import { CONTRACT_TEST_IDS } from "~/features/crm/contracts/contracts";
import { contractsKeys } from "~/features/crm/contracts/queries";
import { fStamp } from "~/features/crm/core/dates";
import { money, moneyExact, pct } from "~/features/crm/core/format";
import { GF_STATUS_META } from "~/features/crm/core/types";
import { balanceNote, depositNote, sentBannerText } from "../contracts/model";
import { fetchContract, postBackfillDayof, postRemind } from "../contracts/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmSheet, useCrmToast, useCrmUser } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { Kv } from "../primitives/Kv";
import { Pill } from "../primitives/Pill";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { Tile } from "../primitives/Tile";
import { ApproveSheet } from "./ApproveSheet";
import { CancelSheet } from "./CancelSheet";
import { ChargeSheet } from "./ChargeSheet";
import { DenySheet } from "./DenySheet";
import { GuestViewSheet } from "./GuestViewSheet";
import { ResendSheet } from "./ResendSheet";

/**
 * THE contract body — the prototype's `contractPanel` (crm-events.js:82-99),
 * used in two places so there is one implementation: the deal's Contract tab,
 * and the sheet the Contracts board opens for a contract whose event predates
 * the CRM (most of them) and therefore has no lead to open.
 *
 * Actions follow the prototype's own gating, plus the role rule the brief sets
 * (D15: approvers are everyone with `sales-director`): approve / deny / charge
 * / cancel / fire-a-reminder are director-only; resend, the balance link and
 * "What the guest sees" are not — a rep who cannot resend their own guest's
 * contract has to ask someone else to do their job.
 */
export interface ContractPanelProps {
  shortId: string;
  /** Rendered under the header — the deal's own link, when there is one. */
  footerLink?: { href: string; label: string } | null;
}

export function ContractPanel({ shortId, footerLink = null }: ContractPanelProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const { isDirector } = useCrmUser();
  const { openSheet, closeSheet } = useCrmSheet();
  const [ruleKey, setRuleKey] = useState("");

  const q = useQuery({
    queryKey: contractsKeys.detail(shortId),
    queryFn: () => fetchContract(crmFetch, shortId),
  });

  const backfill = useMutation({
    mutationFn: () => postBackfillDayof(crmFetch, shortId),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: contractsKeys.all });
      toast(r.message);
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const remind = useMutation({
    mutationFn: (key: string) => postRemind(crmFetch, shortId, key),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: contractsKeys.detail(shortId) });
      toast(r.message);
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  if (q.isPending) return <LoadingState label="Loading the contract…" />;
  if (q.isError) {
    return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  }

  const contract: ContractDetail = q.data.contract;
  const row = contract.row;
  const meta = GF_STATUS_META[row.status];
  const paidPct = pct(row.collectedCents, row.totalCents);
  const pageViews = contract.audit.filter((a) => a.event === "page_view").length;
  // Dated on the server beside `daysOut` — never `Date.now()` in a render body.
  const unsignedDays = row.sentAgoDays ?? 0;
  const refresh = () => {
    closeSheet();
    void qc.invalidateQueries({ queryKey: contractsKeys.all });
  };

  const sheet = (title: string, icon: ReactNode, body: ReactNode, testId?: string) =>
    openSheet({ title, icon, body, testId });

  return (
    <div className="deal-grid" data-testid={CONTRACT_TEST_IDS.contractTab}>
      <div className="stack" style={{ gap: 16 }}>
        <div className="card">
          <div className="card-h">
            <Chip kind={meta.kind} title={meta.help}>
              {meta.label}
            </Chip>
            <span className="small muted">{meta.help}</span>
            <div className="right">
              <Pill>#{row.shortId}</Pill>
              {row.eventNumber ? <Pill>{row.eventNumber}</Pill> : null}
            </div>
          </div>
          <div className="pad stack">
            {contract.cancelPending ? (
              <Banner tone="warn" icon={<IconClock {...ICON} />}>
                <b>Cancel pending.</b> BMI was asked to move this event to Cancellation but Office
                has not confirmed it yet. Nothing is recorded as cancelled, and no refund has
                started, until it does — a job is re-checking.
              </Banner>
            ) : null}

            {row.status === "pending_approval" ? (
              <Banner tone="warn" icon={<IconAlertTriangle {...ICON} />}>
                <b>Post-paid account.</b> Approve to send the contract with no deposit, or deny with
                a reason.
              </Banner>
            ) : null}

            {row.status === "contract_sent" && !row.signedAt ? (
              <Banner tone={unsignedDays >= 2 ? "warn" : "info"} icon={<IconClock {...ICON} />}>
                {sentBannerText(row, pageViews)}
              </Banner>
            ) : null}

            <div className="grid grid-4">
              <Tile
                label="Total"
                value={money(row.totalCents)}
                sub={`incl. tax ${money(row.taxCents)}`}
              />
              <Tile
                label={row.postPaid ? "Deposit" : "Deposit (50%)"}
                value={money(row.depositDueCents)}
                sub={depositNote(row)}
              />
              <Tile label="Balance" value={money(row.balanceCents)} sub={balanceNote(row)} />
              <Tile
                label="Collected"
                value={`${paidPct}%`}
                sub={`${money(row.collectedCents)} of ${money(row.totalCents)}`}
                meter={{ p: paidPct, tone: paidPct === 100 ? "good" : paidPct ? "" : "warn" }}
              />
            </div>

            <Kv
              rows={[
                {
                  label: "Sent",
                  value: row.sentAt ? `${fStamp(row.sentAt)} · email + text` : "—",
                },
                {
                  label: "Signed",
                  value: row.signedAt ? `${fStamp(row.signedAt)} · ${row.guestName}` : "not yet",
                },
                {
                  label: "Card on file",
                  value:
                    row.savedCardBrand && row.savedCardLast4 ? (
                      <>
                        {row.savedCardBrand} •{row.savedCardLast4} · saved at signing, used for the
                        balance charge
                      </>
                    ) : (
                      "none"
                    ),
                },
                {
                  label: "Day-of gift card",
                  value: row.giftCardGan ? (
                    <span className="mono">{row.giftCardGan}</span>
                  ) : (
                    "minted at deposit"
                  ),
                },
                {
                  label: "Day-of order",
                  value: row.dayofOrderId ? (
                    <>
                      Square <span className="mono">{row.dayofOrderId}</span>
                      {row.settledOrderId ? " · settled" : " · OPEN"}
                    </>
                  ) : isDirector ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={backfill.isPending}
                      onClick={() => backfill.mutate()}
                    >
                      {backfill.isPending ? "Creating…" : "Create now"}
                    </button>
                  ) : (
                    <span className="muted">not created</span>
                  ),
                },
                ...(row.taxExempt ? [{ label: "Tax", value: "Exempt · DR-14 on file" }] : []),
              ]}
            />

            <div className="hstack">
              {row.status === "pending_approval" && isDirector && row.shortId ? (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() =>
                      sheet(
                        "Approve post-paid contract",
                        <IconCheck {...ICON} />,
                        <ApproveSheet row={row} onCancel={closeSheet} onDone={refresh} />,
                        CONTRACT_TEST_IDS.approveSheet,
                      )
                    }
                  >
                    <IconCheck {...ICON} /> Approve &amp; send
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() =>
                      sheet(
                        "Deny post-paid contract",
                        <IconAlertTriangle {...ICON} />,
                        <DenySheet row={row} onCancel={closeSheet} onDone={refresh} />,
                        CONTRACT_TEST_IDS.denySheet,
                      )
                    }
                  >
                    Deny
                  </button>
                </>
              ) : null}

              {(row.status === "contract_sent" || row.status === "resign_required") &&
              row.shortId ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    sheet(
                      "Resend contract",
                      <IconSend {...ICON} />,
                      <ResendSheet row={row} onCancel={closeSheet} onDone={refresh} />,
                      CONTRACT_TEST_IDS.resendSheet,
                    )
                  }
                >
                  <IconSend {...ICON} /> Resend contract
                </button>
              ) : null}

              {row.status === "deposit_paid" && isDirector && row.shortId ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    sheet(
                      "Charge balance now",
                      <IconBolt {...ICON} />,
                      <ChargeSheet row={row} mode="card" onCancel={closeSheet} onDone={refresh} />,
                      CONTRACT_TEST_IDS.chargeSheet,
                    )
                  }
                >
                  <IconBolt {...ICON} /> Charge balance now
                </button>
              ) : null}

              {(row.status === "deposit_paid" || row.status === "balance_link_sent") &&
              row.shortId ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    sheet(
                      "Send balance link",
                      <IconLink {...ICON} />,
                      <ChargeSheet row={row} mode="link" onCancel={closeSheet} onDone={refresh} />,
                    )
                  }
                >
                  <IconLink {...ICON} /> Send balance link
                </button>
              ) : null}

              {row.signedPdfUrl ? (
                <Link className="btn" href={row.signedPdfUrl} target="_blank" rel="noreferrer">
                  <IconFile {...ICON} /> Signed PDF
                </Link>
              ) : null}

              <button
                type="button"
                className="btn"
                onClick={() =>
                  sheet(
                    "What the guest sees",
                    <IconEye {...ICON} />,
                    <GuestViewSheet contract={contract} />,
                    CONTRACT_TEST_IDS.guestView,
                  )
                }
              >
                <IconEye {...ICON} /> What the guest sees
              </button>

              {!["cancelled", "completed", "denied"].includes(row.status) &&
              isDirector &&
              row.shortId ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() =>
                    sheet(
                      "Cancel event",
                      <IconAlertTriangle {...ICON} />,
                      <CancelSheet row={row} onCancel={closeSheet} onDone={refresh} />,
                      CONTRACT_TEST_IDS.cancelSheet,
                    )
                  }
                >
                  Cancel event
                </button>
              ) : null}
            </div>

            {footerLink ? (
              <Link className="xs" href={footerLink.href}>
                {footerLink.label}
              </Link>
            ) : null}
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h2>Versions</h2>
            <div className="right xs muted">
              every BMI edit after sending makes a version · price changes force a re-sign
            </div>
          </div>
          {contract.versions.length ? (
            <div className="list">
              {[...contract.versions].reverse().map((v) => (
                <div key={v.n} className="row" style={{ gridTemplateColumns: "auto 1fr auto" }}>
                  <Pill>v{v.n}</Pill>
                  <div>
                    <div className="title">{v.trigger}</div>
                    <div className="meta">
                      {v.changes.map((c, i) => (
                        <span key={`c-${i}`}>{c}</span>
                      ))}
                      {v.diffs.map((d) => (
                        <span key={d.field}>
                          {d.label}: {d.before} → {d.after}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span className="xs muted">{fStamp(v.at)}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState>Not sent yet</EmptyState>
          )}
        </div>
      </div>

      <div className="stack" style={{ gap: 16 }}>
        <div className="card">
          <div className="card-h">
            <h2>Guest messages</h2>
            {isDirector ? (
              <div className="right hstack">
                <label className="sr-only" htmlFor={`${shortId}-rule`}>
                  Reminder to fire
                </label>
                <select
                  id={`${shortId}-rule`}
                  className="select"
                  style={{ width: "auto" }}
                  value={ruleKey}
                  onChange={(e) => setRuleKey(e.target.value)}
                >
                  <option value="">Fire a reminder…</option>
                  {contract.reminderRules.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!ruleKey || remind.isPending}
                  onClick={() => remind.mutate(ruleKey)}
                >
                  <IconBolt {...ICON} /> {remind.isPending ? "Firing…" : "Fire"}
                </button>
              </div>
            ) : null}
          </div>
          <div className="list">
            {contract.notifications.length === 0 ? (
              <EmptyState>Nothing sent to the guest yet.</EmptyState>
            ) : null}
            {contract.notifications.map((n) => (
              <div key={n.id} className="row" style={{ gridTemplateColumns: "auto 1fr auto" }}>
                <span className="avatar sm">
                  {n.channel === "sms" ? (
                    <IconMessage {...ICON} />
                  ) : n.channel === "email" ? (
                    <IconMail {...ICON} />
                  ) : (
                    <IconBolt {...ICON} />
                  )}
                </span>
                <div>
                  <div className="title small">{n.label}</div>
                  <div className="meta">
                    <span>{n.channel}</span>
                    <span>{fStamp(n.at)}</span>
                    {n.error ? <span>{n.error}</span> : null}
                  </div>
                </div>
                <Chip
                  kind={
                    n.status === "sent" || n.status === "delivered"
                      ? "won"
                      : n.status === "failed"
                        ? "lost"
                        : "open"
                  }
                >
                  {n.status}
                </Chip>
              </div>
            ))}
          </div>
          <div className="pad xs muted" style={{ paddingTop: 8 }}>
            Automatic: contract sent · contract updated · 96-hour verify · 7-day waiver · balance
            receipt · thank-you. A failed rule is silenced for this event until you fire it by hand.
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h2>Approval</h2>
          </div>
          <div className="pad small stack">
            {row.postPaid ? (
              <div>
                Post-paid account (GF Post Paid Account product).{" "}
                {row.status === "pending_approval" ? "Waiting on a sales director." : "Approved."}
              </div>
            ) : (
              <div className="muted">Not required — standard 50% deposit.</div>
            )}
            <div className="xs muted">
              Approvals are recorded with the approver&apos;s own sign-in, not a shared address.
            </div>
            {contract.lineItems.length ? (
              <div className="xs muted">
                {contract.lineItems.length} line item
                {contract.lineItems.length === 1 ? "" : "s"} ·{" "}
                {moneyExact(contract.lineItems.reduce((sum, li) => sum + li.totalCents, 0))} before
                tax
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
