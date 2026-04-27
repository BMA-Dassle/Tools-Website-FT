"use client";

import { Fragment, useEffect, useState, useMemo } from "react";
import SubpageHero from "@/components/SubpageHero";
import { modalBackdropProps } from "@/lib/a11y";

/* ── Types ── */

type Session = {
  sessionId: number;
  sessionName: string;
  scheduledStart: string;
  position: number;
  points: number;
  bestLap: number;
  laps: number;
  scoreTime: string;
};

type Driver = {
  persId: number;
  name: string;
  totalPoints: number;
  sessions: Session[];
};

type SortField = "points" | "bestLap" | "races";

/* ── League config ──
 *
 * The Apr–Jul 2026 season runs Blue + Red leagues that are scored as
 * a single combined standings table. The combined Pandora endpoint
 * (/standings/{location}) is great for the top-line driver list but
 * only emits per-session points for one of the score groups; to get
 * full session detail with points across BOTH leagues we fetch each
 * league separately via the per-(track, scoreGroup) summary
 * endpoint and merge by persId.
 */

type LeagueLeg = {
  track: string;
  scoreGroup: string;
  /** Legacy name used during a Pandora rename window. Tried as a
   *  soft fallback when the canonical name returns no rows. */
  scoreGroupFallback?: string;
};

const LEAGUE = {
  leagues: [
    {
      track: "Blue Track",
      scoreGroup: "Blue League (April to July 2026)",
      scoreGroupFallback: "Blue League (4/1/26-7/8/26)",
    },
    {
      track: "Red Track",
      scoreGroup: "Red League (April to July 2026)",
    },
  ] as readonly LeagueLeg[],
  label: "FastTrax League",
  dates: "April – July 2026",
  startDate: "2026-01-01T00:00:00",
  endDate: "2026-12-31T23:59:59",
} as const;

/* ── Helpers ── */

function formatLapTime(ms: number): string {
  if (!ms) return "--";
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  const ss = secs.toString().padStart(2, "0");
  const mmm = millis.toString().padStart(3, "0");
  return mins > 0 ? `${mins}:${ss}.${mmm}` : `${secs}.${mmm}s`;
}

function properName(raw: string): string {
  return raw
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function driverBestLap(d: Driver): number {
  const laps = d.sessions.filter((s) => s.bestLap > 0).map((s) => s.bestLap);
  return laps.length ? Math.min(...laps) : Infinity;
}

function isGrandPrix(sessionName: string): boolean {
  return /grandprix|grand\s*prix/i.test(sessionName);
}

/**
 * Render a YYYY-MM-DD (ET) bucket key as a human date header used in
 * the per-driver expand panel. Falls through to the raw key on bad
 * input so we never crash the row over a parser hiccup.
 */
function formatDateHeader(dateKey: string): string {
  if (dateKey === "unknown") return "Date unknown";
  try {
    const [y, m, d] = dateKey.split("-").map(Number);
    if (!y || !m || !d) return dateKey;
    // Build at noon ET to avoid DST-edge mis-rendering as the prior
    // day in earlier UTC zones — we just want the date string.
    const dt = new Date(Date.UTC(y, m - 1, d, 17, 0, 0));
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(dt);
  } catch {
    return dateKey;
  }
}


const rankColors: Record<number, string> = {
  1: "#FFD700",
  2: "#C0C0C0",
  3: "#CD7F32",
};

const rankBg: Record<number, string> = {
  1: "rgba(255,215,0,0.08)",
  2: "rgba(192,192,192,0.06)",
  3: "rgba(205,127,50,0.05)",
};

/* ── Stat Card ── */

function StatCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center text-center"
      style={{
        backgroundColor: "rgba(7,16,39,0.6)",
        border: "1px solid rgba(0,226,229,0.15)",
        borderRadius: "8px",
        padding: "20px 16px",
      }}
    >
      <span
        className="font-heading uppercase"
        style={{ fontSize: "clamp(28px, 5vw, 40px)", color: accent || "#00E2E5", lineHeight: 1.1 }}
      >
        {value}
      </span>
      <span
        className="font-body mt-1"
        style={{ fontSize: "13px", color: "rgba(245,236,238,0.55)", letterSpacing: "0.5px" }}
      >
        {label}
      </span>
    </div>
  );
}

/* ── Sort Button ── */

function SortBtn({
  label,
  field,
  active,
  onClick,
}: {
  label: string;
  field: SortField;
  active: SortField;
  onClick: (f: SortField) => void;
}) {
  const isActive = field === active;
  return (
    <button
      onClick={() => onClick(field)}
      className="font-body font-medium transition-colors"
      style={{
        fontSize: "13px",
        padding: "6px 14px",
        borderRadius: "6px",
        border: isActive ? "1px solid rgba(0,226,229,0.5)" : "1px solid rgba(255,255,255,0.1)",
        backgroundColor: isActive ? "rgba(0,226,229,0.12)" : "transparent",
        color: isActive ? "#00E2E5" : "rgba(255,255,255,0.5)",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

/* ── Expandable Row ── */

function DriverRow({
  driver,
  rank,
  leaderPoints,
  leaderBestLap,
  sortField,
  onHeatClick,
}: {
  driver: Driver;
  rank: number;
  leaderPoints: number;
  leaderBestLap: number;
  sortField: SortField;
  /** Click handler — fired when the user taps a session row in the
   *  expanded breakdown. Opens the per-heat standings modal. */
  onHeatClick?: (s: Session) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const bestLap = driverBestLap(driver);
  const raceCount = driver.sessions.length;
  const pointsGap = leaderPoints - driver.totalPoints;
  const lapGap = bestLap !== Infinity ? bestLap - leaderBestLap : 0;

  const gapDisplay =
    rank === 1
      ? "--"
      : sortField === "bestLap"
        ? lapGap > 0
          ? `+${(lapGap / 1000).toFixed(3)}s`
          : "--"
        : pointsGap > 0
          ? `-${pointsGap} pts`
          : "--";

  const rankColor = rankColors[rank] || "rgba(255,255,255,0.4)";
  const rowBg = rankBg[rank] || (rank % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent");

  // Filter out practice sessions defensively — the cron / Pandora
  // already excludes them at the source (excludePractice=true), but
  // double-checking here means the expand panel never accidentally
  // renders one if a future schema change leaks them through.
  const sessionsForDetail = useMemo(
    () => driver.sessions.filter((s) => !/practice/i.test(s.sessionName)),
    [driver.sessions],
  );

  // Group by race-night date. Pandora's `scheduledStart` is UTC ISO;
  // we bucket by ET calendar day so a session at 11:30 PM doesn't get
  // shoved into "tomorrow" for staff working a Florida-time clock.
  const dateGroups = useMemo(() => {
    const buckets = new Map<string, Session[]>(); // key = YYYY-MM-DD ET
    const sorted = [...sessionsForDetail].sort(
      (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
    );
    for (const s of sorted) {
      let key = "unknown";
      try {
        const d = new Date(s.scheduledStart);
        if (!isNaN(d.getTime())) {
          key = new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/New_York",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(d);
        }
      } catch { /* fall through to "unknown" bucket */ }
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(s);
    }
    // Map -> array, preserving insertion order (sorted oldest first
    // already so date headers descend chronologically).
    return Array.from(buckets.entries()).map(([dateKey, sessions]) => ({
      dateKey,
      label: formatDateHeader(dateKey),
      sessions,
    }));
  }, [sessionsForDetail]);

  return (
    <>
      {/* Main row */}
      <tr
        onClick={() => setExpanded((e) => !e)}
        className="cursor-pointer transition-colors hover:bg-white/[0.04]"
        style={{ backgroundColor: rowBg }}
      >
        {/* Rank */}
        <td className="px-3 py-3 sm:px-4">
          <span
            className="font-heading inline-flex items-center justify-center"
            style={{
              width: "32px",
              height: "32px",
              fontSize: "16px",
              color: rankColor,
              borderRadius: rank <= 3 ? "50%" : undefined,
              border: rank <= 3 ? `2px solid ${rankColor}` : undefined,
            }}
          >
            {rank}
          </span>
        </td>

        {/* Driver */}
        <td className="px-2 py-3 sm:px-4">
          <span
            className="font-body"
            style={{
              fontSize: "15px",
              color: rank <= 3 ? rankColor : "rgba(245,236,238,0.9)",
              fontWeight: rank === 1 ? 600 : 400,
            }}
          >
            {properName(driver.name)}
          </span>
        </td>

        {/* Total Points */}
        <td className="px-2 py-3 sm:px-4 text-center">
          <span
            className="font-body font-semibold"
            style={{ fontSize: "15px", color: "#00E2E5" }}
          >
            {driver.totalPoints}
          </span>
        </td>

        {/* Races */}
        <td className="px-2 py-3 sm:px-4 text-center hidden sm:table-cell">
          <span
            className="font-body"
            style={{ fontSize: "14px", color: "rgba(245,236,238,0.6)" }}
          >
            {raceCount}
          </span>
        </td>

        {/* Best Lap */}
        <td className="px-2 py-3 sm:px-4 text-center hidden md:table-cell">
          <span
            className="font-body font-medium"
            style={{ fontSize: "14px", color: "rgba(245,236,238,0.8)" }}
          >
            {bestLap < Infinity ? formatLapTime(bestLap) : "--"}
          </span>
        </td>

        {/* Gap */}
        <td className="px-2 py-3 sm:px-4 text-right hidden sm:table-cell">
          <span
            className="font-body"
            style={{ fontSize: "13px", color: rank === 1 ? "#FFD700" : "rgba(245,236,238,0.4)" }}
          >
            {gapDisplay}
          </span>
        </td>

        {/* Expand chevron */}
        <td className="px-2 py-3 sm:px-3 text-right">
          <span
            className="inline-block transition-transform"
            style={{
              transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
              color: "rgba(255,255,255,0.3)",
              fontSize: "13px",
            }}
          >
            &#9660;
          </span>
        </td>
      </tr>

      {/* Session breakdown */}
      {expanded && (
        <tr>
          <td colSpan={7} style={{ padding: 0 }}>
            <div
              style={{
                backgroundColor: "rgba(0,4,24,0.6)",
                borderTop: "1px solid rgba(0,226,229,0.1)",
                borderBottom: "1px solid rgba(0,226,229,0.1)",
              }}
            >
              {/* Mobile-friendly session list */}
              <div className="overflow-x-auto">
                <table className="w-full" style={{ minWidth: "420px" }}>
                  <thead>
                    <tr>
                      {["Session", "Pos", "Points", "Best Lap", "Laps"].map((h) => (
                        <th
                          key={h}
                          className="font-body text-left px-4 py-2"
                          style={{
                            fontSize: "13px",
                            color: "rgba(255,255,255,0.3)",
                            fontWeight: 500,
                            textTransform: "uppercase",
                            letterSpacing: "0.5px",
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dateGroups.map(({ dateKey, label, sessions }) => (
                      <Fragment key={dateKey}>
                        {/* Date header — one row per race night so
                             staff can see what session belongs to which
                             night without parsing prefixes. */}
                        <tr>
                          <td
                            colSpan={5}
                            className="font-body"
                            style={{
                              fontSize: "11px",
                              fontWeight: 600,
                              color: "rgba(0,226,229,0.85)",
                              textTransform: "uppercase",
                              letterSpacing: "1.4px",
                              padding: "12px 16px 6px 16px",
                              borderTop: "1px solid rgba(0,226,229,0.12)",
                              backgroundColor: "rgba(0,226,229,0.04)",
                            }}
                          >
                            {label}
                          </td>
                        </tr>
                        {sessions.map((s) => {
                      // Visual emphasis: any session that scored
                      // points OR is named like a grandprix gets the
                      // bold + cyan treatment. Points display follows
                      // s.points strictly so Red League "Scored"
                      // sessions show their actual value.
                      const hasPoints = s.points > 0;
                      const emphasized = hasPoints || isGrandPrix(s.sessionName);
                      return (
                        <tr
                          key={s.sessionId}
                          onClick={() => onHeatClick?.(s)}
                          style={{
                            borderBottom: "1px solid rgba(255,255,255,0.04)",
                            cursor: onHeatClick ? "pointer" : "default",
                          }}
                          className={onHeatClick ? "hover:bg-white/[0.03] transition-colors" : ""}
                          title={onHeatClick ? "Click to view this heat's full standings" : undefined}
                        >
                          <td className="px-4 py-2">
                            <span
                              className="font-body"
                              style={{
                                fontSize: "13px",
                                fontWeight: emphasized ? 600 : 400,
                                color: emphasized ? "rgba(245,236,238,0.9)" : "rgba(245,236,238,0.5)",
                              }}
                            >
                              {s.sessionName}
                            </span>
                          </td>
                          <td className="px-4 py-2">
                            <span
                              className="font-body font-medium"
                              style={{
                                fontSize: "13px",
                                color:
                                  s.position === 1
                                    ? "#FFD700"
                                    : s.position === 2
                                      ? "#C0C0C0"
                                      : s.position === 3
                                        ? "#CD7F32"
                                        : "rgba(245,236,238,0.6)",
                              }}
                            >
                              P{s.position}
                            </span>
                          </td>
                          <td className="px-4 py-2">
                            <span
                              className="font-body font-semibold"
                              style={{ fontSize: "13px", color: hasPoints ? "#00E2E5" : "rgba(255,255,255,0.3)" }}
                            >
                              {hasPoints ? s.points : "—"}
                            </span>
                          </td>
                          <td className="px-4 py-2">
                            <span
                              className="font-body"
                              style={{ fontSize: "13px", color: "rgba(245,236,238,0.6)" }}
                            >
                              {s.bestLap > 0 ? formatLapTime(s.bestLap) : "--"}
                            </span>
                          </td>
                          <td className="px-4 py-2">
                            <span
                              className="font-body"
                              style={{ fontSize: "13px", color: "rgba(245,236,238,0.45)" }}
                            >
                              {s.laps}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ── Loading Spinner ── */

function Spinner() {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4">
      <div
        className="animate-spin"
        style={{
          width: "40px",
          height: "40px",
          border: "3px solid rgba(0,226,229,0.15)",
          borderTop: "3px solid #00E2E5",
          borderRadius: "50%",
        }}
      />
      <p className="font-body" style={{ color: "rgba(245,236,238,0.5)", fontSize: "14px" }}>
        Loading standings...
      </p>
    </div>
  );
}

/* ── Page ── */

export default function LeagueStandingsPage() {
  /** Combined standings — drivers from every league merged by persId.
   *  Practice sessions are filtered out (excludePractice=true) since
   *  the per-driver expand panel only shows scored heats now. */
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sortField, setSortField] = useState<SortField>("points");
  /** Session the user has tapped to drill into. null = modal closed.
   *  Click a session row in any driver expand panel → fetches that
   *  session's full standings and shows the modal. */
  const [heatTarget, setHeatTarget] = useState<Session | null>(null);

  useEffect(() => {
    /**
     * Pandora's combined /standings/{location} endpoint returns the
     * driver list + total points but only emits per-session points
     * for ONE of the score groups (the other shows up with point=0
     * even when the racer scored). To get the full per-session
     * detail across both leagues, fetch each league separately via
     * the per-(track, scoreGroup) summary endpoint and merge by
     * persId.
     */
    async function fetchOneLeague(
      cfg: LeagueLeg,
      excl: "true" | "false",
    ): Promise<Driver[]> {
      const tryFetch = async (sg: string) => {
        const params = new URLSearchParams({
          action: "summary",
          track: cfg.track,
          scoreGroup: sg,
          startDate: LEAGUE.startDate,
          endDate: LEAGUE.endDate,
          excludePractice: excl,
        });
        const res = await fetch(`/api/leagues?${params.toString()}`);
        if (!res.ok) return null;
        const json = await res.json();
        if (!json?.success) return null;
        return (json.data as Driver[]) || [];
      };

      // Canonical name first; legacy fallback only fires when the
      // canonical name comes back empty AND a fallback is configured.
      let drivers = await tryFetch(cfg.scoreGroup);
      if ((drivers === null || drivers.length === 0) && cfg.scoreGroupFallback) {
        const legacy = await tryFetch(cfg.scoreGroupFallback);
        if (legacy && legacy.length > 0) drivers = legacy;
      }
      return drivers || [];
    }

    /**
     * Union drivers across N leagues — same persId merges sessions +
     * SUMS totalPoints. Per-league summary calls return totals scoped
     * to that score group only, so summing across leagues is the
     * correct combined-season total.
     *
     * Sanity check on totals math: if Pandora's combined /standings/
     * call shows Ethan with 118 pts (58 from Blue GPs + 60 from Red
     * scored), and the per-league summary calls return Blue=58,
     * Red=60, this function produces 118. ✓
     *
     * Sessions are de-duped by sessionId — defensive against the
     * unlikely case where the same session was tagged with both
     * score groups upstream.
     */
    function mergeDrivers(...lists: Driver[][]): Driver[] {
      const byId = new Map<number, Driver>();
      for (const list of lists) {
        for (const d of list) {
          const existing = byId.get(d.persId);
          if (!existing) {
            // Clone to avoid sharing the sessions array reference.
            byId.set(d.persId, { ...d, sessions: [...d.sessions] });
            continue;
          }
          existing.totalPoints += d.totalPoints;
          const seenIds = new Set(existing.sessions.map((s) => s.sessionId));
          for (const s of d.sessions) {
            if (!seenIds.has(s.sessionId)) {
              existing.sessions.push(s);
              seenIds.add(s.sessionId);
            }
          }
        }
      }
      return Array.from(byId.values());
    }

    async function fetchStandings() {
      try {
        // Fetch every league in parallel (excludePractice=true so
        // the response is already practice-free). Practice sessions
        // aren't shown anywhere on this page, so a single fetch per
        // league covers both the standings table and the per-driver
        // expand panel.
        const results = await Promise.all(
          LEAGUE.leagues.map((cfg) => fetchOneLeague(cfg, "true")),
        );
        const merged = mergeDrivers(...results);
        if (merged.length === 0) {
          throw new Error("No standings returned");
        }
        setDrivers(merged);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load standings");
      } finally {
        setLoading(false);
      }
    }
    fetchStandings();
  }, []);

  /* Sorted drivers */
  const sorted = useMemo(() => {
    const copy = [...drivers];
    switch (sortField) {
      case "points":
        copy.sort((a, b) => b.totalPoints - a.totalPoints);
        break;
      case "bestLap":
        copy.sort((a, b) => driverBestLap(a) - driverBestLap(b));
        break;
    }
    return copy;
  }, [drivers, sortField]);

  /* Stats */
  const totalDrivers = drivers.length;
  const leader = sorted[0];
  const fastestLap = useMemo(() => {
    let best = Infinity;
    for (const d of drivers) {
      for (const s of d.sessions) {
        if (s.bestLap > 0 && s.bestLap < best) best = s.bestLap;
      }
    }
    return best < Infinity ? best : 0;
  }, [drivers]);
  const leaderBestLap = leader ? driverBestLap(leader) : Infinity;

  return (
    <>
      <SubpageHero
        title="League Standings"
        backgroundImage="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/qualifications-hero.webp"
      />

      {/* ── Main Content ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(48px, 8vw, 100px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-5xl mx-auto">
          {/* League badge */}
          <div className="flex justify-center mb-8">
            <div
              className="font-body inline-flex items-center gap-2"
              style={{
                fontSize: "14px",
                fontWeight: 600,
                color: "#00E2E5",
                padding: "8px 20px",
                borderRadius: "100px",
                border: "1px solid rgba(0,226,229,0.3)",
                backgroundColor: "rgba(0,226,229,0.08)",
                letterSpacing: "0.3px",
              }}
            >
              <span style={{ fontSize: "13px" }}>&#9679;</span>
              {LEAGUE.label} &middot; {LEAGUE.dates}
            </div>
          </div>

          {loading ? (
            <Spinner />
          ) : error ? (
            <div className="text-center py-20">
              <p className="font-body" style={{ color: "#E41C1D", fontSize: "16px" }}>
                {error}
              </p>
              <button
                onClick={() => window.location.reload()}
                className="font-body mt-4"
                style={{
                  color: "#00E2E5",
                  fontSize: "14px",
                  background: "none",
                  border: "1px solid rgba(0,226,229,0.3)",
                  padding: "8px 20px",
                  borderRadius: "6px",
                  cursor: "pointer",
                }}
              >
                Try Again
              </button>
            </div>
          ) : drivers.length === 0 ? (
            <div className="text-center py-20">
              <p className="font-body" style={{ color: "rgba(245,236,238,0.5)", fontSize: "16px" }}>
                No standings data available yet. Races start soon!
              </p>
            </div>
          ) : (
            <>
              {/* Stats Cards */}
              <div className="grid grid-cols-3 gap-3 mb-10">
                <StatCard label="Total Drivers" value={String(totalDrivers)} />
                <StatCard label="League Leader" value={leader ? properName(leader.name).split(" ")[0] : "--"} accent="#FFD700" />
                <StatCard label="Fastest Lap" value={fastestLap ? formatLapTime(fastestLap) : "--"} accent="#E41C1D" />
              </div>


              {/* Standings Table */}
              <div
                className="overflow-x-auto"
                style={{
                  borderRadius: "8px",
                  border: "1px solid rgba(0,226,229,0.1)",
                  backgroundColor: "rgba(7,16,39,0.5)",
                }}
              >
                <table className="w-full" style={{ minWidth: "360px" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid rgba(0,226,229,0.15)" }}>
                      {[
                        { label: "#", className: "px-3 sm:px-4", hideOn: "" },
                        { label: "Driver", className: "px-2 sm:px-4", hideOn: "" },
                        { label: "Points", className: "px-2 sm:px-4 text-center", hideOn: "" },
                        { label: "Races", className: "px-2 sm:px-4 text-center hidden sm:table-cell", hideOn: "sm" },
                        { label: "Best Lap", className: "px-2 sm:px-4 text-center hidden md:table-cell", hideOn: "md" },
                        { label: "Gap", className: "px-2 sm:px-4 text-right hidden sm:table-cell", hideOn: "sm" },
                        { label: "", className: "px-2 sm:px-3", hideOn: "" },
                      ].map((col, i) => (
                        <th
                          key={i}
                          className={`font-body py-3 ${col.className} ${col.hideOn ? `hidden ${col.hideOn}:table-cell` : ""}`}
                          style={{
                            fontSize: "13px",
                            color: "rgba(255,255,255,0.35)",
                            fontWeight: 500,
                            textTransform: "uppercase",
                            letterSpacing: "0.5px",
                            textAlign: "inherit",
                          }}
                        >
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((driver, i) => (
                      <DriverRow
                        key={driver.persId}
                        driver={driver}
                        rank={i + 1}
                        leaderPoints={leader.totalPoints}
                        leaderBestLap={sortField === "bestLap" ? driverBestLap(sorted[0]) : leaderBestLap}
                        sortField={sortField}
                        onHeatClick={setHeatTarget}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Footer note */}
              <p
                className="font-body text-center mt-6"
                style={{ fontSize: "13px", color: "rgba(245,236,238,0.35)" }}
              >
                Tap any driver to view session breakdown. Tap a session to see that heat&apos;s standings.
              </p>
            </>
          )}
        </div>
      </section>

      {heatTarget && (
        <HeatStandingsModal heat={heatTarget} onClose={() => setHeatTarget(null)} />
      )}
    </>
  );
}

/* ── Heat standings modal ── */

/**
 * Per-session driver row coming back from the scores endpoint. We
 * deliberately allow alternate field names since Pandora has been
 * known to vary between `firstName`/`lastName` and a single `name`.
 */
type HeatRow = {
  persId?: number;
  firstName?: string;
  lastName?: string;
  name?: string;
  position?: number;
  points?: number;
  bestLap?: number;
  laps?: number;
};

function HeatStandingsModal({ heat, onClose }: { heat: Session; onClose: () => void }) {
  const [rows, setRows] = useState<HeatRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const params = new URLSearchParams({
          action: "scores",
          sessionId: String(heat.sessionId),
        });
        const res = await fetch(`/api/leagues?${params.toString()}`);
        const json = res.ok ? await res.json() : null;
        if (cancelled) return;
        if (!json?.success) throw new Error(json?.error || "API error");
        const data: HeatRow[] = Array.isArray(json.data) ? json.data : [];
        // Sort by position ascending (P1 first); push 0 / undefined to end.
        data.sort((a, b) => {
          const ap = a.position && a.position > 0 ? a.position : Number.MAX_SAFE_INTEGER;
          const bp = b.position && b.position > 0 ? b.position : Number.MAX_SAFE_INTEGER;
          return ap - bp;
        });
        setRows(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load heat");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [heat.sessionId]);

  function rowName(r: HeatRow): string {
    if (r.name && r.name.trim()) return properName(r.name);
    const parts = [r.firstName, r.lastName].filter(Boolean).join(" ").trim();
    return parts ? properName(parts) : "(unknown)";
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-3"
      style={{ height: "100dvh", backgroundColor: "rgba(0,0,0,0.8)" }}
      {...modalBackdropProps(onClose)}
    >
      <div
        className="relative w-full max-w-xl rounded-xl"
        style={{
          backgroundColor: "#0a1128",
          border: "1.78px solid rgba(255,255,255,0.1)",
          maxHeight: "calc(100dvh - 1.5rem)",
          overflowY: "auto",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close heat standings"
          className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          style={{ fontSize: "20px", lineHeight: 1 }}
        >
          &times;
        </button>
        <div className="p-5 sm:p-6">
          <p className="text-[#00E2E5] text-xs font-bold uppercase tracking-widest mb-1">Heat Standings</p>
          <h3 className="font-display text-white text-xl uppercase tracking-wide pr-10 mb-1">
            {heat.sessionName}
          </h3>
          <p className="text-white/40 text-xs mb-5">
            {(() => {
              try {
                return new Intl.DateTimeFormat("en-US", {
                  timeZone: "America/New_York",
                  weekday: "long",
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                }).format(new Date(heat.scheduledStart));
              } catch { return ""; }
            })()}
          </p>

          {loading ? (
            <div className="py-10 text-center text-white/50 text-sm">Loading heat…</div>
          ) : error ? (
            <div className="py-10 text-center text-red-400 text-sm">{error}</div>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-white/50 text-sm">No data for this heat.</div>
          ) : (
            <table className="w-full">
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  {["#", "Driver", "Pts", "Best Lap", "Laps"].map((h) => (
                    <th
                      key={h}
                      className="font-body text-left px-3 py-2"
                      style={{
                        fontSize: "11px",
                        color: "rgba(255,255,255,0.35)",
                        fontWeight: 500,
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const pos = r.position && r.position > 0 ? r.position : i + 1;
                  const podium = pos === 1 ? "#FFD700" : pos === 2 ? "#C0C0C0" : pos === 3 ? "#CD7F32" : "rgba(245,236,238,0.6)";
                  return (
                    <tr
                      key={r.persId ?? i}
                      style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                    >
                      <td className="px-3 py-2 font-body" style={{ fontSize: "13px", color: podium, fontWeight: 600 }}>
                        P{pos}
                      </td>
                      <td className="px-3 py-2 font-body" style={{ fontSize: "13px", color: "rgba(245,236,238,0.9)" }}>
                        {rowName(r)}
                      </td>
                      <td className="px-3 py-2 font-body font-semibold" style={{ fontSize: "13px", color: r.points && r.points > 0 ? "#00E2E5" : "rgba(255,255,255,0.3)" }}>
                        {r.points && r.points > 0 ? r.points : "—"}
                      </td>
                      <td className="px-3 py-2 font-body" style={{ fontSize: "13px", color: "rgba(245,236,238,0.6)" }}>
                        {r.bestLap && r.bestLap > 0 ? formatLapTime(r.bestLap) : "--"}
                      </td>
                      <td className="px-3 py-2 font-body" style={{ fontSize: "13px", color: "rgba(245,236,238,0.45)" }}>
                        {r.laps ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
