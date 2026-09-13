"use client";

import { LEAD_TEST_IDS } from "~/features/crm/leads/contracts";
import { DEAL_TAB_DESCRIPTION, DEAL_TAB_LABEL, type DealTabProps } from "./tabs";

/**
 * A deal tab whose PR has not landed: the title and the prototype's one-line
 * description, and nothing that pretends to be data. B5 (contract, payments,
 * history) and B6 (notes, event) replace their lines in `tabs.ts`.
 */
export default function TabComingLater({ tab }: DealTabProps) {
  return (
    <div className="card" data-testid={LEAD_TEST_IDS.dealTab(tab)} style={{ maxWidth: 640 }}>
      <div className="pad stack">
        <div className="eyebrow">Coming in a later PR</div>
        <h2 style={{ fontSize: 16 }}>{DEAL_TAB_LABEL[tab]}</h2>
        <p className="muted" style={{ margin: 0 }}>
          {DEAL_TAB_DESCRIPTION[tab]}
        </p>
      </div>
    </div>
  );
}
