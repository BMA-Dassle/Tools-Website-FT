import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import { StageRailView } from "./StageRailView";
import { buildStageRail, type RailRoom, type StageRow } from "../briefing/stage-rail";
import { EMPTY_PIT_LANE } from "../pit/pit-board";
import type { BriefingRoomState } from "../briefing/types";
import type { CrewBoard, CrewEntry } from "~/features/staff/crew-list";

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

/** A floor at about 6 PM: two available, three on a group, one on a break, one
 *  rostered who has not arrived — every state the pills can be in. */
function crewBoard(over: Partial<CrewBoard> = {}): CrewBoard {
  const entry = (o: Partial<CrewEntry> & { userId: number; firstName: string }): CrewEntry => ({
    briefed: 0,
    race: null,
    state: "available",
    top: false,
    ...o,
  });
  return {
    list: [
      entry({ userId: 1, firstName: "Ivan", briefed: 7 }),
      entry({ userId: 2, firstName: "Colton" }),
      entry({
        userId: 3,
        firstName: "Pedro",
        briefed: 9,
        state: "assigned",
        top: true,
        race: { track: "blue", heatNumber: 35 },
      }),
      entry({
        userId: 4,
        firstName: "Dayanara",
        briefed: 8,
        state: "assigned",
        race: { track: "red", heatNumber: 33 },
      }),
      entry({
        userId: 5,
        firstName: "Mia",
        briefed: 2,
        state: "assigned",
        race: { track: "mega", heatNumber: null },
      }),
      entry({ userId: 6, firstName: "Joel", briefed: 3, state: "break" }),
      entry({ userId: 7, firstName: "Jocelyn", state: "not-in" }),
    ],
    unattributed: 2,
    groups: 31,
    briefers: 5,
    rosterAvailable: true,
    ...over,
  };
}

interface El {
  type?: unknown;
  key?: string | null;
  props?: { children?: ReactNode; style?: Record<string, unknown> };
}

/**
 * A child component's own output, or null for a host element.
 *
 * The rail composes three hook-free components of its own — the Track Ops row,
 * the crew pills, the host chips — and an element referencing one of those is
 * an unrendered `{ type: fn }` node whose words are nowhere in the tree. Since
 * every one of them is a plain function of its props (the same property that
 * lets this file call `StageRailView` directly), calling it is all the
 * rendering these assertions need.
 */
function expand(el: El): ReactNode {
  return typeof el.type === "function"
    ? (el.type as (p: unknown) => ReactNode)(el.props ?? {})
    : null;
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
  walk(expand(el), out);
  if (el.props) walk(el.props.children, out);
  return out;
}

/** Every string and number in the tree, joined — the wall's words. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as El;
  const own = textOf(expand(el));
  return own + (el.props ? textOf(el.props.children) : "");
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
      // With the Track Ops row in, so the pills are held to the rule too.
      const tree = StageRailView({
        rows: megaRows(),
        density,
        accent: "#a06bff",
        crew: crewBoard(),
      });
      const sizes = walk(tree)
        .map((el) => el.props?.style?.fontSize)
        .filter((v): v is string | number => v != null);
      expect(sizes.length).toBeGreaterThan(5);
      for (const size of sizes) {
        // `em` passes for the same reason LABEL_COL's basis does: it resolves
        // against a parent whose own size is a clamp, so it tracks the viewport
        // through it. A bare number is a pixel, and a pixel is the bug.
        expect(String(size)).toMatch(/clamp\(|vw|vh|em$/);
      }
    });
  }

  /**
   * THE LABEL NEVER WRAPS (owner 2026-08-25: "I don't like that room drops below
   * blue on all these"). "CHECKING IN" and "BLUE ROOM" were breaking onto a
   * second line, which pushes that one row taller and knocks the rail out of
   * rhythm. The column is sized in `em` of the label's own type, so it cannot
   * drift out of step with the font clamps the way a `vw` guess did.
   */
  for (const density of ["wall", "compact"] as const) {
    it(`never lets a ${density} stage label wrap onto a second line`, () => {
      const tree = StageRailView({ rows: megaRows(), density, accent: "#a06bff" });
      // The label columns are the only `em`-based flex bases in the tree — the
      // detail span next to them is `1 1 0`, and the point of the em basis is
      // that the column tracks the label's own clamp.
      const labels = walk(tree).filter((el) => /em$/.test(String(el.props?.style?.flex ?? "")));
      // Seven rows on a Mega night, so seven label columns.
      expect(labels).toHaveLength(7);
      for (const el of labels) {
        expect(el.props?.style?.whiteSpace).toBe("nowrap");
        // Sized against its OWN type, not the viewport — the column has to
        // follow the label's clamp, and `vw` does not.
        expect(String(el.props?.style?.flex)).toMatch(/em$/);
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

  /**
   * THE HOST CHIP, ON EVERY ROW (owner 2026-09-07). It used to be dim caps butted
   * against the level — "35 STARTER PEDRO" — and only on the four lane rows, so
   * a marshal looked like a property of the pit rather than a fact about a
   * group. Same slot, same treatment, every row that HAS a group.
   */
  it("names the host on every occupied row, the briefing room included", () => {
    const rooms: RailRoom[] = [
      { room: "red", state: roomState({ heatNumber: 63 }), host: "Anthony" },
      { room: "blue", state: roomState({ heatNumber: 64, marshal: "Lexiel" }) },
    ];
    const rows = buildStageRail({
      called: { heatNumber: 65, raceType: "Intermediate" },
      rooms,
      lane: {
        ...EMPTY_PIT_LANE,
        racing: { sessionId: "3", heatNumber: 60, raceType: "Pro", room: "red", host: "Pedro" },
      },
      nowMs: NOW,
    });
    const text = textOf(StageRailView({ rows, density: "wall", accent: "#a06bff" }));
    // Beside the state (the check-in board's shape) and on the state (the TV
    // feeds' shape) both reach the row.
    expect(text).toContain("Anthony");
    expect(text).toContain("Lexiel");
    expect(text).toContain("Pedro");
  });

  it("says so when a group has nobody, and stays quiet on an empty stage", () => {
    const rows = buildStageRail({
      // Checking in has a heat but no host — nobody claims a group until the
      // film starts — while Holding and the rest have no group at all.
      called: { heatNumber: 65, raceType: "Intermediate" },
      rooms: [{ room: "red", state: null }],
      lane: null,
      nowMs: NOW,
    });
    const text = textOf(StageRailView({ rows, density: "wall", accent: "#a06bff" }));
    expect(text.match(/no host yet/g)).toHaveLength(1);
  });

  /**
   * THE TRACK OPS ROW — who is free, under Pit in, on both tracks' panels.
   */
  describe("Track Ops row", () => {
    it("lists the crew in the order the fold gave them", () => {
      const text = textOf(
        StageRailView({
          rows: megaRows(),
          density: "wall",
          accent: "#a06bff",
          crew: crewBoard(),
        }),
      );
      expect(text).toContain("Track Ops");
      const order = ["Ivan", "Colton", "Pedro", "Dayanara", "Joel", "Jocelyn"];
      let at = -1;
      for (const name of order) {
        const next = text.indexOf(name);
        expect(next).toBeGreaterThan(at);
        at = next;
      }
    });

    it("tags each assigned marshal with the track letter and heat", () => {
      const text = textOf(
        StageRailView({ rows: megaRows(), density: "wall", accent: "#a06bff", crew: crewBoard() }),
      );
      expect(text).toContain("B35");
      expect(text).toContain("R33");
      // A group with no heat number keeps the letter alone rather than "Mnull".
      expect(text).toContain("M");
      expect(text).not.toContain("Mnull");
    });

    it("is dropped entirely when nobody is on the floor", () => {
      const empty = textOf(
        StageRailView({
          rows: megaRows(),
          density: "wall",
          accent: "#a06bff",
          crew: crewBoard({ list: [] }),
        }),
      );
      expect(empty).not.toContain("Track Ops");
      const absent = textOf(
        StageRailView({ rows: megaRows(), density: "wall", accent: "#a06bff" }),
      );
      expect(absent).not.toContain("Track Ops");
    });

    it("says the roster is unavailable rather than letting a short list lie", () => {
      const text = textOf(
        StageRailView({
          rows: megaRows(),
          density: "wall",
          accent: "#a06bff",
          crew: crewBoard({ rosterAvailable: false }),
        }),
      );
      expect(text).toContain("roster unavailable");
    });

    it("keeps every pill's key distinct", () => {
      const tree = StageRailView({
        rows: megaRows(),
        density: "compact",
        accent: "#a06bff",
        crew: crewBoard(),
      });
      const keys = walk(tree)
        .map((el) => el.key)
        .filter((k): k is string => k != null);
      expect(new Set(keys).size).toBe(keys.length);
    });
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
