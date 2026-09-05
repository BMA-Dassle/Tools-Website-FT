/**
 * The race report, rendered.
 *
 * A SERVER COMPONENT with no state and no socket — the race is over, nothing
 * moves. That is what makes the same markup usable from a page, from `/racer`,
 * from a kiosk, and (later) as the body of an email: it is a pure function of
 * the report.
 *
 * TWO MODES, ONE COMPONENT. Given a `kart` it opens with that driver's own
 * result, their chart and their lap-by-lap; without one it is the full board.
 * They share the standings table deliberately — a personal report that
 * disagreed with the board it links to would make a guest trust neither.
 *
 * WHAT A RACER ACTUALLY ASKS, and where each answer comes from:
 *   "how fast was I?"        best lap, and the chart's shape
 *   "was that any good?"     gap to the heat's fastest, and the field spread
 *   "am I consistent?"       best against MEDIAN lap, not against the one spin
 *   "did I improve?"         first third of the heat against the last third
 *   "what do I chase next?"  the level-up cutoffs, from the same module the
 *                            kiosk sheet and the post-heat text already use
 *   "what happened to me?"   the flag timeline, marshal's words included
 */
import Link from "next/link";
import { formatLapTime } from "~/features/racing/driver-view/laps";
import {
  levelUpFor,
  type RaceReport,
  type ReportDriver,
} from "~/features/racing/driver-view/report";
import { nextLevelTarget } from "~/features/racing/qualify";
import { t, type CopyKey, type Locale } from "~/features/racing/driver-view/copy";
import { LapChart, LapSparkline } from "./LapChart";
import { c, font, label, numeral, track as trackColor } from "./tokens";

const MEDAL: Record<number, string> = { 1: "#FFD700", 2: "#C0C0C0", 3: "#CD7F32" };

/** Flag kinds worth a line in the timeline, and how to name them. */
const EVENT_LABEL: Record<string, CopyKey> = {
  blue: "blueTitle",
  caution: "cautionTitle",
  red: "redKicker",
  crash: "crashTitle",
  blackwhite: "blackwhiteTitle",
  disqualified: "dsqTitle",
  personalBest: "personalBestTitle",
  dayRecord: "dayRecordTitle",
  monthRecord: "monthRecordTitle",
  everRecord: "everRecordTitle",
  didNotStart: "dnsTitle",
};

/** "+1.062" / "−0.480". A signed gap always carries its sign. */
function signed(ms: number | null): string {
  if (ms === null) return "—";
  if (ms === 0) return "0.000";
  return `${ms > 0 ? "+" : "−"}${(Math.abs(ms) / 1000).toFixed(3)}`;
}

/** "1.062" — a magnitude, where the sign would be noise. */
function plain(ms: number | null): string {
  return ms === null ? "—" : (Math.abs(ms) / 1000).toFixed(3);
}

export function RaceReportView({
  report,
  driver,
  locale,
}: {
  report: RaceReport;
  driver?: ReportDriver | null;
  locale: Locale;
}) {
  const accent = report.track ? trackColor[report.track] : c.cyan;
  const heat = report.heatNumber ? `Heat ${report.heatNumber}` : (report.sessionName ?? "Race");

  return (
    <main
      style={{
        minHeight: "100dvh",
        background: c.ground,
        color: c.ink,
        fontFamily: font.body,
        padding: "clamp(16px, 4vw, 40px)",
        // The site nav is `fixed top-0` and there is no global spacer — every
        // chromed page owns its own offset. Without this the nav pill sat
        // straight across the heading. Matches the scale /rewards uses.
        paddingTop: "clamp(120px, 18vw, 180px)",
        maxWidth: 960,
        margin: "0 auto",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ width: 5, height: 34, background: accent }} />
        <div style={{ minWidth: 0 }}>
          <h1
            style={{
              fontFamily: font.display,
              fontSize: "clamp(24px, 5.5vw, 36px)",
              fontWeight: 900,
              fontStyle: "italic",
              textTransform: "uppercase",
              letterSpacing: "-0.025em",
              margin: 0,
              lineHeight: 1,
            }}
          >
            {heat}
          </h1>
          <div style={{ ...label, fontSize: 10, color: c.inkDim, marginTop: 6 }}>
            {[report.sessionName, driver ? `${t(locale, "labelKart")} ${driver.kart}` : null]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <div style={{ flexGrow: 1 }} />
        {report.fastestLap ? (
          <div style={{ textAlign: "right" }}>
            <div style={{ ...label, fontSize: 9, color: c.inkDim }}>
              {t(locale, "labelFastestLap")}
            </div>
            <div
              style={{
                ...numeral,
                fontSize: 26,
                fontWeight: 900,
                color: c.violet,
                lineHeight: 1.1,
              }}
            >
              {formatLapTime(report.fastestLap.ms)}
            </div>
            <div style={{ fontSize: 12, color: c.inkDim }}>{report.fastestLap.name}</div>
          </div>
        ) : null}
      </header>

      {driver ? (
        <PersonalPanel driver={driver} report={report} locale={locale} accent={accent} />
      ) : null}

      <Standings report={report} driver={driver} locale={locale} accent={accent} />

      <SessionInsights report={report} locale={locale} />

      {report.timeline.length > 0 ? (
        <section style={{ marginTop: 30 }}>
          <SectionTitle>{t(locale, "sectionWhatHappened")}</SectionTitle>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {report.timeline.map((e) => {
              const key = EVENT_LABEL[e.kind];
              if (!key) return null;
              const mine = driver?.kart === e.kart;
              return (
                <li
                  key={e.eventId}
                  style={{
                    display: "flex",
                    gap: 12,
                    padding: "8px 0",
                    borderBottom: `1px solid ${c.hairline}`,
                    fontSize: 13.5,
                    opacity: driver && !mine ? 0.55 : 1,
                  }}
                >
                  <span style={{ ...numeral, color: c.inkFaint, width: 62, flexShrink: 0 }}>
                    {new Date(e.atMs).toLocaleTimeString("en-US", {
                      timeZone: "America/New_York",
                      hour12: false,
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span style={{ color: c.inkDim, width: 58, flexShrink: 0 }}>
                    {e.kart ? `${t(locale, "labelKart")} ${e.kart}` : ""}
                  </span>
                  <span style={{ flexGrow: 1, textWrap: "pretty" }}>
                    {t(locale, key)}
                    {e.note ? ` — “${e.note}”` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {driver ? (
        <p style={{ marginTop: 30, fontSize: 14 }}>
          <Link href={`/race/${report.sessionId}`} style={{ color: c.cyan }}>
            {t(locale, "linkFullResults")}
          </Link>
        </p>
      ) : null}
    </main>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ ...label, fontSize: 11, color: c.inkDim, margin: "0 0 12px", fontWeight: 600 }}>
      {children}
    </h2>
  );
}

/** The driver's own result: headline stats, the chart, then every lap. */
function PersonalPanel({
  driver,
  report,
  locale,
  accent,
}: {
  driver: ReportDriver;
  report: RaceReport;
  locale: Locale;
  accent: string;
}) {
  const best = driver.summary.best?.lapTimeMs ?? null;
  const levelUp = levelUpFor(report, driver, nextLevelTarget);

  if (driver.summary.timed.length === 0) {
    return (
      <p style={{ marginTop: 24, fontSize: 15, color: c.inkDim }}>{t(locale, "labelNothingYet")}</p>
    );
  }

  return (
    <section style={{ marginTop: 26 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
          gap: 1,
          background: c.hairline,
          border: `1px solid ${c.hairline}`,
        }}
      >
        <Stat
          locale={locale}
          labelKey="labelPosition"
          value={driver.position > 0 ? `P${driver.position}` : "—"}
        />
        <Stat locale={locale} labelKey="labelBest" value={formatLapTime(best)} tint={c.violet} />
        <Stat locale={locale} labelKey="labelLaps" value={String(driver.summary.timed.length)} />
        <Stat
          locale={locale}
          labelKey="labelGapToFastest"
          value={signed(driver.gapToFastestMs)}
          tint={driver.gapToFastestMs === 0 ? c.violet : undefined}
        />
      </div>

      {/* level-up — the strongest thing we can tell a racer */}
      {levelUp ? (
        <div
          style={{
            marginTop: 14,
            border: `1px solid ${levelUp.achieved ? c.violet : c.hairline}`,
            background: levelUp.achieved ? "rgba(134,82,255,0.13)" : c.panel,
            padding: "14px 16px",
          }}
        >
          <div style={{ ...label, fontSize: 9, color: levelUp.achieved ? c.violet : c.inkDim }}>
            {t(locale, "levelUpTitle")}
          </div>
          <div
            style={{
              fontFamily: font.display,
              fontSize: "clamp(15px, 2.6vw, 20px)",
              fontWeight: 700,
              marginTop: 5,
              lineHeight: 1.3,
              textWrap: "pretty",
            }}
          >
            {levelUp.achieved
              ? t(locale, "levelUpAchieved", { level: levelUp.level })
              : t(locale, "levelUpChasing", {
                  time: formatLapTime(levelUp.targetMs),
                  level: levelUp.level,
                  gap: plain(levelUp.gapMs),
                })}
          </div>
          {!levelUp.achieved ? (
            <div
              style={{
                marginTop: 12,
                height: 7,
                background: "rgba(245,236,238,0.10)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${progressToTarget(best, levelUp.targetMs)}%`,
                  height: "100%",
                  background: c.violet,
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* the shape of the drive */}
      <div style={{ marginTop: 22, border: `1px solid ${c.hairline}`, padding: "14px 12px 6px" }}>
        <div style={{ ...label, fontSize: 9, color: c.inkDim, padding: "0 4px 8px" }}>
          {t(locale, "sectionHowItWent")}
        </div>
        <LapChart laps={driver.laps} accent={accent} />
      </div>

      {/* the two numbers that tell a racer how to get faster */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
          gap: 1,
          background: c.hairline,
          border: `1px solid ${c.hairline}`,
          borderTop: "none",
        }}
      >
        <Insight
          title={t(locale, "labelRepeatability")}
          value={plain(driver.medianGapMs)}
          hint={t(locale, "labelRepeatabilityHint")}
        />
        <Insight
          title={t(locale, "labelImprovement")}
          value={
            driver.improvementMs === null
              ? "—"
              : driver.improvementMs > 0
                ? plain(driver.improvementMs)
                : t(locale, "labelNoImprovement")
          }
          tint={driver.improvementMs !== null && driver.improvementMs > 0 ? c.cyan : undefined}
          hint={t(locale, "labelImprovementHint")}
        />
        {driver.bestLapNumber !== null ? (
          <Insight
            title={t(locale, "labelBest")}
            value={formatLapTime(best)}
            tint={c.violet}
            hint={t(locale, "labelBestOnLap", { n: String(driver.bestLapNumber) })}
          />
        ) : null}
      </div>

      {/* every lap */}
      <div style={{ marginTop: 22, border: `1px solid ${c.hairline}` }}>
        <div
          style={{
            ...label,
            fontSize: 9,
            color: c.inkDim,
            padding: "10px 14px",
            borderBottom: `1px solid ${c.hairline}`,
          }}
        >
          {t(locale, "sectionYourLaps")}
        </div>
        {driver.laps.map((l) => {
          const isBest = l.lapTimeMs !== null && l.lapTimeMs === best;
          return (
            <div
              key={l.passingId}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 10,
                padding: "7px 14px",
                paddingLeft: isBest ? 11 : 14,
                borderBottom: `1px solid rgba(245,236,238,0.06)`,
                background: isBest ? "rgba(134,82,255,0.13)" : undefined,
                borderLeft: isBest ? `3px solid ${c.violet}` : undefined,
              }}
            >
              <span style={{ ...numeral, fontSize: 12, width: 24, color: c.inkDim }}>
                {l.lapNumber}
              </span>
              <span
                style={{
                  ...numeral,
                  fontSize: 16,
                  fontWeight: isBest ? 800 : 600,
                  flexGrow: 1,
                  color: l.lapTimeMs === null ? c.inkFaint : c.ink,
                }}
              >
                {l.lapTimeMs === null ? t(locale, "labelNoTime") : formatLapTime(l.lapTimeMs)}
              </span>
              <span style={{ ...numeral, fontSize: 12, color: isBest ? c.violet : c.inkDim }}>
                {l.lapTimeMs === null
                  ? t(locale, "labelRollout")
                  : isBest
                    ? t(locale, "labelBest")
                    : signed(l.lapTimeMs - (best ?? l.lapTimeMs))}
              </span>
            </div>
          );
        })}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "10px 14px",
            borderTop: `1px solid ${c.hairline}`,
          }}
        >
          <span style={{ ...label, fontSize: 9, color: c.inkDim }}>
            {t(locale, "labelAverage")}
          </span>
          <span style={{ ...numeral, fontSize: 15, fontWeight: 700 }}>
            {formatLapTime(driver.summary.averageMs)}
          </span>
        </div>
      </div>
    </section>
  );
}

/** How far along the bar sits between "well off" and "there". Clamped, because
 *  a racer three seconds off should still see SOME bar rather than an empty one
 *  that reads as "hopeless". */
function progressToTarget(bestMs: number | null, targetMs: number): number {
  if (bestMs === null) return 0;
  // Treat 25% slower than the target as the bottom of the scale.
  const floor = targetMs * 1.25;
  const pct = ((floor - bestMs) / (floor - targetMs)) * 100;
  return Math.max(6, Math.min(97, Math.round(pct)));
}

function Standings({
  report,
  driver,
  locale,
  accent,
}: {
  report: RaceReport;
  driver?: ReportDriver | null;
  locale: Locale;
  accent: string;
}) {
  return (
    <section style={{ marginTop: 30 }}>
      <SectionTitle>{t(locale, "sectionResults")}</SectionTitle>
      <div style={{ border: `1px solid ${c.hairline}`, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
          <thead>
            <tr>
              {[
                { k: "", align: "left" as const, w: 46 },
                { k: t(locale, "labelKart"), align: "left" as const, w: 56 },
                { k: "", align: "left" as const },
                { k: "", align: "left" as const, w: 100 },
                { k: t(locale, "labelBest"), align: "right" as const, w: 82 },
                { k: t(locale, "labelGapToFastest"), align: "right" as const, w: 78 },
                { k: t(locale, "labelLaps"), align: "right" as const, w: 56 },
              ].map((h, i) => (
                <th
                  key={i}
                  style={{
                    ...label,
                    fontSize: 9,
                    color: c.inkDim,
                    textAlign: h.align,
                    padding: "10px 12px",
                    borderBottom: `1px solid ${c.hairline}`,
                    fontWeight: 500,
                    width: h.w,
                  }}
                >
                  {h.k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.drivers.map((d) => {
              const mine = driver?.kart === d.kart;
              const isFastest = report.fastestLap?.kart === d.kart;
              return (
                <tr
                  key={d.kart}
                  style={{
                    background: mine ? "rgba(134,82,255,0.13)" : undefined,
                    borderLeft: mine ? `3px solid ${c.violet}` : "3px solid transparent",
                  }}
                >
                  <td
                    style={{
                      ...numeral,
                      fontSize: 16,
                      fontWeight: 800,
                      padding: "9px 12px",
                      color: MEDAL[d.position] ?? c.inkDim,
                    }}
                  >
                    {d.position > 0 ? d.position : "—"}
                  </td>
                  <td style={{ ...numeral, fontSize: 14, padding: "9px 12px", color: c.inkDim }}>
                    {d.kart}
                  </td>
                  <td style={{ fontSize: 14.5, padding: "9px 12px", fontWeight: mine ? 700 : 400 }}>
                    {d.name}
                    {d.disqualified ? (
                      <span style={{ ...label, fontSize: 9, color: c.red, marginLeft: 8 }}>
                        {t(locale, "dsqTitle")}
                      </span>
                    ) : null}
                  </td>
                  <td style={{ padding: "6px 12px" }}>
                    <LapSparkline laps={d.laps} accent={mine ? c.violet : accent} />
                  </td>
                  <td
                    style={{
                      ...numeral,
                      fontSize: 15,
                      fontWeight: 700,
                      padding: "9px 12px",
                      textAlign: "right",
                      color: isFastest ? c.violet : c.ink,
                    }}
                  >
                    {formatLapTime(d.summary.best?.lapTimeMs ?? null)}
                  </td>
                  <td
                    style={{
                      ...numeral,
                      fontSize: 13,
                      padding: "9px 12px",
                      textAlign: "right",
                      color: c.inkDim,
                    }}
                  >
                    {d.gapToFastestMs === 0 ? "—" : signed(d.gapToFastestMs)}
                  </td>
                  <td
                    style={{
                      ...numeral,
                      fontSize: 14,
                      padding: "9px 12px",
                      textAlign: "right",
                      color: c.inkDim,
                    }}
                  >
                    {d.summary.timed.length}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Two things about the heat as a whole, only when they mean something. */
function SessionInsights({ report, locale }: { report: RaceReport; locale: Locale }) {
  if (report.fieldSpreadMs === null && report.mostImproved === null) return null;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
        gap: 1,
        background: c.hairline,
        border: `1px solid ${c.hairline}`,
        borderTop: "none",
      }}
    >
      {report.fieldSpreadMs !== null ? (
        <Insight
          title={t(locale, "labelFieldSpread")}
          value={plain(report.fieldSpreadMs)}
          hint={t(locale, "labelFieldSpreadHint")}
        />
      ) : null}
      {report.mostImproved ? (
        <Insight
          title={t(locale, "labelMostImproved")}
          value={report.mostImproved.name}
          tint={c.cyan}
          hint={`${t(locale, "labelKart")} ${report.mostImproved.kart} · ${plain(report.mostImproved.ms)}`}
        />
      ) : null}
    </div>
  );
}

function Insight({
  title,
  value,
  hint,
  tint,
}: {
  title: string;
  value: string;
  hint?: string;
  tint?: string;
}) {
  return (
    <div style={{ background: c.panel, padding: "13px 15px" }}>
      <div style={{ ...label, fontSize: 9, color: c.inkDim }}>{title}</div>
      <div
        style={{
          ...numeral,
          fontSize: 24,
          fontWeight: 900,
          lineHeight: 1.15,
          marginTop: 2,
          color: tint ?? c.ink,
        }}
      >
        {value}
      </div>
      {hint ? (
        <div style={{ fontSize: 11.5, color: c.inkFaint, marginTop: 4, lineHeight: 1.35 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  locale,
  labelKey,
  value,
  tint,
}: {
  locale: Locale;
  labelKey: CopyKey;
  value: string;
  tint?: string;
}) {
  return (
    <div style={{ background: c.panel, padding: "13px 15px" }}>
      <div style={{ ...label, fontSize: 9, color: c.inkDim }}>{t(locale, labelKey)}</div>
      <div
        style={{
          ...numeral,
          fontSize: 30,
          fontWeight: 900,
          lineHeight: 1.1,
          color: tint ?? c.ink,
        }}
      >
        {value}
      </div>
    </div>
  );
}
