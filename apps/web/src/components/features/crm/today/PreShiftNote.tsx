"use client";

import { IconCheck, IconSpeakerphone, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { CENTRE_LIST } from "~/features/crm/core/centres";
import type { CentreCode } from "~/features/crm/core/types";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast, useCrmUser } from "../lib/use-crm-user";
import { ICON } from "../primitives/icon-props";

/**
 * "A little note for the day from me" — the owner's pre-shift, at the top of
 * My Day.
 *
 * Owner, 2026-09-14: "Would be cool to have a little note for the day from me,
 * something like a pre shift that appears on their 'my day'."
 *
 * IT IS A PRE-SHIFT, so it behaves like one:
 *   - it is about ONE DAY and gone the next, because that is what a pre-shift
 *     is; a message that lingers for a week is an announcement nobody reads;
 *   - it sits ABOVE the work, not in a menu — the point is that it is seen
 *     without being looked for;
 *   - "Got it" dismisses it FOR THAT REP ONLY and does not delete it, so a
 *     director can still answer "did the team see Friday's note". That is most
 *     of why it is worth building rather than sending a text.
 *
 * Nothing renders when there is nothing to say: an empty banner reserving space
 * for a note that was never written is worse than no feature.
 */

interface DailyNote {
  id: string;
  date: string;
  centre: CentreCode | null;
  repId: string | null;
  body: string;
  authorEmail: string;
  read: boolean;
  readCount: number;
}

interface NoteResponse {
  date: string;
  notes: DailyNote[];
  all: DailyNote[];
}

export function PreShiftNote() {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const { isDirector } = useCrmUser();
  const id = useId();
  const [draft, setDraft] = useState("");
  const [centre, setCentre] = useState<"" | CentreCode>("");
  const [composing, setComposing] = useState(false);

  const q = useQuery({
    queryKey: ["crm", "daily-note"],
    queryFn: () => crmFetch<NoteResponse>("/daily-note"),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["crm", "daily-note"] });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      crmFetch("/daily-note", { method: "POST", body }),
    onSuccess: () => {
      setDraft("");
      setComposing(false);
      void invalidate();
      toast("Pre-shift note posted");
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const ack = useMutation({
    mutationFn: (noteId: string) =>
      crmFetch("/daily-note", { method: "POST", body: { noteId, read: true } }),
    onSuccess: () => void invalidate(),
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const remove = useMutation({
    mutationFn: (noteId: string) => crmFetch("/daily-note", { method: "DELETE", body: { noteId } }),
    onSuccess: () => {
      void invalidate();
      toast("Note taken down");
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  // Only the ones this person has not dismissed. A director's own compose box
  // is separate, so they do not have to dismiss their own note to write one.
  const unread = (q.data?.notes ?? []).filter((n) => !n.read);

  if (!q.data) return null;
  if (unread.length === 0 && !isDirector) return null;

  return (
    <>
      {unread.map((note) => (
        <div className="preshift" key={note.id} data-testid="crm-preshift-note">
          <span className="ps-ico" aria-hidden>
            <IconSpeakerphone {...ICON} />
          </span>
          <div className="ps-body">
            <div className="ps-eyebrow">
              Today&rsquo;s note
              {note.centre ? ` · ${CENTRE_LIST.find((c) => c.code === note.centre)?.short}` : ""}
              {note.repId ? " · for you" : ""}
            </div>
            {/* The owner's own words, wrapped but never reformatted. */}
            <p className="ps-text">{note.body}</p>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => ack.mutate(note.id)}
            disabled={ack.isPending}
          >
            <IconCheck {...ICON} /> Got it
          </button>
          {isDirector ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost btn-icon"
              aria-label="Take this note down"
              title={`Take down — ${note.readCount} read so far`}
              onClick={() => remove.mutate(note.id)}
              disabled={remove.isPending}
            >
              <IconTrash {...ICON} />
            </button>
          ) : null}
        </div>
      ))}

      {isDirector ? (
        composing ? (
          <div className="preshift preshift-compose">
            <span className="ps-ico" aria-hidden>
              <IconSpeakerphone {...ICON} />
            </span>
            <div className="ps-body">
              <label className="sr-only" htmlFor={`${id}-body`}>
                Today&rsquo;s note
              </label>
              <textarea
                id={`${id}-body`}
                className="textarea"
                rows={2}
                /* No `autoFocus`: the a11y gate refuses it, and it is right to
                   — a box that grabs focus moves a screen reader's cursor
                   without being asked. The director just pressed the button
                   beside it, so they are already here. */
                placeholder="What the team should know before the shift…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="hstack" style={{ marginTop: 8, gap: 8 }}>
                <label className="sr-only" htmlFor={`${id}-centre`}>
                  Who sees it
                </label>
                <select
                  id={`${id}-centre`}
                  className="select"
                  style={{ width: "auto" }}
                  value={centre}
                  onChange={(e) => setCentre(e.target.value as "" | CentreCode)}
                >
                  <option value="">Everyone</option>
                  {CENTRE_LIST.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.short} only
                    </option>
                  ))}
                </select>
                <span style={{ flex: 1 }} />
                <button type="button" className="btn btn-sm" onClick={() => setComposing(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={!draft.trim() || save.isPending}
                  onClick={() => save.mutate({ body: draft.trim(), centre: centre || null })}
                >
                  Post for today
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* Quiet until asked for: the director's own My Day is a working
             screen, and a permanent compose box at the top of it is a box
             nobody types in. */
          <div className="preshift-add">
            <button type="button" className="btn btn-sm" onClick={() => setComposing(true)}>
              <IconSpeakerphone {...ICON} />{" "}
              {(q.data.all ?? []).length > 0 ? "Add another note" : "Write today's note"}
            </button>
          </div>
        )
      ) : null}
    </>
  );
}
