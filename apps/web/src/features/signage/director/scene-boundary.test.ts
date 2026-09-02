import { describe, it, expect } from "vitest";
import { SceneBoundary } from "./SceneBoundary";

/**
 * The boundary's whole policy lives in its two statics, and they are pure — so
 * this drives them directly rather than rendering a tree (the suite runs in
 * `environment: "node"`, and React error boundaries do not engage in SSR anyway).
 *
 * What is being protected: a scene that throws is skipped FOR ITS OWN FRAME, and
 * the next frame gets a clean attempt. Get the second half wrong and one bad
 * celebration silently turns the wall into an advertising screen for the rest of
 * the evening — which looks fine from the lobby and is not.
 */

type State = { crashed: boolean; forKey: string | null };
const props = (frameKey: string) =>
  ({ frameKey, scene: "celebration", fallback: null, children: null }) as never;

/** Replay what React does: derive from props, then render; on a throw, derive
 *  from the error and derive from props again before re-rendering. */
function nextState(state: State, frameKey: string): State {
  const patch = SceneBoundary.getDerivedStateFromProps(props(frameKey), state);
  return { ...state, ...(patch ?? {}) };
}

describe("SceneBoundary", () => {
  const fresh: State = { crashed: false, forKey: null };

  it("adopts the first frame without claiming a crash", () => {
    expect(nextState(fresh, "celebration:evt-1")).toEqual({
      crashed: false,
      forKey: "celebration:evt-1",
    });
  });

  it("keeps the fallback up for the REST of the frame that threw", () => {
    let s = nextState(fresh, "celebration:evt-1");
    // The child throws.
    s = { ...s, ...SceneBoundary.getDerivedStateFromError() };
    expect(s.crashed).toBe(true);
    // The director ticks four times a second on the same decision; each of those
    // re-renders must NOT clear the verdict, or the scene is retried (and throws)
    // every 250ms for the length of the celebration.
    s = nextState(s, "celebration:evt-1");
    s = nextState(s, "celebration:evt-1");
    expect(s.crashed).toBe(true);
  });

  it("gives the NEXT frame a clean attempt", () => {
    let s = nextState(fresh, "celebration:evt-1");
    s = { ...s, ...SceneBoundary.getDerivedStateFromError() };
    // The wall moves on to the pricing board.
    s = nextState(s, "open-now");
    expect(s).toEqual({ crashed: false, forKey: "open-now" });
  });

  it("does not let one bad event poison the same scene for a later one", () => {
    let s = nextState(fresh, "celebration:evt-1");
    s = { ...s, ...SceneBoundary.getDerivedStateFromError() };
    // A different guest checks in — same scene, different identity, so it is a
    // different frame and deserves its own chance.
    s = nextState(s, "celebration:evt-2");
    expect(s.crashed).toBe(false);
  });
});
