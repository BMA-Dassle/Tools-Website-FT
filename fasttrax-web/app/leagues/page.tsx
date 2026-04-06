"use client";

import { useEffect, useState, useMemo } from "react";
import SubpageHero from "@/components/SubpageHero";

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

/* ── League config (hardcoded for now) ── */

const LEAGUE = {
  track: "Blue Track",
  scoreGroup: "Blue League (4/1/26-7/8/26)",
  label: "Blue League",
  dates: "4/1/26 - 7/8/26",
  startDate: "2026-01-01",
  endDate: "2026-12-31",
};

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
        className="font-[var(--font-anton)] uppercase"
        style={{ fontSize: "clamp(28px, 5vw, 40px)", color: accent || "#00E2E5", lineHeight: 1.1 }}
      >
        {value}
      </span>
      <span
        className="font-[var(--font-poppins)] mt-1"
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
      className="font-[var(--font-poppins)] font-medium transition-colors"
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
}: {
  driver: Driver;
  rank: number;
  leaderPoints: number;
  leaderBestLap: number;
  sortField: SortField;
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

  const sortedSessions = useMemo(
    () =>
      [...driver.sessions].sort(
        (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
      ),
    [driver.sessions],
  );

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
            className="font-[var(--font-anton)] inline-flex items-center justify-center"
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
            className="font-[var(--font-poppins)]"
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
            className="font-[var(--font-poppins)] font-semibold"
            style={{ fontSize: "15px", color: "#00E2E5" }}
          >
            {driver.totalPoints}
          </span>
        </td>

        {/* Races */}
        <td className="px-2 py-3 sm:px-4 text-center hidden sm:table-cell">
          <span
            className="font-[var(--font-poppins)]"
            style={{ fontSize: "14px", color: "rgba(245,236,238,0.6)" }}
          >
            {raceCount}
          </span>
        </td>

        {/* Best Lap */}
        <td className="px-2 py-3 sm:px-4 text-center hidden md:table-cell">
          <span
            className="font-[var(--font-poppins)] font-medium"
            style={{ fontSize: "14px", color: "rgba(245,236,238,0.8)" }}
          >
            {bestLap < Infinity ? formatLapTime(bestLap) : "--"}
          </span>
        </td>

        {/* Gap */}
        <td className="px-2 py-3 sm:px-4 text-right hidden sm:table-cell">
          <span
            className="font-[var(--font-poppins)]"
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
              fontSize: "12px",
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
                          className="font-[var(--font-poppins)] text-left px-4 py-2"
                          style={{
                            fontSize: "11px",
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
                    {sortedSessions.map((s) => {
                      const gp = isGrandPrix(s.sessionName);
                      return (
                        <tr
                          key={s.sessionId}
                          style={{
                            borderBottom: "1px solid rgba(255,255,255,0.04)",
                          }}
                        >
                          <td className="px-4 py-2">
                            <span
                              className="font-[var(--font-poppins)]"
                              style={{
                                fontSize: "13px",
                                fontWeight: gp ? 600 : 400,
                                color: gp ? "rgba(245,236,238,0.9)" : "rgba(245,236,238,0.5)",
                              }}
                            >
                              {s.sessionName}
                            </span>
                          </td>
                          <td className="px-4 py-2">
                            <span
                              className="font-[var(--font-poppins)] font-medium"
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
                              className="font-[var(--font-poppins)] font-semibold"
                              style={{ fontSize: "13px", color: gp ? "#00E2E5" : "rgba(0,226,229,0.5)" }}
                            >
                              {s.points}
                            </span>
                          </td>
                          <td className="px-4 py-2">
                            <span
                              className="font-[var(--font-poppins)]"
                              style={{ fontSize: "13px", color: "rgba(245,236,238,0.6)" }}
                            >
                              {s.bestLap > 0 ? formatLapTime(s.bestLap) : "--"}
                            </span>
                          </td>
                          <td className="px-4 py-2">
                            <span
                              className="font-[var(--font-poppins)]"
                              style={{ fontSize: "13px", color: "rgba(245,236,238,0.45)" }}
                            >
                              {s.laps}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
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
      <p className="font-[var(--font-poppins)]" style={{ color: "rgba(245,236,238,0.5)", fontSize: "14px" }}>
        Loading standings...
      </p>
    </div>
  );
}

/* ── Page ── */

export default function LeagueStandingsPage() {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sortField, setSortField] = useState<SortField>("points");

  useEffect(() => {
    async function fetchStandings() {
      try {
        const params = new URLSearchParams({
          action: "summary",
          track: LEAGUE.track,
          scoreGroup: LEAGUE.scoreGroup,
          startDate: LEAGUE.startDate,
          endDate: LEAGUE.endDate,
        });
        const res = await fetch(`/api/leagues?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!json.success) throw new Error(json.error || "API error");
        setDrivers(json.data || []);
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
      case "races":
        copy.sort((a, b) => b.sessions.length - a.sessions.length || b.totalPoints - a.totalPoints);
        break;
    }
    return copy;
  }, [drivers, sortField]);

  /* Stats */
  const totalDrivers = drivers.length;
  const totalRaces = drivers.reduce((sum, d) => sum + d.sessions.length, 0);
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
              className="font-[var(--font-poppins)] inline-flex items-center gap-2"
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
              <span style={{ fontSize: "10px" }}>&#9679;</span>
              {LEAGUE.label} &middot; {LEAGUE.dates}
            </div>
          </div>

          {loading ? (
            <Spinner />
          ) : error ? (
            <div className="text-center py-20">
              <p className="font-[var(--font-poppins)]" style={{ color: "#E41C1D", fontSize: "16px" }}>
                {error}
              </p>
              <button
                onClick={() => window.location.reload()}
                className="font-[var(--font-poppins)] mt-4"
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
              <p className="font-[var(--font-poppins)]" style={{ color: "rgba(245,236,238,0.5)", fontSize: "16px" }}>
                No standings data available yet. Races start soon!
              </p>
            </div>
          ) : (
            <>
              {/* Stats Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-10">
                <StatCard label="Total Drivers" value={String(totalDrivers)} />
                <StatCard label="Total Races" value={String(totalRaces)} />
                <StatCard label="League Leader" value={leader ? properName(leader.name).split(" ")[0] : "--"} accent="#FFD700" />
                <StatCard label="Fastest Lap" value={fastestLap ? formatLapTime(fastestLap) : "--"} accent="#E41C1D" />
              </div>

              {/* Sort controls */}
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                <span
                  className="font-[var(--font-poppins)]"
                  style={{ fontSize: "12px", color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.5px" }}
                >
                  Sort by:
                </span>
                <SortBtn label="Points" field="points" active={sortField} onClick={setSortField} />
                <SortBtn label="Best Lap" field="bestLap" active={sortField} onClick={setSortField} />
                <SortBtn label="Races" field="races" active={sortField} onClick={setSortField} />
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
                          className={`font-[var(--font-poppins)] py-3 ${col.className} ${col.hideOn ? `hidden ${col.hideOn}:table-cell` : ""}`}
                          style={{
                            fontSize: "11px",
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
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Footer note */}
              <p
                className="font-[var(--font-poppins)] text-center mt-6"
                style={{ fontSize: "13px", color: "rgba(245,236,238,0.35)" }}
              >
                Tap any driver to view session breakdown. Standings update after each race night.
              </p>
            </>
          )}
        </div>
      </section>
    </>
  );
}
