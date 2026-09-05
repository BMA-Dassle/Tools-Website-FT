"use client";

/**
 * The alert rail — a section of the pit board, not a popup over it.
 *
 * IT USED TO FLOAT. Cards were `position: fixed` along the bottom, which meant
 * a personal best sat squarely on top of the kart number, the gap and the lap
 * count (owner 2026-09-05, with a screenshot of exactly that). Covering data a
 * driver is trying to read, in order to tell them something they are pleased
 * about, is the wrong trade every time.
 *
 * SO IT HAS ITS OWN BAND, always present and always the same height. Reserved
 * rather than conditional on purpose: a rail that appears and disappears would
 * resize the two big numbers every time a lap lands, and a pit board whose
 * layout moves is worse than one with a quiet empty strip in it.
 *
 * ONE LINE, ONE ALERT. A driver reads one thing at a glance, so this shows the
 * newest and lets the rest expire behind it — `visibleInline` has already
 * ordered and de-duplicated them. Two lines of body copy belong on the report,
 * not on a screen someone is glancing at between corners.
 */
import type { DriverAlert } from "~/features/racing/driver-view/types";
import { t, type Locale, type CopyKey } from "~/features/racing/driver-view/copy";
import { formatLapTime } from "~/features/racing/driver-view/laps";
import { c, fluid, font, label } from "./tokens";

const LOOK: Partial<Record<DriverAlert["kind"], { accent: string; title: CopyKey }>> = {
  personalBest: { accent: c.violet, title: "personalBestTitle" },
  dayRecord: { accent: c.amber, title: "dayRecordTitle" },
  monthRecord: { accent: c.amber, title: "monthRecordTitle" },
  everRecord: { accent: c.magenta, title: "everRecordTitle" },
  recovered: { accent: c.green, title: "recoveredTitle" },
  restricted: { accent: c.amber, title: "restrictedTitle" },
  slowZone: { accent: c.inkDim, title: "slowZoneTitle" },
  kartReassigned: { accent: c.inkDim, title: "reassignedTitle" },
  didNotStart: { accent: c.red, title: "dnsTitle" },
  aboutToStart: { accent: c.cyan, title: "aboutToStartTitle" },
  finished: { accent: c.inkDim, title: "finishedTitle" },
  positionUp: { accent: c.cyan, title: "positionUpTitle" },
};

/** The band's height, held whether or not anything is in it. */
const RAIL_HEIGHT = fluid(26, 4.4, 42);

export function InlineAlerts({ alerts, locale }: { alerts: DriverAlert[]; locale: Locale }) {
  const newest = alerts.find((a) => LOOK[a.kind] !== undefined) ?? null;
  const look = newest ? LOOK[newest.kind] : undefined;

  // A lap time is stored as raw ms so the wording never drifts; format it here.
  const value =
    newest && newest.kind === "personalBest" ? formatLapTime(Number(newest.value)) : newest?.value;

  return (
    <div
      aria-live="polite"
      style={{
        flexShrink: 0,
        height: RAIL_HEIGHT,
        display: "flex",
        alignItems: "center",
        gap: fluid(7, 1.2, 12),
        padding: `0 ${fluid(10, 2.5, 24)}`,
        background: look ? `${look.accent}1f` : c.navy,
        borderTop: `1px solid ${c.hairline}`,
        borderLeft: look ? `3px solid ${look.accent}` : "3px solid transparent",
        overflow: "hidden",
        fontFamily: font.body,
        // Only the CONTENT fades in. Animating the band itself would move the
        // numbers above it, which is the thing this rewrite exists to stop.
        transition: "background 240ms ease-out, border-color 240ms ease-out",
      }}
    >
      {look && newest ? (
        <>
          <span
            style={{
              ...label,
              fontSize: fluid(8, 1.3, 12),
              fontWeight: 700,
              color: look.accent,
              whiteSpace: "nowrap",
            }}
          >
            {t(locale, look.title)}
          </span>
          {value ? (
            <span
              style={{
                fontFamily: font.display,
                fontVariantNumeric: "tabular-nums",
                fontSize: fluid(13, 2.4, 22),
                fontWeight: 800,
                color: c.ink,
                lineHeight: 1,
              }}
            >
              {value}
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
