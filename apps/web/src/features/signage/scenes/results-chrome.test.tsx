import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import { Footer, Shell } from "./results-chrome";
import { LiveStamp } from "./LiveStamp";

/**
 * THE LIVENESS STAMP HAS TO BE ON EVERY FACE OF THE SCORES WALL, and this is
 * the test that keeps it there.
 *
 * The stamp is the only thing on this board that moves, so it is the only thing
 * that can tell a dead wall from a quiet one (see liveness.ts). It is mounted
 * ONCE, inside the shared Footer, precisely so that no face can be missed — but
 * "mounted once in a shared component" is only true until somebody adds a
 * second footer or moves the brand logo around. A board that silently lost its
 * stamp would go straight back to being unfalsifiable at the glass, which is
 * the failure this whole change exists to end.
 *
 * `Footer` and `Shell` are hook-free, so they can be called directly and their
 * element trees walked — the same technique as checkin-feed.test.tsx, and for
 * the same reason (node environment, no DOM, and a react 18/19 mismatch in this
 * install layout makes react-dom/server unusable here). LiveStamp itself holds
 * hooks and is therefore checked by IDENTITY in the tree rather than rendered;
 * what it says is pinned in liveness.test.ts.
 */

/** Does this tree contain an element of the given component type? */
function contains(node: ReactNode, type: unknown): boolean {
  if (node == null || typeof node === "boolean") return false;
  if (typeof node === "string" || typeof node === "number") return false;
  if (Array.isArray(node)) return node.some((n) => contains(n, type));
  const el = node as { type?: unknown; props?: { children?: ReactNode } };
  if (el.type === type) return true;
  return el.props ? contains(el.props.children, type) : false;
}

/** Every string and number in the tree, joined — the wall's words. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as { props?: { children?: ReactNode } };
  return el.props ? textOf(el.props.children) : "";
}

describe("the scores wall footer", () => {
  it("carries the liveness stamp", () => {
    expect(contains(Footer({ left: "Results final", right: null }), LiveStamp)).toBe(true);
  });

  it("still shows whatever the board put in the footer beside it", () => {
    // The stamp is an ADDITION to the footer, not a replacement for the brand
    // mark or the results line — one slot quietly eating the other is exactly
    // the kind of regression a "does it contain the stamp" test alone misses.
    const foot = Footer({ left: "Results final · 8 racers · 10:49 PM", right: "MARK" });
    expect(textOf(foot)).toContain("Results final · 8 racers · 10:49 PM");
    expect(textOf(foot)).toContain("MARK");
  });

  it("is the footer every 'nothing to show yet' card goes through", () => {
    // The idle card is the state that needs the stamp MOST: a board with nothing
    // on it is the one a passer-by is most likely to read as broken, and it is
    // the face that sits up for hours between the last race and the 2am
    // rollover.
    //
    // Asserted as "Shell routes through the shared Footer" rather than by
    // hunting for the stamp inside it — Shell renders Footer as an ELEMENT, so
    // its children are not expanded in this tree, and a walk looking for
    // LiveStamp would report false for a card that in fact shows it. Composed
    // with the first test, going through Footer IS carrying the stamp; and this
    // is the invariant that actually breaks if somebody hand-rolls a second
    // footer for one card.
    const idle = Shell({
      track: "red",
      venue: "FT",
      title: "Red Track",
      rightLabel: "Heat",
      rightValue: "—",
      big: "Scores will be shown here",
      small: "The first race of the day has not finished yet.",
      footLeft: "Waiting for the first finish",
    });
    expect(contains(idle, Footer)).toBe(true);
  });
});
