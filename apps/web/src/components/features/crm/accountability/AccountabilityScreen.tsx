"use client";

import { IconAlertTriangle, IconHistory, IconTarget } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ScreenProps } from "~/features/crm/core/screens";
import {
  ACCOUNTABILITY_RANGES,
  MEASURE_TEST_IDS,
  type AccountabilityRange,
  type RepAccountability,
  type TargetsPostBody,
} from "~/features/crm/kpi/contracts";
import { measureKeys } from "~/features/crm/kpi/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useUrlQuery } from "../lib/use-url-query";
import { useCrmFetch, useCrmSheet, useCrmToast, useCrmUser } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { Seg } from "../primitives/Seg";
import { Tile } from "../primitives/Tile";
import { fetchAccountability, fetchTargets, postTargets } from "../kpi/queries";
import { RepMeterCard } from "./RepMeterCard";
import { TargetsSheet } from "./TargetsSheet";
import { TeamTable } from "./TeamTable";
import { behindSentence, meterTone, pctOf } from "./model";

/**
 * `/admin/crm/accountability` (C7) — the prototype's `accountability` screen
 * (crm-shared.js:410-417) over `crm_activities`.
 *
 * VISIBILITY IS THE SERVER'S. This component renders whatever the API returns;
 * it does not decide who may see whom. `accountability()` narrows the roster
 * to the caller's own row unless they carry `sales-director`, and ignores a
 * `?rep=` a rep is not entitled to — so hiding the team table here is
 * presentation, not protection, and a hand-typed URL gains nothing.
 *
 * `crm_activities` IS THE ONLY SOURCE. A channel whose PR has not landed
 * counts zero, which is the truth; nothing here reaches for Vox, Graph or 3CX.
 */
const RANGE_LABEL: Record<AccountabilityRange, string> = {
  week: "This week",
  last: "Last week",
  "4w": "4 weeks",
};

export default function AccountabilityScreen({ query }: ScreenProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const { isDirector } = useCrmUser();
  const { openSheet, closeSheet } = useCrmSheet();
  const [urlQuery, setUrlQuery] = useUrlQuery(query);

  const range: AccountabilityRange = ACCOUNTABILITY_RANGES.includes(
    urlQuery.range as AccountabilityRange,
  )
    ? (urlQuery.range as AccountabilityRange)
    : "week";
  const rep = isDirector ? (urlQuery.rep ?? null) : null;

  const dataQ = useQuery({
    queryKey: measureKeys.accountability({ range, rep }),
    queryFn: () => fetchAccountability(crmFetch, { range, rep }),
  });

  // The weekly (un-scaled) targets the sheet edits. Only a director can open
  // the sheet, so this read is theirs alone and stays idle for a rep.
  const targetsQ = useQuery({
    queryKey: measureKeys.targets(),
    queryFn: () => fetchTargets(crmFetch),
    enabled: isDirector,
  });

  const save = useMutation({
    mutationFn: (body: TargetsPostBody) => postTargets(crmFetch, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: measureKeys.all });
      closeSheet();
      toast("Targets updated — they apply from next Monday.");
    },
  });

  if (dataQ.isPending) return <LoadingState label="Counting the week…" />;
  if (dataQ.isError) {
    return <ErrorState message={errorMessage(dataQ.error)} onRetry={() => void dataQ.refetch()} />;
  }
  if (!dataQ.data) return <EmptyState>Nothing to show yet.</EmptyState>;

  const { window, reps, reachOuts, behind } = dataQ.data;
  const spanLabel = window.weeks > 1 ? `${window.weeks} weeks` : "week";
  const reachOutPct = pctOf(reachOuts.done, reachOuts.hosts);

  const openTargets = (target: RepAccountability) => {
    const weekly =
      targetsQ.data?.targets.find((t) => t.repSlug === target.slug)?.target ?? target.target;
    openSheet({
      title: `Weekly targets · ${target.displayName}`,
      icon: <IconTarget {...ICON} />,
      testId: MEASURE_TEST_IDS.targetsSheet,
      body: (
        <TargetsSheet
          rep={target}
          weekly={weekly}
          effectiveFrom={nextMonday(new Date())}
          onCancel={closeSheet}
          onSubmit={async (body) => {
            await save.mutateAsync(body);
          }}
        />
      ),
    });
  };

  return (
    <div className="stack" style={{ gap: 12 }} data-testid={MEASURE_TEST_IDS.accountability}>
      <div className="hstack between wrap" style={{ gap: 8 }}>
        <span className="xs muted">
          {window.label} · counts every logged call, text, email and last-year reach-out
          {window.weeks > 1 ? ` · targets scaled to ${window.weeks} weeks` : ""}
        </span>
        <Seg
          label="Range"
          testId={MEASURE_TEST_IDS.accountabilityRange}
          options={ACCOUNTABILITY_RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r] }))}
          value={range}
          onChange={(v) => setUrlQuery({ range: v === "week" ? null : v })}
        />
      </div>

      {behind ? (
        <Banner tone="warn" icon={<IconAlertTriangle {...ICON} />}>
          {behindSentence(behind, window.workingDaysLeft)}
        </Banner>
      ) : null}

      {/*
        SAME-TIME-LAST-YEAR REACH-OUTS. Owner, 2026-09-13: "move same time last
        year reach outs to the accountability board." It was a tile on the KPI
        dashboard, surrounded by booked, quoted and collected money — and it is
        not money, it is how much of last year's book the team has phoned. That
        is the same work the four meters below it count, and `reachouts` is
        already one of them and one of every rep's weekly targets.

        Full width, because it is the only figure on this page that belongs to
        the whole team rather than to a person: the denominator is last year's
        bookings, and a booking is not anybody's.
      */}
      <div className="grid" data-testid={MEASURE_TEST_IDS.reachOuts}>
        <Tile
          label="Same-time-last-year reach-outs"
          value={String(reachOuts.done)}
          unit={` of ${reachOuts.hosts} host${reachOuts.hosts === 1 ? "" : "s"}`}
          ico={<IconHistory {...ICON} />}
          icoCls="warn"
          meter={{ p: reachOutPct, tone: meterTone(reachOutPct) }}
          sub={
            reachOuts.hosts === 0
              ? `Nobody booked a group event in ${window.label.toLowerCase()} a year ago — nothing to reach out to.`
              : `${reachOuts.remaining} host${reachOuts.remaining === 1 ? "" : "s"} with no lead this year · whole team · ${window.label}`
          }
        />
      </div>

      {reps.length === 0 ? (
        <EmptyState>
          {isDirector
            ? "No salespeople on the roster yet — seed the roster from the Statuses screen."
            : "You do not have a salesperson row yet, so there is nothing to count. Ask Jacob to add you on the Rules screen."}
        </EmptyState>
      ) : null}

      <div className={reps.length > 1 ? "grid grid-2" : "grid"}>
        {reps.map((r) => (
          <RepMeterCard
            key={r.slug}
            rep={r}
            spanLabel={spanLabel}
            onEditTargets={isDirector ? openTargets : undefined}
          />
        ))}
      </div>

      {isDirector && reps.length > 0 ? (
        <div className="card">
          <div className="card-h">
            <h2>Team, {window.weeks > 1 ? `last ${window.weeks} weeks` : "this week"}</h2>
          </div>
          <TeamTable reps={reps} windowLabel={window.label} />
        </div>
      ) : null}

      <p className="xs muted">
        A touch counts once per lead per channel per Eastern day. Auto-replies, delivery receipts
        and anything the guest sent us never count. Reach-outs count when the activity is logged as
        a reach-out, or when the lead came from last year’s events.
      </p>
    </div>
  );
}

/** The Monday after the ET week containing `now` — what a saved target starts on. */
function nextMonday(now: Date): string {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [y, m, d] = ymd.split("-").map(Number);
  const at = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12));
  const dow = at.getUTCDay();
  const toMonday = dow === 0 ? -6 : 1 - dow;
  at.setUTCDate(at.getUTCDate() + toMonday + 7);
  return at.toISOString().slice(0, 10);
}
