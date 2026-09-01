import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import { SceneBowlingCheckin } from "./SceneBowlingCheckin";
import type { SceneProps } from "../director/types";

/**
 * THE LEFT PANEL MUST NOT INVITE A GUEST TO A KIOSK THAT WILL REFUSE THEM.
 *
 * That rule (owner 2026-08-19) used to be kept by omission: the column listed only
 * guests whose lane QAMF had reported ready, and dropped everyone else. On 2026-09-01
 * the owner asked for the other half — "reservations within next hour and whether lane
 * is available or not" — because silently omitting somebody who is standing in the
 * lobby reads as "we have no record of you".
 *
 * So the rule moved from the QUERY into the DRAWING, and that is what these lock down: a
 * guest whose lane is not ready is on the board by name, and is given no lane number and
 * no instruction to go and check in.
 *
 * Rendered by calling the component and walking the element tree rather than through
 * react-dom, for the same reason as checkin-feed.test.tsx: a root-hoisted react 18 from
 * another workspace shadows apps/web's react 19 in this repo's install layout. Nothing
 * here needs a DOM — the question is only which words reach the wall.
 */

/**
 * Every string and number in the tree, in order, joined — the wall's words.
 *
 * DESCENDS INTO FUNCTION COMPONENTS, which the sibling walker in checkin-feed.test.tsx
 * does not need to: this panel's two lists are a nested `Column`, so its words live in
 * that element's PROPS and never in `children`. Calling the component is safe here
 * precisely because everything on this panel is hook-free — a component with state would
 * need a real renderer.
 */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as { type?: unknown; props?: { children?: ReactNode } };
  if (typeof el.type === "function") {
    const render = el.type as (p: unknown) => ReactNode;
    return textOf(render(el.props ?? {}));
  }
  return el.props ? textOf(el.props.children) : "";
}

type Available = { name: string; timeLabel: string; lanes: string; laneReady: boolean };
type CheckedIn = { name: string; lanes: string; laneReady: boolean };

function wall(available: Available[], checkedIn: CheckedIn[] = []): string {
  return textOf(
    SceneBowlingCheckin({
      feed: { bowlingCheckins: { available, checkedIn } },
    } as unknown as SceneProps),
  );
}

const READY: Available = { name: "Gabby W.", timeLabel: "7:30 PM", lanes: "12", laneReady: true };
const NOT_READY: Available = {
  name: "Marcus T.",
  timeLabel: "8:00 PM",
  lanes: "",
  laneReady: false,
};

describe("the lane-available column", () => {
  it("SHOWS a guest whose lane is not ready — they are not hidden", () => {
    // The change of 2026-09-01. Before this they were dropped from the query entirely.
    expect(wall([NOT_READY])).toContain("Marcus T.");
  });

  it("but tells them the lane is NOT ready, and never says to check in", () => {
    const said = wall([NOT_READY]);
    expect(said).toContain("Lane not ready yet");
    expect(said).not.toContain("Check in now");
  });

  it("and gives them NO lane number — a number is the invitation", () => {
    // Even when a lane has been penciled in, quoting it before QAMF says ready is the
    // exact thing that sends a guest to a kiosk which turns them away.
    const said = wall([{ ...NOT_READY, lanes: "9" }]);
    expect(said).not.toContain("Lane 9");
    // They still get their booked time, so they know they are in the right place.
    expect(said).toContain("8:00 PM");
  });

  it("a READY guest gets the lane and the invitation", () => {
    const said = wall([READY]);
    expect(said).toContain("Gabby W.");
    expect(said).toContain("Lane 12");
    expect(said).toContain("Check in now");
  });

  it("the two states are distinguishable on the same board", () => {
    const said = wall([READY, NOT_READY]);
    expect(said).toContain("Check in now");
    expect(said).toContain("Lane not ready yet");
  });

  it("says what is happening when nobody is due, rather than going blank", () => {
    // An empty half of a two-column board reads as a fault; a sentence reads as "nobody
    // yet", which is the normal state for a quiet stretch.
    expect(wall([])).toContain("No reservations due in the next hour");
  });
});

describe("the skip-the-desk band", () => {
  it("names BOTH ways in, on every state of the board", () => {
    // Owner 2026-09-01: "encourage mobile and kiosk check in more". It used to be a
    // quiet grey line under one column, and only when that column had rows.
    for (const state of [[], [READY], [NOT_READY]]) {
      const said = wall(state);
      expect(said.toLowerCase()).toContain("phone");
      expect(said.toLowerCase()).toContain("kiosk");
      expect(said).toContain("Skip the desk");
    }
  });

  it("promises the shoes, because that is the thing self check-in cannot hand over", () => {
    // A guest who does not know shoes are coming queues at the desk to ask — the very
    // queue this panel exists to empty.
    expect(wall([READY]).toLowerCase()).toContain("shoes");
  });
});
