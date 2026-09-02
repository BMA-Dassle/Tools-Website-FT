/**
 * /kiosk/staff Lanes tab — flatten a LaneGrid into the per-lane rows a floor
 * lead actually reads: what's on each lane right now, and when it frees.
 *
 * Pure module (no vendor calls) so the flattening rules are unit-testable —
 * the grid itself comes from `lane-plan/grid.server.ts#buildGrid`, which fuses
 * the schedule read with the live floor. Everything here consumes the grid's
 * `busy` intervals; it must NEVER reach into `liveLanes[].closedAtMs` for an
 * end time — `ClosedAt` is a state-as-of stamp that reads ≈now on every lane
 * (see reference: QAMF lane ClosedAt is NOT a close time).
 */
import type { LaneGrid } from "~/features/lane-plan/types";

/** Which QAMF grids a kiosk's venue covers. FastTrax and HeadPinz Fort Myers
 *  are one physical complex, so an FM kiosk shows BOTH houses; Naples has one. */
export interface StaffLaneCenter {
  centerId: number;
  label: string;
}

export type StaffLaneState = "error" | "busy" | "soon" | "free";

export interface StaffLane {
  lane: number;
  state: StaffLaneState;
  /** Who is on it (busy) or landing next (soon). Null when free. */
  title: string | null;
  players: number;
  /** League / maintenance / non-bookable — occupied but not sellable play. */
  isBlock: boolean;
  /** `Type.Description` free text ("Walk-in > Classic", "League", …). */
  kind: string;
  /** busy → when it frees; soon → when it starts. Epoch ms. */
  untilMs: number | null;
}

export interface StaffLaneBoard {
  centerId: number;
  label: string;
  readAtMs: number;
  lanes: StaffLane[];
  /** Schedule-vs-floor disagreements, from findGridGaps — a blocking row means
   *  the schedule alone would have missed real occupancy. */
  gaps: Array<{ lane: number; severity: "blocking" | "info"; problem: string }>;
}

/**
 * One lane's staff-facing row at `atMs`.
 *
 * Precedence: hardware error > busy now > booked soon > free. "Busy" means ANY
 * busy interval covers `atMs` — schedule or floor — so a session running past
 * its booked end (a floor interval) and a lane opened straight in Conqueror
 * (`Reservation: null`) both read busy, never free.
 */
export function flattenLaneGrid(grid: LaneGrid, atMs: number): StaffLane[] {
  return grid.lanes.map((lane) => {
    if (grid.errorLanes.has(lane)) {
      return {
        lane,
        state: "error" as const,
        title: null,
        players: 0,
        isBlock: false,
        kind: "",
        untilMs: null,
      };
    }

    const mine = grid.busy.filter((b) => b.laneNumber === lane);
    const now = mine.filter((b) => atMs >= b.startMs && atMs < b.endMs);
    if (now.length > 0) {
      // Frees when the LAST covering interval ends. For the label prefer the
      // schedule interval — it carries the real reservation title; the floor
      // interval's title is a synthetic "running X…" placeholder.
      const untilMs = Math.max(...now.map((b) => b.endMs));
      const labeled = now.find((b) => b.source === "schedule") ?? now[0];
      return {
        lane,
        state: "busy" as const,
        title: labeled.title || null,
        players: Math.max(...now.map((b) => b.players)),
        isBlock: now.some((b) => b.isBlock),
        kind: labeled.kind,
        untilMs,
      };
    }

    const upcoming = mine
      .filter((b) => b.startMs > atMs && b.startMs < grid.windowEndMs)
      .sort((a, b) => a.startMs - b.startMs)[0];
    if (upcoming) {
      return {
        lane,
        state: "soon" as const,
        title: upcoming.title || null,
        players: upcoming.players,
        isBlock: upcoming.isBlock,
        kind: upcoming.kind,
        untilMs: upcoming.startMs,
      };
    }

    return {
      lane,
      state: "free" as const,
      title: null,
      players: 0,
      isBlock: false,
      kind: "",
      untilMs: null,
    };
  });
}
