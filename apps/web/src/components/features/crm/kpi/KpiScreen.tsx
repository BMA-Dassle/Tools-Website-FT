"use client";

import {
  IconBolt,
  IconCalendar,
  IconChartLine,
  IconCheck,
  IconFileText,
  IconInbox,
  IconTarget,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { CENTRE_LIST } from "~/features/crm/core/centres";
import { CRM_BASE } from "~/features/crm/core/contracts";
import type { ScreenProps } from "~/features/crm/core/screens";
import { KPI_FOOTNOTE, MEASURE_TEST_IDS } from "~/features/crm/kpi/contracts";
import { measureKeys } from "~/features/crm/kpi/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useUrlQuery } from "../lib/use-url-query";
import { useCrmFetch, useCrmUser } from "../lib/use-crm-user";
import { ICON } from "../primitives/icon-props";
import { Meter } from "../primitives/Meter";
import { Avatar } from "../primitives/Avatar";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { Seg } from "../primitives/Seg";
import { Tile } from "../primitives/Tile";
import { Donut } from "./Donut";
import { Funnel } from "./Funnel";
import { LostBars } from "./LostBars";
import { MonthlyChart } from "./MonthlyChart";
import { PacingChart } from "./PacingChart";
import { SourcePairs } from "./SourcePairs";
import { Spark } from "./Spark";
import {
  attributionNote,
  basisTitle,
  deltaMark,
  deltaOf,
  kpiSubtitle,
  money,
  moneyK,
  needLabel,
  needPerDay,
  pctOf,
  responseLabel,
  sourceSummary,
} from "./model";
import { fetchKpi } from "./queries";
import { rangeOptions, windowKeyOf } from "./range";

/**
 * `/admin/crm/kpi` (C7) — the prototype's `kpi` screen (crm-shared.js:373-401)
 * over real data.
 *
 * THE THREE MONEYS. The old portal dashboard conflated BMI project value, the
 * signed contract total and what Square actually collected, so every figure
 * here names its own basis in a `title` tooltip AND the page carries
 * `KPI_FOOTNOTE` at the bottom, in words, where the owner reads it without
 * hovering anything:
 *   Booked / Quoted / pacing / by-salesperson / monthly  → basis `bmi`
 *   Deposits due next 30 days                            → basis `square`
 *   Conversion / leads / response                        → counts and minutes
 *
 * Same-time-last-year reach-outs are NOT here any more. They count a rep's
 * phone calls, not money, and they now sit with the calls, texts and emails on
 * the accountability board (owner, 2026-09-13).
 *
 * The rep/director split is NOT done by hiding tiles: `kpiDashboard` narrows a
 * rep to their own row before it reads anything, so this component renders
 * whatever it is given and a hand-typed `?rep=` changes nothing for a rep.
 */
export default function KpiScreen({ query }: ScreenProps) {
  const crmFetch = useCrmFetch();
  const { isDirector, user } = useCrmUser();
  const [urlQuery, setUrlQuery] = useUrlQuery(query);

  const month = urlQuery.month ?? null;
  const quarter = urlQuery.quarter ?? null;
  const rep = isDirector ? (urlQuery.rep ?? null) : null;
  const centre = urlQuery.centre ?? null;

  const params = { month, quarter, rep, centre };
  const kpiQ = useQuery({
    queryKey: measureKeys.kpi(params),
    queryFn: () => fetchKpi(crmFetch, params),
  });

  const data = kpiQ.data;
  const ranges = rangeOptions(new Date());
  const activeRange = windowKeyOf(data?.window.key ?? null, month, quarter, ranges);

  if (kpiQ.isPending) return <LoadingState label="Working out the month…" />;
  if (kpiQ.isError) {
    return <ErrorState message={errorMessage(kpiQ.error)} onRetry={() => void kpiQ.refetch()} />;
  }
  if (!data) return <EmptyState>Nothing to show yet.</EmptyState>;

  const { team, window, pacing, attribution } = data;
  const who = data.repSlug
    ? (data.reps[0]?.displayName ?? data.repSlug)
    : isDirector
      ? "All salespeople"
      : (user.rep?.displayName ?? user.name);

  const bookedDelta = deltaOf(team.bookedCents, team.lastYearToDateCents);
  const goalPct = pctOf(team.bookedCents, team.goalCents);
  const need = needPerDay(team, window.elapsed, window.days);
  const conversion = pctOf(team.confirmed, team.leads);
  const openQuotes = data.funnel
    .filter((f) => f.statusId === "quote" || f.statusId === "contract")
    .reduce((a, f) => a + f.count, 0);
  const tySpark = pacing.points.map((p) => p.tyCents).filter((v): v is number => v !== null);
  const note = attributionNote(attribution);
  const noRepRow = !isDirector && data.reps.length === 0;

  const onRange = (value: string) => {
    const picked = ranges.find((r) => r.value === value);
    if (!picked) return;
    setUrlQuery(
      picked.kind === "quarter"
        ? { quarter: picked.key, month: null }
        : { month: picked.key, quarter: null },
    );
  };

  return (
    <div className="stack" style={{ gap: 12 }} data-testid={MEASURE_TEST_IDS.kpi}>
      <div className="hstack between wrap" style={{ gap: 8 }}>
        <span className="xs muted">
          {kpiSubtitle(window.label, who, window.elapsed, window.days)}
        </span>
        <div className="hstack" style={{ gap: 8 }}>
          <Seg
            label="Window"
            testId={MEASURE_TEST_IDS.kpiRange}
            options={ranges.map((r) => ({ value: r.value, label: r.label }))}
            value={activeRange}
            onChange={onRange}
          />
          {isDirector ? (
            <Link className="btn btn-sm" href={`${CRM_BASE}/goals`}>
              <IconTarget {...ICON} /> <span className="lbl">Goals</span>
            </Link>
          ) : null}
        </div>
      </div>

      {noRepRow ? (
        <EmptyState>
          You do not have a salesperson row yet, so there is nothing to measure. Ask Jacob to add
          you on the Rules screen.
        </EmptyState>
      ) : null}

      <div className="hstack wrap" style={{ gap: 8 }}>
        <Seg
          label="Center"
          options={[
            { value: "", label: "All centres" },
            ...CENTRE_LIST.map((c) => ({ value: c.code, label: c.short })),
          ]}
          value={centre ?? ""}
          onChange={(v) => setUrlQuery({ centre: v || null })}
        />
        {/* Options come from `roster`, which ignores the filter. Deriving them
            from `data.reps` meant picking a person left one option, tripped the
            length guard, and removed the only way back to the team. */}
        {isDirector && data.roster.length > 1 ? (
          <Seg
            label="Salesperson"
            options={[
              { value: "", label: "Team" },
              ...data.roster.map((r) => ({ value: r.slug, label: r.firstName })),
            ]}
            value={rep ?? ""}
            onChange={(v) => setUrlQuery({ rep: v || null })}
          />
        ) : null}
      </div>

      <div className="grid grid-4" data-testid={MEASURE_TEST_IDS.kpiTiles}>
        <Tile
          label={
            <span title={basisTitle("Confirmed projects whose event falls in this window.", "bmi")}>
              Booked this window
            </span>
          }
          value={money(team.bookedCents)}
          ico={<IconChartLine {...ICON} />}
          icoCls="good"
          delta={
            bookedDelta.comparable ? (
              <span className={`delta ${bookedDelta.dir}`}>
                {deltaMark(bookedDelta.dir)} {bookedDelta.pct}% vs LY
              </span>
            ) : (
              <span className="delta flat">• no last-year figure</span>
            )
          }
          sub={`${money(team.lastYearToDateCents)} by the same day last year`}
          corner={tySpark.length > 1 ? <Spark values={tySpark} /> : undefined}
        />
        <Tile
          label={
            <span title={basisTitle("Booked against the goal set on the Goals screen.", "bmi")}>
              Goal pace
            </span>
          }
          value={`${goalPct}%`}
          unit={team.goalCents ? ` of ${moneyK(team.goalCents)}` : " · no goal set"}
          ico={<IconTarget {...ICON} />}
          corner={team.goalCents ? <Donut pct={goalPct} label="Goal pace" /> : undefined}
          sub={team.goalCents ? needLabel(need) : "Set a monthly goal to see a pace here."}
        />
        <Tile
          label={
            <span
              title={basisTitle(
                "Projects in Quote or Send Contract — money still in play, none of it collected.",
                "bmi",
              )}
            >
              Quoted, not yet won
            </span>
          }
          value={money(team.quotedCents)}
          ico={<IconFileText {...ICON} />}
          icoCls="warn"
          sub={`${openQuotes} open quote${openQuotes === 1 ? "" : "s"} & contracts in our pipeline`}
        />
        <Tile
          label={
            <span
              title={basisTitle(
                "Confirmed projects as a share of every project that reached a lead state.",
                "count",
              )}
            >
              Conversion
            </span>
          }
          value={`${conversion}%`}
          unit={` ${team.confirmed} of ${team.leads}`}
          ico={<IconCheck {...ICON} />}
          icoCls="good"
          sub="Portal buckets, so this figure sits beside the old KPI Dashboard"
        />
      </div>

      {/* Three, not four: "Same-time-last-year reach-outs" moved to the
          accountability board (owner, 2026-09-13). It counted phone calls on a
          page of revenue figures. */}
      <div className="grid grid-3">
        <Tile
          label={
            <span
              title={basisTitle(
                "Minutes from a lead arriving to its assignee's first outbound call, text or email.",
                "minutes",
              )}
            >
              Median first response
            </span>
          }
          value={responseLabel(data.medianResponseMinutes)}
          ico={<IconBolt {...ICON} />}
          icoCls="violet"
          delta={
            data.previousMedianResponseMinutes !== null ? (
              <span className="delta chip-like">
                was {responseLabel(data.previousMedianResponseMinutes)} a year ago
              </span>
            ) : undefined
          }
          sub="Leads still untouched are left out, not counted as forever"
        />
        <Tile
          label={
            <span
              title={basisTitle(
                "Leads WE captured in this window, from crm_leads — not BMI projects.",
                "count",
              )}
            >
              Leads this window
            </span>
          }
          value={String(data.leadSources.reduce((a, s) => a + s.leads, 0))}
          ico={<IconInbox {...ICON} />}
          sub={sourceSummary(data.leadSources)}
        />
        <Tile
          label={
            <span
              title={basisTitle(
                "Unpaid deposits plus unpaid balances on contracts whose event is in the next 30 days. This is CASH, the only tile on the page that is not booking value.",
                "square",
              )}
            >
              Deposits due next 30 days
            </span>
          }
          value={money(data.deposits.outstandingCents)}
          ico={<IconCalendar {...ICON} />}
          icoCls="orange"
          sub={`${data.deposits.events} event${data.deposits.events === 1 ? "" : "s"} · ${data.deposits.unsigned} unsigned contract${data.deposits.unsigned === 1 ? "" : "s"} · Square`}
        />
      </div>

      {note ? <p className="xs muted">{note}</p> : null}

      <div className="kpi-split">
        <div className="card">
          <div className="card-h">
            <h2>Booked vs same day last year</h2>
          </div>
          <div className="pad">
            <PacingChart
              series={pacing}
              thisYearLabel={String(window.year)}
              lastYearLabel={String(window.year - 1)}
              caption={`Cumulative booked project value for ${window.label}, against the same days a year earlier. BMI project value.`}
            />
          </div>
        </div>
        <div className="card">
          <div className="card-h">
            <h2>Pipeline by our status</h2>
            <div className="right xs muted">count · open $</div>
          </div>
          <div className="pad">
            <Funnel rows={data.funnel} />
            <p className="xs muted" style={{ marginTop: 10 }}>
              Bar length = number of leads · right column = the value WE put on those leads
              (`crm_leads`), not a BMI or Square figure.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-3">
        <div className="card">
          <div className="card-h">
            <h2>By salesperson</h2>
          </div>
          <div className="scroll-x">
            <table className="tbl" data-testid={MEASURE_TEST_IDS.byRep}>
              <thead>
                <tr>
                  <th scope="col">Rep</th>
                  <th scope="col" className="num">
                    Booked
                  </th>
                  <th scope="col" className="num">
                    Goal
                  </th>
                  <th scope="col" className="num">
                    vs LY
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.reps.map((r) => {
                  const d = deltaOf(r.bookedCents, r.lastYearToDateCents);
                  const p = pctOf(r.bookedCents, r.goalCents);
                  return (
                    <tr key={r.slug}>
                      <th scope="row">
                        <span className="hstack">
                          <Avatar initials={r.initials} repSlug={r.slug} name={r.displayName} sm />{" "}
                          {r.firstName}
                        </span>
                      </th>
                      <td className="num">{money(r.bookedCents)}</td>
                      <td className="num">
                        <span className="hstack" style={{ justifyContent: "flex-end", gap: 6 }}>
                          <Meter pct={p} label={`${r.firstName} against goal`} className="inline" />
                          {r.goalCents ? `${p}%` : "—"}
                        </span>
                      </td>
                      <td className="num">
                        {d.comparable ? (
                          <span className={`delta ${d.dir}`}>
                            {deltaMark(d.dir)} {d.pct}%
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {data.reps.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      No salespeople to show.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <div className="card-h">
            <h2>Conversion by source</h2>
            <div className="right xs muted">won share of leads</div>
          </div>
          <div className="pad">
            <SourcePairs rows={data.bySource} />
          </div>
        </div>
        <div className="card">
          <div className="card-h">
            <h2>Why we lost</h2>
          </div>
          <div className="pad">
            <LostBars rows={data.lostReasons} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Goal vs last year, by month</h2>
          {isDirector ? (
            <div className="right">
              <Link className="btn btn-sm" href={`${CRM_BASE}/goals`}>
                Edit goals
              </Link>
            </div>
          ) : null}
        </div>
        <div className="pad">
          <MonthlyChart
            rows={data.monthly}
            year={window.year}
            caption={`Monthly goal, last year's actual and this year's actual for ${window.year}. BMI project value.`}
          />
        </div>
      </div>

      <p className="xs muted" data-testid={MEASURE_TEST_IDS.footnote}>
        {KPI_FOOTNOTE}
      </p>
    </div>
  );
}
