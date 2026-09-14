"use client";

import { IconLayersIntersect, IconSend } from "@tabler/icons-react";
import Link from "next/link";
import { CRM_BASE } from "~/features/crm/core/contracts";
import { LEAD_TEST_IDS } from "~/features/crm/leads/contracts";
import { ICON } from "../primitives/icon-props";
import { ContractPanel } from "./ContractPanel";
import type { DealTabProps } from "./tabs";

/**
 * The deal's Contract tab (crm-events.js:82).
 *
 * A lead has a contract once `gf_short_id` is set — which happens when the BMI
 * state is flipped to "Send Contract" and the dispatch cron mints one. Until
 * then this is the prototype's empty state, verbatim, with the two things that
 * actually exist behind it: the status change that creates the contract, and
 * the quote builder.
 *
 * "Send contract now" is not a button here on purpose. Flipping the status is
 * the Pipeline PR's action (B4 owns `statuses/service/transition.ts`), and a
 * second rail that writes the same BMI state from this tab would be exactly
 * the "two writers for one entity" R5 forbids. The copy says where to do it.
 */
export default function ContractTab({ detail, setQuery }: DealTabProps) {
  const { lead } = detail;

  if (!lead.gfShortId) {
    return (
      <div className="card" data-testid={LEAD_TEST_IDS.dealTab("contract")}>
        <div className="pad stack">
          <div className="eyebrow">No contract yet</div>
          <div className="small">
            A contract is created the moment the BMI state is flipped to <b>Send Contract</b>. Move
            this deal to the <b>Contract sent</b> status on the Pipeline board to do that, or build
            the quote first.
          </div>
          <div className="hstack">
            <Link className="btn" href={`${CRM_BASE}/pipeline?deal=${lead.publicId}`}>
              <IconSend {...ICON} /> Open on the board
            </Link>
            <Link className="btn" href={`${CRM_BASE}/builder/${lead.publicId}`}>
              <IconLayersIntersect {...ICON} /> Build quote in BMI
            </Link>
          </div>
          <div className="xs muted">
            Sending runs the AI grammar clean-up on the public notes, writes the cleaned text back
            to BMI, creates the Square day-of order, and emails + texts the guest the 5-step signing
            page.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-testid={LEAD_TEST_IDS.dealTab("contract")}>
      {/* The event is a sibling tab, so "open the event" switches tabs rather
          than navigating: same record, other lens, drawer stays open. */}
      <ContractPanel shortId={lead.gfShortId} onOpenEvent={() => setQuery({ tab: "event" })} />
    </div>
  );
}
