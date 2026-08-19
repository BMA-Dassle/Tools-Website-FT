"use client";

/**
 * WHICH PANEL AM I — the wall's setup and sync test, on the glass.
 *
 * Two jobs, both of which can only be done by standing in front of the wall:
 *
 *  1. IS THE ORDER RIGHT? Every panel prints its position as a row of boxes with its
 *     own filled. Walk the wall and the filled box must march left to right. A pair
 *     wired to the wrong monitors is then obvious in one glance instead of being
 *     inferred from a config page — and it names the PLAYER and the MONITOR SIDE, so
 *     the fix is "swap the two outputs on hpfm-fd-a", not "something is wrong".
 *
 *  2. IS THE SHINE ACTUALLY IN SYNC? "It looks out of sync" is not a thing anybody
 *     can act on. So this prints the two numbers that decide it, live: the panel's
 *     CLOCK OFFSET, and the current phase of `tv-sweep` in its 7.5s cycle. Read them
 *     off all five —
 *       · offsets differ by a lot   → the clock sync is the problem
 *       · offsets agree, phases don't → the phase SEEK is the problem
 *       · both agree                  → they are in sync and something else reads wrong
 *     which turns an argument about what the wall looks like into one measurement.
 *
 * Pushed from the admin page as a 5-minute preview, so it expires on its own and can
 * never be left up in front of guests. `?demo=identify` does the same on one tab.
 */
import { useEffect, useRef, useState } from "react";
import { TV_W } from "../constants";

const SWEEP_PERIOD_MS = 7500;

/** How a panel's place reads out loud, so staff and I use the same words. */
function positionWord(position: number, count: number): string {
  if (count <= 1) return "ON ITS OWN";
  if (position === 0) return "FAR LEFT";
  if (position === count - 1) return "FAR RIGHT";
  if (count % 2 === 1 && position === (count - 1) / 2) return "CENTRE";
  return position === 1 ? "SECOND FROM LEFT" : `${position + 1} FROM LEFT`;
}

export function WallIdentify({
  screenId,
  screenName,
  buildSha,
  offset,
  wall,
  pairing,
}: {
  screenId: string | null;
  screenName: string;
  buildSha: string;
  /** The shared-clock correction this panel is applying, in ms. */
  offset: number;
  wall: { wallId: string; position: number; count: number } | null;
  pairing: { groupId: string; position: number; count: number } | null;
}) {
  const position = wall?.position ?? 0;
  const count = wall?.count ?? 1;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        background: "rgba(0,4,24,0.94)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 44,
        padding: 80,
      }}
    >
      {/* THE ORDER CHECK. Five boxes, this panel's filled and numbered. Walk the
          wall: the filled box must move left to right. */}
      <div style={{ display: "flex", gap: 22 }}>
        {Array.from({ length: count }, (_, i) => {
          const mine = i === position;
          return (
            <div
              key={i}
              style={{
                width: Math.min(230, (TV_W - 300) / count),
                height: 190,
                borderRadius: 18,
                border: `8px solid ${mine ? "#00e2e5" : "rgba(245,236,238,0.22)"}`,
                background: mine ? "#00e2e5" : "transparent",
                color: mine ? "#000418" : "rgba(245,236,238,0.3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: "var(--font-heading), sans-serif",
                fontStyle: "italic",
                fontWeight: 800,
                fontSize: 128,
                lineHeight: 1,
                boxShadow: mine ? "0 0 70px rgba(0,226,229,0.6)" : "none",
              }}
            >
              {i + 1}
            </div>
          );
        })}
      </div>

      <div style={{ textAlign: "center" }}>
        <div
          className="tv-display"
          style={{ fontSize: 96, color: "#fff", lineHeight: 1, letterSpacing: "0.02em" }}
        >
          {positionWord(position, count)}
        </div>
        <div
          style={{
            marginTop: 18,
            fontFamily: "ui-monospace, monospace",
            fontSize: 58,
            color: "#00e2e5",
            letterSpacing: "0.06em",
          }}
        >
          {screenId ?? "NO SCREEN ID"}
        </div>
        <div style={{ marginTop: 10, fontSize: 34, color: "rgba(245,236,238,0.72)" }}>
          {screenName}
        </div>
      </div>

      {/* WHICH MACHINE, AND WHICH OUTPUT ON IT — the actionable half. */}
      <div
        style={{
          fontSize: 40,
          color: "#fff",
          background: "rgba(255,255,255,0.08)",
          border: "3px solid rgba(0,226,229,0.5)",
          borderRadius: 14,
          padding: "20px 40px",
          textAlign: "center",
        }}
      >
        {pairing
          ? `Player ${pairing.groupId} — ${pairing.position === 0 ? "LEFT" : "RIGHT"} monitor`
          : "Its own player — single monitor"}
        {wall ? ` · wall ${wall.wallId}` : " · not on a wall"}
      </div>

      <SyncReadout offset={offset} buildSha={buildSha} />
    </div>
  );
}

/**
 * The live sync numbers.
 *
 * `phase` is read off the RUNNING `tv-sweep` animation rather than recomputed, so it
 * is what the panel is actually doing — the whole point is to catch the case where
 * the seek did not take. Sampled on a rAF loop that stops with the overlay; nothing
 * here survives the preview expiring.
 */
function SyncReadout({ offset, buildSha }: { offset: number; buildSha: string }) {
  const [phase, setPhase] = useState<number | null>(null);
  const raf = useRef(0);

  useEffect(() => {
    const tick = () => {
      // The scene's own sweep element, wherever it is in the tree.
      const el = document.querySelector<HTMLElement>(".tv-sweep");
      let found: number | null = null;
      if (el && typeof el.getAnimations === "function") {
        for (const anim of el.getAnimations()) {
          const t = anim.currentTime;
          if (typeof t === "number") {
            found = ((t % SWEEP_PERIOD_MS) + SWEEP_PERIOD_MS) % SWEEP_PERIOD_MS;
            break;
          }
        }
      }
      setPhase(found);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, []);

  const cell = (label: string, value: string, note?: string) => (
    <div style={{ textAlign: "center", minWidth: 340 }}>
      <div
        style={{
          fontSize: 26,
          letterSpacing: "0.22em",
          color: "rgba(245,236,238,0.5)",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "ui-monospace, monospace",
          fontSize: 62,
          color: "#46d68c",
          marginTop: 8,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      {note && (
        <div style={{ fontSize: 24, color: "rgba(245,236,238,0.45)", marginTop: 4 }}>{note}</div>
      )}
    </div>
  );

  return (
    <div style={{ display: "flex", gap: 60, alignItems: "flex-start" }}>
      {cell(
        "clock offset",
        `${offset >= 0 ? "+" : ""}${Math.round(offset)} ms`,
        "same on all five",
      )}
      {cell(
        "shine phase",
        phase == null ? "— not seeked" : `${(phase / 1000).toFixed(2)} s`,
        phase == null ? "no sweep found" : "of 7.50 s · same on all five",
      )}
      {cell("build", buildSha, "must match everywhere")}
    </div>
  );
}
