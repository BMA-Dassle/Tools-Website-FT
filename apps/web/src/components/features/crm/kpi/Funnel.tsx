/**
 * "Pipeline by our status" — the prototype's `funnel()` (crm-shared.js:370).
 * Bar length = number of leads; the right column is the open value of that
 * stage. Hook-free.
 *
 * THE COLOUR IS THE STATUS'S OWN, not a chart palette. `--st-*` is what the
 * pipeline board paints its columns and what a status chip wears on a deal, so
 * a row here is recognisably the same thing as the column it came from — the
 * "colour follows the entity" rule. It also means colour carries no
 * information a reader has to decode: every row is directly labelled with its
 * status name, and the count is printed inside the bar.
 *
 * BASIS `crm_leads.value_cents` — OUR estimate of the deal, not a BMI or Square
 * figure. The card footer says so, because "$48k in Quote" would otherwise
 * read as money BMI knows about.
 */

import { MEASURE_TEST_IDS, type FunnelRow } from "~/features/crm/kpi/contracts";
import { moneyK } from "./model";

/** The status hues the board uses, in pipeline order (crm.css `--st-*`). */
const STATUS_HUE: Record<string, string> = {
  new: "var(--st-new)",
  assigned: "var(--st-new)",
  contacted: "var(--st-contacted)",
  waiting: "var(--st-waiting)",
  quote: "var(--st-quote)",
  contract: "var(--st-contract)",
  deposit: "var(--st-contract)",
  confirmed: "var(--st-won)",
  lost: "var(--muted2)",
  noresp: "var(--muted2)",
};

export interface FunnelProps {
  rows: readonly FunnelRow[];
}

export function Funnel({ rows }: FunnelProps) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (rows.length === 0) return <p className="xs muted">No statuses configured yet.</p>;
  return (
    <div className="funnel" data-testid={MEASURE_TEST_IDS.funnel}>
      {rows.map((r) => (
        <div className="fr" key={r.statusId}>
          <span>{r.label}</span>
          <div
            className="bar"
            style={{
              width: `${Math.max(8, Math.round((r.count / max) * 100))}%`,
              background: STATUS_HUE[r.statusId] ?? "var(--st-new)",
            }}
          >
            {r.count}
          </div>
          <span className="n">{r.valueCents ? moneyK(r.valueCents) : "—"}</span>
        </div>
      ))}
    </div>
  );
}
