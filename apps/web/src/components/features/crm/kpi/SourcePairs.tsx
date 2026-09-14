/**
 * "Conversion by source" — the prototype's `pairs()` (crm-shared.js:371): one
 * track per source, filled to the share of its leads that were won. Hook-free.
 *
 * A SHARE, not a count, so a source with four leads and two wins reads 50%
 * beside one with eighty leads and forty. The raw pair is on the row's `title`
 * and in the text beside it, because 50% of four is not evidence of anything
 * and the reader needs the denominator to know that.
 */

import { MEASURE_TEST_IDS, type SourceRow } from "~/features/crm/kpi/contracts";
import { pctOf } from "./model";

export interface SourcePairsProps {
  rows: readonly SourceRow[];
}

export function SourcePairs({ rows }: SourcePairsProps) {
  const shown = rows.filter((r) => r.leads > 0);
  if (shown.length === 0) {
    return <p className="xs muted">No leads captured in this window.</p>;
  }
  return (
    <div className="pairs" data-testid={MEASURE_TEST_IDS.bySource}>
      {shown.map((r) => {
        const p = pctOf(r.won, r.leads);
        return (
          <div className="pair" key={r.source}>
            <span className="small">{r.label}</span>
            <div className="tr" title={`${r.won} won of ${r.leads} leads`}>
              <i style={{ width: `${Math.min(100, p)}%` }} />
            </div>
            <span className="n">{p}%</span>
          </div>
        );
      })}
    </div>
  );
}
