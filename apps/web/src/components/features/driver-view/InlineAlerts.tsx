"use client";

/**
 * The second tier — everything that must not steal the screen mid-corner.
 *
 * Sits over the bottom of the pit board, never over the position or the clock,
 * and clears itself. `visibleInline` has already dropped the stale ones and
 * collapsed duplicates, so this only has to render.
 */
import type { DriverAlert } from "~/features/racing/driver-view/types";
import { t, type Locale, type CopyKey } from "~/features/racing/driver-view/copy";
import { formatLapTime } from "~/features/racing/driver-view/laps";
import { c, fluid, font } from "./tokens";

const LOOK: Partial<
  Record<DriverAlert["kind"], { accent: string; title: CopyKey; body: CopyKey }>
> = {
  personalBest: { accent: c.violet, title: "personalBestTitle", body: "personalBestBody" },
  dayRecord: { accent: c.amber, title: "dayRecordTitle", body: "dayRecordBody" },
  monthRecord: { accent: c.amber, title: "monthRecordTitle", body: "monthRecordBody" },
  everRecord: { accent: c.magenta, title: "everRecordTitle", body: "everRecordBody" },
  recovered: { accent: c.green, title: "recoveredTitle", body: "recoveredBody" },
  restricted: { accent: c.amber, title: "restrictedTitle", body: "restrictedBody" },
  slowZone: { accent: c.inkDim, title: "slowZoneTitle", body: "slowZoneBody" },
  kartReassigned: { accent: c.inkDim, title: "reassignedTitle", body: "reassignedBody" },
  didNotStart: { accent: c.red, title: "dnsTitle", body: "dnsBody" },
  aboutToStart: { accent: c.cyan, title: "aboutToStartTitle", body: "aboutToStartBody" },
  finished: { accent: c.inkDim, title: "finishedTitle", body: "finishedBody" },
  positionUp: { accent: c.cyan, title: "positionUpTitle", body: "positionUpTitle" },
};

export function InlineAlerts({ alerts, locale }: { alerts: DriverAlert[]; locale: Locale }) {
  if (alerts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      style={{
        position: "fixed",
        left: fluid(8, 2, 20),
        right: fluid(8, 2, 20),
        bottom: fluid(8, 2, 20),
        zIndex: 40,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "none",
      }}
    >
      {alerts.map((a) => {
        const look = LOOK[a.kind];
        if (!look) return null;
        // A record alert carries the time it was set at; a lap-time value is
        // stored as raw ms and formatted here so the wording never drifts.
        const value =
          a.kind === "personalBest" ? formatLapTime(Number(a.value)) : (a.value ?? null);
        return (
          <div
            key={a.eventId}
            style={{
              background: c.panel,
              border: `1px solid ${c.hairline}`,
              borderLeft: `3px solid ${look.accent}`,
              padding: `${fluid(7, 1.2, 13)} ${fluid(10, 1.8, 16)}`,
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              fontFamily: font.body,
            }}
          >
            <div style={{ minWidth: 0, flexGrow: 1 }}>
              <div
                style={{
                  fontFamily: font.display,
                  fontSize: fluid(12, 2, 17),
                  fontWeight: 800,
                  color: look.accent,
                  lineHeight: 1.15,
                }}
              >
                {t(locale, look.title)}
                {value ? ` — ${value}` : ""}
              </div>
              <div
                style={{
                  fontSize: fluid(10, 1.6, 14),
                  lineHeight: 1.3,
                  color: "rgba(245,236,238,0.72)",
                  marginTop: 2,
                  textWrap: "pretty",
                }}
              >
                {t(locale, look.body)}
              </div>
            </div>
          </div>
        );
      })}
      <style>{`@media (prefers-reduced-motion: no-preference) {
        [aria-live="polite"] > div { animation: dv-slide 240ms ease-out; }
        @keyframes dv-slide { from { transform: translateY(8px); opacity: 0; } }
      }`}</style>
    </div>
  );
}
