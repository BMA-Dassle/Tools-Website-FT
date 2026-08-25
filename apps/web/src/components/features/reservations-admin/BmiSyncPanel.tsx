"use client";

/**
 * BMI sync — a filter-bar BUTTON that opens a modal (owner 2026-08-12: "this
 * needs to be a button with popup modal, with filters for waiting or cleared").
 *
 * It started as an always-open section, which cost the board a block of vertical
 * space to say "nothing is wrong" on the overwhelming majority of loads. As a
 * button it says the same thing in a badge and gets out of the way — while still
 * being the thing you reach for when a pill goes amber.
 *
 * WHAT IT WATCHES. Under cloud-first, a booking completes on the BMI cloud and
 * the on-site (Pandora) work — waiver record, registration, grid seat — lands
 * seconds to minutes later behind a barrier. That gap used to be invisible until
 * a racer wasn't on the grid.
 *
 * The BADGE is the whole point of the button: it shows the worst outstanding
 * state without being opened, so nobody has to remember to check. Silent (plain)
 * only when there is genuinely nothing owed.
 */
import { useMemo, useState } from "react";
import ModalShell from "./ModalShell";
import type { AdminSyncRow } from "~/features/reservations-admin/bmi-sync-view";

const TONE = {
  parked: { bg: "rgba(239,68,68,0.14)", fg: "#f87171", border: "rgba(239,68,68,0.35)" },
  late: { bg: "rgba(240,179,65,0.14)", fg: "#f0b341", border: "rgba(240,179,65,0.35)" },
  pending: { bg: "rgba(148,163,184,0.14)", fg: "#94a3b8", border: "rgba(148,163,184,0.3)" },
  done: { bg: "rgba(34,197,94,0.12)", fg: "#22c55e", border: "rgba(34,197,94,0.3)" },
  /** Closed by a person. Deliberately grey, not green: nothing landed. */
  dismissed: { bg: "rgba(148,163,184,0.10)", fg: "#94a3b8", border: "rgba(148,163,184,0.22)" },
} as const;

export function toneFor(r: AdminSyncRow): keyof typeof TONE {
  if (r.status === "parked") return "parked";
  if (r.status === "done") return "done";
  // Terminal-and-quiet. Must be tested BEFORE the age fallback below, or a
  // closed row reads as "late" for ever — the trap that hid `cancelled` rows.
  if (r.status === "dismissed" || r.status === "cancelled") return "dismissed";
  return r.ageMin >= 10 ? "late" : "pending";
}

/** What the State pill says. One word per status; never "gave up" for a row a
 *  person has already dealt with. */
export function stateLabel(r: AdminSyncRow): string {
  if (r.status === "done") return "landed";
  if (r.status === "parked") return "gave up";
  if (r.status === "dismissed") return "set aside";
  if (r.status === "cancelled") return "cancelled";
  return r.ageMin >= 10 ? "late" : "waiting";
}

/** Desk language beats field names: "waiting for the center's server to see the
 *  person" tells staff what is happening; "person-local" does not. */
const BARRIER_COPY: Record<string, string> = {
  "person-local": "waiting for the center's server to see the person",
  "person-cloud": "waiting for BMI cloud to see the person",
  "project-local": "waiting for the reservation to reach the center",
  "party-ready": "waiting for the whole party to sync + all waivers verified",
  // The two newest barriers had no entry, so staff read the raw slug as the
  // tooltip on exactly the rows most likely to need explaining.
  "party-seated": "waiting for every racer to appear on the grid",
  "persons-local": "waiting for the center's server to see everyone named",
  none: "no wait",
};

const KIND_COPY: Record<string, string> = {
  "repair-person-details": "Fix person record (birthdate/contact)",
  "push-waiver-signature": "Send waiver to BMI",
  "add-membership": "Grant registration",
  "attach-project-person": "Add guest to reservation",
  "stamp-confirmation-state": "Mark reservation checked in",
  // Not a queue row — a signer's attach outcome, folded in so a guest who went
  // through cleanly is VISIBLE instead of silent (owner: "I just put in a person
  // name test again and don't see it here?").
  "guest-added": "Guest added (waiver)",
};

/** Waiting = still owed. Cleared = landed, or closed by a person. Attention =
 *  gave up and nobody has dealt with it yet. */
type Filter = "waiting" | "cleared" | "attention" | "all";

/** Closed for good, whoever closed it — a landed row and a set-aside row both
 *  belong under "Cleared", because neither is owed any more. */
export const isSettled = (r: AdminSyncRow): boolean =>
  r.status === "done" || r.status === "dismissed" || r.status === "cancelled";

/**
 * How long the step actually took, created → resolved.
 *
 * Seconds below a minute, because that is the whole point of the comparison now:
 * the Vercel Queues push settles in ~28s and the old every-2-minutes cron could
 * not beat 120s. Rounding that to "0m" would hide the only number worth seeing.
 *
 * Returns null when there is nothing honest to show — still running, or a derived
 * row that stamps resolved = created and would read as a meaningless 0s.
 */
function tookLabel(createdAt: string, resolvedAt: string | null): string | null {
  if (!resolvedAt) return null;
  const ms = Date.parse(resolvedAt) - Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function BmiSyncPanel({
  rows,
  token,
  olderParked = 0,
  onChanged,
}: {
  rows: AdminSyncRow[];
  /** Admin token, for the dismiss POST. Without it the control is not offered —
   *  a button that cannot work must not be on screen. */
  token?: string;
  /** Still-parked rows OLDER than the board's window. Counted, not listed. */
  olderParked?: number;
  /** Ask the board to re-poll after a dismissal, so the row leaves immediately
   *  instead of lingering until the next 20s tick. */
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("waiting");
  /** Row id currently being dismissed — disables just that row's button. */
  const [dismissing, setDismissing] = useState<number | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);
  /** Dismissed here, this session. The board's next poll makes it authoritative;
   *  until then this keeps the row from sitting there looking untouched. */
  const [justDismissed, setJustDismissed] = useState<number[]>([]);

  const visible = useMemo(
    () => rows.filter((r) => !(r.source === "queue" && justDismissed.includes(r.id))),
    [rows, justDismissed],
  );

  const counts = useMemo(
    () => ({
      waiting: visible.filter((r) => r.status === "pending").length,
      late: visible.filter((r) => r.status === "pending" && r.ageMin >= 10).length,
      cleared: visible.filter(isSettled).length,
      attention: visible.filter((r) => r.status === "parked").length,
      all: visible.length,
    }),
    [visible],
  );

  const shown = useMemo(() => {
    if (filter === "all") return visible;
    if (filter === "waiting") return visible.filter((r) => r.status === "pending");
    if (filter === "cleared") return visible.filter(isSettled);
    return visible.filter((r) => r.status === "parked");
  }, [visible, filter]);

  /**
   * Close a work order. The reason is required by the API and asked for here —
   * a row closed with no reason is indistinguishable from one nobody looked at,
   * which is how the board filled up in the first place.
   */
  const dismiss = async (r: AdminSyncRow) => {
    if (!token || r.source !== "queue") return;
    const reason = window.prompt(
      `Set aside "${KIND_COPY[r.kind] ?? r.kind}"${r.who ? ` for ${r.who}` : ""}?\n\n` +
        `This does NOT do the work — it records that someone looked and decided\n` +
        `it will not land. Say why (kept on the row):`,
      "",
    );
    if (reason === null) return; // cancelled
    if (reason.trim().length < 3) {
      setDismissError("A reason is required — a few words is enough.");
      return;
    }
    setDismissing(r.id);
    setDismissError(null);
    try {
      const res = await fetch(`/api/admin/bmi-sync?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "dismiss",
          source: "queue",
          id: r.id,
          reason: reason.trim(),
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        detail?: string;
        error?: string;
      } | null;
      if (!res.ok) {
        setDismissError(
          data?.detail || data?.error || `Could not set it aside (HTTP ${res.status})`,
        );
        return;
      }
      setJustDismissed((prev) => [...prev, r.id]);
      onChanged?.();
    } catch (err) {
      setDismissError(err instanceof Error ? err.message : "Could not set it aside");
    } finally {
      setDismissing(null);
    }
  };

  // Worst-first, so the button reads as the loudest thing outstanding.
  const badge =
    counts.attention > 0
      ? { text: `${counts.attention} stuck`, ...TONE.parked }
      : counts.late > 0
        ? { text: `${counts.late} late`, ...TONE.late }
        : counts.waiting > 0
          ? { text: `${counts.waiting} syncing`, ...TONE.pending }
          : null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          // Open on whatever actually needs looking at, so the first thing shown
          // is never an empty list the operator has to filter their way out of.
          setFilter(
            counts.attention > 0 ? "attention" : counts.waiting > 0 ? "waiting" : "cleared",
          );
          setOpen(true);
        }}
        title="On-site (Pandora) sync steps waiting on the center's server"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "0.5rem 0.9rem",
          borderRadius: 9999,
          border: `1px solid ${badge ? badge.border : "var(--ba-chip-border, rgba(148,163,184,0.3))"}`,
          background: badge ? badge.bg : "transparent",
          color: badge ? badge.fg : "var(--ba-fg)",
          fontSize: 14,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        BMI sync
        {badge && (
          <span style={{ fontSize: 12, fontWeight: 700, opacity: 0.95 }}>{badge.text}</span>
        )}
      </button>

      {open && (
        <ModalShell onClose={() => setOpen(false)} maxWidth={960} padding="1.25rem">
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>BMI sync</h2>
            <span style={{ fontSize: 12, opacity: 0.55 }}>
              on-site (Pandora) steps waiting on the center&apos;s server
              {/* The board shows the last week. Anything older is COUNTED here
                  rather than dropped — a quiet board must never be mistaken for
                  an empty one. */}
              {olderParked > 0 && (
                <>
                  {" · "}
                  <span style={{ opacity: 0.85 }} title="Older than this board's 7-day window">
                    {olderParked} older still stuck
                  </span>
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              style={{
                marginLeft: "auto",
                background: "transparent",
                border: "none",
                color: "inherit",
                fontSize: 20,
                cursor: "pointer",
                opacity: 0.6,
              }}
            >
              ×
            </button>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "0.75rem 0 1rem" }}>
            {(
              [
                ["waiting", `Waiting (${counts.waiting})`],
                ["attention", `Needs a human (${counts.attention})`],
                ["cleared", `Cleared (${counts.cleared})`],
                ["all", `All (${counts.all})`],
              ] as Array<[Filter, string]>
            ).map(([key, label]) => {
              const active = filter === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  style={{
                    padding: "0.35rem 0.75rem",
                    borderRadius: 9999,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                    border: `1px solid ${active ? "rgba(34,197,94,0.45)" : "rgba(148,163,184,0.28)"}`,
                    background: active ? "rgba(34,197,94,0.15)" : "transparent",
                    color: active ? "#22c55e" : "inherit",
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {dismissError && (
            <p
              style={{
                margin: "0 0 0.75rem 0",
                padding: "0.5rem 0.75rem",
                borderRadius: 8,
                fontSize: 12,
                backgroundColor: "rgba(239,68,68,0.15)",
                color: "#ef4444",
                border: "1px solid rgba(239,68,68,0.3)",
              }}
            >
              {dismissError}
            </p>
          )}

          {shown.length === 0 ? (
            <p style={{ padding: "2rem 0", textAlign: "center", fontSize: 13, opacity: 0.45 }}>
              {filter === "waiting"
                ? "Nothing waiting — every guest and on-site step has landed."
                : filter === "attention"
                  ? "Nothing stuck. Anything that gave up retrying would show here."
                  : "Nothing to show."}
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{ width: "100%", minWidth: 900, borderCollapse: "collapse", fontSize: 13 }}
              >
                <thead>
                  <tr
                    style={{
                      textAlign: "left",
                      fontSize: 11,
                      textTransform: "uppercase",
                      opacity: 0.45,
                    }}
                  >
                    <th style={{ padding: "0.5rem 0.75rem 0.5rem 0", fontWeight: 500 }}>Step</th>
                    <th style={{ padding: "0.5rem 0.75rem 0.5rem 0", fontWeight: 500 }}>Who</th>
                    <th style={{ padding: "0.5rem 0.75rem 0.5rem 0", fontWeight: 500 }}>Center</th>
                    <th style={{ padding: "0.5rem 0.75rem 0.5rem 0", fontWeight: 500 }}>
                      Reservation
                    </th>
                    <th style={{ padding: "0.5rem 0.75rem 0.5rem 0", fontWeight: 500 }}>State</th>
                    <th style={{ padding: "0.5rem 0.75rem 0.5rem 0", fontWeight: 500 }}>Age</th>
                    <th
                      title="How long the step took, from enqueue to landed. The queue push settles in seconds; the old cron could not beat two minutes."
                      style={{ padding: "0.5rem 0.75rem 0.5rem 0", fontWeight: 500 }}
                    >
                      Took
                    </th>
                    <th style={{ padding: "0.5rem 0.75rem 0.5rem 0", fontWeight: 500 }}>Tries</th>
                    <th style={{ padding: "0.5rem 0.75rem 0.5rem 0", fontWeight: 500 }}>
                      Last message
                    </th>
                    {/* The action column. Headed for screen readers but blank on
                        screen — a visible "Action" label would be louder than the
                        one small button it heads. */}
                    <th style={{ padding: "0.5rem 0 0.5rem 0", fontWeight: 500 }}>
                      <span
                        style={{
                          position: "absolute",
                          width: 1,
                          height: 1,
                          overflow: "hidden",
                          clip: "rect(0 0 0 0)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        Action
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const t = TONE[toneFor(r)];
                    return (
                      <tr
                        key={r.id}
                        style={{
                          borderTop: "1px solid rgba(148,163,184,0.14)",
                          verticalAlign: "top",
                        }}
                      >
                        <td style={{ padding: "0.5rem 0.75rem 0.5rem 0" }}>
                          {KIND_COPY[r.kind] ?? r.kind}
                          {/* WHICH MECHANISM is carrying it. Two transports run side
                              by side — Vercel Queues for the waiver push, the Neon
                              cron for everything else — so "behind" means different
                              things and needs a different fix. Under the kind rather
                              than a new column: it qualifies the work, it is not a
                              fact about the guest. */}
                          {r.transport && (
                            <div
                              style={{
                                fontFamily: "monospace",
                                fontSize: 10,
                                opacity: 0.45,
                                whiteSpace: "nowrap",
                              }}
                              title={
                                r.transport === "vercel-queue"
                                  ? "Vercel Queues — delayed message, pushed ~20-30s after signing"
                                  : "Neon queue, drained by the every-2-minutes cron"
                              }
                            >
                              {r.transport === "vercel-queue" ? "via queue" : "via cron"}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: "0.5rem 0.75rem 0.5rem 0", opacity: 0.85 }}>
                          {r.who ?? "—"}
                          {r.barrierRef && (
                            <div style={{ fontFamily: "monospace", fontSize: 10, opacity: 0.45 }}>
                              {r.barrierRef}
                            </div>
                          )}
                        </td>
                        <td
                          style={{
                            padding: "0.5rem 0.75rem 0.5rem 0",
                            opacity: 0.85,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {r.center ?? "—"}
                        </td>
                        <td
                          style={{
                            padding: "0.5rem 0.75rem 0.5rem 0",
                            fontFamily: "monospace",
                            fontSize: 11,
                            opacity: 0.7,
                          }}
                        >
                          {r.reservationRef ?? "—"}
                        </td>
                        <td style={{ padding: "0.5rem 0.75rem 0.5rem 0" }}>
                          <span
                            title={BARRIER_COPY[r.barrier] ?? r.barrier}
                            style={{
                              padding: "2px 8px",
                              borderRadius: 9999,
                              fontSize: 11,
                              fontWeight: 700,
                              background: t.bg,
                              color: t.fg,
                              border: `1px solid ${t.border}`,
                              // "gave up" is two words in a narrow column and was
                              // wrapping into a two-line pill. A status pill must
                              // stay one line or it stops reading as a pill.
                              display: "inline-block",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {stateLabel(r)}
                          </span>
                        </td>
                        <td
                          style={{
                            padding: "0.5rem 0.75rem 0.5rem 0",
                            opacity: 0.7,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {r.ageMin}m
                        </td>
                        <td
                          style={{
                            padding: "0.5rem 0.75rem 0.5rem 0",
                            opacity: 0.7,
                            whiteSpace: "nowrap",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {tookLabel(r.createdAt, r.resolvedAt) ?? "—"}
                        </td>
                        <td style={{ padding: "0.5rem 0.75rem 0.5rem 0", opacity: 0.7 }}>
                          {r.attempts}
                        </td>
                        <td
                          style={{ padding: "0.5rem 0.75rem 0.5rem 0", fontSize: 12, opacity: 0.6 }}
                        >
                          {r.lastError ?? "—"}
                        </td>
                        {/* SET ASIDE — only for a parked QUEUE row. A waiver row is a
                            different table with its own rail, and a guest-add row is
                            derived from a live probe and has no key to act on; the
                            `source` check is what keeps an id from reaching the wrong
                            table. No token (an embed that was not given one) means no
                            button, rather than one that 401s. */}
                        <td style={{ padding: "0.5rem 0 0.5rem 0", whiteSpace: "nowrap" }}>
                          {token && r.source === "queue" && r.status === "parked" ? (
                            <button
                              type="button"
                              onClick={() => void dismiss(r)}
                              disabled={dismissing === r.id}
                              title="Record that someone looked at this and it will not land. Does not do the work."
                              style={{
                                padding: "0.25rem 0.6rem",
                                borderRadius: 9999,
                                fontSize: 11,
                                fontWeight: 600,
                                cursor: dismissing === r.id ? "not-allowed" : "pointer",
                                border: "1px solid rgba(148,163,184,0.28)",
                                background: "transparent",
                                color: "inherit",
                                opacity: dismissing === r.id ? 0.5 : 0.8,
                              }}
                            >
                              {dismissing === r.id ? "…" : "Set aside"}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </ModalShell>
      )}
    </>
  );
}
