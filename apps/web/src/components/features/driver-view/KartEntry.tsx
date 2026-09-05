"use client";

/**
 * The only way in: a kart number.
 *
 * NO SCAN, NO PASS, NO SIGN-IN (owner 2026-09-05). Every event on the venue wire
 * carries `RentalObjectName`, so the number on the nose cone is a complete key —
 * which also means this works for a walk-up with no account, and for a spectator
 * in the stands following a driver they can see.
 *
 * Keys are 44px minimum and the number is enormous, because this is tapped by
 * someone in a helmet, standing up, in a hurry.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { t, type Locale } from "~/features/racing/driver-view/copy";
import { AddToHomeScreen } from "./AddToHomeScreen";
import { PoweredByBmi, TrackerLogo } from "./TrackerBrand";
import { c, fluid, font, label, numeral } from "./tokens";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"] as const;

export function KartEntry({ locale }: { locale: Locale }) {
  const router = useRouter();
  const [value, setValue] = useState("");

  const press = (k: string) => {
    if (k === "del") return setValue((v) => v.slice(0, -1));
    if (k === "") return;
    // Three digits is every kart the venue has and then some.
    setValue((v) => (v.length >= 3 ? v : v + k));
  };

  const go = () => {
    const n = value.replace(/^0+/, "");
    if (n) router.push(`/kart/${n}`);
  };

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: c.ground,
        color: c.ink,
        fontFamily: font.body,
        display: "flex",
        flexWrap: "wrap",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          flex: "1 1 320px",
          padding: fluid(16, 3, 32),
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        {/* The tracker is chrome-free and, once installed, the only FastTrax
            surface a guest is looking at — so the mark lives on the screen. */}
        <div style={{ marginBottom: fluid(10, 1.8, 18) }}>
          <TrackerLogo />
        </div>

        <h1
          style={{
            fontFamily: font.display,
            fontSize: fluid(22, 4.5, 36),
            fontWeight: 900,
            fontStyle: "italic",
            textTransform: "uppercase",
            letterSpacing: "-0.025em",
            lineHeight: 1,
            margin: 0,
          }}
        >
          {t(locale, "entryTitle")}
        </h1>
        <p style={{ fontSize: fluid(12, 2.2, 17), color: "rgba(245,236,238,0.60)", marginTop: 7 }}>
          {t(locale, "entryHint")}
        </p>

        <div
          style={{
            flexGrow: 1,
            marginTop: 16,
            background: c.panel,
            border: `1px solid ${value ? "rgba(0,226,229,0.50)" : c.hairline}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: fluid(90, 20, 190),
          }}
          aria-live="polite"
        >
          <span
            style={{
              ...numeral,
              fontSize: fluid(64, 18, 140),
              fontWeight: 900,
              fontStyle: "italic",
              letterSpacing: "-0.05em",
              lineHeight: 1,
              color: value ? c.ink : c.inkFaint,
            }}
          >
            {value || "–"}
          </span>
        </div>

        <button
          type="button"
          onClick={go}
          disabled={!value}
          style={{
            height: 60,
            flexShrink: 0,
            marginTop: 14,
            background: value ? c.cyan : c.panel,
            color: value ? c.ground : c.inkFaint,
            border: "none",
            cursor: value ? "pointer" : "default",
            ...label,
            fontSize: fluid(12, 2, 17),
            fontWeight: 700,
          }}
        >
          {t(locale, "entryStart")}
        </button>

        {/* Offered here and nowhere else: this is the only screen a guest is
            standing still on. On the pit board it would be an interruption. */}
        <div style={{ marginTop: 12, flexShrink: 0 }}>
          <AddToHomeScreen locale={locale} />
        </div>

        <div style={{ marginTop: fluid(10, 1.6, 16), flexShrink: 0 }}>
          <PoweredByBmi align="left" />
        </div>
      </div>

      <div
        style={{
          flex: "1 1 300px",
          padding: fluid(16, 3, 32),
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gridTemplateRows: "repeat(4, minmax(56px, 1fr))",
          gap: 9,
          minWidth: 0,
        }}
      >
        {KEYS.map((k, i) => (
          <button
            key={`${k}-${i}`}
            type="button"
            onClick={() => press(k)}
            disabled={k === ""}
            aria-label={k === "del" ? t(locale, "entryClear") : k || undefined}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 44,
              background: k === "" ? "transparent" : c.panel,
              border: k === "" ? "1px solid transparent" : `1px solid rgba(245,236,238,0.12)`,
              color: k === "del" ? c.inkDim : c.ink,
              fontFamily: font.display,
              fontSize: fluid(20, 3.4, 32),
              fontWeight: 700,
              cursor: k === "" ? "default" : "pointer",
            }}
          >
            {k === "del" ? (
              <svg
                width="26"
                height="26"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 5H8l-6 7 6 7h13a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z" />
                <line x1="17" y1="9" x2="12" y2="14" />
                <line x1="12" y1="9" x2="17" y2="14" />
              </svg>
            ) : (
              k
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
