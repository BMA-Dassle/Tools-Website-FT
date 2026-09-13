"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState } from "react";
import { CRM_BASE } from "~/features/crm/core/contracts";
import { fDate, fMonth, monthKey } from "~/features/crm/core/dates";
import {
  EVENT_TYPE_LABEL,
  type LeadSuggestionView,
  type LeadView,
  type QueueRepColumn,
  type RuleTraceRowView,
} from "~/features/crm/leads/contracts";
import { QUEUE_POLL_MS, leadsKeys } from "~/features/crm/leads/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { Avatar } from "../primitives/Avatar";
import { Chip } from "../primitives/Chip";
import { MON } from "../primitives/DateBlock";
import { RuleTrace, type RuleTraceRow } from "../primitives/RuleTrace";
import { centreShort } from "../leads/LeadCard";
import { assignToastText, leadTitle } from "../leads/model";
import { fetchQueue, postAssign } from "../leads/queries";

const CENTRE_NAME: Record<LeadView["centre"], string> = {
  HPFM: "HeadPinz Fort Myers",
  FT: "FastTrax Fort Myers",
  HPN: "HeadPinz Naples",
};

/**
 * `assignSheet(id)` (crm-shared.js:230): the lead's facts, "Why <pick>" with
 * the rule trace when the engine has one — a neutral "No auto-pick yet" line
 * until B2 is wired — one `.opt` per assignable rep with their open volume
 * for the party month, a note, and "Assign to <first>". The volume comes from
 * the queue read (director-only, like this sheet).
 */
export interface AssignSheetProps {
  lead: LeadView;
  suggestion: LeadSuggestionView | null;
  trace: RuleTraceRowView[];
  onCancel: () => void;
  onDone: () => void;
}

/**
 * The pill on a trace row shows the rule's on-screen code ("R6"), the way the
 * Rules screen's own "Try a lead" does — the numeric `crm_assignment_rules.id`
 * travels on the wire so `crm_assignments.rule_id` stays a real foreign key,
 * but it means nothing to a director. Falls back to the id when a row has no
 * code (a rule deleted since the decision was traced).
 */
export function toTraceSteps(rows: readonly RuleTraceRowView[]): RuleTraceRow[] {
  return rows.map((t) => ({
    ruleId: t.code ?? t.ruleId,
    hit: t.hit,
    note: t.note,
    label: t.label,
  }));
}

export function AssignSheet({ lead, suggestion, trace, onCancel, onDone }: AssignSheetProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const id = useId();
  const [picked, setPicked] = useState<string | null>(suggestion?.rep.id ?? null);
  const [note, setNote] = useState("");

  const queue = useQuery({
    queryKey: leadsKeys.queue(),
    queryFn: () => fetchQueue(crmFetch),
    staleTime: QUEUE_POLL_MS,
  });

  const assign = useMutation({
    mutationFn: (repId: string) =>
      postAssign(crmFetch, lead.publicId, { repId, note: note.trim() || null }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      const first = r.assignment.toRepName?.split(/\s+/)[0] ?? "rep";
      const t = assignToastText(first, r.bmi);
      toast(t.text, t.kind);
      onDone();
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const month = monthKey(lead.eventDate);
  const monLabel = MON[Number(month.slice(5)) - 1] ?? month;
  const traceSteps = toTraceSteps(trace);
  const columns: QueueRepColumn[] = queue.data?.reps ?? [];
  const pickedCol = columns.find((c) => c.rep.id === picked) ?? null;
  const pickFirst = pickedCol?.rep.firstName ?? suggestion?.rep.firstName ?? null;

  return (
    <div className="stack">
      <div className="muted small">
        {fDate(lead.eventDate)} · {lead.guests} guests · {EVENT_TYPE_LABEL[lead.type]} ·{" "}
        {CENTRE_NAME[lead.centre]}. Volume = each rep&apos;s open leads for{" "}
        <b>{fMonth(lead.eventDate)}</b>.
      </div>

      {trace.length > 0 && suggestion ? (
        <RuleTrace
          steps={traceSteps}
          finalRuleId={suggestion.finalRuleCode ?? suggestion.ruleId ?? undefined}
          heading={`Why ${suggestion.rep.firstName}`}
          footer={
            <Link className="xs" href={`${CRM_BASE}/rules`}>
              Edit rules ↗
            </Link>
          }
        />
      ) : (
        <div className="rule-trace">
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            Auto-pick
          </div>
          {trace.length > 0 ? (
            <>
              <div className="small muted">
                No auto-pick — the rules ran and left this one for you. Pick a rep below.
              </div>
              <RuleTrace steps={traceSteps} />
            </>
          ) : (
            <div className="small muted">
              No auto-pick — the rules could not run for this lead. Pick a rep below.
            </div>
          )}
          <Link className="xs" href={`${CRM_BASE}/rules`}>
            Edit rules ↗
          </Link>
        </div>
      )}

      <div className="stack" role="radiogroup" aria-label="Assign to">
        {queue.isPending ? <div className="empty">Loading the team…</div> : null}
        {queue.isError ? <div className="banner crit">{errorMessage(queue.error)}</div> : null}
        {columns.map((c) => {
          const v = c.volume[month] ?? { guests: 0, count: 0 };
          const covers = c.rep.centres.includes(lead.centre);
          const isPick = c.rep.id === picked;
          return (
            <button
              key={c.rep.id}
              type="button"
              role="radio"
              aria-checked={isPick}
              className={isPick ? "opt pick" : "opt"}
              onClick={() => setPicked(c.rep.id)}
              style={{ width: "100%", textAlign: "left" }}
            >
              <Avatar initials={c.rep.initials} repSlug={c.rep.slug} name={c.rep.displayName} />
              <div>
                <div className="strong hstack">
                  {c.rep.displayName}
                  {suggestion?.rep.id === c.rep.id ? <Chip kind="open">Auto-pick</Chip> : null}
                </div>
                <div className="why">
                  {v.count} open leads · {v.guests} guests in {monLabel}
                  {covers ? "" : ` · does not cover ${centreShort(lead.centre)}`}
                </div>
              </div>
              <span className="money strong tabular">{v.guests}</span>
            </button>
          );
        })}
      </div>

      <div className="field">
        <label htmlFor={`${id}-note`}>Note to rep (optional)</label>
        <input
          id={`${id}-note`}
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Referred by Lee Health — treat as warm"
        />
      </div>

      <div className="hstack" style={{ justifyContent: "flex-end" }}>
        {queue.data?.autoAssignInMinutes != null ? (
          <span className="muted small" style={{ marginRight: "auto" }}>
            Auto-assign runs in {queue.data.autoAssignInMinutes} min if nobody picks
          </span>
        ) : null}
        <button type="button" className="btn" onClick={onCancel} disabled={assign.isPending}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!picked || assign.isPending}
          onClick={() => picked && assign.mutate(picked)}
        >
          {assign.isPending
            ? "Assigning…"
            : pickFirst
              ? `Assign to ${pickFirst}`
              : `Assign ${leadTitle(lead)}`}
        </button>
      </div>
    </div>
  );
}
