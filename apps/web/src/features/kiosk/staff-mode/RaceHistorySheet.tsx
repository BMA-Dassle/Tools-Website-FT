"use client";

/**
 * Race history — read-only view of a racer's account: every finished heat from
 * Office `personStats/races` (best per track, distance to the next level), plus
 * the memberships and credit balances BMI holds on them.
 *
 * "Add membership" is here as the follow-through: staff read the account,
 * decide, act — one tap, same person. The distance-to-level line reads the
 * same cutoffs racing/qualify.ts uses everywhere else, so "1.31 s off Pro" here
 * and the level-up text the racer gets after a heat can never disagree.
 */
import { useEffect, useState, type ReactNode } from "react";
import { fetchStaffAccount } from "./client";
import { formatGapMs, formatLapMs, type TrackKey } from "./race-history";
import type { StaffAccountView } from "./service.server";
import { SheetCancel, SheetError, SheetGo, SheetLabel, StaffSheetFrame } from "./StaffSheetFrame";
import { closeStaffSheet, openStaffSheet, useStaffMode } from "./store";
import type { StaffSurfaceContextValue } from "./StaffModeSurface";
import type { StaffTarget } from "./types";

const TRACK_LABEL: Record<TrackKey, string> = { blue: "Blue", red: "Red", mega: "Mega" };
const TRACK_COLOR: Record<TrackKey, string> = { blue: "#4fa9ff", red: "#e53935", mega: "#f0b341" };

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function heatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "2-digit" }),
  });
}

/** "Red Starter" out of "46 - Red Starter" — the heat number is on its own. */
function heatParts(heat: string): { num: string; type: string } {
  const m = /^\s*(\d+)\s*-\s*(.+)$/.exec(heat);
  return m ? { num: m[1], type: m[2].trim() } : { num: "", type: heat };
}

export function RaceHistorySheet({
  target,
  surface,
}: {
  target: StaffTarget;
  surface: StaffSurfaceContextValue;
}) {
  const { token } = useStaffMode();
  const [account, setAccount] = useState<StaffAccountView | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One read per mount — StaffSheetHost keys this sheet by member, so a
  // different person is a fresh mount with fresh (null) state; no reset needed.
  useEffect(() => {
    let cancelled = false;
    void fetchStaffAccount(token, target.personId, surface.location).then((res) => {
      if (cancelled) return;
      if ("error" in res) setError(res.error);
      else setAccount(res.account);
    });
    return () => {
      cancelled = true;
    };
  }, [token, target.personId, surface.location]);

  const licence =
    account?.licenseActive === true
      ? "Licence on file"
      : account?.licenseActive === false
        ? "No active licence"
        : null;
  const summary = account?.summary ?? null;
  const since = summary?.first ? ` · racing since ${shortDate(summary.first)}` : "";

  return (
    <StaffSheetFrame
      eyebrow="Staff · Race history"
      title={target.name}
      subtitle={`BMI ${target.personId}${licence ? ` · ${licence}` : ""}${since}`}
      footer={
        <>
          <SheetCancel onClick={closeStaffSheet} label="Close" />
          <SheetGo grow={1} onClick={() => openStaffSheet({ kind: "membership", target })}>
            Add membership
          </SheetGo>
        </>
      }
    >
      {!account && !error && (
        <div className="flex items-center gap-[16px] text-[26px] text-white/60">
          <span className="h-[28px] w-[28px] animate-spin rounded-full border-2 border-[#46d68c]/30 border-t-[#46d68c]" />
          Reading the account…
        </div>
      )}
      {error && <SheetError>{error}</SheetError>}

      {account && (
        <>
          {/* Stat tiles — races + best per track. */}
          <div className="grid grid-cols-4 gap-[12px]">
            <Stat label="Races" value={summary ? String(summary.races) : "—"} />
            {(["blue", "red", "mega"] as TrackKey[]).map((k) => (
              <Stat
                key={k}
                label={`Best ${TRACK_LABEL[k]}`}
                value={formatLapMs(summary?.best[k])}
                sub={
                  summary?.earned[k]
                    ? `${summary.earned[k]} pace`
                    : summary?.best[k]
                      ? "Starter pace"
                      : undefined
                }
                color={TRACK_COLOR[k]}
              />
            ))}
          </div>

          {summary?.next && (
            <div className="rounded-[16px] border border-[#f0b341]/35 bg-[#f0b341]/10 px-[22px] py-[16px] text-[24px]">
              <b className="text-[#f0b341]">
                {formatGapMs(summary.next.gapMs)} off {summary.next.level}
              </b>{" "}
              on {TRACK_LABEL[summary.next.track]} — needs {formatLapMs(summary.next.targetMs)}
            </div>
          )}

          <div>
            <SheetLabel>Heats</SheetLabel>
            {account.heats === null ? (
              <div className="text-[24px] text-white/45">Couldn&apos;t read race history.</div>
            ) : account.heats.length === 0 ? (
              <div className="text-[24px] text-white/45">No races on record.</div>
            ) : (
              <div className="max-h-[520px] overflow-y-auto">
                <table className="w-full border-collapse text-[24px] tabular-nums">
                  <thead>
                    <tr className="text-left">
                      <Th>Date</Th>
                      <Th>Heat</Th>
                      <Th>Kart</Th>
                      <Th right>Best</Th>
                      <Th right>Avg</Th>
                      <Th right>Laps</Th>
                      <Th right>Pos</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {account.heats.map((h, i) => {
                      const { num, type } = heatParts(h.heat);
                      return (
                        <tr key={`${h.when}-${i}`} className="border-t border-white/10">
                          <td className="py-[10px] pr-[10px] whitespace-nowrap">
                            {heatDate(h.when)}
                          </td>
                          <td className="py-[10px] pr-[10px]">
                            {num && <span className="mr-[10px] text-white/40">#{num}</span>}
                            {type}
                          </td>
                          <td className="py-[10px] pr-[10px] text-white/60">{h.kart || "—"}</td>
                          <td className="py-[10px] pr-[10px] text-right font-bold">
                            {formatLapMs(h.bestMs)}
                          </td>
                          <td className="py-[10px] pr-[10px] text-right text-white/60">
                            {formatLapMs(h.avgMs)}
                          </td>
                          <td className="py-[10px] pr-[10px] text-right text-white/60">
                            {h.laps ?? "—"}
                          </td>
                          <td className="py-[10px] text-right">{h.position ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <SheetLabel>Memberships</SheetLabel>
            {account.memberships === null ? (
              <div className="text-[24px] text-white/45">Couldn&apos;t read memberships.</div>
            ) : account.memberships.length === 0 ? (
              <div className="text-[24px] text-white/45">None on file.</div>
            ) : (
              <div className="flex flex-wrap gap-[10px]">
                {account.memberships.map((m, i) => (
                  <span
                    key={`${m.name}-${i}`}
                    className={`rounded-[14px] border px-[18px] py-[10px] text-[22px] ${
                      m.active
                        ? "border-[#46d68c]/40 bg-[#46d68c]/8 text-white"
                        : "border-white/10 text-white/35"
                    }`}
                    title={`${shortDate(m.starts)} → ${shortDate(m.stops)}`}
                  >
                    {m.name}
                    <span className="ml-[10px] text-[18px] text-white/40">
                      → {shortDate(m.stops)}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div>
            <SheetLabel>Credits &amp; comps</SheetLabel>
            {account.credits === null ? (
              <div className="text-[24px] text-white/45">Couldn&apos;t read balances.</div>
            ) : account.credits.length === 0 ? (
              <div className="text-[24px] text-white/45">No balances.</div>
            ) : (
              <div className="flex flex-wrap gap-[12px]">
                {account.credits.map((c) => (
                  <span
                    key={c.kind}
                    className="rounded-[14px] border border-white/10 bg-white/[0.04] px-[20px] py-[12px] text-[24px]"
                  >
                    <span className="k-display k-num mr-[10px] text-[30px] text-[#46d68c]">
                      {c.balance}
                    </span>
                    {c.kind}
                  </span>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </StaffSheetFrame>
  );
}

function Stat({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="rounded-[16px] border border-white/10 bg-white/[0.04] px-[18px] py-[16px]">
      <div
        className="k-eyebrow text-[17px] tracking-[0.18em] text-white/45"
        style={color ? { color } : undefined}
      >
        {label}
      </div>
      <div className="k-display k-num mt-[4px] text-[40px]">{value}</div>
      {sub && <div className="mt-[2px] text-[18px] text-white/45">{sub}</div>}
    </div>
  );
}

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return (
    <th
      className={`k-eyebrow pb-[8px] pr-[10px] text-[17px] tracking-[0.18em] text-white/45 ${right ? "text-right" : ""}`}
    >
      {children}
    </th>
  );
}
