/**
 * The race report, rendered.
 *
 * A SERVER COMPONENT with no state and no socket — the race is over, nothing
 * moves. That is what makes the same markup usable from a page, from `/racer`,
 * from a kiosk, and (later) as the body of an email: it is a pure function of
 * the report.
 *
 * TWO MODES, ONE COMPONENT. Given a `kart` it opens with that driver's own
 * result and their lap-by-lap; without one it is the full board. They share the
 * standings table deliberately — a personal report that disagreed with the board
 * it links to would make a guest trust neither.
 */
import Link from "next/link";
import { formatLapTime } from "~/features/racing/driver-view/laps";
import type { RaceReport, ReportDriver } from "~/features/racing/driver-view/report";
import { t, type CopyKey, type Locale } from "~/features/racing/driver-view/copy";
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
        maxWidth: 960,
        margin: "0 auto",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 5, height: 30, background: accent }} />
        <div>
          <h1
            style={{
              fontFamily: font.display,
              fontSize: "clamp(22px, 5vw, 34px)",
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
          {report.sessionName ? (
            <div style={{ ...label, fontSize: 10, color: c.inkDim, marginTop: 5 }}>
              {report.sessionName}
            </div>
          ) : null}
        </div>
      </header>

      {driver ? <PersonalPanel driver={driver} report={report} locale={locale} /> : null}

      <section style={{ marginTop: 28 }}>
        <h2 style={{ ...label, fontSize: 11, color: c.inkDim, margin: "0 0 10px" }}>
          {t(locale, "labelPosition")}
        </h2>
        <div style={{ border: `1px solid ${c.hairline}`, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 420 }}>
            <thead>
              <tr>
                {[
                  "",
                  t(locale, "labelKart"),
                  "",
                  t(locale, "labelBest"),
                  t(locale, "labelLaps"),
                ].map((h, i) => (
                  <th
                    key={i}
                    style={{
                      ...label,
                      fontSize: 9,
                      color: c.inkDim,
                      textAlign: i >= 3 ? "right" : "left",
                      padding: "9px 12px",
                      borderBottom: `1px solid ${c.hairline}`,
                      fontWeight: 500,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.drivers.map((d) => {
                const mine = driver?.kart === d.kart;
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
                        fontSize: 15,
                        fontWeight: 800,
                        padding: "8px 12px",
                        color: MEDAL[d.position] ?? c.inkDim,
                        width: 44,
                      }}
                    >
                      {d.position > 0 ? d.position : "—"}
                    </td>
                    <td
                      style={{
                        ...numeral,
                        fontSize: 14,
                        padding: "8px 12px",
                        color: c.inkDim,
                        width: 56,
                      }}
                    >
                      {d.kart}
                    </td>
                    <td
                      style={{ fontSize: 14.5, padding: "8px 12px", fontWeight: mine ? 700 : 400 }}
                    >
                      {d.name}
                      {d.disqualified ? (
                        <span style={{ ...label, fontSize: 9, color: c.red, marginLeft: 8 }}>
                          {t(locale, "dsqTitle")}
                        </span>
                      ) : null}
                    </td>
                    <td
                      style={{
                        ...numeral,
                        fontSize: 15,
                        fontWeight: 700,
                        padding: "8px 12px",
                        textAlign: "right",
                        color: report.fastestLap?.kart === d.kart ? c.violet : c.ink,
                      }}
                    >
                      {formatLapTime(d.summary.best?.lapTimeMs ?? null)}
                    </td>
                    <td
                      style={{
                        ...numeral,
                        fontSize: 14,
                        padding: "8px 12px",
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

      {report.timeline.length > 0 ? (
        <section style={{ marginTop: 28 }}>
          <h2 style={{ ...label, fontSize: 11, color: c.inkDim, margin: "0 0 10px" }}>{heat}</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {report.timeline.map((e) => {
              const key = EVENT_LABEL[e.kind];
              if (!key) return null;
              return (
                <li
                  key={e.eventId}
                  style={{
                    display: "flex",
                    gap: 12,
                    padding: "7px 0",
                    borderBottom: `1px solid ${c.hairline}`,
                    fontSize: 13.5,
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
                  <span style={{ color: c.inkDim, width: 54, flexShrink: 0 }}>
                    {e.kart ? `${t(locale, "labelKart")} ${e.kart}` : ""}
                  </span>
                  <span style={{ flexGrow: 1 }}>
                    {t(locale, key)}
                    {e.note ? ` — “${e.note}”` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {!driver ? null : (
        <p style={{ marginTop: 28, fontSize: 13, color: c.inkFaint }}>
          <Link href={`/race/${report.sessionId}`} style={{ color: c.cyan }}>
            {t(locale, "labelPosition")}
          </Link>
        </p>
      )}
    </main>
  );
}

/** The driver's own result, above the board. */
function PersonalPanel({
  driver,
  report,
  locale,
}: {
  driver: ReportDriver;
  report: RaceReport;
  locale: Locale;
}) {
  const best = driver.summary.best?.lapTimeMs ?? null;
  return (
    <section style={{ marginTop: 22 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
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
          labelKey="labelAverage"
          value={formatLapTime(driver.summary.averageMs)}
        />
      </div>

      <div style={{ marginTop: 18, border: `1px solid ${c.hairline}` }}>
        <div
          style={{
            ...label,
            fontSize: 9,
            color: c.inkDim,
            padding: "9px 12px",
            borderBottom: `1px solid ${c.hairline}`,
          }}
        >
          {t(locale, "labelLaps")} · {t(locale, "labelKart")} {driver.kart}
        </div>
        {driver.laps.map((l) => (
          <div
            key={l.passingId}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              padding: "6px 12px",
              borderBottom: `1px solid rgba(245,236,238,0.06)`,
              background:
                l.lapTimeMs !== null && l.lapTimeMs === best ? "rgba(134,82,255,0.13)" : undefined,
            }}
          >
            <span style={{ ...numeral, fontSize: 12, width: 22, color: c.inkDim }}>
              {l.lapNumber}
            </span>
            <span
              style={{
                ...numeral,
                fontSize: 16,
                fontWeight: l.lapTimeMs === best ? 800 : 600,
                flexGrow: 1,
                color: l.lapTimeMs === null ? c.inkFaint : c.ink,
              }}
            >
              {l.lapTimeMs === null ? t(locale, "labelNoTime") : formatLapTime(l.lapTimeMs)}
            </span>
            <span style={{ ...numeral, fontSize: 12, color: c.inkDim }}>
              {l.lapTimeMs === null
                ? t(locale, "labelRollout")
                : best !== null && l.lapTimeMs > best
                  ? `+${((l.lapTimeMs - best) / 1000).toFixed(3)}`
                  : t(locale, "labelBest")}
            </span>
          </div>
        ))}
      </div>

      {report.fastestLap &&
      report.fastestLap.kart !== driver.kart &&
      driver.gapToFastestMs !== null ? (
        <p style={{ marginTop: 12, fontSize: 13.5, color: c.inkDim }}>
          {report.fastestLap.name} · {formatLapTime(report.fastestLap.ms)} (+
          {(driver.gapToFastestMs / 1000).toFixed(3)})
        </p>
      ) : null}
    </section>
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
    <div style={{ background: c.panel, padding: "12px 14px" }}>
      <div style={{ ...label, fontSize: 9, color: c.inkDim }}>{t(locale, labelKey)}</div>
      <div
        style={{ ...numeral, fontSize: 30, fontWeight: 900, lineHeight: 1.1, color: tint ?? c.ink }}
      >
        {value}
      </div>
    </div>
  );
}
