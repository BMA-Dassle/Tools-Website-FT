import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import { CheckinFeed } from "./SceneRaceCheckin";

/**
 * The Mega check-in wall's tally must not outlive its own heat.
 *
 * THE FAILURE THIS LOCKS OUT (owner, 2026-08-17): Red heat 56 checked in two
 * racers, staff sent the group to the red briefing room, and an hour later the
 * board still read "2 OF 2" over an empty wall. The names had already gone —
 * the send pushes the scan floor to +Infinity — but the count came straight off
 * `raceCheckin`, which is built from `pandora:last-race:*`: a key that
 * deliberately outlives the heat so the session line does not blink out between
 * heats. Only the count was ungated, so only the count got stranded.
 *
 * Rendered by calling the component and walking the element tree rather than
 * through react-dom: a root-hoisted react 18 from another workspace shadows
 * apps/web's react 19 in this repo's install layout, and react-dom/server
 * refuses a mismatched pair. Nothing here needs a DOM — the question is only
 * which text the board puts on the wall.
 */

type Props = Parameters<typeof CheckinFeed>[0];

const HEAT = { heatNumber: 56, raceType: "Starter" };

/** Every string and number in the tree, in order, joined — the wall's words. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as { props?: { children?: ReactNode } };
  return el.props ? textOf(el.props.children) : "";
}

function wall(overrides: Partial<Props>): string {
  return textOf(
    CheckinFeed({
      accent: "#6600cc",
      race: null,
      scans: [],
      checkedIn: 2,
      total: 2,
      showRecordsQr: false,
      ...overrides,
    }),
  );
}

describe("CheckinFeed", () => {
  it("shows the tally while the heat is still checking in", () => {
    expect(wall({ race: HEAT })).toContain("2 of 2");
  });

  it("drops the tally once the heat has been sent to a briefing room", () => {
    // `race` null with no announcement running is exactly the post-send,
    // between-heats state the wall sat in for an hour.
    expect(wall({ race: null, announce: null })).not.toContain("2 of 2");
  });

  it("keeps the tally through the send announcement, over the names it counts", () => {
    const said = wall({
      race: null,
      announce: { room: "red", heatNumber: 56, raceType: "Starter" },
    });
    expect(said).toContain("2 of 2");
    expect(said).toContain("RED ROOM");
  });

  it("never tells the wall to scan", () => {
    // Owner 2026-08-17: no "Scan to check in" caption. The desk and the
    // e-ticket already say it, and it was the only thing on a blank board.
    for (const state of [{ race: HEAT }, { race: null }, { race: HEAT, scans: [] }]) {
      expect(wall(state).toLowerCase()).not.toContain("scan to check in");
    }
  });
});
