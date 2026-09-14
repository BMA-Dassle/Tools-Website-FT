"use client";

import {
  IconAlertTriangle,
  IconBuildingWarehouse,
  IconInfoCircle,
  IconPlayerPause,
  IconRefresh,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createPortal } from "react-dom";
import {
  BUILDER_TEST_IDS,
  HEAT_FULL_ERROR,
  SYNCING_MESSAGE,
  type BuilderPostBody,
  type BuilderStateResponse,
  type QuoteLine,
  type ScheduleBlock,
} from "~/features/crm/bmi/contracts";
import { builderKeys } from "~/features/crm/bmi/queries";
import { templateLinesFromQuote } from "~/features/crm/bmi/service/templates";
import { CENTRES } from "~/features/crm/core/centres";
import { CRM_BASE } from "~/features/crm/core/contracts";
import { fDate } from "~/features/crm/core/dates";
import { moneyExact } from "~/features/crm/core/format";
import type { ScreenProps } from "~/features/crm/core/screens";
import { CrmApiError, errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast, useScreenHead, useTopbarSlot } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";
import { ErrorState, LoadingState } from "../primitives/States";
import { AddLine } from "./AddLine";
import { QuoteLines } from "./QuoteLines";
import { SchedulePicker } from "./SchedulePicker";
import { Templates } from "./Templates";
import { liveLines, parseHoldHint, projectLabel, quoteTotalCents } from "./model";
import { fetchBuilderState, postBuilder, postTemplates } from "./queries";

/**
 * `/admin/crm/builder/<leadId>` — "Build in BMI" (C5).
 *
 * THE ONLY SCREEN IN THE CRM THAT WRITES TO BMI OFFICE, and it says so out
 * loud at every step:
 *
 *  - **Our rows first.** The table is `crm_quote_lines`, not Office's product
 *    list. A line the rep added is on screen whether or not Office took it,
 *    with a chip saying which and a Retry beside it. An Office outage costs a
 *    press, never the quote.
 *  - **A full heat is a sentence, not a stack trace.** Office refuses an
 *    over-capacity `linkSchedule` with a 403 soft refusal; the picker shows
 *    "this heat is full — pick another" with Office's own wording, and a
 *    director (only) may force it through.
 *  - **Someone else's edit is visible, never overwritten.** A product row on
 *    the project that we did not put there raises a banner naming it.
 *  - **Paused means paused.** With `CRM_BMI_WRITES` off, or the director's
 *    toggle down, the builder says "BMI writes are paused by admin" and
 *    degrades to a quote recorded in the CRM alone.
 *  - **The centre has not seen it yet, and we say so.** Office's cloud reaches
 *    the desk's own copy in minutes, so until Pandora reads the project back
 *    the header says "syncing to centre".
 *
 * Availability's "Hold these lanes in BMI" lands here as
 * `?lanes=13–15&start=1080&section=Regular`; that hint seeds the picker and is
 * never trusted into a write.
 */

export default function BuilderScreen({ view, query }: ScreenProps) {
  // ---- hooks above every early return (react-hooks/rules-of-hooks) ----
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const slot = useTopbarSlot();
  const qc = useQueryClient();
  const [scheduling, setScheduling] = useState<QuoteLine | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const leadId = view[0] ?? query.lead ?? "";
  const hint = parseHoldHint(query);

  const stateQ = useQuery({
    queryKey: builderKeys.state(leadId),
    queryFn: () => fetchBuilderState(crmFetch, leadId),
    enabled: leadId !== "",
  });

  const data = stateQ.data;

  const act = useMutation({
    mutationFn: (body: BuilderPostBody) => postBuilder(crmFetch, body),
    onSuccess: (next: BuilderStateResponse) => {
      qc.setQueryData(builderKeys.state(leadId), next);
      setRefusal(null);
    },
    onError: (err: unknown) => {
      // A soft refusal is not a failure: it is Office telling the rep the heat
      // is full. It stays on the picker, in Office's own words, instead of
      // being flattened into a red toast that says "something went wrong".
      if (err instanceof CrmApiError && err.message === HEAT_FULL_ERROR) {
        setRefusal(err.officePrompt?.message ?? "That heat is full.");
        void qc.invalidateQueries({ queryKey: builderKeys.state(leadId) });
        return;
      }
      toast(errorMessage(err), "crit");
    },
  });

  const saveTemplate = useMutation({
    mutationFn: (name: string) =>
      postTemplates(crmFetch, {
        action: "save",
        name,
        centre: data?.lead?.centre ?? null,
        baselineGuests: data?.lead?.guests ?? 1,
        lines: templateLinesFromQuote(
          liveLines(data?.lines ?? []).map((l) => ({
            productId: l.productId,
            productName: l.nameOverride ?? l.productName,
            quantity: l.quantity,
          })),
          data?.lead?.guests ?? 1,
        ),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: builderKeys.all });
      toast("Saved as a template");
    },
    onError: (err: unknown) => toast(errorMessage(err), "crit"),
  });

  const archiveTemplate = useMutation({
    mutationFn: (id: string) => postTemplates(crmFetch, { action: "archive", id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: builderKeys.all });
      toast("Template retired");
    },
    onError: (err: unknown) => toast(errorMessage(err), "crit"),
  });

  useScreenHead(
    data?.lead ? data.lead.title : null,
    data?.lead ? `${fDate(data.lead.eventDate)} · ${CENTRES[data.lead.centre].short}` : null,
  );

  // ---- derived (no hooks below this line) ----
  const busy = act.isPending || stateQ.isFetching;
  const lines = data?.lines ?? [];
  const total = quoteTotalCents(lines);
  const writesPaused = data ? !data.writes.enabled : false;

  if (leadId === "") {
    return (
      <div className="card">
        <div className="pad">
          <Banner tone="info" icon={<IconInfoCircle {...ICON} />}>
            Open the builder from a deal — it quotes against one lead&rsquo;s BMI project.
          </Banner>
        </div>
      </div>
    );
  }

  if (stateQ.isPending) return <LoadingState label="Reading the quote…" />;

  if (stateQ.isError) {
    return (
      <div className="pad">
        <ErrorState message={errorMessage(stateQ.error)} onRetry={() => void stateQ.refetch()} />
      </div>
    );
  }

  if (!data || data.leadMissing || !data.lead) {
    return (
      <div className="card">
        <div className="pad">
          <Banner tone="warn" icon={<IconAlertTriangle {...ICON} />}>
            That lead is not in the CRM, so there is nothing to quote against.
          </Banner>
        </div>
      </div>
    );
  }

  const lead = data.lead;

  return (
    <>
      {slot
        ? createPortal(
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => act.mutate({ action: "sync", lead: leadId })}
              disabled={busy}
            >
              <IconRefresh {...ICON} />
              <span className="lbl">Re-read BMI</span>
            </button>,
            slot,
          )
        : null}

      <div className="card" data-testid={BUILDER_TEST_IDS.screen}>
        <div className="card-h">
          <h2>Build in BMI · {CENTRES[lead.centre].short}</h2>
          <div className="right xs muted">
            {projectLabel(data.project?.number ?? null, data.project?.projectId ?? null)} ·{" "}
            {fDate(lead.eventDate)} · {lead.guests} guests
          </div>
        </div>

        {writesPaused ? (
          <div className="pad">
            <Banner
              tone="warn"
              icon={<IconPlayerPause {...ICON} />}
              testId={BUILDER_TEST_IDS.writesPaused}
            >
              <b>{data.writes.message}</b> The quote is still recorded in the CRM — nothing is sent
              to BMI until writes are switched back on, then press Retry on each line.
            </Banner>
          </div>
        ) : null}

        {data.changedInOffice ? (
          <div className="pad">
            <Banner
              tone="warn"
              icon={<IconBuildingWarehouse {...ICON} />}
              testId={BUILDER_TEST_IDS.changedInOffice}
            >
              {/* The Office-added lines are IN THE TABLE now, so this no longer
                  lists them — a banner naming rows that are visible three
                  inches below it is noise, and listing them by raw id was how
                  a fully-built event came to read "Nothing on this quote yet".
                  What still deserves a banner is a line that has GONE: the CRM
                  wrote it, Office no longer has it, and nothing on screen would
                  otherwise say so. */}
              <b>Changed in Office.</b>{" "}
              {data.gone.length > 0
                ? `${data.gone.length === 1 ? "A line the CRM wrote is" : `${data.gone.length} lines the CRM wrote are`} no longer on the project — someone removed ${data.gone.length === 1 ? "it" : "them"} in Office.`
                : `${data.officeOnly.length === 1 ? "A line was" : `${data.officeOnly.length} lines were`} added in Office. ${data.officeOnly.length === 1 ? "It is" : "They are"} listed below and the builder leaves ${data.officeOnly.length === 1 ? "it" : "them"} alone — edit in Office if wrong.`}
            </Banner>
          </div>
        ) : null}

        {data.sync === "syncing" ? (
          <div className="pad">
            <Banner tone="info" icon={<IconInfoCircle {...ICON} />}>
              {SYNCING_MESSAGE}
            </Banner>
          </div>
        ) : null}

        {!data.project ? (
          <div className="pad stack">
            <Banner tone="info" icon={<IconInfoCircle {...ICON} />}>
              This lead has no BMI project yet. Creating one writes the shell, attaches the host and
              saves the date — nothing is charged and nothing is confirmed.
            </Banner>
            <div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || writesPaused}
                onClick={() => act.mutate({ action: "create-project", lead: leadId })}
              >
                <span className="lbl">Create the project in BMI</span>
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="pad-x">
              <QuoteLines
                lines={lines}
                officeOnly={data.officeOnly}
                canForce={data.canForce}
                busy={busy}
                onRetry={(lineId) => act.mutate({ action: "retry-line", lead: leadId, lineId })}
                onRemove={(lineId) => act.mutate({ action: "remove-line", lead: leadId, lineId })}
                onSchedule={(line) => {
                  setRefusal(null);
                  setScheduling(line);
                }}
              />
            </div>

            <div className="pad">
              <div className="done-strip" data-testid={BUILDER_TEST_IDS.balance}>
                <span>
                  Quote total <b className="money">{moneyExact(total)}</b>
                </span>
                {data.balance ? (
                  <span className="muted">
                    BMI says {moneyExact(data.balance.totalCents)} · balance{" "}
                    {moneyExact(data.balance.balanceCents)}
                  </span>
                ) : (
                  <span className="muted">BMI total not read yet</span>
                )}
              </div>
            </div>

            <div className="pad">
              <AddLine
                centre={lead.centre}
                date={lead.eventDate}
                lead={leadId}
                busy={busy || writesPaused}
                onAdd={(input) => act.mutate({ action: "add-line", lead: leadId, ...input })}
              />
            </div>
          </>
        )}
      </div>

      <Templates
        centre={lead.centre}
        guests={lead.guests}
        busy={busy}
        canSave={liveLines(lines).length > 0}
        onApply={(templateId) => act.mutate({ action: "apply-template", lead: leadId, templateId })}
        onSave={() => {
          const name = window.prompt("Name this template");
          if (name?.trim()) saveTemplate.mutate(name.trim());
        }}
        onArchive={(id) => archiveTemplate.mutate(id)}
      />

      {hint.lanes.length > 0 ? (
        <div className="card">
          <div className="pad xs muted">
            Came from availability: {hint.section ?? "lanes"} {hint.lanes[0]}–
            {hint.lanes[hint.lanes.length - 1]}. Lane blocks are linked per quote line — add the
            lane product above, then press Schedule on it.{" "}
            <a href={`${CRM_BASE}/availability/${encodeURIComponent(leadId)}`}>
              Back to availability
            </a>
          </div>
        </div>
      ) : null}

      <SchedulePicker
        open={scheduling !== null}
        line={scheduling}
        centre={lead.centre}
        date={lead.eventDate}
        guests={lead.guests}
        lead={leadId}
        canForce={data.canForce}
        busy={busy}
        refusal={refusal}
        onClose={() => {
          setScheduling(null);
          setRefusal(null);
        }}
        onLink={(blocks: ScheduleBlock[], force: boolean) => {
          if (!scheduling) return;
          act.mutate({
            action: "link-schedule",
            lead: leadId,
            lineId: scheduling.id,
            blocks,
            force,
          });
        }}
      />
    </>
  );
}
