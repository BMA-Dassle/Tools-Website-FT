"use client";

/**
 * The birthday takeover — the biggest thing either karting board ever does.
 *
 * When a birthday racer checks in, the Blue and Red boards STOP being two
 * screens and become one enormous display: the name runs across both, confetti
 * launched on the left arrives on the right, and the whole thing lands
 * together.
 *
 * HOW TWO SCREENS AGREE WITH NO MESSAGING. Everything is laid out on a single
 * virtual canvas `count × 1920` wide and each board renders its own window of
 * it (`pairedLayout`). Both boards are drawing the identical picture from the
 * identical shared clock and the identical event id — so screen 0 showing
 * "HAPPY BIR" and screen 1 showing "THDAY" is not a synchronisation problem, it
 * is the same drawing seen through two windows. A board that reboots mid-
 * celebration rejoins the frame it should be on.
 *
 * On an unpaired screen it degrades to a single-screen birthday moment, which
 * is what a lobby TV should do with the same event.
 */
import { IconCake, IconConfetti } from "@tabler/icons-react";
import { TV_W, TV_H } from "../constants";
import { withAlpha } from "../color";
import { pairedLayout, type SceneProps } from "../director/types";

const BIRTHDAY_PINK = "#ec4899";
const BIRTHDAY_GOLD = "#f0b341";
const CONFETTI_COUNT = 160;

export function SceneBirthdayTakeover({ decision, config }: SceneProps) {
  const event = decision.event;
  if (!event) return null;

  const layout = pairedLayout(config.pairing, TV_W);
  const spanW = layout?.spanW ?? TV_W;
  const offsetX = layout?.offsetX ?? 0;

  const name = event.firstName?.trim().split(/\s+/)[0] ?? "";

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#12010c" }}>
      {/* THE VIRTUAL CANVAS. Wider than this screen when paired; each board
          slides it so its own window lines up with the physical wall. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: spanW,
          height: TV_H,
          transform: `translate3d(${offsetX}px, 0, 0)`,
        }}
      >
        {/* Warm bloom across the whole span, centred on the join between the
            two boards so the pair reads as one light source. */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(60% 90% at 50% 60%, ${withAlpha(BIRTHDAY_PINK, 0.45)}, transparent 72%)`,
          }}
        />
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(40% 70% at 50% 100%, ${withAlpha(BIRTHDAY_GOLD, 0.35)}, transparent 70%)`,
          }}
        />

        <SpanConfetti spanW={spanW} />

        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 24,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 34 }}>
            <IconCake
              size={110}
              color={BIRTHDAY_GOLD}
              style={{ filter: `drop-shadow(0 0 30px ${BIRTHDAY_GOLD})` }}
            />
            <span
              className="tv-eyebrow"
              style={{ color: BIRTHDAY_GOLD, fontSize: 44, letterSpacing: "0.34em" }}
            >
              Happy Birthday
            </span>
            <IconConfetti
              size={110}
              color={BIRTHDAY_PINK}
              style={{ filter: `drop-shadow(0 0 30px ${BIRTHDAY_PINK})` }}
            />
          </div>

          {/* The name is sized against the FULL span, so on a pair it genuinely
              runs across the gap between the two boards. */}
          <div
            className="tv-display tv-rise"
            style={{
              fontSize: layout ? 380 : 200,
              lineHeight: 0.9,
              color: "#fff",
              textAlign: "center",
              whiteSpace: "nowrap",
              textShadow: `0 0 40px rgba(255,255,255,0.5), 0 0 120px ${BIRTHDAY_PINK}, 0 0 220px ${withAlpha(BIRTHDAY_GOLD, 0.6)}`,
            }}
          >
            {name || "Happy Birthday"}
          </div>

          <div
            className="tv-display"
            style={{
              fontSize: layout ? 76 : 52,
              color: withAlpha("#ffffff", 0.9),
              textAlign: "center",
            }}
          >
            Let&rsquo;s go racing
          </div>
        </div>

        {/* Ribbons top and bottom, drawn across the whole span so the pair is
            framed as one object rather than two bordered screens. */}
        <Ribbon top spanW={spanW} />
        <Ribbon spanW={spanW} />
      </div>
    </div>
  );
}

function Ribbon({ top, spanW }: { top?: boolean; spanW: number }) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        width: spanW,
        [top ? "top" : "bottom"]: 0,
        height: 14,
        background: `linear-gradient(90deg, ${BIRTHDAY_PINK}, ${BIRTHDAY_GOLD}, ${BIRTHDAY_PINK})`,
        boxShadow: `0 0 40px ${withAlpha(BIRTHDAY_PINK, 0.8)}`,
      }}
    />
  );
}

/**
 * Confetti across the whole span.
 *
 * Particles are placed and thrown in VIRTUAL canvas coordinates, so one
 * launched near the join drifts from the left board onto the right one. Every
 * value is derived from the particle index — never Math.random() — so both
 * boards compute byte-identical trajectories and the pair stays coherent.
 */
function SpanConfetti({ spanW }: { spanW: number }) {
  const palette = [BIRTHDAY_PINK, BIRTHDAY_GOLD, "#00e2e5", "#46d68c", "#ffffff", "#4fa9ff"];
  return (
    <div aria-hidden style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {Array.from({ length: CONFETTI_COUNT }, (_, i) => {
        const x = ((i * 61) % 100) / 100; // deterministic 0..1 across the span
        const size = 10 + ((i * 17) % 12);
        const dur = 2400 + ((i * 89) % 1800);
        const rise = 520 + ((i * 71) % 620);
        const drift = (((i * 43) % 200) - 100) * 8;
        return (
          <span
            key={i}
            style={{
              position: "absolute",
              bottom: -30,
              left: x * spanW,
              width: size,
              height: size * 1.5,
              background: palette[i % palette.length],
              borderRadius: 2,
              opacity: 0,
              animation: `tv-confetti ${dur}ms cubic-bezier(0.15,0.55,0.35,1) ${(i % 20) * 60}ms both`,
              ["--dx" as string]: `${drift}px`,
              ["--dy" as string]: `${-rise}px`,
              ["--rot" as string]: `${(i % 2 ? 1 : -1) * (180 + ((i * 31) % 720))}deg`,
            }}
          />
        );
      })}
    </div>
  );
}
