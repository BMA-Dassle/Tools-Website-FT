import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import { StageRailView } from "./StageRailView";
import { buildStageRail, type RailRoom, type StageRow } from "../briefing/stage-rail";
import { EMPTY_PIT_LANE } from "../pit/pit-board";
import type { BriefingRoomState } from "../briefing/types";

/**
 * THE ONE RENDERER, HELD TO THE TWO RULES IT KEEPS BREAKING.
 *
 * `StageRailView` is hook-free, so it can be called directly and its element
 * tree walked — the same technique as results-chrome.test.tsx, and for the same
 * reason (node environment, no DOM, and a react 18/19 mismatch in this install
 * layout makes react-dom/server unusable here).
 *
 * Both rules below have already cost a wall:
 *
 *  • EVERY SIZE VIEWPORT-RELATIVE. A pass through this file with pixel values
 *    lifted from a windowed preview made every camera board render at its floor
 *    (owner 2026-08-24: "everything got extreme small on the camera TVs, I
 *    warned about this!"). Now that the Mega session tracker renders here too,
 *    a fixed pixel in this component reaches a whole pit sign.
 *  • TWO ROOMS, ONE TRACK. A Mega night's rail carries a row per briefing room,
 *    and two rows that used to be one is exactly the shape that produces
 *    duplicate React keys.
 */

const NOW = 1_700_000_000_000;

function roomState(over: Partial<BriefingRoomState>): BriefingRoomState {
  return {
    kind: "timeline",
    tier: "starter",
    track: "mega",
    raceType: "Starter",
    sessionId: "9000",
    heatNumber: 60,
    triggeredAtMs: NOW - 60_000,
    videoUrl: "https://example.test/film.mp4",
    videoDurationMs: 5 * 60_000,
    ...over,
  };
}

/** A Mega night: both rooms briefing, and four lane stages each carrying the
 *  room its group walks back into. */
function megaRows(): StageRow[] {
  const rooms: RailRoom[] = [
    { room: "red", state: roomState({ heatNumber: 63 }) },
    { room: "blue", state: roomState({ heatNumber: 64 }) },
  ];
  return buildStageRail({
    called: { heatNumber: 65, raceType: "Intermediate" },
    rooms,
    lane: {
      ...EMPTY_PIT_LANE,
      holding: { sessionId: "1", heatNumber: 62, raceType: "Pro", room: "red", atMs: NOW },
      karts: {
        sessionId: "2",
        heatNumber: 61,
        raceType: "Starter",
        room: "blue",
        atMs: NOW,
        preRaceAtMs: null,
        preRaceDurationS: null,
      },
      racing: { sessionId: "3", heatNumber: 60, raceType: "Pro", room: "red" },
      pitIn: {
        sessionId: "4",
        heatNumber: 59,
        raceType: "Starter",
        room: "blue",
        atMs: NOW,
        finishedAtMs: null,
        postRaceAtMs: null,
        postRaceDurationS: null,
      },
    },
    nowMs: NOW,
  });
}

/** A split night: one room feeds this track, so the rail keeps its folded row. */
function splitRows(): StageRow[] {
  return buildStageRail({
    called: { heatNumber: 65, raceType: "Intermediate" },
    rooms: [{ room: "red", state: roomState({ heatNumber: 63, track: "red" }) }],
    lane: {
      ...EMPTY_PIT_LANE,
      holding: { sessionId: "1", heatNumber: 62, raceType: "Pro", room: "red", atMs: NOW },
    },
    nowMs: NOW,
  });
}

interface El {
  type?: unknown;
  key?: string | null;
  props?: { children?: ReactNode; style?: Record<string, unknown> };
}

/** Every element in the tree, flattened. */
function walk(node: ReactNode, out: El[] = []): El[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") return out;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return out;
  }
  const el = node as El;
  out.push(el);
  if (el.props) walk(el.props.children, out);
  return out;
}

/** Every string and number in the tree, joined — the wall's words. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as { props?: { children?: ReactNode } };
  return el.props ? textOf(el.props.children) : "";
}

describe("StageRailView", () => {
  /**
   * THE SIZE RULE, ENFORCED RATHER THAN COMMENTED. Every font-size this
   * component emits must be viewport-relative — a `clamp()`, a `vw` or a `vh`.
   * A bare number is a pixel, and a pixel is the bug that shrank the camera
   * boards.
   */
  for (const density of ["wall", "compact"] as const) {
    it(`sizes every ${density} row against the viewport, never in pixels`, () => {
      const tree = StageRailView({ rows: megaRows(), density, accent: "#a06bff" });
      const sizes = walk(tree)
        .map((el) => el.props?.style?.fontSize)
        .filter((v): v is string | number => v != null);
      expect(sizes.length).toBeGreaterThan(5);
      for (const size of sizes) {
        expect(String(size)).toMatch(/clamp\(|vw|vh/);
      }
    });
  }

  it("gives the two room rows distinct keys", () => {
    // Two rows that used to be one is how duplicate keys get introduced, and
    // React's answer to a duplicate key is to drop a row — on this wall, the
    // second briefing room.
    const tree = StageRailView({ rows: megaRows(), density: "wall", accent: "#a06bff" });
    const keys = walk(tree)
      .map((el) => el.key)
      .filter((k): k is string => k != null);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("names both rooms on a Mega night", () => {
    const text = textOf(StageRailView({ rows: megaRows(), density: "wall", accent: "#a06bff" }));
    expect(text).toContain("Red room");
    expect(text).toContain("Blue room");
    expect(text).toContain("Session 63");
    expect(text).toContain("Session 64");
  });

  /**
   * THE RETURN-ROOM PILL, AND WHERE IT MAY NOT GO (owner 2026-08-17: "for mega
   * keep a pill next to the race on what room they will be returning to").
   *
   * On a Mega night one circuit is fed by two rooms, so "which door does this
   * race come back to" is a real question. On a split night the rail is already
   * inside its own room's screen and the pill would be the wall reading itself
   * back — which is why it keys off the rail having room rows at all rather
   * than off a prop a caller could forget.
   */
  it("pills each lane stage with the room it comes back to, on a Mega night", () => {
    const text = textOf(StageRailView({ rows: megaRows(), density: "wall", accent: "#a06bff" }));
    expect(text).toContain("→ RED ROOM");
    expect(text).toContain("→ BLUE ROOM");
  });

  it("shows no pill on a split night, where the screen is already the room", () => {
    const text = textOf(StageRailView({ rows: splitRows(), density: "wall", accent: "#ff3b30" }));
    expect(text).not.toContain("→ RED ROOM");
    expect(text).toContain("Briefing");
  });

  /**
   * THE BANDS ARE A WALL THING. A stage row is a long line spread across a
   * whole television and the eye has to carry it left to right; on the camera
   * rail, 58% of a small panel with its rows already tight, a rule per row is
   * noise. The tracker had these before it joined this component.
   */
  it("bands the wall rows with a hairline, but never the first", () => {
    const tree = StageRailView({ rows: megaRows(), density: "wall", accent: "#a06bff" });
    const borders = walk(tree)
      .map((el) => el.props?.style?.borderTop)
      .filter((v) => typeof v === "string" && v.startsWith("1px"));
    // Seven rows on a Mega night, so six lines between them.
    expect(borders).toHaveLength(6);
  });

  it("leaves the compact camera rail unbanded", () => {
    const tree = StageRailView({ rows: megaRows(), density: "compact", accent: "#a06bff" });
    const borders = walk(tree)
      .map((el) => el.props?.style?.borderTop)
      .filter((v) => typeof v === "string" && v.startsWith("1px"));
    expect(borders).toHaveLength(0);
  });

  it("never pills an empty stage — a room beside a dash is about nobody", () => {
    const rows = buildStageRail({
      called: null,
      rooms: [
        { room: "red", state: null },
        { room: "blue", state: null },
      ],
      lane: null,
      nowMs: NOW,
    });
    const text = textOf(StageRailView({ rows, density: "wall", accent: "#a06bff" }));
    expect(text).not.toContain("→");
  });
});
