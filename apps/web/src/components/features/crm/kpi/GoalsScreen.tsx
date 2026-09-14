"use client";

import { IconAlertTriangle, IconDeviceFloppy, IconTarget } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { todayEasternYmd } from "~/features/crm/core/dates";
import type { ScreenProps } from "~/features/crm/core/screens";
import { MEASURE_TEST_IDS, type GoalsPostResponse } from "~/features/crm/kpi/contracts";
import { measureKeys } from "~/features/crm/kpi/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast, useCrmUser, useTopbarSlot } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { Tile } from "../primitives/Tile";
import { money } from "./model";
import {
  cellKey,
  draftFromCells,
  dirtyCells,
  formatMoneyInput,
  invalidCells,
  mirrorLines,
  monthTotals,
  suggestAll,
  suggestFrom,
  yearTotals,
  type GoalDraft,
} from "./goals-model";
import { fetchGoals, postGoals } from "./queries";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `/admin/crm/goals` (C7) — the prototype's `goals` screen
 * (crm-shared.js:403-408): a month × salesperson grid of monthly
 * booked-revenue goals, with last year's actual under each box.
 *
 * NEON IS WRITTEN FIRST AND IS THE TRUTH. Save posts to `/goals`, which
 * commits the grid before it even queues the Pandora mirror that keeps
 * commissions consistent. So a Pandora outage can delay the mirror; it can
 * never lose what the owner typed. Any mirror that is queued, failed or parked
 * is PRINTED on this screen — never swallowed — because Neon and Pandora
 * disagreeing is exactly the thing a director needs to know.
 *
 * Director-only by `DIRECTOR_ONLY_SCREENS`; `canEdit` from the server is
 * checked again here so the inputs are read-only if that ever changes.
 */
export default function GoalsScreen({ query }: ScreenProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const slot = useTopbarSlot();
  const { isDirector } = useCrmUser();

  const year = Number(query.year) || Number(todayEasternYmd().slice(0, 4));
  const [draft, setDraft] = useState<GoalDraft | null>(null);
  const [lastSave, setLastSave] = useState<GoalsPostResponse | null>(null);

  const goalsQ = useQuery({
    queryKey: measureKeys.goals(year),
    queryFn: () => fetchGoals(crmFetch, year),
  });

  const data = goalsQ.data;
  const cells = useMemo(() => data?.cells ?? [], [data]);
  const reps = data?.reps ?? [];
  // The draft is seeded once per load and then owned by the keyboard: deriving
  // it from `cells` on every render would snap a half-typed number back the
  // moment a background refetch landed.
  const current = draft ?? draftFromCells(cells);

  const save = useMutation({
    mutationFn: () => postGoals(crmFetch, { goals: dirtyCells(current, cells, year) }),
    onSuccess: (res) => {
      setLastSave(res);
      setDraft(draftFromCells(res.cells));
      void qc.invalidateQueries({ queryKey: measureKeys.all });
      toast(
        res.mirrorError
          ? "Goals saved. The Pandora mirror did not go through — see the note below."
          : res.queued.length
            ? `Goals saved and mirrored to Pandora for ${res.queued.join(", ")}.`
            : "Goals saved.",
        res.mirrorError ? "warn" : "ok",
      );
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  if (goalsQ.isPending) return <LoadingState label="Loading goals…" />;
  if (goalsQ.isError) {
    return (
      <ErrorState message={errorMessage(goalsQ.error)} onRetry={() => void goalsQ.refetch()} />
    );
  }
  if (!data) return <EmptyState>Nothing to show yet.</EmptyState>;

  const canEdit = isDirector && data.canEdit;
  const totals = monthTotals(cells, current);
  const year0 = yearTotals(totals);
  const bad = invalidCells(current);
  const changed = dirtyCells(current, cells, year);
  const byRepMonth = new Map(cells.map((c) => [cellKey(c.repSlug, c.month), c]));
  const lines = mirrorLines(data.mirror);

  const setCell = (slug: string, month: number, value: string) =>
    setDraft({ ...current, [cellKey(slug, month)]: value });

  return (
    <div className="stack" style={{ gap: 12 }} data-testid={MEASURE_TEST_IDS.goals}>
      {slot && canEdit
        ? createPortal(
            <>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setDraft(suggestAll(cells, data.suggestFactor, current))}
              >
                <IconTarget {...ICON} /> <span className="lbl">Suggest from last year</span>
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                data-testid={MEASURE_TEST_IDS.goalsSave}
                disabled={save.isPending || changed.length === 0 || bad.length > 0}
                onClick={() => save.mutate()}
              >
                <IconDeviceFloppy {...ICON} />{" "}
                <span className="lbl">
                  {save.isPending
                    ? "Saving…"
                    : changed.length
                      ? `Save ${changed.length} change${changed.length === 1 ? "" : "s"}`
                      : "Saved"}
                </span>
              </button>
            </>,
            slot,
          )
        : null}

      <Banner tone="info" icon={<IconTarget {...ICON} />}>
        Type a goal, or click a last-year figure to copy it into the box. “Suggest from last year”
        fills every month with last year × {data.suggestFactor.toFixed(2)}.{" "}
        {canEdit
          ? "Saving writes to our database first; Pandora is mirrored afterwards so commissions read the same numbers."
          : "You can read these; only a sales director can change them."}
      </Banner>

      {bad.length > 0 ? (
        <Banner tone="crit" icon={<IconAlertTriangle {...ICON} />}>
          {bad.length} box{bad.length === 1 ? "" : "es"} hold something that is not a whole-dollar
          amount. Fix {bad.length === 1 ? "it" : "them"} before saving — nothing is written until
          every box reads as money.
        </Banner>
      ) : null}

      {lastSave?.mirrorError ? (
        <Banner tone="warn" icon={<IconAlertTriangle {...ICON} />}>
          Saved here, but Pandora did not take it: {lastSave.mirrorError}. The goal is safe in our
          database and the mirror will be retried; commissions read Pandora, so tell whoever runs
          them if this stays red.
        </Banner>
      ) : null}

      {lines.length > 0 ? (
        <div className="stack" style={{ gap: 6 }} data-testid={MEASURE_TEST_IDS.goalsMirror}>
          {lines.map((l) => (
            <Banner key={l.repSlug} tone={l.tone === "ok" ? "info" : l.tone}>
              {l.text}
            </Banner>
          ))}
        </div>
      ) : null}

      <div className="card scroll-x">
        <table className="tbl" data-testid={MEASURE_TEST_IDS.goalsTable}>
          <caption className="xs muted">
            Monthly booked-revenue goal per salesperson for {year}, with last year’s actual and this
            year’s actual to date. Basis: BMI project value in Confirmation states.
          </caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              {reps.map((r) => (
                <th scope="col" key={r.slug}>
                  {r.firstName}
                </th>
              ))}
              <th scope="col" className="num">
                Team goal
              </th>
              <th scope="col" className="num">
                Team LY
              </th>
            </tr>
          </thead>
          <tbody>
            {totals.map((t) => (
              <tr key={t.month}>
                <th scope="row" className="strong">
                  {MON[t.month - 1]} {year}
                </th>
                {reps.map((r) => {
                  const cell = byRepMonth.get(cellKey(r.slug, t.month));
                  const id = MEASURE_TEST_IDS.goalInput(r.slug, t.month);
                  const ly = cell?.lastYearCents ?? 0;
                  return (
                    <td key={r.slug}>
                      <div className="stack" style={{ gap: 2 }}>
                        <input
                          className="input tabular"
                          style={{ width: 104, padding: "5px 8px" }}
                          inputMode="numeric"
                          data-testid={id}
                          id={id}
                          aria-label={`${r.firstName} ${MON[t.month - 1]} ${year} goal`}
                          aria-invalid={bad.includes(cellKey(r.slug, t.month)) ? "true" : undefined}
                          readOnly={!canEdit}
                          value={current[cellKey(r.slug, t.month)] ?? ""}
                          onChange={(e) => setCell(r.slug, t.month, e.target.value)}
                        />
                        <span className="xs muted">
                          {ly > 0 && canEdit ? (
                            <button
                              type="button"
                              className="linkish"
                              onClick={() => setCell(r.slug, t.month, formatMoneyInput(ly))}
                              title={`Copy last year’s ${money(ly)} into ${r.firstName}’s ${MON[t.month - 1]} goal`}
                            >
                              LY {money(ly)}
                            </button>
                          ) : (
                            <>LY {money(ly)}</>
                          )}
                          {cell?.actualCents !== null && cell?.actualCents !== undefined
                            ? ` · act ${money(cell.actualCents)}`
                            : ""}
                          {ly > 0 && canEdit ? (
                            <>
                              {" · "}
                              <button
                                type="button"
                                className="linkish"
                                onClick={() =>
                                  setCell(
                                    r.slug,
                                    t.month,
                                    formatMoneyInput(suggestFrom(ly, data.suggestFactor)),
                                  )
                                }
                                title={`Copy last year × ${data.suggestFactor.toFixed(2)}`}
                              >
                                ×{data.suggestFactor.toFixed(2)}
                              </button>
                            </>
                          ) : null}
                        </span>
                      </div>
                    </td>
                  );
                })}
                <td className="num strong">{money(t.goalCents)}</td>
                <td className="num muted">{money(t.lastYearCents)}</td>
              </tr>
            ))}
            {totals.length === 0 ? (
              <tr>
                <td colSpan={reps.length + 3} className="muted">
                  No salespeople on the roster yet — seed the roster from the Statuses screen.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="grid grid-3">
        <Tile label={`${year} total goal`} value={money(year0.goalCents)} />
        <Tile label={`${year - 1} actual`} value={money(year0.lastYearCents)} />
        <Tile
          label="Growth implied"
          value={
            year0.growthPct === null ? "—" : `${year0.growthPct > 0 ? "+" : ""}${year0.growthPct}%`
          }
          sub={year0.growthPct === null ? "No last-year actual to compare with" : undefined}
        />
      </div>

      <p className="xs muted">
        Goals are per salesperson per month. Pandora’s goals table is keyed by name with no centre,
        so the mirror sends each salesperson’s yearly TOTAL under their Office username — the
        per-centre split stays here.
      </p>
    </div>
  );
}
