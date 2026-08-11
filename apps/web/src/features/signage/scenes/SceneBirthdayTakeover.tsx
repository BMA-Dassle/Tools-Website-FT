"use client";

/**
 * The birthday takeover — the biggest thing the karting boards ever do.
 *
 * ⚠ THE BOARDS ARE ~4 FEET APART (owner 2026-08-11). They are NOT a bezel-to-
 * bezel video wall, so NOTHING READABLE MAY CROSS THE GAP. A name split across
 * four feet of wall is not a wide name, it is two broken halves. Every board
 * therefore renders the COMPLETE message at full size, and the pairing is
 * expressed in TIME rather than geometry:
 *
 *   - a light pulse hands off board→board on the shared clock, so the two read
 *     as talking to each other across the gap;
 *   - confetti erupts from each board's INNER edge, throwing toward the space
 *     between them, so the gap becomes part of the show instead of a seam;
 *   - the finale lands on both boards at the same instant.
 *
 * All of it is derived from the shared clock and the screen's own `position`,
 * so the boards choreograph with zero messaging between them and a board that
 * reboots mid-celebration rejoins on the correct beat.
 *
 * Unpaired screens simply run the same thing without the hand-off.
 *
 * NO FRAME. An earlier version drew gradient bars along the top and bottom;
 * with the relay edge down one side they read as a box around the name and
 * looked stuck on (owner 2026-08-11). The name now sits on the glow alone, and
 * the only edge is the soft one that carries the hand-off.
 */
import { IconCake, IconConfetti } from "@tabler/icons-react";
import { TV_W } from "../constants";
import { withAlpha } from "../color";
import type { SceneProps } from "../director/types";

const BIRTHDAY_PINK = "#ec4899";
const BIRTHDAY_GOLD = "#f0b341";
const CONFETTI_COUNT = 90;

/** One hand-off lap. Each board holds the spotlight for half of it. */
const RELAY_MS = 2_400;

export function SceneBirthdayTakeover({ decision, config, nowMs }: SceneProps) {
  const event = decision.event;
  if (!event) return null;

  const pairing = config.pairing;
  const count = pairing && pairing.count >= 2 ? pairing.count : 1;
  const position = pairing ? Math.min(Math.max(0, pairing.position), count - 1) : 0;

  // Whose turn it is to be lit. Clock-derived, so both boards agree without
  // talking — the pulse appears to travel across the four feet between them.
  const turn = Math.floor(((nowMs - decision.startedAtMs) / RELAY_MS) * count) % count;
  const lit = count === 1 || turn === position;

  // Confetti throws toward the gap: the rightmost board throws left, the
  // leftmost throws right, so the space between them fills.
  const throwDir = count === 1 ? 0 : position === 0 ? 1 : -1;

  const name = event.firstName?.trim().split(/\s+/)[0] ?? "";

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#12010c" }}>
      {/* Warm ground, brightening on this board's beat. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(70% 90% at 50% 65%, ${withAlpha(BIRTHDAY_PINK, 0.5)}, transparent 74%)`,
          opacity: lit ? 1 : 0.45,
          transition: `opacity ${RELAY_MS / 2}ms ease-in-out`,
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(50% 60% at 50% 100%, ${withAlpha(BIRTHDAY_GOLD, 0.4)}, transparent 72%)`,
        }}
      />

      <Confetti throwDir={throwDir} />

      {/* The complete message, on every board. Sized to fit ONE screen. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 20,
          padding: "0 80px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <IconCake
            size={84}
            color={BIRTHDAY_GOLD}
            style={{ filter: `drop-shadow(0 0 26px ${BIRTHDAY_GOLD})` }}
          />
          <span
            className="tv-eyebrow"
            style={{ color: BIRTHDAY_GOLD, fontSize: 40, letterSpacing: "0.3em" }}
          >
            Happy Birthday
          </span>
          <IconConfetti
            size={84}
            color={BIRTHDAY_PINK}
            style={{ filter: `drop-shadow(0 0 26px ${BIRTHDAY_PINK})` }}
          />
        </div>

        <div
          className="tv-display tv-rise"
          style={{
            fontSize: 250,
            lineHeight: 0.9,
            color: "#fff",
            textAlign: "center",
            whiteSpace: "nowrap",
            maxWidth: TV_W - 160,
            overflow: "hidden",
            textShadow: `0 0 40px rgba(255,255,255,0.5), 0 0 120px ${BIRTHDAY_PINK}, 0 0 200px ${withAlpha(BIRTHDAY_GOLD, 0.55)}`,
          }}
        >
          {name || "Happy Birthday"}
        </div>

        <div className="tv-display" style={{ fontSize: 64, color: withAlpha("#ffffff", 0.9) }}>
          Let&rsquo;s go racing
        </div>
      </div>

      {/* Edge light on the side facing the other board — the visible end of the
          hand-off, so the pulse reads as crossing the gap. */}
      {count > 1 && <RelayEdge lit={lit} side={position === 0 ? "right" : "left"} />}
    </div>
  );
}

function RelayEdge({ lit, side }: { lit: boolean; side: "left" | "right" }) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [side]: 0,
        width: 260,
        background: `linear-gradient(to ${side === "right" ? "right" : "left"}, transparent, ${withAlpha(BIRTHDAY_GOLD, 0.4)})`,
        opacity: lit ? 1 : 0,
        transition: `opacity ${RELAY_MS / 2}ms ease-in-out`,
      }}
    />
  );
}

/**
 * Confetti thrown toward the other board.
 *
 * Abstract shapes are the one thing that CAN play across the gap: a particle
 * leaving the inner edge of one board and another arriving on the far board
 * reads as energy crossing the space, where a split word would just read as
 * broken. Every value derives from the particle index — never Math.random() —
 * so both boards compute identical fields and stay coherent.
 */
function Confetti({ throwDir }: { throwDir: number }) {
  const palette = [BIRTHDAY_PINK, BIRTHDAY_GOLD, "#00e2e5", "#46d68c", "#ffffff", "#4fa9ff"];
  return (
    <div aria-hidden style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {Array.from({ length: CONFETTI_COUNT }, (_, i) => {
        const x = ((i * 61) % 100) / 100;
        const size = 10 + ((i * 17) % 12);
        const dur = 2400 + ((i * 89) % 1800);
        const rise = 560 + ((i * 71) % 620);
        // Bias sideways travel toward the gap; unpaired screens spray evenly.
        const spread = (((i * 43) % 200) - 100) * 5;
        const drift = throwDir === 0 ? spread : spread * 0.4 + throwDir * (260 + ((i * 37) % 420));
        return (
          <span
            key={i}
            style={{
              position: "absolute",
              bottom: -30,
              left: `${x * 100}%`,
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
