"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import SubpageHero from "@/components/SubpageHero";
import Image from "next/image";
import { useTrackStatus } from "@/hooks/useTrackStatus";
import { trackBookingClick } from "@/lib/analytics";

const glowShadow = "rgba(229,0,0,0.48) 0px 0px 30px";

const ACCESS_TOKEN = "63inwlpilbjlobwppml";
const API_BASE = "https://modules-api22.sms-timing.com/api/besttimes";

type BestTimeRecord = {
  position: number;
  participant: string;
  score: string;
  date: string;
};

type Category = {
  label: string;
  color: string;
  border: string;
  rscId: string;
  scgId: string;
};

type Track = "blue" | "red" | "mega";

type TrackConfig = {
  key: Track;
  label: string;
  accent: string;
  adult: Category[];
  junior: Category[];
};

const tracks: TrackConfig[] = [
  {
    key: "blue",
    label: "Blue Track",
    accent: "rgb(0,74,173)",
    adult: [
      { label: "Starter", color: "rgb(228,28,29)", border: "rgba(228,28,29,0.59)", rscId: "11208654", scgId: "11207805" },
      { label: "Intermediate", color: "rgb(0,74,173)", border: "rgba(0,74,173,0.59)", rscId: "11208654", scgId: "11207803" },
      { label: "Pro", color: "rgb(134,82,255)", border: "rgba(134,82,255,0.59)", rscId: "11208654", scgId: "11207807" },
    ],
    junior: [
      { label: "Junior Starter", color: "rgb(228,28,29)", border: "rgba(228,28,29,0.59)", rscId: "11208654", scgId: "11936433" },
      { label: "Junior Intermediate", color: "rgb(0,74,173)", border: "rgba(0,74,173,0.59)", rscId: "11208654", scgId: "12755221" },
      { label: "Junior Pro", color: "rgb(134,82,255)", border: "rgba(134,82,255,0.59)", rscId: "11208654", scgId: "15175252" },
    ],
  },
  {
    key: "red",
    label: "Red Track",
    accent: "rgb(228,28,29)",
    adult: [
      { label: "Starter", color: "rgb(228,28,29)", border: "rgba(228,28,29,0.59)", rscId: "11208660", scgId: "12113911" },
      { label: "Intermediate", color: "rgb(0,74,173)", border: "rgba(0,74,173,0.59)", rscId: "11208660", scgId: "11207809" },
      { label: "Pro", color: "rgb(134,82,255)", border: "rgba(134,82,255,0.59)", rscId: "11208660", scgId: "11207813" },
    ],
    junior: [
      { label: "Junior", color: "rgb(228,28,29)", border: "rgba(228,28,29,0.59)", rscId: "11208660", scgId: "11207811" },
    ],
  },
  {
    key: "mega",
    label: "Mega Track",
    accent: "rgb(134,82,255)",
    adult: [
      { label: "Starter", color: "rgb(228,28,29)", border: "rgba(228,28,29,0.59)", rscId: "-1", scgId: "11207799" },
      { label: "Intermediate", color: "rgb(0,74,173)", border: "rgba(0,74,173,0.59)", rscId: "-1", scgId: "11207797" },
      { label: "Pro", color: "rgb(134,82,255)", border: "rgba(134,82,255,0.59)", rscId: "-1", scgId: "11207801" },
    ],
    junior: [
      { label: "Junior Intermediate", color: "rgb(0,74,173)", border: "rgba(0,74,173,0.59)", rscId: "-1", scgId: "16924035" },
      { label: "Junior Pro", color: "rgb(134,82,255)", border: "rgba(134,82,255,0.59)", rscId: "-1", scgId: "16924037" },
    ],
  },
];

type TimeRange = "month" | "year" | "alltime";

function estNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "long",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return { year: get("year"), month: get("month"), weekday: get("weekday") };
}

function getStartDate(range: TimeRange): string {
  const { year, month } = estNow();
  if (range === "month") return `${year}-${month}-1 06:00:00`;
  if (range === "year") return `${year}-1-1 06:00:00`;
  return "2024-1-1 06:00:00";
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatTime(score: string): string {
  // Handle "1:02.212" format from Mega Track
  if (score.includes(":")) return score;
  const secs = parseFloat(score);
  if (secs >= 60) {
    const mins = Math.floor(secs / 60);
    const rem = (secs % 60).toFixed(3);
    return `${mins}:${rem.padStart(6, "0")}`;
  }
  return `${secs.toFixed(3)}s`;
}

function LeaderboardCard({ category, timeRange }: { category: Category; timeRange: TimeRange }) {
  const [records, setRecords] = useState<BestTimeRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      const startDate = encodeURIComponent(getStartDate(timeRange));
      const url = `${API_BASE}/records/headpinzftmyers?locale=en-US&rscId=${category.rscId}&scgId=${category.scgId}&startDate=${startDate}&endDate=&maxResult=10&accessToken=${ACCESS_TOKEN}&_t=${Date.now()}`;
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();
      setRecords(data.records || []);
    } catch {
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, [category.rscId, category.scgId, timeRange]);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  return (
    <div
      className="flex flex-col"
      style={{
        backgroundColor: "rgba(7,16,39,0.5)",
        border: `1.78px dashed ${category.border}`,
        borderRadius: "8px",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "16px 20px", borderBottom: `1px solid ${category.border}` }}>
        <h3
          className="font-[var(--font-anton)] uppercase"
          style={{ color: category.color, fontSize: "20px", letterSpacing: "1.2px" }}
        >
          {category.label}
        </h3>
      </div>

      {loading ? (
        <div className="p-6 text-center">
          <p className="font-[var(--font-poppins)] text-white/50 text-sm">Loading...</p>
        </div>
      ) : records.length === 0 ? (
        <div className="p-6 text-center">
          <p className="font-[var(--font-poppins)] text-white/40 text-sm">No records for this period</p>
        </div>
      ) : (
        <div className="flex flex-col">
          {records.map((r, i) => (
            <div
              key={`${r.participant}-${r.score}`}
              className="flex items-center gap-3 px-4 py-2.5"
              style={{
                borderBottom: i < records.length - 1 ? "1px solid rgba(255,255,255,0.06)" : undefined,
                backgroundColor: i === 0 ? "rgba(255,215,0,0.06)" : undefined,
              }}
            >
              <span
                className="font-[var(--font-anton)] shrink-0 text-center"
                style={{
                  width: "28px",
                  fontSize: "16px",
                  color: i === 0 ? "rgb(255,215,0)" : i === 1 ? "rgb(192,192,192)" : i === 2 ? "rgb(205,127,50)" : "rgba(255,255,255,0.4)",
                }}
              >
                {r.position}
              </span>
              <span
                className="font-[var(--font-poppins)] flex-1 truncate"
                style={{ fontSize: "14px", color: "rgba(245,236,238,0.9)", fontWeight: i === 0 ? 600 : 400 }}
              >
                {r.participant}
              </span>
              <span
                className="font-[var(--font-poppins)] font-semibold shrink-0"
                style={{ fontSize: "14px", color: category.color }}
              >
                {formatTime(r.score)}
              </span>
              <span
                className="font-[var(--font-poppins)] shrink-0 hidden sm:inline"
                style={{ fontSize: "12px", color: "rgba(255,255,255,0.3)", width: "50px", textAlign: "right" }}
              >
                {formatDate(r.date)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── WebSocket Live Timing ── */

const WS_HOST = "webserver22.sms-timing.com";
const WS_PORT = 10015;
const LIVE_TRACKS = [
  { key: "blue" as const, label: "Blue Track", accent: "rgb(0,74,173)", serverKey: "11208654@headpinzftmyers" },
  { key: "red" as const, label: "Red Track", accent: "rgb(228,28,29)", serverKey: "11208660@headpinzftmyers" },
  { key: "mega" as const, label: "Mega Track", accent: "rgb(134,82,255)", serverKey: "-1@headpinzftmyers" },
];

type LiveDriver = {
  name: string;
  kart: string;
  position: number;
  laps: number;
  bestLap: number;
  avgLap: number;
  lastLap: number;
  gap: string;
};

type HeatState = "idle" | "running" | "paused" | "finished";

function msToLap(ms: number): string {
  if (!ms) return "";
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  const ss = secs.toString().padStart(2, "0");
  const mmm = millis.toString().padStart(3, "0");
  return mins > 0 ? `${mins}:${ss}.${mmm}` : `${ss}.${mmm}`;
}

function msToCountdown(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function LiveTimingPanel({ serverKey, accent }: { serverKey: string; accent: string }) {
  const [drivers, setDrivers] = useState<LiveDriver[]>([]);
  const [heatName, setHeatName] = useState("");
  const [heatState, setHeatState] = useState<HeatState>("idle");
  const [timeLeft, setTimeLeft] = useState(0);
  const [noRaces, setNoRaces] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let closed = false;

    function connect() {
      if (closed) return;
      const ws = new WebSocket(`wss://${WS_HOST}:${WS_PORT}/`);
      wsRef.current = ws;

      ws.onopen = () => ws.send(`START ${serverKey}`);

      ws.onmessage = (evt) => {
        if (evt.data === "{}") {
          setNoRaces(true);
          setDrivers([]);
          return;
        }
        try {
          const data = JSON.parse(evt.data);
          setNoRaces(false);
          setHeatName((data.N || "").replace("[HEAT]", "Heat"));

          const state = data.S as number;
          setHeatState(state === 1 ? "running" : state === 2 ? "paused" : state >= 3 ? "finished" : "idle");
          setTimeLeft(data.C || 0);

          const dArr = (data.D || []) as Array<Record<string, unknown>>;
          setDrivers(
            dArr.map((d) => ({
              name: (d.N as string) || "",
              kart: String(d.K ?? ""),
              position: (d.P as number) || 0,
              laps: (d.L as number) || 0,
              bestLap: (d.B as number) || 0,
              avgLap: (d.A as number) || 0,
              lastLap: (d.T as number) || 0,
              gap: (d.G as string) || "",
            }))
          );
        } catch { /* ignore parse errors */ }
      };

      ws.onclose = () => {
        if (!closed) reconnectTimer = setTimeout(connect, 5000);
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [serverKey]);

  if (noRaces) {
    return (
      <div
        className="flex flex-col items-center justify-center"
        style={{
          minHeight: "200px",
          backgroundColor: "rgba(7,16,39,0.5)",
          border: `1.78px dashed ${accent}40`,
          borderRadius: "8px",
        }}
      >
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.3, marginBottom: "12px" }}>
          <circle cx="12" cy="12" r="10" stroke="white" strokeWidth="1.5" />
          <path d="M12 6v6l4 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <p className="font-[var(--font-poppins)] text-white/40 text-sm">No races running</p>
      </div>
    );
  }

  return (
    <div
      style={{
        backgroundColor: "rgba(7,16,39,0.5)",
        border: `1.78px dashed ${accent}59`,
        borderRadius: "8px",
        overflow: "hidden",
      }}
    >
      {/* Heat header */}
      <div
        className="flex items-center justify-between px-5 py-3"
        style={{ backgroundColor: accent, color: "white" }}
      >
        <span className="font-[var(--font-anton)] uppercase tracking-wider text-base">
          {heatName}
        </span>
        <span className="font-[var(--font-poppins)] font-semibold text-sm">
          {heatState === "running" && timeLeft > 0 && msToCountdown(timeLeft)}
          {heatState === "paused" && "PAUSED"}
          {heatState === "finished" && "FINISHED"}
        </span>
      </div>

      {/* Table header */}
      <div
        className="grid font-[var(--font-poppins)] font-semibold uppercase text-xs tracking-wider px-4 py-2.5"
        style={{
          gridTemplateColumns: "40px 1fr 50px 50px 85px 85px 85px 60px",
          color: "rgba(255,255,255,0.5)",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <span>Pos</span>
        <span>Driver</span>
        <span className="text-center">Kart</span>
        <span className="text-center">Laps</span>
        <span className="text-right">Best</span>
        <span className="text-right">Last</span>
        <span className="text-right">Avg</span>
        <span className="text-right">Gap</span>
      </div>

      {/* Driver rows */}
      {drivers.map((d, i) => (
        <div
          key={`${d.name}-${d.kart}`}
          className="grid font-[var(--font-poppins)] px-4 py-2"
          style={{
            gridTemplateColumns: "40px 1fr 50px 50px 85px 85px 85px 60px",
            fontSize: "13px",
            borderBottom: i < drivers.length - 1 ? "1px solid rgba(255,255,255,0.05)" : undefined,
            backgroundColor: i === 0 ? "rgba(255,215,0,0.05)" : undefined,
          }}
        >
          <span
            className="font-[var(--font-anton)]"
            style={{
              color: i === 0 ? "rgb(255,215,0)" : i === 1 ? "rgb(192,192,192)" : i === 2 ? "rgb(205,127,50)" : "rgba(255,255,255,0.4)",
              fontSize: "15px",
            }}
          >
            {d.position}
          </span>
          <span className="truncate" style={{ color: "rgba(245,236,238,0.9)", fontWeight: i === 0 ? 600 : 400 }}>
            {d.name}
          </span>
          <span className="text-center" style={{ color: "rgba(255,255,255,0.5)" }}>{d.kart}</span>
          <span className="text-center" style={{ color: "rgba(255,255,255,0.5)" }}>{d.laps}</span>
          <span className="text-right font-semibold" style={{ color: accent }}>{msToLap(d.bestLap)}</span>
          <span className="text-right" style={{ color: "rgba(255,255,255,0.7)" }}>{msToLap(d.lastLap)}</span>
          <span className="text-right" style={{ color: "rgba(255,255,255,0.5)" }}>{msToLap(d.avgLap)}</span>
          <span className="text-right" style={{ color: "rgba(255,255,255,0.4)", fontSize: "12px" }}>
            {i === 0 ? "" : d.gap}
          </span>
        </div>
      ))}
    </div>
  );
}

function LiveTimingTabs({ isMega }: { isMega: boolean }) {
  /* When Mega Track is active, show Blue + Red feeds (Mega uses the combined physical tracks).
     The -1 serverKey doesn't return live data — real data flows through the Blue/Red feeds. */
  const visibleTracks = isMega
    ? LIVE_TRACKS.filter((t) => t.key !== "mega")
    : LIVE_TRACKS.filter((t) => t.key !== "mega");

  return (
    <div>
      {isMega && (
        <h3
          className="font-[var(--font-anton)] uppercase text-center mb-6"
          style={{ color: "rgb(134,82,255)", fontSize: "24px", letterSpacing: "1.2px" }}
        >
          Mega Track Live
        </h3>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {visibleTracks.map((t) => (
          <div key={t.key}>
            <h4
              className="font-[var(--font-anton)] uppercase text-center mb-4"
              style={{ color: isMega ? "rgb(134,82,255)" : t.accent, fontSize: "20px", letterSpacing: "1.2px" }}
            >
              {isMega ? `${t.label} Feed` : `${t.label} Live`}
            </h4>
            <LiveTimingPanel serverKey={t.serverKey} accent={isMega ? "rgb(134,82,255)" : t.accent} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function LeaderboardsPage() {
  const trackStatus = useTrackStatus();
  const isMega = trackStatus?.megaTrackEnabled ?? estNow().weekday === "Tuesday";
  const [timeRange, setTimeRange] = useState<TimeRange>("month");
  const [activeTrack, setActiveTrack] = useState<Track>("blue");
  const [classFilter, setClassFilter] = useState<"adult" | "junior">("adult");

  const track = tracks.find((t) => t.key === activeTrack)!;
  const filtered = classFilter === "adult" ? track.adult : track.junior;

  return (
    <>
      <SubpageHero
        title="Live Leaderboards & Standings"
        backgroundImage="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/leaderboards-hero.webp"
      />

      {/* ── Section: Intro ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) 0" }}>
        <div className="max-w-7xl mx-auto px-8 flex flex-col lg:flex-row gap-10 items-center">
          <div className="flex-1">
            <h2
              className="font-[var(--font-anton)] italic uppercase text-white"
              style={{
                fontSize: "clamp(32px, 8vw, 72px)",
                lineHeight: "1",
                letterSpacing: "3px",
                marginBottom: "16px",
                textShadow: glowShadow,
              }}
            >
              Who&apos;s Leading the Pack?
            </h2>
            <p
              className="mb-8 font-[var(--font-poppins)]"
              style={{
                color: "rgba(255,255,255,0.898)",
                fontSize: "18px",
                lineHeight: "1.6",
                maxWidth: "700px",
              }}
            >
              Real-time performance data straight from the timing line. Track
              every apex and every overtake as it happens.
            </p>
            <a
              href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
              target="_blank"
              rel="noopener noreferrer"
              onClick={trackBookingClick}
              className="inline-block font-[var(--font-poppins)] font-semibold uppercase text-white tracking-wider transition-all hover:scale-105"
              style={{
                backgroundColor: "rgb(228,28,29)",
                borderRadius: "555px",
                padding: "16px 24px",
                fontSize: "14px",
              }}
            >
              Book today
            </a>
          </div>
          <div
            className="flex-1 relative rounded-2xl overflow-hidden"
            style={{ minHeight: "clamp(250px, 50vw, 400px)" }}
          >
            <Image
              src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/leaderboards-inline1.webp"
              alt="Racing at FastTrax"
              fill
              className="object-cover"
              sizes="(max-width: 1024px) 100vw, 50vw"
            />
          </div>
        </div>
      </section>

      {/* ── Section: The Live Timing ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) 0" }}>
        <div className="max-w-7xl mx-auto px-8">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{
              fontSize: "clamp(32px, 8vw, 72px)",
              lineHeight: "1",
              letterSpacing: "3px",
              marginBottom: "48px",
              textShadow: "rgba(255,30,0,0.4) 0px 0px 30px",
            }}
          >
            The Live Timing
          </h2>

          <LiveTimingTabs isMega={isMega} />
        </div>
      </section>

      {/* ── Section: Best Times by Race Type ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) 0" }}>
        <div className="max-w-7xl mx-auto px-8">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{
              fontSize: "clamp(32px, 8vw, 72px)",
              lineHeight: "1",
              letterSpacing: "3px",
              marginBottom: "16px",
              textShadow: glowShadow,
            }}
          >
            Hall of Fame
          </h2>
          <p
            className="text-center mx-auto mb-8 font-[var(--font-poppins)]"
            style={{ color: "rgba(245,236,238,0.8)", fontSize: "18px", lineHeight: "1.6", maxWidth: "700px" }}
          >
            Top 10 fastest lap times by race type. Think you can crack the list?
          </p>

          {/* Track Tabs */}
          <div className="flex justify-center gap-1 mb-6">
            {tracks.map((t) => (
              <button
                key={t.key}
                onClick={() => setActiveTrack(t.key)}
                className="font-[var(--font-anton)] uppercase tracking-wider text-base px-6 py-3 transition-all cursor-pointer"
                style={{
                  backgroundColor: activeTrack === t.key ? "rgba(7,16,39,0.7)" : "transparent",
                  color: activeTrack === t.key ? t.accent : "rgba(255,255,255,0.4)",
                  borderBottom: activeTrack === t.key ? `3px solid ${t.accent}` : "3px solid transparent",
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Filters */}
          <div className="flex flex-wrap justify-center gap-3 mb-10">
            {/* Time Range */}
            {(["month", "year", "alltime"] as TimeRange[]).map((r) => (
              <button
                key={r}
                onClick={() => setTimeRange(r)}
                className="font-[var(--font-poppins)] font-semibold uppercase text-sm px-5 py-2.5 rounded-full transition-all cursor-pointer"
                style={{
                  backgroundColor: timeRange === r ? "rgb(228,28,29)" : "rgba(7,16,39,0.5)",
                  color: timeRange === r ? "white" : "rgba(255,255,255,0.6)",
                  border: timeRange === r ? "1px solid rgb(228,28,29)" : "1px solid rgba(255,255,255,0.15)",
                }}
              >
                {r === "month" ? "This Month" : r === "year" ? "This Year" : "All Time"}
              </button>
            ))}

            <div style={{ width: "1px", backgroundColor: "rgba(255,255,255,0.15)", margin: "0 4px" }} />

            {/* Class Filter */}
            {(["adult", "junior"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setClassFilter(f)}
                className="font-[var(--font-poppins)] font-semibold uppercase text-sm px-5 py-2.5 rounded-full transition-all cursor-pointer"
                style={{
                  backgroundColor: classFilter === f ? "rgb(134,82,255)" : "rgba(7,16,39,0.5)",
                  color: classFilter === f ? "white" : "rgba(255,255,255,0.6)",
                  border: classFilter === f ? "1px solid rgb(134,82,255)" : "1px solid rgba(255,255,255,0.15)",
                }}
              >
                {f === "adult" ? "Adult" : "Junior"}
              </button>
            ))}
          </div>

          {/* Leaderboard Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filtered.map((cat) => (
              <LeaderboardCard key={cat.label} category={cat} timeRange={timeRange} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Section: Performance Journey ── */}
      <section className="relative overflow-hidden">
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/checkered-flag.webp"
          alt="Background"
          fill
          className="object-cover"
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-[#000418]/85" />
        <div
          className="relative z-10 max-w-7xl mx-auto"
          style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}
        >
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white text-center"
            style={{
              fontSize: "clamp(32px, 8vw, 72px)",
              lineHeight: "1",
              letterSpacing: "3px",
              marginBottom: "48px",
              textShadow: "rgba(255,30,0,0.4) 0px 0px 30px",
            }}
          >
            Performance Journey: Beyond the Lap
          </h2>
          <div className="flex flex-col sm:flex-row gap-6 justify-center max-w-5xl mx-auto">
            {[
              {
                num: "1",
                title: "Personal Stats",
                desc: "Want to see your full history? Log into the FastTrax Racing App to view every heat you\u2019ve ever run, your average g-force, and your personal bests.",
                borderColor: "rgba(228,28,29,0.59)",
                titleColor: "rgb(228,28,29)",
              },
              {
                num: "2",
                title: "Daily Top 10",
                desc: "Check the \u2018Daily\u2019 tab to see if you\u2019ve cracked today\u2019s leaderboard. The top times of the day are featured on the big screens at Nemo\u2019s Brickyard Bistro.",
                borderColor: "rgba(0,74,173,0.59)",
                titleColor: "rgb(0,74,173)",
              },
              {
                num: "3",
                title: "Unlock Speed Tiers",
                desc: "Top times aren\u2019t just for bragging rights. Consistent, fast, and safe laps are the only way to unlock Intermediate and Pro speeds.",
                borderColor: "rgba(134,82,255,0.63)",
                titleColor: "rgb(134,82,255)",
              },
            ].map((step) => (
              <div
                key={step.num}
                className="flex-1 flex flex-col"
                style={{
                  backgroundColor: "rgba(7,16,39,0.5)",
                  border: `1.78px dashed ${step.borderColor}`,
                  borderRadius: "8px",
                  padding: "20px",
                  textAlign: "center",
                }}
              >
                <p
                  className="font-[var(--font-anton)] text-white mb-2"
                  style={{ fontSize: "24px" }}
                >
                  {step.num}
                </p>
                <h3
                  className="font-[var(--font-anton)] uppercase mb-3"
                  style={{
                    color: step.titleColor,
                    fontSize: "24px",
                    letterSpacing: "1.2px",
                  }}
                >
                  {step.title}
                </h3>
                <p
                  className="font-[var(--font-poppins)]"
                  style={{
                    color: "rgba(245,236,238,0.8)",
                    fontSize: "16px",
                    lineHeight: "1.5",
                  }}
                >
                  {step.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Section: Track Information Alert ── */}
      <section className="bg-[#000418]" style={{ padding: "clamp(60px, 10vw, 120px) clamp(16px, 4vw, 32px)" }}>
        <div className="max-w-7xl mx-auto flex flex-col lg:flex-row gap-10 items-center">
          <div
            className="flex-1 relative rounded-2xl overflow-hidden"
            style={{ minHeight: "clamp(200px, 40vw, 300px)" }}
          >
            <Image
              src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/leaderboards-inline2.webp"
              alt="Track leaderboard display"
              fill
              className="object-cover"
              sizes="(max-width: 1024px) 100vw, 50vw"
            />
          </div>
          <div className="flex-1">
            <h2
              className="font-[var(--font-anton)] italic uppercase text-white"
              style={{
                fontSize: "clamp(32px, 8vw, 72px)",
                lineHeight: "1",
                letterSpacing: "3px",
                marginBottom: "32px",
                textShadow: glowShadow,
              }}
            >
              Track Information Alert
            </h2>
            <div
              style={{
                backgroundColor: "rgba(7,16,39,0.5)",
                border: "1.78px dashed rgb(134,82,255)",
                borderRadius: "8px",
                padding: "20px",
              }}
            >
              <h3
                className="font-[var(--font-anton)] uppercase mb-3"
                style={{
                  color: "rgb(134,82,255)",
                  fontSize: "30px",
                  letterSpacing: "1.5px",
                }}
              >
                Tuesday Mega Track
              </h3>
              <p
                className="font-[var(--font-poppins)]"
                style={{
                  color: "rgb(245,236,238)",
                  fontSize: "18px",
                  lineHeight: "1.5",
                }}
              >
                Tuesday Mega Track: Every Tuesday, we combine the Red and Blue
                tracks into one massive multi-level circuit. Standings for
                Tuesdays are recorded on a dedicated Mega Track leaderboard.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Section: Bottom CTA ── */}
      <section className="relative overflow-hidden" style={{ minHeight: "clamp(500px, 80vh, 788px)" }}>
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/leaderboards-cta.webp"
          alt="Racing action"
          fill
          className="object-cover"
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-[#000418]/40" />
        <div className="relative z-10 flex flex-col items-center justify-center text-center h-full px-8">
          <h2
            className="font-[var(--font-anton)] italic uppercase text-white"
            style={{
              fontSize: "clamp(32px, 8vw, 72px)",
              lineHeight: "1",
              letterSpacing: "3px",
              marginBottom: "32px",
              textShadow: glowShadow,
            }}
          >
            Think you can beat the best?
          </h2>
          <div className="flex flex-wrap gap-4 justify-center">
            <a
              href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
              target="_blank"
              rel="noopener noreferrer"
              onClick={trackBookingClick}
              className="inline-block font-[var(--font-poppins)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105"
              style={{
                backgroundColor: "rgb(228,28,29)",
                borderRadius: "555px",
                padding: "16px 24px",
                fontSize: "14px",
              }}
            >
              BOOK YOUR HEAT NOW
            </a>
            <a
              href="https://smstim.in/headpinzftmyers"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block font-[var(--font-poppins)] font-bold uppercase text-white tracking-wider transition-all hover:scale-105"
              style={{
                backgroundColor: "rgb(0,74,173)",
                borderRadius: "555px",
                padding: "16px 24px",
                fontSize: "14px",
              }}
            >
              DOWNLOAD THE APP
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
