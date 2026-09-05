"use client";

/**
 * A flag, full screen.
 *
 * ONE COMPONENT FOR EVERY FLAG, driven by a table, because the thing that must
 * never vary between them is the shape: the same glyph in the same place, the
 * same kicker/hero/body rhythm, the same context bar. A driver has a fraction of
 * a second and recognises the colour and the position of the words before they
 * read either.
 *
 * RED AND CAUTION FLASH, AT DIFFERENT SPEEDS. Red alternates hard at 1.1s;
 * caution pulses softly at 1.9s. Two alarms that pulse alike are one alarm, and
 * the driver has to be able to tell "stop" from "slow down" without reading.
 * Everything else is steady — a flashing courtesy flag is noise.
 *
 * RED ASKS FOR NOTHING. The karts are cut by the system before this renders, so
 * the copy says stay put and nothing else. Never give an instruction the driver
 * cannot act on.
 */
import type { CSSProperties } from "react";
import type { DriverAlert } from "~/features/racing/driver-view/types";
import { t, type Locale } from "~/features/racing/driver-view/copy";
import { c, fluid, font, label, numeral } from "./tokens";

/** A waving flag on a pole, in the fill given. */
function FlagGlyph({ fill, size }: { fill: string; size: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" style={{ flexShrink: 0 }}>
      <path d="M22 8 V94" stroke={fill} strokeWidth="6" strokeLinecap="round" opacity="0.85" />
      <path d="M25 14 C41 5, 57 25, 76 15 L76 55 C57 65, 41 45, 25 54 Z" fill={fill} />
    </svg>
  );
}

interface FlagLook {
  field: string;
  ink: string;
  glyph: string;
  /** `flash` = hard alternation (red). `pulse` = soft (caution). */
  motion?: "flash" | "pulse";
  kickerKey?: Parameters<typeof t>[1];
  titleKey: Parameters<typeof t>[1];
  bodyKey: Parameters<typeof t>[1];
}

const LOOKS: Partial<Record<DriverAlert["kind"], FlagLook>> = {
  green: {
    field: c.green,
    ink: c.ground,
    glyph: c.ground,
    titleKey: "greenTitle",
    bodyKey: "greenBody",
  },
  blue: {
    field: c.blueFlag,
    ink: "#ffffff",
    glyph: "#ffffff",
    titleKey: "blueTitle",
    bodyKey: "blueBody",
  },
  caution: {
    field: c.amber,
    ink: c.ground,
    glyph: c.ground,
    motion: "pulse",
    kickerKey: "cautionKicker",
    titleKey: "cautionTitle",
    bodyKey: "cautionBody",
  },
  red: {
    field: c.red,
    ink: "#ffffff",
    glyph: "#ffffff",
    motion: "flash",
    kickerKey: "redKicker",
    titleKey: "redTitle",
    bodyKey: "redBody",
  },
  blackwhite: {
    field: c.ink,
    ink: c.ground,
    glyph: c.ground,
    kickerKey: "blackwhiteKicker",
    titleKey: "blackwhiteTitle",
    bodyKey: "blackwhiteBody",
  },
  disqualified: {
    field: c.ground,
    ink: c.red,
    glyph: c.red,
    kickerKey: "dsqKicker",
    titleKey: "dsqTitle",
    bodyKey: "dsqBody",
  },
  paused: {
    field: c.panel,
    ink: c.ink,
    glyph: c.amber,
    titleKey: "pausedTitle",
    bodyKey: "pausedBody",
  },
  chequered: {
    field: c.ground,
    ink: c.ink,
    glyph: c.ink,
    kickerKey: "chequeredKicker",
    titleKey: "chequeredTitle",
    bodyKey: "chequeredBody",
  },
};

export function FlagTakeover({
  alert,
  locale,
  kart,
  heatName,
  onOpenResults,
}: {
  alert: DriverAlert;
  locale: Locale;
  kart: string;
  heatName: string;
  /** Offered only on the chequered flag — the results exist by then. */
  onOpenResults?: () => void;
}) {
  // The crash screen is the one with something to do, so it has its own layout.
  if (alert.kind === "crash") return <CrashTakeover locale={locale} kart={kart} />;

  const look = LOOKS[alert.kind];
  if (!look) return null;

  const motion: CSSProperties =
    look.motion === "flash"
      ? { animation: "dv-redflash 1.1s steps(1, end) infinite" }
      : look.motion === "pulse"
        ? { animation: "dv-amberpulse 1.9s ease-in-out infinite" }
        : {};

  const kicker = look.kickerKey ? t(locale, look.kickerKey, { kart: alert.value ?? "" }) : heatName;

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: look.field,
        color: look.ink,
        fontFamily: font.body,
        display: "flex",
        flexDirection: "column",
        ...motion,
      }}
    >
      <div
        style={{
          flexGrow: 1,
          display: "flex",
          alignItems: "center",
          gap: fluid(18, 4, 40),
          padding: `0 ${fluid(20, 5, 56)}`,
          minHeight: 0,
        }}
      >
        <FlagGlyph fill={look.glyph} size={fluid(88, 20, 190)} />
        <div style={{ minWidth: 0 }}>
          <div style={{ ...label, fontSize: fluid(10, 1.5, 14), fontWeight: 700, opacity: 0.78 }}>
            {kicker}
          </div>
          <div
            style={{
              ...numeral,
              fontSize: fluid(40, 10, 96),
              fontWeight: 900,
              fontStyle: "italic",
              lineHeight: 0.88,
              letterSpacing: "-0.04em",
              textTransform: "uppercase",
              marginTop: 4,
            }}
          >
            {t(locale, look.titleKey)}
          </div>
          <div
            style={{
              fontFamily: font.display,
              fontSize: fluid(15, 3, 28),
              fontWeight: 700,
              lineHeight: 1.15,
              marginTop: 10,
              textWrap: "pretty",
            }}
          >
            {t(locale, look.bodyKey)}
          </div>
          {alert.note ? (
            <div
              style={{
                display: "inline-block",
                marginTop: 12,
                padding: "7px 12px",
                background: look.ink,
                color: look.field,
                fontSize: fluid(12, 1.8, 16),
                fontWeight: 600,
              }}
            >
              {t(locale, "marshalNote")}: “{alert.note}”
            </div>
          ) : null}
        </div>
      </div>

      <div
        style={{
          flexShrink: 0,
          background: "rgba(0,0,0,0.28)",
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: `${fluid(8, 1.4, 16)} ${fluid(20, 5, 56)}`,
        }}
      >
        <span
          style={{ ...numeral, fontSize: fluid(14, 2.4, 22), fontWeight: 800, fontStyle: "italic" }}
        >
          {t(locale, "labelKart")} {kart}
        </span>
        <span style={{ ...label, fontSize: fluid(9, 1.3, 12), opacity: 0.7 }}>{heatName}</span>
        <div style={{ flexGrow: 1 }} />
        {alert.kind === "chequered" && onOpenResults ? (
          <button
            type="button"
            onClick={onOpenResults}
            style={{
              ...label,
              fontSize: fluid(10, 1.4, 13),
              fontWeight: 700,
              color: look.field,
              background: look.ink,
              border: "none",
              padding: "10px 16px",
              minHeight: 44,
              cursor: "pointer",
            }}
          >
            {t(locale, "labelLaps")}
          </button>
        ) : null}
      </div>

      <style>{`
        @keyframes dv-redflash {
          0%, 44% { background-color: ${c.red}; }
          50%, 94% { background-color: ${c.redDeep}; }
          100% { background-color: ${c.red}; }
        }
        @keyframes dv-amberpulse {
          0%, 100% { background-color: ${c.amber}; }
          50% { background-color: ${c.amberDeep}; }
        }
        @media (prefers-reduced-motion: reduce) {
          [role="alert"] { animation: none !important; }
        }
      `}</style>
    </div>
  );
}

/**
 * Crash detect — the only flag with a procedure on it.
 *
 * Leads with the kart having been slowed FOR them, because that is the thing
 * that stops a driver panicking, and only then gives the reverse controls. The
 * warning to look behind is on a full-width bar of its own: it matters more than
 * the instruction it follows.
 */
function CrashTakeover({ locale, kart }: { locale: Locale; kart: string }) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: c.panel,
        color: c.ink,
        fontFamily: font.body,
        display: "flex",
        flexDirection: "column",
        borderTop: `8px solid ${c.amber}`,
      }}
    >
      <div
        style={{
          flexGrow: 1,
          display: "flex",
          alignItems: "center",
          gap: fluid(14, 3, 30),
          padding: `0 ${fluid(16, 4, 40)}`,
          minHeight: 0,
        }}
      >
        <div style={{ flex: "1 1 44%", minWidth: 0 }}>
          <div
            style={{
              ...numeral,
              fontSize: fluid(30, 7.5, 66),
              fontWeight: 900,
              fontStyle: "italic",
              lineHeight: 0.88,
              letterSpacing: "-0.04em",
              textTransform: "uppercase",
            }}
          >
            {t(locale, "crashTitle")}
          </div>
          <div
            style={{
              fontFamily: font.display,
              fontSize: fluid(13, 2.4, 21),
              fontWeight: 700,
              lineHeight: 1.25,
              marginTop: 12,
              color: c.amber,
              textWrap: "pretty",
            }}
          >
            {t(locale, "crashKicker")}
          </div>
        </div>

        <div style={{ flex: "1 1 56%", minWidth: 0 }}>
          <div
            style={{
              fontFamily: font.display,
              fontSize: fluid(12, 2, 18),
              fontWeight: 700,
              color: "rgba(245,236,238,0.88)",
              marginBottom: 10,
              textWrap: "pretty",
            }}
          >
            {t(locale, "crashInstruction")}
          </div>
          <div style={{ display: "flex", alignItems: "stretch", gap: 12 }}>
            <ControlChip
              accent={c.amber}
              lead={t(locale, "crashHold")}
              name={t(locale, "crashYellow")}
              shape="button"
            />
            <div
              style={{
                ...numeral,
                fontSize: fluid(18, 3, 32),
                fontWeight: 800,
                color: c.inkDim,
                alignSelf: "center",
              }}
            >
              +
            </div>
            <ControlChip
              accent={c.green}
              lead={t(locale, "crashThen")}
              name={t(locale, "crashGreen")}
              shape="pedal"
            />
          </div>
        </div>
      </div>

      <div
        style={{
          flexShrink: 0,
          background: c.amber,
          color: c.ground,
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: `${fluid(8, 1.4, 16)} ${fluid(16, 4, 40)}`,
        }}
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke={c.ground}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0 }}
        >
          <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span style={{ fontFamily: font.display, fontSize: fluid(12, 2, 20), fontWeight: 800 }}>
          {t(locale, "crashWarning")}
        </span>
        <div style={{ flexGrow: 1 }} />
        <span
          style={{ ...numeral, fontSize: fluid(11, 1.8, 18), fontWeight: 800, fontStyle: "italic" }}
        >
          {t(locale, "labelKart")} {kart}
        </span>
      </div>
    </div>
  );
}

function ControlChip({
  accent,
  lead,
  name,
  shape,
}: {
  accent: string;
  lead: string;
  name: string;
  shape: "button" | "pedal";
}) {
  return (
    <div
      style={{
        flexGrow: 1,
        background: c.navy,
        border: `1px solid ${accent}80`,
        padding: `${fluid(8, 1.4, 16)} 10px`,
        textAlign: "center",
      }}
    >
      <svg width="44" height="44" viewBox="0 0 48 48" fill="none" style={{ marginBottom: 5 }}>
        {shape === "button" ? (
          <>
            <circle cx="24" cy="24" r="15" fill={accent} />
            <circle cx="24" cy="24" r="20" stroke={accent} strokeWidth="2" opacity="0.32" />
          </>
        ) : (
          <>
            <rect x="16" y="8" width="16" height="27" rx="4" fill={accent} />
            <path
              d="M13 39 h22"
              stroke={accent}
              strokeWidth="2.6"
              strokeLinecap="round"
              opacity="0.45"
            />
          </>
        )}
      </svg>
      <div style={{ ...label, fontSize: fluid(8, 1.2, 11), fontWeight: 700, color: accent }}>
        {lead}
      </div>
      <div
        style={{
          fontFamily: font.display,
          fontSize: fluid(12, 2, 18),
          fontWeight: 800,
          lineHeight: 1.1,
          marginTop: 2,
        }}
      >
        {name}
      </div>
    </div>
  );
}
