"use client";

/**
 * The pit board — the live driver view.
 *
 * TWO NUMBERS AND NOTHING TO READ (owner 2026-09-05: "they won't be able to look
 * at that while driving"). Position and last lap, as large as the panel allows.
 * Everything else is a quiet strip along the bottom that can be ignored at
 * speed and is there when the kart is parked. The lap-by-lap list that used to
 * live on the right is gone — it is a screen of its own now, for after the flag.
 *
 * TWO SOURCES, DELIBERATELY SEPARATE:
 *   the SOCKET (browser-direct, `useLiveKart`) gives position, laps, gap, clock;
 *   the API POLL gives flags, incidents and lap history, which the socket has no
 *   idea about.
 * Either can fail without the other. A dead socket leaves the flags working; a
 * dead API leaves the board live. Neither failure blanks the screen.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLiveKart } from "~/features/racing/driver-view/useLiveKart";
import { currentTakeover, visibleInline } from "~/features/racing/driver-view/standing";
import { formatLapTime, summarise } from "~/features/racing/driver-view/laps";
import { t, type Locale } from "~/features/racing/driver-view/copy";
import type { DriverAlert, DriverLap, TrackKey } from "~/features/racing/driver-view/types";
import { FlagTakeover } from "./FlagTakeover";
import { RotateGate } from "./RotateGate";
import { InlineAlerts } from "./InlineAlerts";
import { c, fluid, font, label, numeral, track as trackColor } from "./tokens";

interface ApiState {
  binding: {
    participantName: string | null;
    sessionName: string | null;
    track: TrackKey | null;
  } | null;
  laps: DriverLap[];
  alerts: DriverAlert[];
}

/** How often to ask the server for flags. A red flag two seconds stale is a red
 *  flag that failed, so this is fast — but it is two Redis reads and one indexed
 *  query, and the socket carries the per-second traffic. */
const POLL_MS = 2_000;

export function DriverScreen({ kart, locale }: { kart: string; locale: Locale }) {
  const router = useRouter();
  const [api, setApi] = useState<ApiState>({ binding: null, laps: [], alerts: [] });
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const res = await fetch(`/api/kart/${encodeURIComponent(kart)}`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as ApiState;
        if (!stop) {
          setApi(json);
          setLoaded(true);
        }
      } catch {
        // Keep whatever we had. A screen that blanks on a blip is worse than a
        // screen a few seconds behind.
      }
    }
    void poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [kart]);

  // One ticker drives both the countdown and the alert expiry, so a flag never
  // outstays its welcome just because no new data arrived.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const live = useLiveKart(kart, api.binding?.track ?? null);
  const takeover = useMemo(() => currentTakeover(api.alerts, now), [api.alerts, now]);
  const inline = useMemo(() => visibleInline(api.alerts, now), [api.alerts, now]);
  const history = useMemo(() => summarise(api.laps), [api.laps]);

  const heatName = live.heatName || api.binding?.sessionName || "";
  const sessionId = takeover?.sessionId ?? null;

  const openResults = useCallback(() => {
    if (sessionId) router.push(`/race/${sessionId}/${kart}`);
  }, [router, sessionId, kart]);

  // Best lap: prefer the socket's, fall back to what we have stored. They agree
  // in the normal case; the stored one survives a socket that never connected.
  const bestMs = live.bestLapMs ?? history.best?.lapTimeMs ?? null;
  const lastMs = live.lastLapMs ?? history.last?.lapTimeMs ?? null;
  const isBest = lastMs !== null && bestMs !== null && lastMs <= bestMs;
  const accent = live.track
    ? trackColor[live.track]
    : api.binding?.track
      ? trackColor[api.binding.track]
      : c.cyan;

  /**
   * NOTHING ON THIS KART — almost always a mistyped number.
   *
   * Gated on `loaded` so it cannot flash before the first poll answers, and on
   * the live socket having found nothing either. Showing an empty pit board
   * here would leave a guest staring at dashes wondering whether the race had
   * started; saying so plainly, with the way back one tap away, is the whole
   * difference between "broken" and "you meant a different kart".
   */
  const nothingHere =
    loaded && !live.onTrack && api.binding === null && api.laps.length === 0 && !takeover;

  if (nothingHere) {
    return (
      <RotateGate locale={locale} kart={kart} heatName="">
        <main
          style={{
            minHeight: "100dvh",
            background: c.ground,
            color: c.ink,
            fontFamily: font.body,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: fluid(10, 2, 20),
            padding: fluid(20, 5, 48),
            textAlign: "center",
          }}
        >
          <div style={{ ...label, fontSize: fluid(9, 1.5, 13), color: c.inkDim }}>
            {t(locale, "labelKart")}
          </div>
          <div
            style={{
              ...numeral,
              fontSize: fluid(56, 16, 130),
              fontWeight: 900,
              fontStyle: "italic",
              lineHeight: 0.85,
              letterSpacing: "-0.05em",
            }}
          >
            {kart}
          </div>
          <div
            style={{
              fontFamily: font.display,
              fontSize: fluid(14, 2.6, 22),
              fontWeight: 700,
              color: "rgba(245,236,238,0.75)",
              maxWidth: "36ch",
              textWrap: "pretty",
            }}
          >
            {t(locale, "waitingBody", { kart })}
          </div>
          <Link
            href="/kart"
            style={{
              ...label,
              marginTop: 6,
              minHeight: 44,
              display: "flex",
              alignItems: "center",
              padding: "0 20px",
              background: c.cyan,
              color: c.ground,
              textDecoration: "none",
              fontSize: fluid(11, 1.8, 14),
              fontWeight: 700,
            }}
          >
            {t(locale, "wrongKart")}
          </Link>
        </main>
      </RotateGate>
    );
  }

  return (
    <RotateGate locale={locale} kart={kart} heatName={heatName}>
      <div
        style={{
          minHeight: "100dvh",
          background: c.ground,
          color: c.ink,
          fontFamily: font.body,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* context + clock */}
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: `${fluid(6, 1.2, 14)} ${fluid(12, 2.5, 24)}`,
            background: c.navy,
            borderBottom: `1px solid ${c.hairline}`,
          }}
        >
          <div style={{ width: 5, height: fluid(18, 3, 28), background: accent }} />
          <span style={{ ...label, fontSize: fluid(9, 1.5, 14), fontWeight: 700 }}>
            {heatName || `${t(locale, "labelKart")} ${kart}`}
          </span>
          <div style={{ flexGrow: 1 }} />
          {live.state === "running" ? (
            <span
              style={{
                width: 11,
                height: 11,
                borderRadius: "50%",
                background: c.green,
                boxShadow: `0 0 12px ${c.green}d9`,
              }}
              aria-hidden
            />
          ) : null}
          <div
            style={{
              ...numeral,
              fontSize: fluid(22, 5, 44),
              fontWeight: 800,
              lineHeight: 1,
              letterSpacing: "-0.025em",
              color: live.connected ? c.ink : c.inkFaint,
            }}
          >
            {formatClock(live.remainingMs)}
          </div>
        </div>

        {/* the two numbers */}
        <div
          style={{
            flexGrow: 1,
            display: "grid",
            gridTemplateColumns: "minmax(0, 34%) minmax(0, 1fr)",
            minHeight: 0,
          }}
        >
          <div
            style={{
              borderRight: `1px solid ${c.hairline}`,
              padding: `${fluid(6, 1.5, 16)} ${fluid(12, 2.5, 24)}`,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
            }}
          >
            <div style={{ ...label, fontSize: fluid(9, 1.5, 14), color: c.inkDim }}>
              {t(locale, "labelPosition")}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: fluid(6, 1.6, 16) }}>
              <span
                style={{
                  ...numeral,
                  fontSize: fluid(56, 20, 180),
                  fontWeight: 900,
                  fontStyle: "italic",
                  lineHeight: 0.8,
                  letterSpacing: "-0.05em",
                }}
              >
                {live.position ?? "–"}
              </span>
              {live.deltaPosition > 0 ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    padding: "8px 10px",
                    background: "rgba(0,226,229,0.14)",
                    border: "1px solid rgba(0,226,229,0.45)",
                  }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={c.cyan}
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="6 15 12 9 18 15" />
                  </svg>
                  <span
                    style={{
                      ...numeral,
                      fontSize: fluid(12, 2.4, 24),
                      fontWeight: 900,
                      color: c.cyan,
                      lineHeight: 1,
                    }}
                  >
                    {live.deltaPosition}
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          <div
            style={{
              padding: `${fluid(6, 1.5, 16)} ${fluid(14, 3, 28)}`,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              minWidth: 0,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ ...label, fontSize: fluid(9, 1.5, 14), color: c.inkDim }}>
                {t(locale, "labelLastLap")}
              </span>
              {isBest ? (
                <span
                  style={{
                    ...label,
                    fontSize: fluid(8, 1.3, 12),
                    fontWeight: 700,
                    color: c.ground,
                    background: c.violet,
                    padding: "4px 9px",
                  }}
                >
                  {t(locale, "labelBest")}
                </span>
              ) : null}
            </div>
            <div
              style={{
                ...numeral,
                fontSize: fluid(44, 16, 145),
                fontWeight: 900,
                fontStyle: "italic",
                lineHeight: 0.84,
                letterSpacing: "-0.05em",
                color: isBest ? c.violet : c.ink,
              }}
            >
              {formatLapTime(lastMs)}
            </div>
          </div>
        </div>

        {/* the quiet strip */}
        <div
          style={{
            flexShrink: 0,
            background: c.panel,
            borderTop: `1px solid ${c.hairline}`,
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          }}
        >
          <KartCell locale={locale} kart={kart} />
          <Cell
            locale={locale}
            labelKey="labelGapAhead"
            value={live.gapAhead || "—"}
            tint={c.cyan}
            bordered
          />
          <Cell
            locale={locale}
            labelKey="labelLap"
            value={String(live.laps ?? history.count ?? 0)}
            bordered
          />
          <Cell locale={locale} labelKey="labelBest" value={formatLapTime(bestMs)} bordered />
        </div>

        <InlineAlerts alerts={inline} locale={locale} />
      </div>

      {takeover ? (
        <FlagTakeover
          alert={takeover}
          locale={locale}
          kart={kart}
          heatName={heatName}
          onOpenResults={sessionId ? openResults : undefined}
        />
      ) : null}
    </RotateGate>
  );
}

/**
 * The kart number, and the only way off this screen.
 *
 * THE PIT BOARD HAS NO NAV — it is registered chrome-free, so a guest who typed
 * the wrong number, or who was moved to another kart, would otherwise be
 * stranded watching someone else's race with no way back (owner 2026-09-05).
 *
 * It lives in the quiet strip along the bottom rather than anywhere near the
 * two big numbers: findable when they are parked and looking for it, nowhere
 * near a thumb mid-corner. The 44px target is the floor for a gloved hand.
 */
function KartCell({ locale, kart }: { locale: Locale; kart: string }) {
  return (
    <Link
      href="/kart"
      style={{
        display: "block",
        textDecoration: "none",
        color: "inherit",
        padding: `${fluid(4, 0.9, 10)} ${fluid(10, 2.5, 24)}`,
        minHeight: 44,
      }}
    >
      <div
        style={{
          ...label,
          fontSize: fluid(7, 1.1, 11),
          color: c.inkDim,
          display: "flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        {t(locale, "labelKart")}
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke={c.cyan}
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <polyline points="17 4 9 12 17 20" />
        </svg>
        <span style={{ color: c.cyan }}>{t(locale, "changeKart")}</span>
      </div>
      <div style={{ ...numeral, fontSize: fluid(14, 2.8, 26), fontWeight: 800, lineHeight: 1.05 }}>
        {kart}
      </div>
    </Link>
  );
}

function Cell({
  locale,
  labelKey,
  value,
  tint,
  bordered,
}: {
  locale: Locale;
  labelKey: Parameters<typeof t>[1];
  value: string;
  tint?: string;
  bordered?: boolean;
}) {
  return (
    <div
      style={{
        padding: `${fluid(4, 0.9, 10)} ${fluid(10, 2.5, 24)}`,
        borderLeft: bordered ? `1px solid ${c.hairline}` : undefined,
      }}
    >
      <div style={{ ...label, fontSize: fluid(7, 1.1, 11), color: c.inkDim }}>
        {t(locale, labelKey)}
      </div>
      <div
        style={{
          ...numeral,
          fontSize: fluid(14, 2.8, 26),
          fontWeight: 800,
          lineHeight: 1.05,
          color: tint ?? c.ink,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function formatClock(ms: number): string {
  if (!ms || ms <= 0) return "0:00";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}
