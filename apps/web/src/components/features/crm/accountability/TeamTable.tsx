import { MEASURE_TEST_IDS, type RepAccountability } from "~/features/crm/kpi/contracts";
import { CHANNELS, cellTone, responseLabel, teamTotal } from "./model";

/**
 * "Team, this week" — the prototype's director-only table
 * (crm-shared.js:415). Hook-free.
 *
 * Every cell prints `actual / target`, never a bare number: 31 calls is good
 * against a target of 30 and poor against 60, and a column of unanchored
 * numbers invites exactly that misreading. Colour marks the two ends (met, and
 * under half) and leaves the middle in ordinary ink — the tone is a second
 * signal on a number that is already there, never the only one.
 */
export interface TeamTableProps {
  reps: readonly RepAccountability[];
  /** "Week of Sep 7 – 13" — the table's caption. */
  windowLabel: string;
}

export function TeamTable({ reps, windowLabel }: TeamTableProps) {
  return (
    <div className="scroll-x">
      <table className="tbl" data-testid={MEASURE_TEST_IDS.teamTable}>
        <caption className="xs muted">
          {windowLabel} — logged activity against each salesperson’s target. Counted once per lead
          per channel per Eastern day.
        </caption>
        <thead>
          <tr>
            <th scope="col">Rep</th>
            {CHANNELS.map((c) => (
              <th scope="col" className="num" key={c.key}>
                {c.label}
              </th>
            ))}
            <th scope="col" className="num">
              Median response
            </th>
            <th scope="col" className="num">
              Leads touched
            </th>
          </tr>
        </thead>
        <tbody>
          {reps.map((r) => (
            <tr key={r.slug}>
              <th scope="row">{r.displayName}</th>
              {CHANNELS.map((c) => {
                const tone = cellTone(r.actual[c.key], r.target[c.key]);
                return (
                  <td
                    className="num"
                    key={c.key}
                    style={
                      tone === "good"
                        ? { color: "var(--good-ink)" }
                        : tone === "crit"
                          ? { color: "var(--crit-ink)" }
                          : undefined
                    }
                  >
                    {r.actual[c.key]}
                    <span className="muted"> / {r.target[c.key]}</span>
                  </td>
                );
              })}
              <td className="num">{responseLabel(r.actual.medianResponseMinutes)}</td>
              <td className="num">{r.actual.leadsTouched}</td>
            </tr>
          ))}
          {reps.length === 0 ? (
            <tr>
              <td colSpan={CHANNELS.length + 3} className="muted">
                No salespeople on the roster yet.
              </td>
            </tr>
          ) : null}
        </tbody>
        {reps.length > 1 ? (
          <tfoot>
            <tr>
              <th scope="row">Team</th>
              {CHANNELS.map((c) => {
                const t = teamTotal(reps, c.key);
                return (
                  <td className="num strong" key={c.key}>
                    {t.actual}
                    <span className="muted"> / {t.target}</span>
                  </td>
                );
              })}
              <td className="num muted">—</td>
              <td className="num strong">{reps.reduce((a, r) => a + r.actual.leadsTouched, 0)}</td>
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
