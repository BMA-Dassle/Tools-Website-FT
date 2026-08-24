"use client";

/**
 * The moment something happens: a racer scans in, or someone finishes a booking
 * on a kiosk nearby.
 *
 * Short and loud. Eight seconds, one name, one instruction — a guest looks up
 * because the wall changed, reads it, and moves. Anything more is a poster.
 *
 * NOT the VIP surface. VIPs do not scan in (owner 2026-08-11) — they are met
 * and escorted — so their in-field instruction lives on the track scene's
 * standing banner, driven by the heat roster. This scene greets the ordinary
 * racer who just swiped a licence at the desk.
 *
 * ON A WALL, THE NAME LANDS WHOLE ON THE CENTRE PANEL and the flanking panels
 * carry light and the instruction. A name split across a join is two broken
 * halves however small the gap — that half of the karting boards' four-foot rule
 * survives at six inches, which is why the wall gets a composition rather than a
 * spanning canvas. Five identical cards would be a hall of mirrors; a name on one
 * panel with the wall blooming around it is the moment the guest actually looks up
 * for. Off a wall, `choreo()` reports a group of one and every branch below
 * collapses to exactly today's single-screen layout.
 */
import { IconConfetti, IconArrowBigDownFilled } from "@tabler/icons-react";
import { withAlpha } from "../color";
import { choreo, isWallCentre } from "../wall";
import { TRACK_ACCENTS, trackFromResourceIds } from "../track";
import type { SignageEvent } from "../types";
import type { SceneProps } from "../director/types";

const CONFETTI_COUNT = 80;

export function SceneCelebration({ decision, config }: SceneProps) {
  const event = decision.event;
  if (!event) return null;

  const isRacer = event.kind === "racer-scanned";
  const track = trackFromResourceIds(event.resourceId ? [event.resourceId] : undefined);
  const accent = track ? TRACK_ACCENTS[track] : "#00e2e5";

  const { position, count } = choreo(config);
  const onWall = count > 1;
  // The centre panel carries the name. A lone screen is its own centre, so the
  // single-TV case takes the same branch it always has.
  const carriesName = isWallCentre(position, count);
  // One flanking panel says what to do next, rather than all four repeating it.
  // Position 1 on a five-wide wall: immediately left of the name, where the eye
  // lands next after reading it.
  const carriesInstruction = !onWall || position === Math.max(0, Math.floor((count - 1) / 2) - 1);

  const name = event.firstName?.trim();
  const headline = name ? `Welcome, ${name}` : isRacer ? "Welcome, racer" : "You're all set";
  const instruction = isRacer
    ? "You're checked in. Head to the in-field when your session is called."
    : "Booked at the kiosk — see you shortly";

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#000418" }}>
      {/* Light blooms from the bottom, where the kiosks and the scanner
          physically are — the eye is drawn from the thing that just happened. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(80% 70% at 50% 100%, ${withAlpha(accent, 0.4)}, transparent 70%)`,
        }}
      />

      <Confetti accent={accent} />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 30,
          padding: "0 96px",
        }}
      >
        {(carriesName || !onWall) && (
          <IconConfetti
            size={92}
            color={accent}
            style={{ filter: `drop-shadow(0 0 24px ${accent})` }}
          />
        )}

        {carriesName && (
          <div
            className="tv-display tv-rise"
            style={{
              fontSize: 176,
              color: "#fff",
              textAlign: "center",
              textShadow: `0 0 70px ${withAlpha(accent, 0.7)}`,
              lineHeight: 0.94,
            }}
          >
            {headline}
          </div>
        )}

        {carriesInstruction && (
          <div
            className="tv-glass"
            style={{
              padding: "22px 40px",
              borderLeft: `8px solid ${accent}`,
              maxWidth: 1400,
            }}
          >
            <span style={{ fontSize: 46, color: "rgba(245,236,238,0.92)" }}>{instruction}</span>
          </div>
        )}

        {/* A FLANKING panel of a wall always nods down — each panel stands over its
            own kiosk and the guest who just booked is at exactly one of them, so
            the wall points everywhere rather than guessing which. The panel
            carrying the name keeps the original rule (booking celebrations point,
            racer scans don't — a racer is going to the track, not to a machine),
            and off a wall that is the only branch there is. */}
        {(carriesName ? !isRacer : onWall) && <KioskPointer accent={accent} />}
      </div>
    </div>
  );
}

/** A nod down at the kiosk bank for booking celebrations — the thing that just
 *  happened is right below the screen. */
function KioskPointer({ accent }: { accent: string }) {
  return (
    <div aria-hidden style={{ display: "flex", gap: 26, marginTop: 6 }}>
      {[0, 1, 2].map((i) => (
        <IconArrowBigDownFilled
          key={i}
          size={46}
          color={accent}
          className="tv-chev"
          data-glow-phase-ms={i * 300}
          style={{ opacity: 0.85 }}
        />
      ))}
    </div>
  );
}

/**
 * Hand-rolled CSS confetti: finite animations on spans that unmount with the
 * scene. No canvas, no library, no rAF loop — nothing that can keep running
 * after the moment has passed on a screen that never reloads.
 *
 * Particle variation comes from the INDEX, not from Math.random(): the scene is
 * keyed to a clock-derived decision, so a deterministic burst is identical on
 * every screen showing the same event and cannot re-shuffle on a re-render.
 */
function Confetti({ accent }: { accent: string }) {
  const palette = [accent, "#00e2e5", "#46d68c", "#f0b341", "#e8b14c", "#4fa9ff"];
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: 0,
        display: "flex",
        justifyContent: "center",
      }}
    >
      {Array.from({ length: CONFETTI_COUNT }, (_, i) => {
        const spread = ((i * 37) % 200) - 100; // deterministic -100..100
        const size = 8 + ((i * 13) % 7);
        const dur = 1800 + ((i * 97) % 900);
        const rise = 420 + ((i * 53) % 460);
        return (
          <span
            key={i}
            style={{
              position: "absolute",
              bottom: 0,
              width: size,
              height: size * 1.6,
              background: palette[i % palette.length],
              borderRadius: 2,
              opacity: 0,
              animation: `tv-confetti ${dur}ms cubic-bezier(0.15,0.6,0.35,1) ${(i % 12) * 40}ms both`,
              // Per-particle trajectory, read by the shared keyframe.
              ["--dx" as string]: `${spread * 6}px`,
              ["--dy" as string]: `${-rise}px`,
              ["--rot" as string]: `${(i % 2 ? 1 : -1) * (180 + ((i * 29) % 540))}deg`,
            }}
          />
        );
      })}
    </div>
  );
}

export type { SignageEvent };
