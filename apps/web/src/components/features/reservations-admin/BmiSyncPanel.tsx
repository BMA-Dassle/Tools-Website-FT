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
} as const;

function toneFor(r: AdminSyncRow): keyof typeof TONE {
  if (r.status === "parked") return "parked";
  if (r.status === "done") return "done";
  return r.ageMin >= 10 ? "late" : "pending";
}

/** Desk language beats field names: "waiting for the center's server to see the
 *  person" tells staff what is happening; "person-local" does not. */
const BARRIER_COPY: Record<string, string> = {
  "person-local": "waiting for the center's server to see the person",
  "person-cloud": "waiting for BMI cloud to see the person",
  "project-local": "waiting for the reservation to reach the center",
  "party-ready": "waiting for the whole party to sync + all waivers verified",
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

/** Waiting = still owed. Cleared = landed. Attention = gave up, needs a human. */
type Filter = "waiting" | "cleared" | "attention" | "all";

export function BmiSyncPanel({ rows }: { rows: AdminSyncRow[] }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("waiting");

  const counts = useMemo(
    () => ({
      waiting: rows.filter((r) => r.status === "pending").length,
      late: rows.filter((r) => r.status === "pending" && r.ageMin >= 10).length,
      cleared: rows.filter((r) => r.status === "done").length,
      attention: rows.filter((r) => r.status === "parked").length,
      all: rows.length,
    }),
    [rows],
  );

  const shown = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "waiting") return rows.filter((r) => r.status === "pending");
    if (filter === "cleared") return rows.filter((r) => r.status === "done");
    return rows.filter((r) => r.status === "parked");
  }, [rows, filter]);

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
                style={{ width: "100%", minWidth: 780, borderCollapse: "collapse", fontSize: 13 }}
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
                    <th style={{ padding: "0.5rem 0.75rem 0.5rem 0", fontWeight: 500 }}>
                      Reservation
                    </th>
                    <th style={{ padding: "0.5rem 0.75rem 0.5rem 0", fontWeight: 500 }}>State</th>
                    <th style={{ padding: "0.5rem 0.75rem 0.5rem 0", fontWeight: 500 }}>Age</th>
                    <th style={{ padding: "0.5rem 0.75rem 0.5rem 0", fontWeight: 500 }}>Tries</th>
                    <th style={{ padding: "0.5rem 0 0.5rem 0", fontWeight: 500 }}>Last message</th>
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
                            }}
                          >
                            {r.status === "done"
                              ? "landed"
                              : r.status === "parked"
                                ? "gave up"
                                : r.ageMin >= 10
                                  ? "late"
                                  : "waiting"}
                          </span>
                        </td>
                        <td style={{ padding: "0.5rem 0.75rem 0.5rem 0", opacity: 0.7 }}>
                          {r.ageMin}m
                        </td>
                        <td style={{ padding: "0.5rem 0.75rem 0.5rem 0", opacity: 0.7 }}>
                          {r.attempts}
                        </td>
                        <td style={{ padding: "0.5rem 0 0.5rem 0", fontSize: 12, opacity: 0.6 }}>
                          {r.lastError ?? "—"}
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
