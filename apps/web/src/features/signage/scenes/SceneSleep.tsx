"use client";

/**
 * Closed for the night.
 *
 * Near-black, one dim wordmark, and it MOVES — a new position every five
 * minutes, derived from the clock like everything else. Three jobs at once:
 * it saves power, it stops a static bright element sitting on the same pixels
 * for eight hours, and it tells a passing manager the screen is alive rather
 * than dead.
 */
import { TV_W, TV_H } from "../constants";
import type { SceneProps } from "../director/types";

const MOVE_MS = 5 * 60_000;
/** A coarse grid keeps the mark well inside the panel at every stop. */
const COLS = 3;
const ROWS = 3;

export function SceneSleep({ nowMs }: SceneProps) {
  const step = Math.floor(nowMs / MOVE_MS);
  const col = step % COLS;
  const row = Math.floor(step / COLS) % ROWS;
  const left = ((col + 0.5) / COLS) * TV_W;
  const top = ((row + 0.5) / ROWS) * TV_H;

  return (
    <div style={{ position: "absolute", inset: 0, background: "#000418" }}>
      <div
        className="tv-display"
        style={{
          position: "absolute",
          left,
          top,
          transform: "translate(-50%, -50%)",
          fontSize: 64,
          color: "rgba(245,236,238,0.15)",
          letterSpacing: "0.08em",
          transition: "left 2s ease-in-out, top 2s ease-in-out",
          whiteSpace: "nowrap",
        }}
      >
        HeadPinz
      </div>
    </div>
  );
}
