import { IconTarget } from "@tabler/icons-react";
import { MEASURE_TEST_IDS, type RepAccountability } from "~/features/crm/kpi/contracts";
import { Avatar } from "../primitives/Avatar";
import { ICON } from "../primitives/icon-props";
import { MeterRow } from "../primitives/Meter";
import { Spark } from "../kpi/Spark";
import { channelRows, responseLabel, responseMissed } from "./model";

/**
 * One salesperson's week — the prototype's `row(id)` (crm-shared.js:412): four
 * meters, a four-week call sparkline, and the response/leads-touched footer.
 * Hook-free, so a structure test can call it as a function.
 *
 * Each meter carries its own accessible name and value, because a bar's fill
 * is not something a screen reader can read and "12 / 40" beside it is the
 * number that matters.
 */
export interface RepMeterCardProps {
  rep: RepAccountability;
  /** A director gets the Targets button; a rep reads their own card. */
  onEditTargets?: (rep: RepAccountability) => void;
  /** "week" · "four weeks" — the targets are scaled, so the card says so. */
  spanLabel: string;
}

export function RepMeterCard({ rep, onEditTargets, spanLabel }: RepMeterCardProps) {
  const rows = channelRows(rep.target, rep.actual);
  const missed = responseMissed(rep.actual.medianResponseMinutes, rep.target.responseTargetMinutes);
  return (
    <div className="card" data-testid={MEASURE_TEST_IDS.repCard(rep.slug)}>
      <div className="card-h">
        <Avatar initials={rep.initials} repSlug={rep.slug} name={rep.displayName} sm />
        <h2>{rep.displayName}</h2>
        <div className="right hstack" style={{ gap: 8 }}>
          <span className="xs muted">4-wk calls</span>
          <Spark values={rep.actual.trend} />
          {onEditTargets ? (
            <button type="button" className="btn btn-sm" onClick={() => onEditTargets(rep)}>
              <IconTarget {...ICON} /> <span className="lbl">Targets</span>
            </button>
          ) : null}
        </div>
      </div>
      <div className="pad stack">
        {rows.map((r) => (
          <MeterRow
            key={r.key}
            name={r.label}
            n={`${r.actual} / ${r.target}`}
            pct={r.pct}
            tone={r.tone}
            label={`${rep.displayName}: ${r.label} this ${spanLabel}, ${r.actual} of ${r.target}`}
          />
        ))}
        <div className="hstack between xs muted" style={{ marginTop: 4 }}>
          <span>
            Median first response{" "}
            <b style={{ color: missed ? "var(--crit-ink)" : "var(--fg)" }}>
              {responseLabel(rep.actual.medianResponseMinutes)}
            </b>
            <span className="muted"> (target {rep.target.responseTargetMinutes} min)</span>
          </span>
          <span>{rep.actual.leadsTouched} leads touched</span>
        </div>
      </div>
    </div>
  );
}
