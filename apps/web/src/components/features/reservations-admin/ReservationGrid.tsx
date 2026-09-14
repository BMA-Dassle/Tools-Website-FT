"use client";

/**
 * The reservations board's GRID view — the day laid out on a time axis, one row
 * per lane (bowling) or per track resource (racing), the way the CRM
 * availability board draws an evening.
 *
 * Owner 2026-09-14: "build a board view of this like we did in CRM for
 * availability but without the number of people, etc. If the reservation is one
 * of ours, should be able to click it as well." — and, correcting the first
 * pass, "we do assign lanes when they book… you should be using the new QAMF
 * api as the availability board does so you don't have to worry about this. It
 * will just tell you lane" and "Race legs use blocks".
 *
 * WHAT IS DRAWN IS THE VENDOR'S DAY, NOT OURS. The bars come from QAMF's lane
 * grid and Office's heat blocks, so leagues, maintenance, front-desk bookings
 * and Conqueror walk-ins are all here — none of which exist in
 * `bowling_reservations`. Our own rows are matched ONTO that truth by QAMF
 * reservation id (lanes) or track + start minute (heats); a bar that matches
 * gets its product colour and opens the manage modal, and a bar that does not
 * is drawn in grey and says whose it is on hover. The grid never invents a
 * booking, and never claims one of ours is missing from the centre's own book.
 *
 * NO COUNTS ON THE GLASS — no players, no money, no capacity. That is the
 * "without the number of people, etc." half of the ask, and it is what keeps a
 * bar readable at the width a 12-minute heat actually occupies.
 */
import { useMemo } from "react";
import { clickableDivProps } from "@/lib/a11y";
import {
  barGeometry,
  collapseEmptyRows,
  fmtMinuteOfDay,
  heatMatchIndex,
  laneMatchIndex,
  minutesFromEtMidnight,
  ownerOf,
  pctOf,
  type GridBar,
  type GridBarKind,
  type ReservationGridData,
} from "~/features/reservations-admin/grid";
import { KIND_BADGE } from "~/features/reservations-admin/constants";
import { nowEtWallMs, todayET } from "~/features/reservations-admin/format";
import type { ComboMergeInfo, GroupEvent, Reservation } from "~/features/reservations-admin/types";

type Row = Reservation & { comboMerge?: ComboMergeInfo };

/**
 * Colours for bars that are NOT ours — the centre's own book.
 *
 * Deliberately desaturated. Everything on this board that a manager can act on
 * is one of our reservations; a league block is context, and context that
 * competes with the thing you came to find is noise.
 */
const VENDOR_PALETTE: Record<GridBarKind, { bg: string; fg: string; border: string }> = {
  league: { bg: "rgba(139,92,246,0.16)", fg: "#a78bfa", border: "rgba(139,92,246,0.3)" },
  party: { bg: "rgba(236,72,153,0.16)", fg: "#f472b6", border: "rgba(236,72,153,0.3)" },
  walkin: { bg: "rgba(148,163,184,0.16)", fg: "#94a3b8", border: "rgba(148,163,184,0.28)" },
  maint: { bg: "rgba(239,68,68,0.14)", fg: "#f87171", border: "rgba(239,68,68,0.3)" },
  heat: { bg: "rgba(34,197,94,0.14)", fg: "#4ade80", border: "rgba(34,197,94,0.28)" },
};

/** What a non-ours bar calls itself on hover, by kind. */
const KIND_NOUN: Record<GridBarKind, string> = {
  league: "League",
  party: "Party / group",
  walkin: "Walk-in or front desk",
  maint: "Maintenance",
  heat: "Race heat",
};

/** A combo row wears gold; otherwise the product's own badge colour. */
function ourPalette(r: Reservation) {
  const key = r.comboSpecialId ? "vip" : r.productKind;
  const badge = KIND_BADGE[key] ?? KIND_BADGE.open;
  return { bg: badge.bg, fg: badge.color, border: badge.border };
}

function barTitle(bar: GridBar, owner: Reservation | null): string {
  const when = `${fmtMinuteOfDay(bar.start)} – ${fmtMinuteOfDay(bar.end)}`;
  if (owner) {
    return `${owner.guestName || "Guest"} · ${when} · click to manage`;
  }
  return `${bar.label} · ${when} · ${KIND_NOUN[bar.kind]} — not one of our bookings`;
}

export default function ReservationGrid({
  data,
  loading,
  error,
  rows,
  groupEvents,
  date,
  expandedSections,
  onToggleSection,
  onOpenReservation,
  onOpenEvent,
  resolvingEventId,
}: {
  data: ReservationGridData | null;
  loading: boolean;
  error: string | null;
  /** The board's own visible reservations — already filtered, already polling. */
  rows: Row[];
  groupEvents: GroupEvent[];
  date: string;
  expandedSections: Record<string, boolean>;
  onToggleSection: (name: string) => void;
  onOpenReservation: (r: Row) => void;
  onOpenEvent: (ge: GroupEvent) => void;
  resolvingEventId: number | null;
}) {
  const byQamfId = useMemo(() => laneMatchIndex(rows), [rows]);
  const byHeat = useMemo(() => heatMatchIndex(rows, date), [rows, date]);

  const bounds = data?.bounds ?? null;

  // The NOW line only exists on the day it means something. Reading a red line
  // at 7:40 PM on next Saturday's grid would be actively misleading.
  const nowMinute = useMemo(() => {
    if (date !== todayET() || !bounds) return null;
    const minute = Math.round((nowEtWallMs() - Date.parse(`${date}T00:00:00Z`)) / 60_000);
    return minute >= bounds.openMin && minute <= bounds.closeMin ? minute : null;
  }, [date, bounds]);

  if (loading && !data) {
    return (
      <div style={{ textAlign: "center", padding: "3rem", color: "var(--ba-muted)" }}>
        Reading the lane grid…
      </div>
    );
  }

  if (error || data?.source === "unavailable") {
    return (
      <div
        style={{
          textAlign: "center",
          padding: "2rem",
          color: "#f59e0b",
          backgroundColor: "rgba(245,158,11,0.1)",
          borderRadius: 12,
          border: "1px solid rgba(245,158,11,0.3)",
          fontSize: "0.85rem",
        }}
      >
        {data?.error ?? error}
      </div>
    );
  }

  if (!data || !bounds) return null;

  const hasAnything = data.sections.some((s) => s.rows.some((r) => r.bars.length > 0));

  return (
    <div className="ba-grid">
      {!hasAnything && groupEvents.length === 0 && (
        <div style={{ textAlign: "center", padding: "2rem", color: "var(--ba-muted)" }}>
          The centre&rsquo;s book is empty for this date.
        </div>
      )}

      <div className="ba-grid-scroll">
        {/* EVERYTHING that carries a time lives inside this one element. The
            axis, the group events and the lane rows are all positioned as a
            percentage of ITS width, so a 6 PM tick sits exactly above the bars
            that start at 6 PM — including once the grid is scrolled sideways on
            a phone. A row laid out against any other width silently drifts. */}
        <div className="ba-grid-inner">
          <div className="ba-grid-axis">
            <div className="ba-grid-lab" />
            <div className="ba-grid-track">
              {bounds.ticks.map((t) => (
                <span key={t} style={{ left: `${pctOf(t, bounds)}%` }}>
                  {fmtMinuteOfDay(t).replace(":00", "")}
                </span>
              ))}
            </div>
          </div>

          <div style={{ position: "relative" }}>
            {nowMinute != null && (
              <div
                className="ba-grid-now"
                aria-hidden
                style={{
                  left: `calc(var(--ba-grid-lab) + (100% - var(--ba-grid-lab)) * ${
                    pctOf(nowMinute, bounds) / 100
                  })`,
                }}
              />
            )}

            {/* Group events first: they are the day's anchors, and the ones ops
                is most often asked about on the phone. */}
            {groupEvents.length > 0 && (
              <div className="ba-grid-sec">
                <div className="ba-grid-sec-h">
                  <span>Group Events</span>
                  <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>
                    start time only — a group function books no end
                  </span>
                </div>
                {groupEvents.map((ge) => {
                  const minute = minutesFromEtMidnight(ge.eventDate, date);
                  return (
                    <div className="ba-grid-row" key={ge.id}>
                      <div className="ba-grid-lab" title={ge.eventName}>
                        {ge.eventName}
                      </div>
                      <div className="ba-grid-track">
                        {minute == null ? null : (
                          <div
                            {...clickableDivProps(
                              () => onOpenEvent(ge),
                              `Open event ${ge.eventNumber} details`,
                            )}
                            className="ba-grid-bar is-ours"
                            title={`${ge.eventName} · #${ge.eventNumber} · starts ${fmtMinuteOfDay(
                              minute,
                            )} · click to open`}
                            style={{
                              left: `${pctOf(minute, bounds)}%`,
                              backgroundColor: "rgba(96,165,250,0.18)",
                              color: "#60a5fa",
                              borderColor: "rgba(96,165,250,0.45)",
                              cursor: resolvingEventId != null ? "wait" : "pointer",
                            }}
                          >
                            <span>{fmtMinuteOfDay(minute)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {data.sections.map((section) => {
              const expanded = expandedSections[section.name] === true;
              const display = collapseEmptyRows(section.rows, expanded);
              const busyRows = section.rows.filter((r) => r.bars.length > 0).length;
              const collapsedAny = display.some((d) => d.type === "empty");
              return (
                <div className="ba-grid-sec" key={section.name}>
                  <div className="ba-grid-sec-h">
                    <span>{section.name}</span>
                    {/* Lanes only. A racing section lists just the resources
                        that have something on them, so "3 of 3 in use" would be
                        a tautology dressed up as a statistic. */}
                    {data.source === "lanes" && (
                      <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>
                        {busyRows} of {section.rows.length} in use
                      </span>
                    )}
                  </div>

                  {display.map((entry) =>
                    entry.type === "row" ? (
                      <div className="ba-grid-row" key={`row-${entry.row.id}`}>
                        <div className="ba-grid-lab">{entry.row.label}</div>
                        <div className="ba-grid-track">
                          {entry.row.bars.map((bar) => {
                            const owner = ownerOf(bar, byQamfId, byHeat);
                            const geo = barGeometry(bar, bounds);
                            const palette = owner ? ourPalette(owner) : VENDOR_PALETTE[bar.kind];
                            const label = owner ? owner.guestName || "Guest" : bar.label;
                            return (
                              <div
                                key={bar.key}
                                {...(owner
                                  ? clickableDivProps(
                                      () => onOpenReservation(owner),
                                      `Manage reservation for ${owner.guestName ?? "guest"}`,
                                    )
                                  : {})}
                                className={`ba-grid-bar${owner ? " is-ours" : ""}`}
                                title={barTitle(bar, owner)}
                                style={{
                                  left: `${geo.left}%`,
                                  width: `${geo.width}%`,
                                  backgroundColor: palette.bg,
                                  color: palette.fg,
                                  borderColor: palette.border,
                                }}
                              >
                                <span>{label}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <div className="ba-grid-row ba-grid-empty" key={`empty-${entry.label}`}>
                        <div className="ba-grid-lab">{entry.label}</div>
                        <div className="ba-grid-track">
                          <span>{entry.rows.length} free all day</span>
                        </div>
                      </div>
                    ),
                  )}

                  {(collapsedAny || expanded) && (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => onToggleSection(section.name)}
                      style={{
                        background: "none",
                        border: "none",
                        padding: "2px 0 0 0",
                        marginLeft: "var(--ba-grid-lab)",
                        cursor: "pointer",
                        fontSize: "0.62rem",
                        fontWeight: 600,
                        color: "#60a5fa",
                      }}
                    >
                      {expanded ? "Collapse free lanes" : "Show every lane"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Legend + provenance. "Where did this come from and how old is it" is
          the first question anyone asks of a board they are about to act on. */}
      <div className="ba-grid-legend" style={{ marginTop: 4 }}>
        <span>
          <i style={{ backgroundColor: KIND_BADGE.open.color }} />
          Ours — click to manage
        </span>
        <span>
          <i style={{ backgroundColor: VENDOR_PALETTE.league.fg }} />
          League
        </span>
        <span>
          <i style={{ backgroundColor: VENDOR_PALETTE.party.fg }} />
          Party / group
        </span>
        <span>
          <i style={{ backgroundColor: VENDOR_PALETTE.walkin.fg }} />
          Walk-in / front desk
        </span>
        <span>
          <i style={{ backgroundColor: VENDOR_PALETTE.maint.fg }} />
          Maintenance
        </span>
      </div>
      <div style={{ marginTop: 6, fontSize: "0.62rem", color: "var(--ba-muted)" }}>
        {data.source === "heats"
          ? "Source: BMI Office day planner (heat blocks)"
          : "Source: QAMF reservations search + live lane status"}
        {" — includes front-desk bookings, leagues and maintenance our own database never sees. "}
        Read {new Date(data.readAt).toLocaleTimeString("en-US", { timeZone: "America/New_York" })}
        {data.cached ? " (cached ≤60s)" : ""}.
      </div>
    </div>
  );
}
