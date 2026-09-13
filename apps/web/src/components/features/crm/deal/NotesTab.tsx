"use client";

import {
  IconBolt,
  IconClock,
  IconEdit,
  IconEye,
  IconPlus,
  IconSettings,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import {
  EVENTS_COPY,
  EVENT_TEST_IDS,
  type PrivateNoteSection,
} from "~/features/crm/events/contracts";
import { eventsKeys } from "~/features/crm/events/queries";
import { fStamp } from "~/features/crm/core/dates";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmSheet, useCrmToast } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { Pill } from "../primitives/Pill";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import {
  appendPrivateNote,
  fetchNotes,
  previewPublicNotes,
  savePublicNotes,
} from "../events/queries";
import { FoodOutSheet } from "./FoodOutSheet";
import type { DealTabProps } from "./tabs";

/**
 * `notesPanel(l)` (crm-events.js:121-140) — BMI notes, all three of them:
 *
 *   PUBLIC   the textarea the guest's contract page renders. Replace-only,
 *            and the AI grammar pass can be previewed before it is written.
 *   PRIVATE  the Office private log, split into its sections for DISPLAY: the
 *            `── FastTrax Web ──` block, the `----- Portal Staff -----`
 *            food-out line and whatever staff typed by hand. The composer
 *            APPENDS; nothing here can erase another writer's section (R6).
 *   CRM      the deal's own notes — they stay in the CRM and are never
 *            written to BMI.
 */
export default function NotesTab({ detail, refresh }: DealTabProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const { openSheet, closeSheet } = useCrmSheet();
  const id = useId();
  const publicId = detail.lead.publicId;

  const q = useQuery({
    queryKey: eventsKeys.notes(publicId),
    queryFn: () => fetchNotes(crmFetch, publicId),
    enabled: !!detail.lead.bmi.projectId,
  });

  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const publicNotes = draft ?? q.data?.publicNotes ?? "";
  const dirty = draft !== null && draft !== (q.data?.publicNotes ?? "");
  const writesEnabled = q.data?.writesEnabled !== false;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: eventsKeys.notes(publicId) });
    refresh();
  };

  const save = useMutation({
    mutationFn: (clean: boolean) => savePublicNotes(crmFetch, publicId, publicNotes, clean),
    onSuccess: (r) => {
      setDraft(null);
      invalidate();
      closeSheet();
      if (r.verified) toast("Public notes saved to BMI · guest page updated");
      else
        toast(
          "Sent to BMI, but the re-read did not match — check the project before telling the guest",
          "warn",
        );
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const preview = useMutation({
    mutationFn: () => previewPublicNotes(crmFetch, publicId, publicNotes),
    onSuccess: (r) =>
      openSheet({
        title: "Grammar clean-up preview",
        icon: <IconEye {...ICON} />,
        wide: true,
        body: (
          <div className="stack">
            {!r.available ? (
              <Banner tone="warn">
                The AI editor is not configured here, so your text comes back unchanged.
              </Banner>
            ) : null}
            <div className="grid grid-2">
              <div>
                <div className="eyebrow">You wrote</div>
                <div className="gp-card" style={{ whiteSpace: "pre-wrap" }}>
                  {r.original}
                </div>
              </div>
              <div>
                <div className="eyebrow">Guest will see</div>
                <div className="gp-card gp-notes" style={{ whiteSpace: "pre-wrap" }}>
                  {r.cleaned}
                </div>
              </div>
            </div>
            <div className="xs muted">{EVENTS_COPY.cleanupHelp}</div>
          </div>
        ),
        foot: (
          <>
            <button type="button" className="btn" onClick={closeSheet}>
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!writesEnabled || save.isPending}
              onClick={() => save.mutate(true)}
            >
              Save to BMI
            </button>
          </>
        ),
      }),
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const append = useMutation({
    mutationFn: () => appendPrivateNote(crmFetch, publicId, note),
    onSuccess: (r) => {
      setNote("");
      invalidate();
      if (r.appended) toast("Appended to BMI private notes");
      else toast("BMI would not take the note — it is on this timeline only", "warn");
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const foodOut = () =>
    openSheet({
      title: "Food out time",
      icon: <IconClock {...ICON} />,
      body: (
        <FoodOutSheet
          publicId={publicId}
          current={q.data?.foodOut.time ?? null}
          onDone={() => {
            closeSheet();
            invalidate();
          }}
        />
      ),
    });

  if (!detail.lead.bmi.projectId) {
    return (
      <div className="card" data-testid={EVENT_TEST_IDS.notesTab}>
        <div className="pad">
          <EmptyState>
            This lead has no BMI project yet, so there are no BMI notes to show. Create it in BMI
            from the deal header first.
          </EmptyState>
        </div>
      </div>
    );
  }

  if (q.isPending) return <LoadingState label="Reading the BMI project…" />;
  if (q.isError)
    return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const sections = q.data?.sections ?? [];
  const foodOutSource = q.data?.foodOut.source ?? null;

  return (
    <div className="deal-grid" data-testid={EVENT_TEST_IDS.notesTab}>
      <div className="stack" style={{ gap: 16 }}>
        {!writesEnabled ? (
          <Banner tone="warn">
            BMI writes are paused for this centre — the notes below are read-only until a director
            turns them back on from Statuses.
          </Banner>
        ) : null}

        <div className="card" data-testid={EVENT_TEST_IDS.publicNotes}>
          <div className="card-h">
            <Chip kind="open">Public</Chip>
            <h2>Notes the guest sees</h2>
            <div className="right">
              <span className="xs muted">{EVENTS_COPY.publicNotesCaption}</span>
            </div>
          </div>
          <div className="pad stack">
            <label className="sr-only" htmlFor={`${id}-public`}>
              Public notes
            </label>
            <textarea
              id={`${id}-public`}
              className="textarea"
              rows={6}
              style={{ fontSize: 14 }}
              value={publicNotes}
              disabled={!writesEnabled}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="hstack between">
              <span className="xs muted">{EVENTS_COPY.publicNotesHelp}</span>
              <div className="hstack">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!publicNotes.trim() || preview.isPending}
                  onClick={() => preview.mutate()}
                >
                  <IconEye {...ICON} /> Preview clean-up
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!writesEnabled || !dirty || save.isPending}
                  onClick={() => save.mutate(true)}
                >
                  {save.isPending ? "Saving…" : "Save to BMI"}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="card" data-testid={EVENT_TEST_IDS.privateLog}>
          <div className="card-h">
            <Chip bmi>Private</Chip>
            <h2>Staff notes</h2>
            <div className="right">
              <span className="xs muted">{EVENTS_COPY.privateNotesCaption}</span>
            </div>
          </div>
          <div className="pad stack">
            <div
              className="composer"
              style={{ border: "1px solid var(--border2)", borderRadius: 12, padding: "8px 10px" }}
            >
              <label className="sr-only" htmlFor={`${id}-private`}>
                New private note
              </label>
              <textarea
                id={`${id}-private`}
                placeholder={EVENTS_COPY.privateComposerPlaceholder}
                value={note}
                disabled={!writesEnabled}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-primary btn-icon"
                aria-label="Append the note to BMI"
                disabled={!writesEnabled || !note.trim() || append.isPending}
                onClick={() => append.mutate()}
              >
                <IconPlus {...ICON} />
              </button>
            </div>

            <div className="notelog">
              {sections.length === 0 ? (
                <EmptyState>This project has no private notes yet.</EmptyState>
              ) : null}
              {sections.map((s) => (
                <SectionNote
                  key={s.key}
                  section={s}
                  source={foodOutSource}
                  onFoodOut={writesEnabled ? foodOut : null}
                />
              ))}
            </div>

            <div className="xs muted">{EVENTS_COPY.threeWriters}</div>
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h2>CRM notes</h2>
            <div className="right">
              <span className="xs muted">this CRM only · never written to BMI</span>
            </div>
          </div>
          <div className="pad stack">
            {(q.data?.crmNotes ?? []).length === 0 ? (
              <EmptyState>No CRM notes on this deal yet.</EmptyState>
            ) : null}
            {(q.data?.crmNotes ?? []).map((n) => (
              <div className="note" key={n.id}>
                <div className="nh">
                  <b>{n.actorEmail ?? "system"}</b>
                  <span className="xs muted">{fStamp(n.occurredAt)}</span>
                </div>
                <div className="small" style={{ whiteSpace: "pre-wrap" }}>
                  {n.body}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="stack" style={{ gap: 16 }}>
        <div className="card">
          <div className="card-h">
            <h2>Where each note goes</h2>
          </div>
          <div className="pad stack small">
            <div className="hstack">
              <Chip kind="open">Public</Chip>
              <span>{EVENTS_COPY.whereGoesPublic}</span>
            </div>
            <div className="hstack">
              <Chip bmi>Private</Chip>
              <span>{EVENTS_COPY.whereGoesPrivate}</span>
            </div>
            <div className="divider" />
            <div className="muted">{EVENTS_COPY.crmNotesStayHere}</div>
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h2>Food out</h2>
          </div>
          <div className="pad stack small">
            <div className="hstack between">
              <b style={{ fontSize: 18 }}>{q.data?.foodOut.time ?? "—"}</b>
              <Pill>
                {foodOutSource === "ai"
                  ? `AI${q.data?.foodOut.confidence ? ` · ${q.data.foodOut.confidence} confidence` : ""}`
                  : foodOutSource === "manual"
                    ? "Set by staff"
                    : "not found"}
              </Pill>
            </div>
            <div className="hstack">
              <button
                type="button"
                className="btn btn-sm"
                disabled={!writesEnabled}
                onClick={foodOut}
              >
                <IconEdit {...ICON} /> Food out time
              </button>
            </div>
            <div className="xs muted">{EVENTS_COPY.foodOutHelp}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One parsed slice of the private memo, with the marker it was found by. */
function SectionNote({
  section,
  source,
  onFoodOut,
}: {
  section: PrivateNoteSection;
  source: "ai" | "manual" | null;
  onFoodOut: (() => void) | null;
}) {
  const cls =
    section.key === "web" ? "note web" : section.key === "portal" ? "note portal" : "note";
  return (
    <div className={cls} data-testid={EVENT_TEST_IDS.section(section.key)}>
      <div className="nh">
        {section.key === "web" ? <IconBolt {...ICON} /> : null}
        {section.key === "portal" ? <IconSettings {...ICON} /> : null}
        <b>{section.label}</b>
        {section.marker ? <Pill>{section.marker}</Pill> : null}
      </div>
      <div className="small hstack between">
        <span style={{ whiteSpace: "pre-wrap" }}>{section.text}</span>
        {section.key === "portal" ? (
          <span className="hstack">
            <Pill>{source === "ai" ? "AI" : source === "manual" ? "Manual" : "—"}</Pill>
            {onFoodOut ? (
              <button type="button" className="btn btn-sm" onClick={onFoodOut}>
                <IconEdit {...ICON} /> Food out time
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}
