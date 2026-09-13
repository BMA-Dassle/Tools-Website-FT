"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ContractDetail } from "~/features/crm/contracts/contracts";
import { CONTRACT_TEST_IDS } from "~/features/crm/contracts/contracts";
import { contractsKeys } from "~/features/crm/contracts/queries";
import { fDate } from "~/features/crm/core/dates";
import { money, moneyExact } from "~/features/crm/core/format";
import { notesText } from "../contracts/model";
import { fetchContractNotes } from "../contracts/queries";
import { useCrmFetch } from "../lib/use-crm-user";
import { Kv } from "../primitives/Kv";

/**
 * "What the guest sees" (`guest-view`, crm-events.js:113).
 *
 * WHICH OF THE TWO THE BRIEF ASKED FOR: a faithful read-only copy, not the
 * contract page's own component. `app/contract/[shortId]/ContractClient.tsx`
 * is a 2,590-line client component that owns the whole five-step signing flow
 * — Square card fields, the tax-exempt upload, the signature pad, the payment
 * POSTs. It takes a `QuoteProps` the page builds server-side and it is not
 * exported in any smaller piece. Mounting it inside an admin sheet would drag
 * the payment SDK into the CRM bundle and put live "Pay deposit" buttons in
 * front of staff. So this renders the same FACTS from the same service — the
 * quote the API already returned — and links to the real page for the rest.
 *
 * Recorded here rather than in a commit message because the next person to
 * open this file will ask the same question.
 */
export interface GuestViewSheetProps {
  contract: ContractDetail;
}

export function GuestViewSheet({ contract }: GuestViewSheetProps) {
  const { row } = contract;
  const crmFetch = useCrmFetch();
  const steps = ["Review", "Event Info", "Policies", "Agree & Sign"];
  if (!row.postPaid) steps.push("Deposit");

  // The notes are read LIVE from BMI, not taken from the quote row: a planner
  // who edits the public note in Office sees it here immediately, and the
  // preview can say plainly when the guest's page has not caught up yet.
  const notes = useQuery({
    queryKey: contractsKeys.notes(row.shortId ?? ""),
    queryFn: () => fetchContractNotes(crmFetch, row.shortId as string),
    enabled: Boolean(row.shortId),
    staleTime: 30_000,
  });
  const notesView = notesText(contract.notes, notes.data);

  return (
    <div className="guest-preview" data-testid={CONTRACT_TEST_IDS.guestView}>
      <div className="gp-steps">
        {steps.map((s, i) => (
          <span key={s} className={i === 0 ? "on" : undefined}>
            {i + 1}. {s}
          </span>
        ))}
      </div>

      <div className="gp-card">
        <div className="gp-h">
          {row.eventNumber ?? row.shortId} · {row.title}
        </div>
        <Kv
          rows={[
            { label: "Date", value: fDate(row.eventDate) },
            { label: "Guests", value: row.guests ?? "—" },
            { label: "Total", value: money(row.totalCents) },
          ]}
        />
        <table className="tbl">
          <caption className="sr-only">Line items on the contract</caption>
          <tbody>
            {contract.lineItems.map((li, i) => (
              <tr key={`${li.name}-${i}`}>
                <td>
                  {li.name} <span className="muted">×{li.qty}</span>
                </td>
                <td className="num">{moneyExact(li.totalCents)}</td>
              </tr>
            ))}
            <tr>
              <td className="muted">Tax</td>
              <td className="num">{moneyExact(row.taxCents)}</td>
            </tr>
            <tr>
              <td className="strong">Total</td>
              <td className="num strong">{moneyExact(row.totalCents)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="gp-card gp-notes">
        <div className="eyebrow">
          Notes from {row.rep?.firstName ?? row.plannerName ?? "your planner"}
        </div>
        <div style={{ whiteSpace: "pre-wrap" }}>{notesView.body}</div>
        <div
          className={notesView.warn ? "xs" : "xs muted"}
          style={{ marginTop: 6, ...(notesView.warn ? { color: "var(--warn-ink)" } : null) }}
        >
          {notesView.caption}
        </div>
      </div>

      <div className="gp-card">
        <div className="eyebrow">Payment schedule</div>
        {row.postPaid ? (
          <div className="small">No deposit required — billed after your event.</div>
        ) : (
          <div className="small">
            <b>1.</b> 50% deposit {money(row.depositDueCents)} — due today
            <br />
            <b>2.</b> Remaining {money(row.balanceCents)} — charged to your card on file 72 hours
            before the event
          </div>
        )}
      </div>

      <div className="gp-card">
        <div className="eyebrow">Your event planner</div>
        <div className="small">
          {row.rep?.displayName ?? row.plannerName ?? "—"}
          {row.plannerEmail ? <div className="xs muted">{row.plannerEmail}</div> : null}
        </div>
      </div>

      {contract.guestUrl ? (
        <div className="xs muted">
          The guest&apos;s own page, with the signing steps and payment:{" "}
          <Link href={contract.guestUrl} target="_blank" rel="noreferrer">
            {contract.guestUrl}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
