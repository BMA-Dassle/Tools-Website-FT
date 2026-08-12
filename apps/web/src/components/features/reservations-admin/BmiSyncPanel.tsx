"use client";

/**
 * BMI sync — the admin watch surface (owner 2026-08-12: "add a BMI sync that
 * shows anything that is in that table… will help watch for these problems").
 *
 * Under cloud-first, a booking completes on the BMI cloud while the on-site
 * (Pandora) work — waiver record, licence, grid seat — lands seconds to minutes
 * later behind a barrier. That gap used to be invisible until a racer wasn't on
 * the grid; this panel is where it becomes visible BEFORE anyone walks to the
 * desk.
 *
 * Ordering is the design: PARKED rows first, because nothing is coming to fix
 * those automatically, then still-waiting, then the resolved tail for context.
 * A row that has been waiting past ~10 minutes is coloured, because normal is
 * under a minute and anything longer means Fast WSync is behind.
 */
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

/** "waiting on the local server to see the person" beats "person-local". */
const BARRIER_COPY: Record<string, string> = {
  "person-local": "waiting for the center's server to see the person",
  "person-cloud": "waiting for BMI cloud to see the person",
  "project-local": "waiting for the reservation to reach the center",
  none: "no wait",
};

const KIND_COPY: Record<string, string> = {
  "repair-person-details": "Fix person record (birthdate/contact)",
  "push-waiver-signature": "Send waiver to BMI",
  "add-membership": "Grant racing licence",
  "attach-project-person": "Add guest to reservation",
};

export function BmiSyncPanel({ rows }: { rows: AdminSyncRow[] }) {
  const parked = rows.filter((r) => r.status === "parked").length;
  const waiting = rows.filter((r) => r.status === "pending").length;
  const late = rows.filter((r) => r.status === "pending" && r.ageMin >= 10).length;

  return (
    <section className="mb-6 rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <header className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-semibold text-white">BMI sync</h2>
        <span className="text-[12px] text-white/45">
          on-site (Pandora) steps waiting on the center&apos;s server
        </span>
        <div className="ml-auto flex items-center gap-2 text-[12px]">
          {parked > 0 && (
            <span
              className="rounded-full border px-2 py-[2px] font-semibold"
              style={{
                background: TONE.parked.bg,
                color: TONE.parked.fg,
                borderColor: TONE.parked.border,
              }}
            >
              {parked} needs a human
            </span>
          )}
          {late > 0 && (
            <span
              className="rounded-full border px-2 py-[2px] font-semibold"
              style={{
                background: TONE.late.bg,
                color: TONE.late.fg,
                borderColor: TONE.late.border,
              }}
            >
              {late} running late
            </span>
          )}
          <span className="text-white/45">
            {waiting} waiting · {rows.length} shown
          </span>
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-white/40">
          Nothing in the sync queue — every on-site step has landed.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-white/40">
                <th className="py-2 pr-3 font-medium">Step</th>
                <th className="py-2 pr-3 font-medium">Who</th>
                <th className="py-2 pr-3 font-medium">Reservation</th>
                <th className="py-2 pr-3 font-medium">State</th>
                <th className="py-2 pr-3 font-medium">Age</th>
                <th className="py-2 pr-3 font-medium">Tries</th>
                <th className="py-2 font-medium">Last message</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const t = TONE[toneFor(r)];
                return (
                  <tr key={r.id} className="border-t border-white/5 align-top">
                    <td className="py-2 pr-3 text-white/85">{KIND_COPY[r.kind] ?? r.kind}</td>
                    <td className="py-2 pr-3 text-white/70">
                      {r.who ?? <span className="text-white/35">—</span>}
                      {r.barrierRef && (
                        <div className="font-mono text-[10px] text-white/30">{r.barrierRef}</div>
                      )}
                    </td>
                    <td className="py-2 pr-3 font-mono text-[11px] text-white/55">
                      {r.reservationRef ?? <span className="text-white/30">—</span>}
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className="rounded-full border px-2 py-[2px] text-[11px] font-semibold"
                        style={{ background: t.bg, color: t.fg, borderColor: t.border }}
                        title={BARRIER_COPY[r.barrier] ?? r.barrier}
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
                    <td className="py-2 pr-3 text-white/60">{r.ageMin}m</td>
                    <td className="py-2 pr-3 text-white/60">{r.attempts}</td>
                    <td className="py-2 text-[12px] text-white/50">
                      {r.lastError ?? <span className="text-white/30">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
