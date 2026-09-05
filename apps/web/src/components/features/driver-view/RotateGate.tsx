"use client";

/**
 * Ask for landscape, and only while a phone is the case.
 *
 * The endpoint is a screen bolted to the kart, permanently landscape, and this
 * gate will be dead code the day those arrive (owner 2026-09-05: phones are
 * temporary). Until then a driver holding a phone upright gets a pit board with
 * no room for either number, so it is worth one screen to ask.
 *
 * ORIENTATION, NOT WIDTH. A narrow landscape phone is fine and a wide portrait
 * tablet is not, so the test is the aspect ratio of the viewport rather than a
 * breakpoint. Rendered client-side after mount: there is no orientation on the
 * server, and guessing produces a flash of the wrong screen.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { t, type Locale } from "~/features/racing/driver-view/copy";
import { PoweredByBmi, TrackerLogo } from "./TrackerBrand";
import { c, fluid, font, label, numeral } from "./tokens";

const PORTRAIT_QUERY = "(orientation: portrait)";

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia(PORTRAIT_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

const getSnapshot = () => window.matchMedia(PORTRAIT_QUERY).matches;

/**
 * The server has no orientation, so it assumes landscape and renders the board.
 * Getting that wrong for one frame on a portrait phone is the cheap direction:
 * a flash of the rotate prompt on a landscape device would be the expensive one.
 */
const getServerSnapshot = () => false;

export function RotateGate({
  locale,
  kart,
  heatName,
  children,
}: {
  locale: Locale;
  kart: string;
  heatName: string;
  children: ReactNode;
}) {
  const portrait = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (!portrait) return <>{children}</>;

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: c.ground,
        color: c.ink,
        fontFamily: font.body,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: fluid(20, 5, 40),
        padding: "40px 32px",
        textAlign: "center",
      }}
    >
      <TrackerLogo />

      <svg
        width="112"
        height="112"
        viewBox="0 0 100 100"
        fill="none"
        style={{ animation: "dv-tip 2.8s ease-in-out infinite", transformOrigin: "50% 50%" }}
        aria-hidden
      >
        <rect x="31" y="10" width="38" height="80" rx="6" stroke={c.cyan} strokeWidth="3.5" />
        <line
          x1="43"
          y1="18"
          x2="57"
          y2="18"
          stroke={c.cyan}
          strokeWidth="3"
          strokeLinecap="round"
          opacity="0.6"
        />
      </svg>

      <div>
        <div
          style={{
            ...numeral,
            fontSize: fluid(28, 9, 50),
            fontWeight: 900,
            fontStyle: "italic",
            lineHeight: 0.92,
            letterSpacing: "-0.035em",
            textTransform: "uppercase",
          }}
        >
          {t(locale, "rotateTitle")}
        </div>
        <div
          style={{
            fontFamily: font.display,
            fontSize: fluid(14, 4, 22),
            fontWeight: 600,
            lineHeight: 1.3,
            marginTop: 14,
            color: c.inkDim,
            textWrap: "pretty",
          }}
        >
          {t(locale, "rotateBody")}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 16px",
          border: `1px solid ${c.hairline}`,
          background: c.panel,
        }}
      >
        <div style={{ width: 4, height: 30, background: c.blueFlag, flexShrink: 0 }} />
        <div style={{ textAlign: "left" }}>
          <div style={{ ...numeral, fontSize: 17, fontWeight: 800 }}>
            {t(locale, "labelKart")} {kart}
            {heatName ? ` · ${heatName}` : ""}
          </div>
          <div style={{ ...label, fontSize: 9, color: c.inkDim, marginTop: 2 }}>
            {t(locale, "rotateStill")}
          </div>
        </div>
      </div>

      <PoweredByBmi />

      <style>{`
        @keyframes dv-tip {
          0%, 55% { transform: rotate(0deg); }
          75%, 92% { transform: rotate(-90deg); }
          100% { transform: rotate(0deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          svg { animation: none !important; }
        }
      `}</style>
    </div>
  );
}
